import {shiftMonth,monthEnd} from './businessMetrics.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>v===null||v===undefined?'—':'₹'+Number(v).toLocaleString('en-IN',{maximumFractionDigits:2});
const vendorLabels={PAY_VENDOR:'Paid vendor',RECEIVE_VENDOR:'Vendor refund',ADD_PAYABLE:'Added payable',ADD_RECEIVABLE:'Added vendor credit'};
const customerLabels={ADD_CREDIT:'Credit sale',RECEIVE_CUSTOMER:'Payment received'};
export function creditTotals(accounts,customers=[]){
 const known=accounts.filter(a=>a.balance!==null&&a.balance!==undefined);
 return {toPay:known.length?known.reduce((s,a)=>s+Math.max(0,Number(a.balance)),0):null,
 toReceive:customers.reduce((s,a)=>s+Math.max(0,Number(a.balance)||0),0),unknown:accounts.length-known.length,known:known.length};
}
export async function renderVendorCredits(view,client,profile){
 if(profile.access_class!=='ADMIN'){view.innerHTML='<h2>Admin access required</h2>';return;}
 const token={};view._creditsRequest=token;
 const outlet=profile.context_outlet_id?Number(profile.context_outlet_id):null;
 const requestedMonth=profile._creditsMonth?profile._creditsMonth+'-01':null;
 const [vendors,customers]=await Promise.all(['vendor','customer'].map(ledger=>client.rpc('get_'+ledger+'_credits',{p_outlet_id:outlet,p_month:requestedMonth})));
 if(view._creditsRequest!==token)return;
 const error=vendors.error||customers.error;
 if(error||!vendors.data||!customers.data){view.innerHTML='<h2>Credits unavailable</h2><p class="form-error">'+esc(error?.message||'Please try again.')+'</p><button id="creditRetry" class="secondary" type="button">Retry</button>';view.querySelector('#creditRetry').onclick=()=>renderVendorCredits(view,client,profile);return;}
 const isCustomer=profile._creditsMode==='receive',ledger=isCustomer?'customer':'vendor',data=isCustomer?customers.data:vendors.data;
 const accountId=a=>isCustomer?a.customer_id:a.vendor_id,accountName=a=>isCustomer?a.customer_name:a.vendor_name;
 const labels=isCustomer?customerLabels:vendorLabels;
 const currentMonth=data.business_day.slice(0,7),selectedMonth=data.month.slice(0,7),totals=creditTotals(vendors.data.accounts,customers.data.accounts);
 const lastClosed=data.month_states.filter(s=>s.status==='CLOSED').sort((a,b)=>a.period_month.localeCompare(b.period_month)).at(-1)?.period_month;
 let search='',closingData=null,closingMonth=shiftMonth(currentMonth,-1),selectedMovement=null,editingCustomer=null;
 const message=profile._creditsNotice||'';delete profile._creditsNotice;
 const option=(value,label)=>'<option value="'+esc(value)+'">'+esc(label)+'</option>';
 const refresh=()=>renderVendorCredits(view,client,profile);
 async function save(form,action,payload,revision=data.revision){
  if(!form.reportValidity())return;
  const target=form.querySelector('[role="status"]'),button=form.querySelector('button[type="submit"]');
  const base={...payload,outlet_id:outlet,expected_revision:revision},signature=JSON.stringify({action,base});
  if(form._requestSignature!==signature){form._requestSignature=signature;form._requestId=crypto.randomUUID();}
  button.disabled=true;target.textContent='Saving…';
  try{
   const r=await client.rpc('manage_'+ledger+'_credits',{p_action:action,p_payload:{...base,request_id:form._requestId}});
   if(r.error)throw r.error;if(view._creditsRequest!==token)return;
   profile._creditsNotice=({CLOSE:'Month closed.',REOPEN:'Month reopened.',VOID:'Entry voided.',CUSTOMER:'Customer added.',EDIT_CUSTOMER:'Customer updated.'})[action]||'Entry saved.';
   if(action==='CUSTOMER')profile._creditsMonth=currentMonth;
   await refresh();
  }catch(e){if(view._creditsRequest!==token)return;target.textContent=e.message?.includes('credit_customers_outlet_id_phone_digits')?'This phone number already belongs to a customer.':e.message||'Unable to save. Please retry.';button.disabled=false;}
 }
 const cafeButton=a=>!outlet?'<button type="button" class="credit-cafe-link" data-credit-cafe="'+a.outlet_id+'">'+esc(a.outlet_name)+' ›</button>':'';
 function renderRows(){
  const rows=data.accounts.filter(a=>!search||(accountName(a)+' '+(a.phone||'')+' '+a.outlet_name).toLowerCase().includes(search));
  view.querySelector('#creditAccountRows').innerHTML=rows.length?rows.map(a=>'<article class="credit-account"><div class="credit-account-main"><strong>'+esc(accountName(a))+'</strong>'+(isCustomer?'<a class="credit-phone" href="tel:'+esc(a.phone.replace(/[^+0-9]/g,''))+'">'+esc(a.phone)+'</a>':'')+cafeButton(a)+'<small>'+(a.balance===null?'Not confirmed':a.confirmed_month?'Confirmed '+esc(a.confirmed_month.slice(0,7)):isCustomer?'Recorded':'Not confirmed')+'</small></div><div class="credit-account-balance"><strong>'+money(a.balance===null?null:Math.abs(Number(a.balance)))+'</strong><small>'+(a.balance===null?'':!isCustomer&&Number(a.balance)<0?'Vendor credit':Number(a.balance)===0?'Settled':isCustomer?'To receive':'To pay')+'</small>'+(isCustomer&&outlet?'<button type="button" class="ghost" data-credit-edit="'+esc(accountId(a))+'">Edit</button>':'')+'</div></article>').join(''):'<p class="section-help">'+(search?'No matches.':isCustomer?'No credit customers yet.':'No vendors.')+'</p>';
  view.querySelectorAll('[data-credit-cafe]').forEach(b=>b.onclick=()=>view.dispatchEvent(new CustomEvent('app:navigate',{bubbles:true,detail:{module:'credits',outletId:Number(b.dataset.creditCafe)}})));
  view.querySelectorAll('[data-credit-edit]').forEach(b=>b.onclick=()=>{
   const a=data.accounts.find(a=>accountId(a)===b.dataset.creditEdit),form=view.querySelector('#creditCustomerForm');editingCustomer=accountId(a);
   form.elements.namedItem('name').value=accountName(a);form.elements.phone.value=a.phone;
   form.elements.amount.closest('label').hidden=true;form.querySelector('button[type="submit"]').textContent='Save customer';
   view.querySelector('#creditCustomerTitle').textContent='Edit customer';view.querySelector('#creditCustomerPanel').hidden=false;
   form.elements.namedItem('name').focus();
  });
 }
 function renderClosing(){
  const area=view.querySelector('#creditClosingPanel');if(!closingData){area.innerHTML='';return;}
  const state=closingData.month_states.find(s=>s.outlet_id===outlet&&s.period_month===closingMonth+'-01');
  area.innerHTML='<section class="biz-section credit-closing"><div class="biz-section-heading"><h3>Monthly closing · '+(isCustomer?'Customers':'Vendors')+'</h3><button id="creditClosePanel" class="ghost" type="button">Cancel</button></div><label class="credit-month-label">Month<input id="creditClosingMonth" type="month" max="'+shiftMonth(currentMonth,-1)+'" value="'+closingMonth+'" required></label>'+
   (state?.status==='CLOSED'?'<p class="notice">'+esc(closingMonth)+' · Closed</p><form id="creditReopenForm" class="credit-simple-form"><label>Reason<input name="note" minlength="3" maxlength="500" required></label><button class="secondary" type="submit">Reopen month</button><p class="form-error" role="status"></p></form>':
   '<form id="creditClosingForm" class="credit-closing-form"><div class="credit-closing-list">'+closingData.accounts.map(a=>'<div class="credit-closing-row"><div><strong>'+esc(accountName(a))+'</strong>'+(isCustomer?'<small>'+esc(a.phone)+'</small>':'')+'</div>'+(!isCustomer?'<label>Balance<select name="side_'+accountId(a)+'">'+option('pay','To pay')+option('receive','Vendor credit')+'</select></label>':'')+'<label>Confirmed amount<input name="amount_'+accountId(a)+'" type="number" min="0" max="999999999999.99" step="0.01" required value="'+(a.balance===null?'':Math.abs(Number(a.balance)))+'" placeholder="Enter amount"></label></div>').join('')+'</div><label>Closing note<input name="note" minlength="3" maxlength="500" required></label><label class="credit-confirm-check"><input name="confirmed" type="checkbox" required>All balances confirmed</label><button class="primary" type="submit">Close month</button><p class="form-error" role="status"></p></form>')+'</section>';
  area.querySelector('#creditClosePanel').onclick=()=>{closingData=null;renderClosing();};
  area.querySelector('#creditClosingMonth').onchange=e=>{if(e.target.value&&e.target.value<currentMonth)loadClosing(e.target.value);};
  const form=area.querySelector('#creditClosingForm');
  if(form){
   if(!isCustomer)for(const a of closingData.accounts)form.elements.namedItem('side_'+accountId(a)).value=Number(a.balance)<0?'receive':'pay';
   form.onsubmit=e=>{e.preventDefault();const balances=closingData.accounts.map(a=>({[ledger+'_id']:accountId(a),balance:Number(form.elements.namedItem('amount_'+accountId(a)).value)*(!isCustomer&&form.elements.namedItem('side_'+accountId(a)).value==='receive'?-1:1)}));save(form,'CLOSE',{month:closingMonth+'-01',balances,note:form.elements.note.value},closingData.revision);};
  }
  const reopen=area.querySelector('#creditReopenForm');if(reopen)reopen.onsubmit=e=>{e.preventDefault();save(reopen,'REOPEN',{month:closingMonth+'-01',note:reopen.elements.note.value},closingData.revision);};
 }
 async function loadClosing(month=closingMonth){
  const request={};view._creditsClosingRequest=request;closingMonth=month;const area=view.querySelector('#creditClosingPanel');area.innerHTML='<p class="section-help">Loading…</p>';
  const r=await client.rpc('get_'+ledger+'_credits',{p_outlet_id:outlet,p_month:month+'-01'});
  if(view._creditsRequest!==token||view._creditsClosingRequest!==request)return;
  if(r.error||!r.data){area.innerHTML='<p class="form-error">'+esc(r.error?.message||'Unable to load balances.')+'</p>';return;}
  closingData=r.data;renderClosing();area.scrollIntoView?.({block:'start',behavior:'smooth'});
 }
 const parties=isCustomer?data.customers:data.vendors;
 view.innerHTML='<div class="business-dashboard vendor-credits"><header class="biz-heading"><div><span class="eyebrow">'+esc(outlet?data.outlets[0]?.name:'All cafés')+'</span><h2>Credits</h2></div><div class="biz-date-controls"><label>Month<input id="creditReportingMonth" type="month" value="'+selectedMonth+'" max="'+currentMonth+'"></label><button id="creditRefresh" class="ghost" type="button">Refresh</button></div></header>'+
  (message?'<p class="notice" role="status">'+esc(message)+'</p>':'')+
  '<section class="biz-kpi-grid credit-kpis"><article class="biz-kpi hero"><span>To pay · Vendors</span><strong>'+money(totals.toPay)+'</strong>'+(totals.unknown?'<small>'+totals.unknown+' unconfirmed</small>':'')+'</article><article class="biz-kpi profit"><span>To receive · Customers</span><strong>'+money(totals.toReceive)+'</strong></article></section>'+
  '<div class="credit-tabs" role="tablist" aria-label="Credit accounts"><button type="button" data-credit-tab="pay" role="tab" aria-selected="'+!isCustomer+'">To pay</button><button type="button" data-credit-tab="receive" role="tab" aria-selected="'+isCustomer+'">To receive</button></div>'+
  (outlet?'<div class="credit-toolbar">'+(isCustomer?'<button id="creditOpenCustomer" class="primary" type="button">Add customer</button>':'')+'<button id="creditOpenMovement" class="secondary" type="button">'+(isCustomer?'Record credit / payment':'Record entry')+'</button><button id="creditOpenClosing" class="secondary" type="button">Monthly closing</button></div>':'<p class="notice">Select a café to edit credits.</p>')+
  '<div id="creditClosingPanel"></div>'+
  (isCustomer&&outlet?'<section id="creditCustomerPanel" class="biz-section" hidden><h3 id="creditCustomerTitle">Add customer</h3><form id="creditCustomerForm" class="credit-movement-form"><label>Name<input name="name" autocomplete="name" minlength="2" maxlength="100" required></label><label>Phone number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" required></label><label>Opening credit<input name="amount" type="number" min="0" max="999999999999.99" step="0.01" value="0" required></label><div class="credit-form-buttons"><button class="primary" type="submit">Add customer</button><button id="creditCancelCustomer" class="ghost" type="button">Cancel</button></div><p class="form-error" role="status"></p></form></section>':'')+
  (outlet?'<section id="creditMovementPanel" class="biz-section" hidden><h3>'+(isCustomer?'Credit / payment':'Vendor entry')+'</h3><form id="creditMovementForm" class="credit-movement-form"><label>'+(isCustomer?'Customer':'Vendor')+'<select name="'+ledger+'_id" required>'+option('','Select '+ledger)+parties.map(p=>option(p.id,p.name+(isCustomer?' · '+p.phone:''))).join('')+'</select></label><label>Type<select name="kind">'+Object.entries(labels).map(([k,v])=>option(k,v)).join('')+'</select></label><label>Date<input name="business_date" type="date" max="'+data.business_day+'" value="'+data.business_day+'" required></label><label>Amount<input name="amount" type="number" min="0.01" max="999999999999.99" step="0.01" required></label><label class="credit-note-field">Reference / note<input name="note" minlength="3" maxlength="500" required></label><div class="credit-form-buttons"><button class="primary" type="submit">Save entry</button><button id="creditCancelMovement" class="ghost" type="button">Cancel</button></div><p class="form-error" role="status"></p></form></section>':'')+
  '<section class="biz-section"><div class="biz-section-heading"><div><h3>'+(isCustomer?'Credit customers':'Vendors')+'</h3>'+(lastClosed?'<small>Closed '+esc(lastClosed.slice(0,7))+'</small>':'')+'</div><label class="credit-search">Search<input id="creditAccountSearch" type="search" placeholder="'+(isCustomer?'Name or phone':'Vendor')+'"></label></div><div id="creditAccountRows" class="credit-account-list"></div></section>'+
  '<section class="biz-section"><h3>Entries · '+esc(selectedMonth)+'</h3><div class="credit-entry-list">'+(data.movements.length?data.movements.map(m=>'<article class="credit-entry '+(m.voided_at?'credit-voided':'')+'"><div class="credit-entry-main"><strong>'+esc(accountName(m))+'</strong><small>'+esc(m.business_date)+' · '+esc(labels[m.kind]||m.kind)+(m.voided_at?' · Voided':'')+'</small>'+(!outlet?'<small>'+esc(m.outlet_name)+'</small>':'')+'<p>'+esc(m.note)+'</p>'+(m.void_reason?'<small>'+esc(m.void_reason)+'</small>':'')+'</div><div class="credit-account-balance"><strong>'+money(m.amount)+'</strong>'+(outlet&&!m.voided_at&&(!lastClosed||m.business_date>monthEnd(lastClosed.slice(0,7)))?'<button type="button" class="ghost" data-credit-void="'+esc(m.id)+'">Correct</button>':'')+'</div></article>').join(''):'<p class="section-help">No entries this month.</p>')+'</div>'+
  (outlet?'<form id="creditVoidForm" class="credit-simple-form" hidden><label>Correction reason<input name="note" minlength="3" maxlength="500" required></label><button class="secondary" type="submit">Void entry</button><button id="creditCancelVoid" class="ghost" type="button">Cancel</button><p class="form-error" role="status"></p></form>':'')+'</section>'+
  '<details class="biz-methodology"><summary>How credits work</summary><p>To pay contains supplier balances. To receive contains credit customers. Vendor credits and refunds stay with the vendor account and never count as customer receivables.</p><p>Add a customer with their name, phone and opening credit. Credit sales increase the amount owed; payments reduce it. Enter zero for a settled account. Payments cannot exceed the customer’s balance. Credits entries do not create sales or expenses in Daily Summary; record those there separately.</p><p>Confirm month-end balances for vendors and customers separately. A closing carries the confirmed balances forward with later entries. Unconfirmed vendor balances are excluded from totals. Reopen the latest closed month before correcting its entries, then confirm it again. Every change retains its history.</p></details></div>';
 renderRows();
 view.querySelector('#creditRefresh').onclick=refresh;
 view.querySelector('#creditReportingMonth').onchange=e=>{if(e.target.value&&e.target.value<=currentMonth){profile._creditsMonth=e.target.value;refresh();}};
 view.querySelector('#creditAccountSearch').oninput=e=>{search=e.target.value.trim().toLowerCase();renderRows();};
 view.querySelectorAll('[data-credit-tab]').forEach(b=>b.onclick=()=>{profile._creditsMode=b.dataset.creditTab;refresh();});
 view.querySelector('#creditOpenClosing')?.addEventListener('click',()=>loadClosing());
 view.querySelector('#creditOpenMovement')?.addEventListener('click',()=>{view.querySelector('#creditMovementPanel').hidden=false;view.querySelector('#creditMovementPanel').scrollIntoView?.({block:'start',behavior:'smooth'});});
 view.querySelector('#creditCancelMovement')?.addEventListener('click',()=>{view.querySelector('#creditMovementPanel').hidden=true;});
 const mf=view.querySelector('#creditMovementForm');if(mf)mf.onsubmit=e=>{e.preventDefault();save(mf,'MOVEMENT',{[ledger+'_id']:isCustomer?mf.elements.customer_id.value:Number(mf.elements.vendor_id.value),business_date:mf.elements.business_date.value,kind:mf.elements.kind.value,amount:Number(mf.elements.amount.value),note:mf.elements.note.value});};
 const cf=view.querySelector('#creditCustomerForm');
 if(cf){
  view.querySelector('#creditOpenCustomer').onclick=()=>{editingCustomer=null;cf.reset();cf.elements.amount.closest('label').hidden=false;cf.querySelector('button[type="submit"]').textContent='Add customer';view.querySelector('#creditCustomerTitle').textContent='Add customer';view.querySelector('#creditCustomerPanel').hidden=false;cf.elements.namedItem('name').focus();};
  view.querySelector('#creditCancelCustomer').onclick=()=>{view.querySelector('#creditCustomerPanel').hidden=true;};
  cf.onsubmit=e=>{e.preventDefault();if(!/^[+0-9 ()-]+$/.test(cf.elements.phone.value)||cf.elements.phone.value.replace(/\D/g,'').length<7||cf.elements.phone.value.replace(/\D/g,'').length>15){cf.querySelector('[role="status"]').textContent='Enter a valid phone number.';return;}save(cf,editingCustomer?'EDIT_CUSTOMER':'CUSTOMER',{...(editingCustomer?{customer_id:editingCustomer}: {amount:Number(cf.elements.amount.value)}),name:cf.elements.namedItem('name').value.trim(),phone:cf.elements.phone.value.trim(),note:editingCustomer?'Customer details updated':'Opening customer credit'});};
 }
 const vf=view.querySelector('#creditVoidForm');if(vf){view.querySelectorAll('[data-credit-void]').forEach(b=>b.onclick=()=>{selectedMovement=b.dataset.creditVoid;vf.hidden=false;vf.elements.note.focus();});view.querySelector('#creditCancelVoid').onclick=()=>{vf.hidden=true;};vf.onsubmit=e=>{e.preventDefault();if(selectedMovement)save(vf,'VOID',{movement_id:selectedMovement,note:vf.elements.note.value});};}
}
