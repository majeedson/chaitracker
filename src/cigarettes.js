import {escapeCatalogue as e} from './vendorCatalogue.js';
import {SK_PRICES,PK_PRICES,cigaretteGroups,packPieces} from './cigaretteMetrics.js';
const money=n=>n==null?'—':'₹'+Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
const qty=n=>n==null?'—':Number(n).toLocaleString('en-IN');
const prices=data=>[...new Set([...SK_PRICES,...data.items.map(i=>Number(i.pos_price)).filter(n=>n>0),...(data.day?.sales||[]).map(s=>Number(s.price))])].sort((a,b)=>a-b);
const priceSelect=(data,current)=>`<option value="">Set SK</option>${prices(data).map(n=>`<option value="${n}" ${Number(current)===n?'selected':''}>SK${n}</option>`).join('')}`;
const packSelect=current=>`<option value="">Set PK</option><option value="0" ${current!=null&&Number(current)===0?'selected':''}>No pack sales</option>${PK_PRICES.map(n=>`<option value="${n}" ${Number(current)===n?'selected':''}>PK${n}</option>`).join('')}`;
const saleRows=(data,kind)=>{const isPack=kind==='PK',list=isPack?PK_PRICES:prices(data),savedSales=isPack?data.day?.pack_sales:data.day?.sales;return list.map(price=>{const saved=savedSales?.find(s=>Number(s.price)===price);return {price,kind,code:kind+price,quantity:saved?.[isPack?'packs':'pieces'],amount:saved?.amount};});};
const uuid=()=>crypto.randomUUID();
const orderSignature=entries=>JSON.stringify(entries.map(x=>({item_id:x.item_id,packs:Number(x.packs),pack_price:x.pack_price==null?null:Number(x.pack_price)})).sort((a,b)=>a.item_id.localeCompare(b.item_id)));
const savedOrders=data=>(data.audit||[]).filter(a=>a.action==='order').sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
const latestOrder=(data,vendor)=>savedOrders(data).find(a=>Number(a.payload.input.vendor_id)===Number(vendor));

