// Exercise the actual phone layout in Chromium, including forms and long content.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../../',import.meta.url);
const html=String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>body{margin:0;padding:12px;min-width:0}main{max-width:900px;margin:auto;min-width:0}</style></head><body><main></main><script id="result" type="application/json"></script><script type="module">
import {renderCigarettes} from '/src/cigarettes.js';
const view=document.querySelector('main'),long='VeryLongUnbrokenCigaretteBrandName'.repeat(3),states=[];
const data={vendors:[{id:1,name:'ITC'},{id:2,name:'Advance'}],items:[{item_id:'a',item_name:long,vendor_id:1,vendor_name:'ITC',pieces_per_pack:10,pos_price:10,opening:20,opening_date:'2026-10-05'},{item_id:'b',item_name:'Esse Gold',vendor_id:2,vendor_name:'Advance',pieces_per_pack:20,pos_price:30,opening:100,opening_date:'2026-10-05'}],purchases:[{item_name:long,vendor_name:'ITC',qty:10,unit:'Pack',invoice_amount:1000}],audit:[],history:[],transfers:[],outlets:[{id:1,name:'Teapot'},{id:2,name:'ChaiCafe'}],day:null};
const client={rpc:async(name,args)=>{if(name==='get_effective_business_day')return{data:'2026-10-06'};if(name==='get_cigarette_workspace')return{data};return{data:{saved:true}};}};
const profile={access_class:'ADMIN',context_outlet_id:2,_cigaretteTab:'purchase'};
const check=name=>{const width=innerWidth,overflow=[...view.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().right>width+1).map(e=>e.id||e.className||e.tagName);states.push({name,width,scrollWidth:document.documentElement.scrollWidth,overflow});};
try{
 await renderCigarettes(view,client,profile);check('purchase-collapsed');view.querySelector('.cig-vendor').open=true;check('purchase-expanded');view.querySelector('.cig-add').click();check('purchase-add');
 view.querySelector('[data-cig-tab="orders"]').click();view.querySelector('.cig-vendor').open=true;check('orders');const card=view.querySelector('.cig-vendor');card.querySelector('.cig-include').checked=true;card.querySelector('.cig-packs').value=10;card.querySelector('.cig-message').click();check('order-message');
 view.querySelector('[data-cig-tab="sales"]').click();check('sales');view.querySelector('[data-cig-tab="stock"]').click();view.querySelector('.stock-category').open=true;check('stock');view.querySelectorAll('.cig-review').forEach(d=>d.open=true);check('stock-review');
 data.day={sales:[10,15,20,25,28,30].map(price=>({price,pieces:0,amount:0})),closing:[{item_id:'a',pieces:10},{item_id:'b',pieces:80}],closed_at:'2026-10-06T18:00:00Z',report:{brands:data.items.map(i=>({...i,closing:i.item_id==='a'?10:80})),sales:[10,15,20,25,28,30].map(price=>({price,pieces:0,amount:0}))}};await renderCigarettes(view,client,profile);check('closed-reopen');
 document.querySelector('#result').textContent=JSON.stringify({states});
}catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack});}
</script></body></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(!path.startsWith('/src/')){res.writeHead(404);res.end();return;}
  let file=await fs.readFile(new URL(path==='/src/app-test.js'?'./src/app.js':'.'+path,root),'utf8');
  if(path==='/src/app-test.js')file=file.replace('async function renderPurchases','export async function renderPurchases').replace(/^import .*;$/gm,line=>line.includes('vendorCatalogue.js')||line.includes('vendorPurchases.js')?line:'');
  res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(file);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chromeProfile=await fs.mkdtemp(path.join(os.tmpdir(),'vendors-chrome-'));
const chrome=spawn('google-chrome',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+chromeProfile]);
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Chromium did not start')),20000);let stderr='';
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
  assert.ok(raw,'Browser fixture completed');const result=JSON.parse(raw);assert.ok(!result.error,result.error);assert.equal(result.states.length,9);
  for(const state of result.states){assert.equal(state.width,width,'Browser uses requested viewport');assert.ok(state.scrollWidth<=state.width+1,JSON.stringify(state));assert.deepEqual(state.overflow,[],JSON.stringify(state));}
  console.log('Cigarettes: 9 layout states fit '+width+'px');
  await cdp('Target.closeTarget',{targetId});
 }
}finally{
 socket?.close();chrome.kill();server.close();
 // Chrome may still be releasing profile files.
 await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));
 await fs.rm(chromeProfile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
