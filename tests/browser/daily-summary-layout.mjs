// Exercise the actual phone layout in Chromium, including forms and long content.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../../',import.meta.url);
const html=String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>body{margin:0;padding:14px;min-width:0}main{max-width:900px;margin:auto;min-width:0}</style></head><body><main class="module-view card"></main><script id="result" type="application/json"></script><script type="module">
import {renderDailySummary} from '/fixture-summary.js';
const view=document.querySelector('main'),states=[];
let closed=false,theme='teapot';
const client={from(table){
 const filters=[],q={select(){return q},eq(k,v){filters.push([k,v]);return q},lt(){return q},order(){return q},limit(){return q},maybeSingle:async()=>({data:data(true)}),then(resolve,reject){return Promise.resolve({data:data(false)}).then(resolve,reject)}};
 function data(single){
  if(table==='outlets'){const outlet={id:1,name:'Test Café',theme_key:theme};return single?outlet:[outlet]}
  if(table==='daily_summaries')return filters.some(([k])=>k==='business_date')?{id:'SUM',business_date:'2026-10-06',cash_sale:6300,physical_cash:0,is_closed:closed}:null;
  if(table==='stocktakes')return {id:'STOCK',status:'SUBMITTED'};
  if(table==='vendors')return [{id:1,name:'Long Supplier Name'}];return [];
 }return q;
},async rpc(name){if(name==='get_effective_business_day')return {data:'2026-10-06'};if(name==='get_cigarette_summary')return {data:{closed:true,sales:[{price:10,pieces:10,amount:100}],pack_sales:[{price:260,packs:2,amount:520}]}};if(name==='get_daily_summary_reopen_deadline')return {data:'2026-10-07T12:00:00Z'};return {data:[]}}};
const profile={id:'owner',name:'Owner',access_class:'ADMIN',context_outlet_id:1};
const check=name=>{
 if(!view.textContent.includes('Cigarette POS sales: ₹620 · included in total sales'))throw Error('Daily Summary includes SK + PK revenue exactly once: '+[...view.querySelectorAll('.hint')].map(e=>e.textContent).join(' | '));
 const width=innerWidth,overflow=[...view.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none'&&(e.getBoundingClientRect().right>width+1||e.getBoundingClientRect().left< -1)).map(e=>e.id||e.className||e.tagName);
 const buttons=[...view.querySelectorAll('.summary-actions > button')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim(),color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,height:e.getBoundingClientRect().height}));
 states.push({name,width,scrollWidth:document.documentElement.scrollWidth,overflow,buttons});
};
try{
 for(theme of ['teapot','chai-cafe','planet-cafe','clove','chai-company']){
  closed=false;await renderDailySummary(view,client,profile);check(theme+'-open');
  view.querySelector('#addExpense').click();view.querySelector('#addVendor').click();view.querySelector('#addStaff').click();check(theme+'-entries');
  view.querySelector('#whatsappSummary').click();check(theme+'-message');
  closed=true;await renderDailySummary(view,client,profile);check(theme+'-closed');
 }
 document.querySelector('#result').textContent=JSON.stringify({states});
}catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack});}
</script></body></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(path==='/fixture-summary.js'){const app=await fs.readFile(new URL('src/app.js',root),'utf8');res.setHeader('Content-Type','text/javascript');res.end("import {hasModuleAccess} from '/src/moduleAccess.js';\n"+app.replace(/^import .*;\n/gm,'')+'\nexport {renderDailySummary};');return;}
  if(!path.startsWith('/src/')){res.writeHead(404);res.end();return;}
  const file=await fs.readFile(new URL('.'+path,root),'utf8');
  res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(file);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chromeProfile=await fs.mkdtemp(path.join(os.tmpdir(),'summary-chrome-'));
const chrome=spawn(process.env.CHROME_BIN||'google-chrome',['--disable-dev-shm-usage','--headless','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+chromeProfile]);
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Chromium did not start: '+stderr)),20000);let stderr='';
  chrome.on('error',e=>{clearTimeout(timer);reject(e);});
  chrome.stderr.on('data',chunk=>{stderr+=chunk.toString();const endpoint=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];if(endpoint){clearTimeout(timer);resolve(endpoint);}});
 });
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let seq=0;const pending=new Map();
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 for(const width of [320,360,390,768]){
  const {targetId}=await cdp('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:true},sessionId);
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?width='+width},sessionId);
  let raw='';
  for(let i=0;i<200&&!raw;i++){
   await new Promise(r=>setTimeout(r,50));
   const result=await cdp('Runtime.evaluate',{expression:"document.querySelector('#result')?.textContent||''",returnByValue:true},sessionId);raw=result.result?.value||'';
  }
  assert.ok(raw,'Browser fixture completed');const result=JSON.parse(raw);assert.ok(!result.error,result.error);assert.equal(result.states.length,20);
  for(const state of result.states){assert.equal(state.width,width,'Browser uses requested viewport');assert.ok(state.scrollWidth<=state.width+1,JSON.stringify(state));assert.deepEqual(state.overflow,[],JSON.stringify(state));for(const button of state.buttons){assert.ok(button.text,'Action has a visible label');assert.notEqual(button.color,button.background,JSON.stringify(button));assert.ok(button.height>=44,JSON.stringify(button));}const close=state.buttons.find(b=>b.text==='Close Day');assert.ok(close,'Close Day is always labeled');assert.equal(close.color,'rgb(255, 255, 255)','Close Day retains white text in every café theme');}
  console.log('Daily Summary: 20 layout and label states fit '+width+'px');
  await cdp('Target.closeTarget',{targetId});
 }
}finally{
 socket?.close();chrome.kill();server.close();
 // Chrome may still be releasing profile files.
 await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));
 await fs.rm(chromeProfile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
