import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=(await fs.readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export async function renderApp','async function renderApp').replaceAll('import.meta.env','({})');
async function login(status='complete',pending=true){
 const dom=new JSDOM('<main id="root"></main>'),calls=[],person={id:'employee',name:'Employee',outlet_id:1,access_class:'STAFF',pin_set:false,onboarding_status:status,pin_reset_pending:pending};
 const ctx=vm.createContext({document:dom.window.document,console,FormData,File,fetch:async(url,args)=>{calls.push(args.body);return {ok:true,json:async()=>({success:true})};}});vm.runInContext(source,ctx);
 const client={from(table){const q={select(){return q;},order:async()=>({data:table==='outlets'?[{id:1,name:'Cafe'}]:[person]})};return q;}};
 const root=dom.window.document.querySelector('#root');await ctx.renderLogin(root,client);
 root.querySelector('#outlet-select').value='1';root.querySelector('#outlet-select').onchange();root.querySelector('#name-select').value='employee';root.querySelector('#name-select').onchange();root.querySelector('#start-onboarding').click();
 return {root,calls,dom};
}
test('PIN reset asks only for temporary/new PIN and preserves profile submission',async()=>{
 const h=await login();assert.equal(h.root.querySelector('#ob-full'),null);assert.equal(h.root.querySelector('#ob-back'),null);
 h.root.querySelector('#ob-temp-pin').value='1234';h.root.querySelector('#ob-pin').value='5678';h.root.querySelector('#ob-pin2').value='5678';await h.root.querySelector('#ob-next').onclick();
 assert.equal(h.calls[0].get('action'),'reset_pin');assert.equal(h.calls[0].get('setup_code'),'1234');assert.equal(h.calls[0].get('full_legal_name'),null);assert.equal(h.calls[0].get('identity_document'),null);h.dom.window.close();
});
test('profile reset begins fresh personal details and first-time setup needs no old PIN',async()=>{
 const h=await login('invited',false);assert.equal(h.root.querySelector('#ob-full').value,'');assert.equal(h.root.querySelector('#ob-temp-pin'),null);assert.match(h.root.querySelector('.onboard-progress').textContent,/1 of 6/);h.dom.window.close();
});
test('temporary PIN cannot be kept as the private PIN',async()=>{
 const h=await login();for(const id of ['#ob-temp-pin','#ob-pin','#ob-pin2'])h.root.querySelector(id).value='1234';await h.root.querySelector('#ob-next').onclick();assert.equal(h.calls.length,0);assert.match(h.root.querySelector('#ob-error').textContent,/different/);h.dom.window.close();
});