export async function renderCigarettes(view,client,profile){
 const outletId=Number(profile.access_class==='ADMIN'?profile.context_outlet_id:profile.outlet_id);
 if(!outletId){view.innerHTML='<h2>Select a café</h2>';return;}
 const request={};view._cigaretteRequest=request;
 const {data:today,error:dateError}=await client.rpc('get_effective_business_day',{p_outlet_id:outletId,p_timestamp:new Date().toISOString()});
 if(view._cigaretteRequest!==request)return;
 if(dateError){view.innerHTML=`<p class="form-error">${e(dateError.message)}</p>`;return;}
 let date=profile._cigaretteDate||today,tab=profile._cigaretteTab||'stock',data;
 const owner=profile.access_class==='ADMIN',manager=owner||['Manager','Ops Manager'].includes(profile.role);
 const fetchData=async()=>{
  const response=await client.rpc('get_cigarette_workspace',{p_outlet_id:outletId,p_date:date});
  if(view._cigaretteRequest!==request)return false;
  if(response.error)throw response.error;data=response.data;return true;
 };
 const draftKey=()=>`cafetracker-cigarettes:${outletId}:${date}:${tab}${tab==='orders'?':entered-v148':''}`;
 const readDraft=()=>{try{return JSON.parse(view.ownerDocument.defaultView.localStorage.getItem(draftKey())||'{}');}catch{return {};}};
 const writeDraft=d=>{try{view.ownerDocument.defaultView.localStorage.setItem(draftKey(),JSON.stringify(d));}catch{}};
 const saveDraft=()=>{
  const d={};view.querySelectorAll('.cig-entry-row,.cig-count-row,.cig-sales-row').forEach(r=>{
   d[r.dataset.id||r.dataset.saleCode||r.dataset.price]=Object.fromEntries([...r.querySelectorAll('input,select')].map(i=>[i.className,i.type==='checkbox'?i.checked:i.value]));
  });writeDraft(d);
 };
 const restoreDraft=()=>{
  if(data.day?.closed_at&&tab!=='orders')return;const d=readDraft();
  view.querySelectorAll('.cig-entry-row,.cig-count-row,.cig-sales-row').forEach(r=>{
   const values=d[r.dataset.id||r.dataset.saleCode||r.dataset.price]||(r.dataset.saleCode?.startsWith('SK')?d[r.dataset.price]:null);if(!values)return;r.querySelectorAll('input,select').forEach(i=>{if(values[i.className]!==undefined){if(i.type==='checkbox')i.checked=values[i.className];else i.value=values[i.className];}});
  });
 };
 const act=async(action,payload)=>{
  saveDraft();
  const response=await client.rpc('save_cigarette_action',{p_outlet_id:outletId,p_date:date,p_action:action,p_payload:payload});
  if(response.error)throw response.error;
  if(['sales','close'].includes(action))writeDraft({});
  if(['purchase','order'].includes(action)){const d=readDraft();const ids=action==='order'?data.items.filter(i=>Number(i.vendor_id)===Number(payload.vendor_id)).map(i=>i.item_id):payload.entries.map(i=>i.item_id);ids.forEach(id=>delete d[id]);writeDraft(d);}
 };
 const status=(message,error=false)=>{const el=view.querySelector('#cigMessage');if(el){el.hidden=false;el.textContent=message;el.className='purchase-message '+(error?'error':'success');}};
 const submit=(button,fn)=>async event=>{
  event?.preventDefault();button.disabled=true;
  try{await fn();if(await fetchData()){render();status('Saved.');}}
  catch(err){status(err.message||'Could not save.',true);button.disabled=false;}
 };
 const addBrand=(vendor,target)=>{
  target.hidden=!target.hidden;if(target.hidden)return;
  target.innerHTML=`<form class="cig-add-form"><label>Brand name<input name="name" maxlength="150" required></label><label>Pieces / pack<input name="pack" type="number" min="1" max="100" step="1" required></label><label>PK category<select name="pack_price" required>${packSelect(null)}</select></label><button class="secondary">Add brand</button></form>`;
  const form=target.querySelector('form');form.onsubmit=submit(form.querySelector('button'),async()=>{if(!form.reportValidity())throw Error('Enter brand and pack size.');await act('add',{vendor_id:vendor.id,name:form.elements.name.value,pack:Number(form.elements.pack.value),pack_price:Number(form.elements.pack_price.value)});});
 };
 const render=()=>{
  const closed=!!data.day?.closed_at;
  const revenue=data.day?.sales?[...data.day.sales,...(data.day.pack_sales||[])].reduce((n,s)=>n+Number(s.amount),0):null;
  view.innerHTML=`<div class="cig-workspace"><div class="section-heading"><div><h2>Cigarettes</h2><small>${closed?'Closed':'Closing pending'} · ${data.items.length} brands</small></div><label class="cig-date">Date<input id="cigDate" type="date" max="${e(today)}" value="${e(date)}"></label></div><div class="cig-tabs" role="tablist">${[['orders','Orders'],['purchase','Purchases'],['stock','Stock / Close'],['sales','Sales']].map(([id,label])=>`<button type="button" role="tab" aria-selected="${tab===id}" data-cig-tab="${id}" class="${tab===id?'active':''}">${label}</button>`).join('')}</div><div id="cigMessage" class="purchase-message" role="status" hidden></div><div class="cig-overview"><span>POS sales <strong>${money(revenue)}</strong></span><span>Unassigned SK <strong>${data.items.filter(i=>!i.pos_price).length}</strong></span></div><div id="cigPane"></div></div>`;
  const pane=view.querySelector('#cigPane');let refreshCheck=null;const orderChecks=[];
  view.querySelector('#cigDate').onchange=async event=>{saveDraft();date=event.target.value;profile._cigaretteDate=date;try{if(await fetchData())render();}catch(err){status(err.message,true);}};
  view.querySelectorAll('[data-cig-tab]').forEach(b=>b.onclick=()=>{saveDraft();tab=b.dataset.cigTab;profile._cigaretteTab=tab;render();});
  if(!data.vendors.length){pane.innerHTML='<p class="notice">No cigarette supplier is configured for this café.</p>';return;}
  if(tab==='orders'||tab==='purchase'){
   for(const vendor of data.vendors){
    const card=view.ownerDocument.createElement('details');card.className='order-category-group cig-vendor';
    const list=data.items.filter(i=>Number(i.vendor_id)===Number(vendor.id));
    const savedOrder=tab==='orders'?latestOrder(data,vendor.id):null;
    const savedEntries=savedOrder?.payload.input.entries||[];
    card.innerHTML=`<summary><span><strong>${e(vendor.name)}</strong><small>${list.length} brands</small></span></summary><div class="order-category-body">${closed&&tab==='purchase'?'<p class="notice">Reopen the day to add purchases.</p>':''}<div class="cig-vendor-items">${list.map(i=>{
     const stock=Number(i.last_count||0),suggested=i.last_count_date?Math.ceil(Math.max(0,Number(i.target_stock||0)-stock)/i.pieces_per_pack):0;
     return `<div class="cig-entry-row" data-id="${e(i.item_id)}"><label class="cig-brand"><input class="cig-include" type="checkbox" ${tab==='orders'&&suggested>0?'checked':''} ${closed&&tab==='purchase'?'disabled':''}><span><strong>${e(i.item_name)}</strong><small>${i.pieces_per_pack}/pack · ${qty(stock)} pieces${i.last_count_date?' · '+e(i.last_count_date):' · no count'}</small></span></label><div class="cig-entry-controls ${tab==='purchase'?'cig-purchase-controls':'cig-order-controls'}"><label>Packs<input class="cig-packs" type="number" inputmode="numeric" min="0" step="1" value="${tab==='orders'&&suggested>0?suggested:''}" ${closed&&tab==='purchase'?'disabled':''}></label>${tab==='purchase'?`<label>Total ₹<input class="cig-amount" type="number" inputmode="decimal" min="0.01" step="0.01" ${closed?'disabled':''}></label><label>SK category<select class="cig-sk" required ${closed?'disabled':''}>${priceSelect(data,i.pos_price)}</select></label><label>PK category<select class="cig-pk" required ${closed?'disabled':''}>${packSelect(i.pack_price)}</select></label>`:`<label>PK category<select class="cig-pk">${packSelect(i.pack_price)}</select></label>`}</div></div>`;
    }).join('')}</div><div class="cig-add-panel" hidden></div><div class="cig-actions"><button class="summary-add cig-add" type="button" ${closed?'disabled':''}>＋ Add brand</button><button class="primary cig-save" type="button" ${closed&&tab==='purchase'?'disabled':''}>${tab==='purchase'?'Save purchase':'Save order'}</button>${tab==='orders'?'<button type="button" class="secondary cig-message">Generate message</button>':''}</div><div class="category-order-preview" hidden><textarea readonly></textarea><button class="secondary cig-copy" type="button">Copy</button></div></div>`;
    const requestId=uuid();
    const selected=()=>[...card.querySelectorAll('.cig-entry-row')].filter(r=>r.querySelector('.cig-include').checked).map(r=>({item_id:r.dataset.id,packs:Number(r.querySelector('.cig-packs').value),amount:tab==='purchase'?Number(r.querySelector('.cig-amount').value):null,pos_price:tab==='purchase'?Number(r.querySelector('.cig-sk').value):null,pack_price:r.querySelector('.cig-pk').value===''?null:Number(r.querySelector('.cig-pk').value)}));
    if(savedOrder)card.querySelectorAll('.cig-entry-row').forEach(r=>{const entry=savedEntries.find(x=>x.item_id===r.dataset.id);r.querySelector('.cig-include').checked=!!entry;r.querySelector('.cig-packs').value=entry?.packs??'';r.querySelector('.cig-pk').value=entry?.pack_price??'';});
    card.querySelectorAll('.cig-entry-row').forEach(r=>{
     const i=list.find(i=>i.item_id===r.dataset.id),amount=r.querySelector('.cig-amount');let auto=true;
     r.querySelector('.cig-packs').oninput=()=>{r.querySelector('.cig-include').checked=Number(r.querySelector('.cig-packs').value)>0;if(amount&&auto&&i.cost_per_piece!=null)amount.value=(Number(r.querySelector('.cig-packs').value)*i.pieces_per_pack*i.cost_per_piece).toFixed(2);};
     if(amount)amount.oninput=()=>{auto=amount.value==='';};
    });
    card.querySelector('.cig-add').onclick=()=>addBrand(vendor,card.querySelector('.cig-add-panel'));
    card.querySelector('.cig-save').onclick=submit(card.querySelector('.cig-save'),async()=>{
     const entries=selected();if(!entries.length||entries.some(r=>!Number.isInteger(r.packs)||r.packs<=0||(tab==='purchase'&&(!r.pos_price||r.pack_price==null||r.amount<=0))))throw Error('Choose brands, whole packs, amount, SK and PK categories.');
     if(tab==='orders'&&savedOrder&&orderSignature(entries)===orderSignature(savedEntries))return;
     await act(tab==='purchase'?'purchase':'order',{vendor_id:vendor.id,entries,request_id:requestId});
    });
    if(tab==='orders'){
     const clean=()=>!!savedOrder&&orderSignature(selected())===orderSignature(savedEntries);
     const state=view.ownerDocument.createElement('small');state.className='hint cig-order-state';card.querySelector('.cig-actions').before(state);
     const check=()=>{state.textContent=clean()?'Saved order':savedOrder?'Unsaved changes — save before messaging':'Suggestions only — enter and save';if(!clean()){card.querySelector('.category-order-preview').hidden=true;card.querySelector('textarea').value='';}};
     card.addEventListener('input',check);card.addEventListener('change',check);orderChecks.push(check);
     card.querySelector('.cig-message').onclick=()=>{if(!clean()){status('Save your order before generating the message.',true);return;}card.querySelector('.category-order-preview').hidden=false;card.querySelector('textarea').value=`*${vendor.name.toUpperCase()} — CIGARETTES*\n${date}\n`+savedEntries.map(x=>(list.find(i=>i.item_id===x.item_id)?.item_name||x.item_id)+' — '+x.packs+' packs').join('\n');};
     card.querySelector('.cig-copy').onclick=async()=>{if(!clean()||!card.querySelector('textarea').value){check();status('Save your order and generate the message first.',true);return;}try{await navigator.clipboard.writeText(card.querySelector('textarea').value);status('Copied.');}catch{card.querySelector('textarea').select();status('Select and copy the message.');}};
    }
    pane.append(card);
   }
   if(tab==='purchase')pane.insertAdjacentHTML('beforeend',`<details class="cig-review"><summary>Purchases recorded today</summary>${data.purchases.map(p=>`<div class="purchase-history-line"><span><strong>${e(p.item_name)}</strong><small>${e(p.vendor_name)} · ${qty(p.qty)} ${e(p.unit)}</small></span><b>${money(p.invoice_amount)}</b></div>`).join('')||'<p>No purchases recorded.</p>'}</details>`);
   if(tab==='orders')pane.insertAdjacentHTML('beforeend',`<details class="cig-review"><summary>Saved orders / revisions</summary>${savedOrders(data).map(a=>`<div class="cig-history"><strong>${latestOrder(data,a.payload.input.vendor_id)===a?'Latest order':'Earlier revision'} · ${e(data.vendors.find(v=>Number(v.id)===Number(a.payload.input.vendor_id))?.name||'Vendor')}</strong><br>${e(a.actor_name)} · ${e(new Date(a.created_at).toLocaleTimeString())}<ul>${(a.payload.input.entries||[]).map(x=>`<li>${e(data.items.find(i=>i.item_id===x.item_id)?.item_name||x.item_id)} — ${x.packs} packs</li>`).join('')}</ul></div>`).join('')||'<p>No orders saved.</p>'}</details>`);
  }
  if(tab==='sales'){
   const rows=[...saleRows(data,'SK'),...saleRows(data,'PK')];
   pane.innerHTML=`<form id="cigSales"><div class="cig-sales-head"><strong>POS cigarette sales</strong><button class="summary-add" id="cigZero" type="button" ${closed?'disabled':''}>Set all to zero</button></div>${['SK','PK'].map(kind=>`<h3 class="cig-sale-section">${kind==='SK'?'Loose pieces':'Whole packs'}</h3>${rows.filter(r=>r.kind===kind).map(r=>`<div class="cig-sales-row" data-price="${r.price}" data-kind="${kind}" data-sale-code="${r.code}"><strong>${r.code}</strong><label>${kind==='PK'?'Packs sold':'Pieces sold'}<input class="cig-sold" type="number" inputmode="numeric" min="0" step="1" required value="${r.quantity??''}" ${closed?'disabled':''}></label><label>POS amount ₹<input class="cig-revenue" type="number" inputmode="decimal" min="0" step="0.01" required value="${r.amount??''}" ${closed?'disabled':''}></label></div>`).join('')}`).join('')}<div class="cig-actions"><button class="primary" ${closed?'disabled':''}>Save POS sales</button></div></form><p class="hint">SK + PK sales are included in your Daily Summary total.</p>`;
   const form=pane.querySelector('form');
   form.querySelectorAll('.cig-sales-row').forEach(r=>r.querySelector('.cig-sold').oninput=()=>{r.querySelector('.cig-revenue').value=(Number(r.querySelector('.cig-sold').value)*Number(r.dataset.price)).toFixed(2);});
   form.querySelector('#cigZero').onclick=()=>{form.querySelectorAll('input').forEach(i=>i.value='0');saveDraft();};
   form.onsubmit=submit(form.querySelector('.primary'),async()=>{
    if(!form.reportValidity())throw Error('Enter each SK and PK group, including zeros.');
    const entries=kind=>[...form.querySelectorAll('.cig-sales-row')].filter(r=>r.dataset.kind===kind).map(r=>({price:Number(r.dataset.price),[kind==='PK'?'packs':'pieces']:Number(r.querySelector('.cig-sold').value),amount:Number(r.querySelector('.cig-revenue').value)}));
    await act('sales',{entries:entries('SK'),pack_entries:entries('PK')});
   });
  }
  if(tab==='stock'){
   const saved=new Map((data.day?.closing||[]).map(c=>[c.item_id,c.pieces]));
   pane.innerHTML=`<form id="cigClose">${data.vendors.map(v=>`<details class="stock-category"><summary><span><strong>${e(v.name)}</strong><small>${data.items.filter(i=>Number(i.vendor_id)===Number(v.id)).length} brands</small></span></summary><div class="stock-category-body">${data.items.filter(i=>Number(i.vendor_id)===Number(v.id)).map(i=>{const count=saved.get(i.item_id);return `<div class="cig-count-row" data-id="${e(i.item_id)}" data-pack="${i.pieces_per_pack}"><div><strong>${e(i.item_name)}</strong><small>${i.pos_price?'SK'+i.pos_price:'SK not set'} · ${i.pack_price>0?'PK'+i.pack_price:i.pack_price===0?'No pack sales':'PK not set'} · Opening ${qty(i.opening)}${i.opening_date?' ('+e(i.opening_date)+')':''} · Received ${qty(i.purchased)}</small></div><div class="cig-count-inputs"><label>Packs<input class="cig-count-packs" type="number" inputmode="numeric" min="0" step="1" required value="${count==null?'':Math.floor(count/i.pieces_per_pack)}" ${closed?'disabled':''}></label><label>Loose<input class="cig-count-loose" type="number" inputmode="numeric" min="0" max="${i.pieces_per_pack-1}" step="1" required value="${count==null?'':count%i.pieces_per_pack}" ${closed?'disabled':''}></label><strong class="cig-count-total">${qty(count)}</strong></div></div>`;}).join('')}</div></details>`).join('')}<div id="cigReconciliation"></div><label class="cig-check"><input id="cigVerified" type="checkbox" required ${closed?'checked disabled':''}> Physical count checked</label><div class="cig-actions"><button class="primary" ${closed?'disabled':''}>${closed?'Day closed':'Close cigarettes'}</button></div></form>${owner&&closed?'<form id="cigReopen" class="cig-reopen"><label>Correction reason<input name="reason" minlength="3" required></label><button class="secondary">Reopen day</button></form>':''}<details class="cig-review"><summary>Transfers and adjustments</summary><div id="cigMovements"></div></details><details class="cig-review"><summary>SK / PK categories</summary><div id="cigSettings"></div></details><details class="cig-review"><summary>Recent daily checks</summary><div id="cigHistory"></div></details><details class="cig-review"><summary>Activity</summary>${data.audit.map(a=>`<p>${e(a.action)} · ${e(a.actor_name)} · ${e(new Date(a.created_at).toLocaleTimeString())}${a.payload.input.reason?' · '+e(a.payload.input.reason):''}</p>`).join('')||'<p>No activity.</p>'}</details><details class="cig-review"><summary>How the check works</summary><p>Stock movement = opening + purchases + transfers in − transfers out + approved adjustment − physical closing. Compare its pieces with SK loose sales plus PK pack sales converted to pieces. Linked SK/PK codes are checked together without inventing brand sales. Mixed pack sizes in one sold PK code leave its check incomplete. A positive difference means unaccounted pieces; a negative difference means excess. Brand movement is not brand sales. Missing opening counts or SK/PK assignments leave the check incomplete. Daily Summary already includes cigarette revenue.</p></details>`;
   const form=pane.querySelector('#cigClose');
   const counts=()=>Object.fromEntries([...form.querySelectorAll('.cig-count-row')].map(r=>[r.dataset.id,r.querySelector('.cig-count-packs').value!==''&&r.querySelector('.cig-count-loose').value!==''?packPieces(r.querySelector('.cig-count-packs').value,r.querySelector('.cig-count-loose').value,r.dataset.pack):null]));
   const drawCheck=()=>{
    const groups=closed?cigaretteGroups(data.day.report.brands,data.day.report.sales,Object.fromEntries(data.day.report.brands.map(b=>[b.item_id,b.closing])),date,data.day.report.pack_sales):cigaretteGroups(data.items,data.day?.sales||[],counts(),date,data.day?.pack_sales||[]);
    form.querySelector('#cigReconciliation').innerHTML=checkHtml(groups);
    form.querySelectorAll('.cig-count-row').forEach(r=>r.querySelector('.cig-count-total').textContent=qty(counts()[r.dataset.id]));
   };
   form.querySelectorAll('.cig-count-row input').forEach(i=>i.oninput=()=>{form.querySelector('#cigVerified').checked=false;drawCheck();});refreshCheck=drawCheck;drawCheck();
   form.onsubmit=submit(form.querySelector('.primary'),async()=>{if(!form.reportValidity())throw Error('Count every brand and confirm the physical count.');await act('close',{entries:Object.entries(counts()).map(([item_id,pieces])=>({item_id,pieces}))});});
   const reopen=pane.querySelector('#cigReopen');if(reopen)reopen.onsubmit=submit(reopen.querySelector('button'),async()=>{if(!reopen.reportValidity())throw Error('Enter correction reason.');await act('reopen',{reason:reopen.elements.reason.value});});
   pane.querySelector('#cigSettings').innerHTML=data.items.map(i=>`<div class="cig-setting"><strong>${e(i.item_name)}</strong>${owner?`<div class="cig-setting-selects"><select aria-label="SK category for ${e(i.item_name)}" data-sk-item="${e(i.item_id)}">${priceSelect(data,i.pos_price)}</select><select aria-label="PK category for ${e(i.item_name)}" data-pk-item="${e(i.item_id)}">${packSelect(i.pack_price)}</select></div>`:`<span>${i.pos_price?'SK'+i.pos_price:'Set SK'} · ${i.pack_price>0?'PK'+i.pack_price:i.pack_price===0?'No pack sales':'Set PK during purchase'}</span>`}</div>`).join('');
   pane.querySelectorAll('[data-sk-item]').forEach(s=>s.onchange=submit(s,()=>act('settings',{item_id:s.dataset.skItem,pos_price:s.value===''?null:Number(s.value)})));
   pane.querySelectorAll('[data-pk-item]').forEach(s=>s.onchange=submit(s,()=>act('settings',{item_id:s.dataset.pkItem,pack_price:s.value===''?null:Number(s.value)})));
   pane.querySelector('#cigHistory').innerHTML=data.history.map(h=>`<details class="cig-history"><summary>${e(h.business_date)}</summary>${checkHtml(cigaretteGroups(h.report.brands,h.report.sales,Object.fromEntries(h.report.brands.map(b=>[b.item_id,b.closing])),h.business_date,h.report.pack_sales))}</details>`).join('')||'<p>No closes yet.</p>';
   const m=pane.querySelector('#cigMovements'),options=data.items.map(i=>`<option value="${e(i.item_id)}">${e(i.item_name)}</option>`).join('');
   m.innerHTML=`${data.transfers.map(t=>`<div class="cig-transfer"><span>${e(t.item_name)} · ${t.pieces} pieces<br><small>${e(t.source_name)} → ${e(t.destination_name)} · ${t.received_at?'Received':'Awaiting receipt'}</small></span>${!t.received_at&&Number(t.destination_outlet)===outletId&&!closed?`<button class="secondary" type="button" data-receive="${t.id}">Receive</button>`:''}</div>`).join('')}${!closed?`<form id="cigDispatch" class="cig-movement-form"><label>Brand<select name="item">${options}</select></label><label>To café<select name="destination">${data.outlets.filter(o=>Number(o.id)!==outletId).map(o=>`<option value="${o.id}">${e(o.name)}</option>`).join('')}</select></label><label>Pieces<input name="pieces" type="number" min="1" step="1" required></label><button class="secondary">Dispatch</button></form>${manager?`<form id="cigAdjust" class="cig-movement-form"><label>Brand<select name="item">${options}</select></label><label>Change in pieces<input name="pieces" type="number" step="1" required placeholder="− for loss"></label><label>Reason<input name="reason" minlength="3" required></label><button class="secondary">Approve adjustment</button></form>`:''}`:''}`;
   m.querySelectorAll('[data-receive]').forEach(b=>b.onclick=submit(b,()=>act('receive',{transfer_id:b.dataset.receive})));
   const dispatch=m.querySelector('#cigDispatch');if(dispatch)dispatch.onsubmit=submit(dispatch.querySelector('button'),async()=>{if(!dispatch.reportValidity())throw Error('Complete transfer fields.');await act('dispatch',{item_id:dispatch.elements.item.value,destination:Number(dispatch.elements.destination.value),pieces:Number(dispatch.elements.pieces.value)});});
   const adjust=m.querySelector('#cigAdjust');if(adjust)adjust.onsubmit=submit(adjust.querySelector('button'),async()=>{if(!adjust.reportValidity())throw Error('Complete adjustment fields.');await act('adjust',{item_id:adjust.elements.item.value,pieces:Number(adjust.elements.pieces.value),reason:adjust.elements.reason.value});});
  }
  restoreDraft();refreshCheck?.();orderChecks.forEach(check=>check());pane.addEventListener('input',saveDraft);pane.addEventListener('change',saveDraft);
 };
 try{if(await fetchData())render();}catch(err){view.innerHTML=`<h2>Cigarettes unavailable</h2><p class="form-error">${e(err.message)}</p>`;}
}
function checkHtml(groups){
 const cost=groups.every(g=>g.cost!==null)?groups.reduce((n,g)=>n+g.cost,0):null;
 const exposures=groups.map(g=>g.exposure!==undefined?g.exposure:g.difference==null?null:Math.max(0,g.difference)*g.price);
 const exposure=exposures.every(x=>x!=null)?exposures.reduce((n,x)=>n+x,0):null;
 return `<div class="cig-checks"><h3>SK / PK stock check · pieces</h3>${groups.map(g=>`<div class="cig-group-check ${g.difference>0?'shortage':''}"><strong>${e(g.label||'SK'+g.price)}</strong><span>POS <b>${qty(g.sold)}</b></span><span>Stock movement <b>${qty(g.movement)}</b></span><span>${g.difference==null?e(g.reason||'Incomplete'):g.difference>0?'Unaccounted':g.difference<0?'Excess':'Matched'} <b>${g.difference==null?'':qty(Math.abs(g.difference))}</b></span></div>`).join('')}<small>${groups.some(g=>g.unassigned)?'Set SK / PK categories in Purchases. ':''}${groups.some(g=>!g.complete)?'Daily opening and closing counts are needed.':''}</small><div class="cig-overview"><span>Unaccounted at selling price <strong>${money(exposure)}</strong></span><span>Stock movement cost estimate <strong>${money(cost)}</strong></span></div></div>`;
}
