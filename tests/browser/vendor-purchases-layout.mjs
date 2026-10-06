// Exercise the actual phone layout in Chromium, including forms and long content.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../../',import.meta.url);
const html=String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>body{margin:0;padding:12px;min-width:0}main{max-width:900px;margin:auto;min-width:0}</style></head><body><main></main><script id="result" type="application/json"></script><script type="module">
import {renderVendorPurchases} from '/src/vendorPurchases.js';
import {renderPurchases} from '/src/app-test.js';
const view=document.querySelector('main'),long='VeryLongUnbrokenSupplierOrItemName'.repeat(3),states=[];
const cat={vendors:[{id:1,name:long},{id:2,name:'Other vendor'}],categories:[{id:1,name:'Food'}],items:[{item_id:'one',item_name:long,category_id:1,category_name:'Food',vendor_id:1,vendor_name:long,unit:'kg',order_unit:'kg',last_price:100},{item_id:'two',item_name:'Milk',category_id:1,category_name:'Food',vendor_id:2,vendor_name:'Other vendor',unit:'L',order_unit:'L'}]};
const calls=[],client={from(table){const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return Promise.resolve({data:[]});},then(resolve,reject){return Promise.resolve({data:[]}).then(resolve,reject);}};return q;},rpc:async(name,args)=>{calls.push({name,args});if(name==='get_vendor_catalogue')return{data:cat};if(name==='get_effective_business_day')return{data:'2026-10-06'};if(name==='get_tomorrows_order')return{data:cat.items.map(i=>({...i,suggested_qty:1,order_strategy:'DAILY_FORECAST'}))};if(name==='add_vendor_catalogue_item')return{data:{...cat.items[0],item_id:'new',item_name:args.p_name,unit:args.p_unit,order_unit:args.p_unit}};return{data:[]};}};
const check=name=>{
 const width=innerWidth,overflow=[...view.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().right>width+1).map(e=>e.id||e.className||e.tagName);
 states.push({name,width,scrollWidth:document.documentElement.scrollWidth,overflow});
};
const input=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input'));};
try{
 await renderVendorPurchases(view,client,{id:'staff'},{outletId:1,businessDate:'2026-10-06',catalogue:cat});check('purchase-collapsed');
 const card=view.querySelector('details');card.open=true;input(card.querySelector('.purchase-qty'),'123.5');check('purchase-items');
 card.querySelector('.purchase-add-item').click();check('purchase-add');
 const form=card.querySelector('form');form.elements.category_id.value='new';form.elements.category_id.onchange();form.elements.unit.value='other';form.elements.unit.onchange();check('purchase-new-category-unit');
 card.querySelector('.catalogue-cancel').click();card.querySelector('[data-mode="invoice"]').click();check('purchase-invoice');
 await renderPurchases(view,client,{id:'staff',access_class:'STAFF',outlet_id:1,outlets:{name:'Teapot'}},'orders');check('orders-collapsed');
 let first=view.querySelector('#tomorrowOrderRows details');first.open=true;check('orders-items');
 first.querySelector('.order-card-add').click();check('orders-add');
 first.querySelector('.catalogue-cancel').click();first.querySelector('.category-message').click();check('orders-message');
 document.querySelector('#result').textContent=JSON.stringify({states});
}catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack});}
</script></body></html>
`;
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
  console.log('Purchases/Orders: 9 layout states fit '+width+'px');
  await cdp('Target.closeTarget',{targetId});
 }
}finally{
 socket?.close();chrome.kill();server.close();
 // Chrome may still be releasing profile files.
 await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));
 await fs.rm(chromeProfile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
