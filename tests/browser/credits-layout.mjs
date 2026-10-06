// Exercise the actual phone layout in Chromium, including forms and long content.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root=new URL('../../',import.meta.url);
const html=String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>body{margin:0;padding:12px;min-width:0}main{max-width:900px;margin:auto;min-width:0}</style></head><body><main></main><script id="result" type="application/json"></script><script type="module">
import {renderVendorCredits} from '/src/vendorCredits.js';
const long='VeryLongUnbrokenCustomerAndSupplierName'.repeat(3),view=document.querySelector('main');
const base={business_day:'2026-10-06',month:'2026-10-01',revision:0,outlets:[{id:1,name:'Teapot'}],month_states:[]};
const vendors={...base,vendors:[{id:1,name:long}],accounts:[{vendor_id:1,vendor_name:long,outlet_id:1,outlet_name:'Teapot',balance:999999999999.99,confirmed_month:'2026-09-01'}],movements:[{id:'v1',vendor_name:long,business_date:'2026-10-06',kind:'PAY_VENDOR',amount:999999999999.99,note:'LongPaymentReference'.repeat(25)}]};
const customers={...base,customers:[{id:'c1',name:long,phone:'+91 (98765) 43210'}],accounts:[{customer_id:'c1',customer_name:long,phone:'+91 (98765) 43210',outlet_id:1,outlet_name:'Teapot',balance:999999999999.99}],movements:[{id:'c2',customer_name:long,business_date:'2026-10-06',kind:'RECEIVE_CUSTOMER',amount:999999999999.99,note:'LongCustomerPaymentReference'.repeat(20)}]};
const client={rpc:async(name,args)=>({data:{...(name==='get_customer_credits'?customers:vendors),month:args.p_month||base.month}})};
const profile={access_class:'ADMIN',context_outlet_id:1},states=[];
const check=name=>{
 const width=innerWidth,overflow=[...view.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().right>width+1).map(e=>e.id||e.className||e.tagName);
 states.push({name,width,scrollWidth:document.documentElement.scrollWidth,overflow});
};
try{
 await renderVendorCredits(view,client,profile);check('vendors');
 view.querySelector('#creditOpenMovement').click();check('vendor-entry');
 await view.querySelector('#creditOpenClosing').click();await new Promise(r=>setTimeout(r,30));check('vendor-closing');
 profile._creditsMode='receive';await renderVendorCredits(view,client,profile);check('customers');
 view.querySelector('#creditOpenCustomer').click();check('customer-form');
 view.querySelector('#creditOpenMovement').click();check('customer-payment');
 view.querySelector('#creditOpenClosing').click();await new Promise(r=>setTimeout(r,30));check('customer-closing');
 view.querySelector('[data-credit-void]').click();check('correction');
 view.querySelector('details').open=true;check('expanded-details');
 document.querySelector('#result').textContent=JSON.stringify({states});
}catch(e){document.querySelector('#result').textContent=JSON.stringify({error:e.stack});}
</script></body></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(!path.startsWith('/src/')){res.writeHead(404);res.end();return;}
  const file=await fs.readFile(new URL('.'+path,root),'utf8');
  res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(file);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 for(const width of [320,360,390,768]){
  const {stdout}=await run('google-chrome',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--hide-scrollbars','--force-device-scale-factor=1','--window-size='+width+',1000','--virtual-time-budget=15000','--dump-dom','http://127.0.0.1:'+server.address().port+'/'],{timeout:60000,maxBuffer:4*1024*1024});
  const raw=stdout.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(raw,'Browser fixture completed');const result=JSON.parse(raw);assert.ok(!result.error,result.error);assert.equal(result.states.length,9);
  for(const state of result.states){assert.equal(state.width,width,'Browser uses requested viewport');assert.ok(state.scrollWidth<=state.width+1,JSON.stringify(state));assert.deepEqual(state.overflow,[],JSON.stringify(state));}
  console.log('Credits: 9 layout states fit '+width+'px');
 }
}finally{server.close();}
