import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderCigarettes} from '../src/cigarettes.js';

test('entered orders survive suggestions, reload, revisions and message edits',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://example.test'}),view=dom.window.document.querySelector('main');
 const data={vendors:[{id:1,name:'Kini'}],items:[{item_id:'a',item_name:'Compact',vendor_id:1,pieces_per_pack:10,last_count:0,last_count_date:'2026-09-25',target_stock:100},{item_id:'b',item_name:'Players',vendor_id:1,pieces_per_pack:10,last_count:0,last_count_date:'2026-09-25',target_stock:10}],audit:[],day:null};
 const calls=[];let fail=false;
 const client={rpc:async(name,args)=>{if(name==='get_effective_business_day')return {data:'2026-10-09'};if(name==='get_cigarette_workspace')return {data};calls.push(args);if(fail)return {error:{message:'Offline'}};data.audit.push({action:'order',created_at:new Date(Date.now()+calls.length*1000).toISOString(),actor_name:'Anuj',payload:{input:structuredClone(args.p_payload)}});return {data:{saved:true}};}};
 const profile={access_class:'STAFF',outlet_id:1,role:'Manager',_cigaretteTab:'orders'};
 await renderCigarettes(view,client,profile);
 view.querySelector('.cig-message').click();assert.equal(view.querySelector('textarea').value,'');assert.match(view.textContent,/Save your order before/);
 const fields=()=>[...view.querySelectorAll('.cig-packs')];fields()[0].value='5';fields()[1].value='10';
 await view.querySelector('.cig-save').onclick();assert.deepEqual(fields().map(i=>i.value),['5','10']);
 view.querySelector('.cig-message').click();assert.match(view.querySelector('textarea').value,/Compact — 5 packs/);assert.match(view.querySelector('textarea').value,/Players — 10 packs/);
 await view.querySelector('.cig-save').onclick();assert.equal(calls.length,1,'unchanged save does not create duplicate revision');
 await renderCigarettes(view,client,profile);assert.deepEqual(fields().map(i=>i.value),['5','10']);
 view.querySelector('.cig-message').click();fields()[0].value='7';fields()[0].dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 assert.equal(view.querySelector('textarea').value,'');assert.equal(view.querySelector('.category-order-preview').hidden,true);assert.match(view.textContent,/Unsaved changes/);
 view.querySelector('.cig-message').click();assert.equal(view.querySelector('textarea').value,'');
 fail=true;await view.querySelector('.cig-save').onclick();assert.equal(fields()[0].value,'7');assert.equal(data.audit.length,1);
 await renderCigarettes(view,client,profile);assert.equal(fields()[0].value,'7','intentional unsaved draft survives reload');
 fail=false;await view.querySelector('.cig-save').onclick();assert.equal(data.audit.length,2);assert.equal(view.querySelectorAll('.cig-history').length,2);assert.match(view.textContent,/Earlier revision/);
 view.querySelector('.cig-message').click();assert.match(view.querySelector('textarea').value,/Compact — 7 packs/);
 view.querySelectorAll('.cig-include')[1].checked=false;view.querySelectorAll('.cig-include')[1].dispatchEvent(new dom.window.Event('change',{bubbles:true}));await view.querySelector('.cig-save').onclick();
 assert.equal(view.querySelectorAll('.cig-include')[1].checked,false);assert.equal(fields()[1].value,'');view.querySelector('.cig-message').click();assert.doesNotMatch(view.querySelector('textarea').value,/Players/);
 dom.window.close();
});
