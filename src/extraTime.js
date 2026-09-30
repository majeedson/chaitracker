import './extraTime.css';

export async function renderExtraTime(view, supabase, profile, {escapeHtml, icon} = {}) {
  const esc = escapeHtml || (v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  if(profile.access_class==='ADMIN'&&!profile.context_outlet_id){
    view.innerHTML='<span class="eyebrow">Transfers</span><h2>Select a café</h2><p class="section-help">Choose a café from the top bar to request or dispatch prepared items.</p>'; return;
  }
  const outletId=Number(profile.context_outlet_id||profile.outlet_id);
  const [{data:outlets},{data:staffUsers}]=await Promise.all([
    supabase.from('outlets').select('id,name').order('id'),
    supabase.from('users').select('id,name,outlet_id,active,staff_id').eq('active',true).order('name')
  ]);
  const outletMap=new Map((outlets||[]).map(o=>[Number(o.id),o.name]));
  const itemSource={Rumali:2,Samosa:1,Cutlet:1};
  const sourceForItem=(category,name)=>category==='CHICKEN_PATTY'?2:category==='JUICES'?6:(itemSource[name]||1);
  const defaults={
    CHICKEN_PATTY:[['Tikka','g'],['Finger','Pc'],['Crispcross','Pc'],['Firehouse','Pc'],['Fried','Pc'],['Boiled Chicken','g'],['Kheema','g'],['Wings','Pc']],
    SNACKS:[['Samosa','Pc'],['Cutlet','Pc'],['Rumali','Pc']],
    JUICES:[['Watermelon','Pc'],['Lime','Pc'],['Kulukki','Pc'],['Kannur Cocktail','Pc']]
  };
  const labels={CHICKEN_PATTY:'Chicken Patty',SNACKS:'Snacks',JUICES:'Juices'};
  const isReviewer=profile.access_class==='ADMIN'||['Manager','Ops Manager'].includes(profile.role);
  const displayQty=r=>r.category==='CHICKEN_PATTY'?'Quantity decided at dispatch':`${Number(r.requested_qty)} ${r.unit} requested`;
  const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2});
  let tab='request',manual={CHICKEN_PATTY:[],SNACKS:[],JUICES:[]},lastSaved=[];
  const rateKey=category=>'cafetracker-transfer-rate:'+category;
  const getRate=category=>{const saved=localStorage.getItem(rateKey(category));return saved!==null&&Number.isFinite(Number(saved))?Number(saved):(category==='CHICKEN_PATTY'?20:category==='SNACKS'?2:0);};
  const setRate=(category,value)=>localStorage.setItem(rateKey(category),String(value));

  view.innerHTML=`
    <div class="extra-time-page ${isReviewer?'has-payments':''}">
      <div class="compact-heading"><span class="eyebrow">Inter-café preparation</span><h2>Transfers</h2><p>${esc(outletMap.get(outletId)||'Café')}</p></div>
      <div class="extra-time-toggle"><button class="active" data-et-tab="request">Request</button><button data-et-tab="dispatch">Dispatch</button><button data-et-tab="receive">Receive</button>${isReviewer?'<button data-et-tab="payments">Payments</button>':''}</div>
      <div id="extraTimePanel"></div>
    </div>`;
  const panel=view.querySelector('#extraTimePanel');
  view.querySelectorAll('[data-et-tab]').forEach(btn=>btn.onclick=()=>{tab=btn.dataset.etTab;view.querySelectorAll('[data-et-tab]').forEach(b=>b.classList.toggle('active',b===btn));draw();});

  const requestRows=category=>[...defaults[category],...manual[category]].filter(([name])=>sourceForItem(category,name)!==outletId).map(([name,unit])=>category==='CHICKEN_PATTY'?`<label class="extra-time-item request-choice"><div><strong>${esc(name)}</strong><small>Request preparation</small></div><input type="checkbox" data-et-request data-category="${category}" data-name="${esc(name)}" data-unit="${esc(unit)}"></label>`:`<div class="extra-time-item"><div><strong>${esc(name)}</strong><small>${esc(unit)}</small></div><input type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" data-et-request data-category="${category}" data-name="${esc(name)}" data-unit="${esc(unit)}"></div>`).join('');

  const requestSection=category=>{
    const available=[...defaults[category],...manual[category]].filter(([name])=>sourceForItem(category,name)!==outletId); if(!available.length)return ''; const sources=[...new Set(available.map(([name])=>sourceForItem(category,name)))],source=sources[0],same=false;
    return `<details class="extra-time-section" ${category==='CHICKEN_PATTY'?'open':''}>
      <summary><span><strong>${labels[category]}</strong><small>${sources.length===1?'From '+esc(outletMap.get(source)||'source café'):'Prepared at different cafés'}</small></span><b>›</b></summary>
      <div class="extra-time-body">${requestRows(category)}
        <button class="extra-time-add" type="button" data-et-add="${category}">＋ Add Item</button>
      </div>
    </details>`;
  };

  async function drawRequest(){
    panel.innerHTML=`
      <div class="extra-time-note">Enter only what this café needs. Saving creates the request; WhatsApp is optional.</div>
      ${['CHICKEN_PATTY','SNACKS','JUICES'].map(requestSection).join('')}
      <div class="extra-time-actions"><button id="saveExtraRequest" class="primary full">Save Request</button><button id="generateExtraRequest" class="secondary full" ${lastSaved.length?'':'disabled'}>Generate Message</button></div>
      <div id="extraRequestMessage" class="whatsapp-preview" hidden><div class="whatsapp-preview-head"><strong>Request message</strong><button id="copyExtraRequest" class="summary-add" type="button">Copy</button></div><textarea readonly></textarea></div>
      <p id="extraTimeStatus" class="form-error" hidden></p>`;
    panel.querySelectorAll('[data-et-add]').forEach(btn=>btn.onclick=()=>{
      const name=prompt('Item name'); if(!name?.trim()) return;
      const unit=prompt('Unit (Pc, g, kg, Bottle...)','Pc')||'Pc';
      manual[btn.dataset.etAdd].push([name.trim(),unit.trim()||'Pc']); drawRequest();
    });
    panel.querySelector('#saveExtraRequest').onclick=saveRequest;
    panel.querySelector('#generateExtraRequest').onclick=generateRequestMessage;
  }

  async function saveRequest(){
    const status=panel.querySelector('#extraTimeStatus'),btn=panel.querySelector('#saveExtraRequest');
    const entered=[...panel.querySelectorAll('[data-et-request]')].map(i=>({category:i.dataset.category,item_name:i.dataset.name,unit:i.dataset.unit,requested_qty:i.dataset.category==='CHICKEN_PATTY'?null:Number(i.value||0),selected:i.dataset.category==='CHICKEN_PATTY'?i.checked:Number(i.value||0)>0})).filter(x=>x.selected);
    if(!entered.length){status.textContent='Choose at least one item.';status.hidden=false;return;}
    const invalid=entered.find(x=>sourceForItem(x.category,x.item_name)===outletId);
    if(invalid){status.textContent=labels[invalid.category]+' is prepared at this café, so it does not need an inter-café request.';status.hidden=false;return;}
    btn.disabled=true;btn.textContent='Saving…';status.hidden=true;
    const group=crypto.randomUUID();
    const rows=entered.map(({selected,...x})=>({...x,request_group:group,request_outlet_id:outletId,source_outlet_id:sourceForItem(x.category,x.item_name),requested_by:profile.id,status:'REQUESTED'}));
    const {data,error}=await supabase.from('extra_time_requests').insert(rows).select('id,request_group,source_outlet_id,category,item_name,requested_qty,unit');
    btn.disabled=false;btn.textContent='Save Request';
    if(error){status.textContent=error.message;status.hidden=false;return;}
    lastSaved=data||[];status.textContent='Request saved ✓';status.className='summary-inline-status ok';status.hidden=false;
    panel.querySelector('#generateExtraRequest').disabled=false;
  }

  function generateRequestMessage(){
    if(!lastSaved.length)return;
    const bySource=new Map();
    lastSaved.forEach(r=>{if(!bySource.has(r.source_outlet_id))bySource.set(r.source_outlet_id,[]);bySource.get(r.source_outlet_id).push(r);});
    const text=[...bySource.entries()].map(([source,rows])=>`Transfers Request\n${outletMap.get(outletId)||'Café'} → ${outletMap.get(Number(source))||'Preparing café'}\n`+rows.map(r=>r.category==='CHICKEN_PATTY'?`• ${r.item_name}`:`• ${r.item_name}: ${Number(r.requested_qty)} ${r.unit}`).join('\n')).join('\n\n');
    const box=panel.querySelector('#extraRequestMessage');box.hidden=false;box.querySelector('textarea').value=text;
    box.querySelector('#copyExtraRequest').onclick=async()=>{await navigator.clipboard.writeText(text);box.querySelector('#copyExtraRequest').textContent='Copied ✓';};
  }

  async function drawDispatch(){
    panel.innerHTML='<div class="loading">Loading requests…</div>';
    const {data,error}=await supabase.from('extra_time_requests').select('*').eq('source_outlet_id',outletId).eq('status','REQUESTED').order('requested_at',{ascending:true});
    if(error){panel.innerHTML='<p class="form-error">'+esc(error.message)+'</p>';return;}
    const rows=data||[];
    if(!rows.length){panel.innerHTML='<div class="extra-time-empty"><strong>No pending requests</strong><span>Incoming requests for this café will appear here.</span></div>';return;}
    const groups=new Map();
    rows.forEach(r=>{const key=r.request_group+'|'+r.category;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);});
    panel.innerHTML=[...groups.entries()].map(([key,items])=>{
      const first=items[0],cat=first.category,staff=(staffUsers||[]).filter(u=>Number(u.outlet_id)===outletId),pay=cat!=='JUICES';
      return `<section class="extra-time-dispatch" data-et-group="${esc(key)}" data-category="${cat}">
        <div class="extra-time-dispatch-head"><div><span>${labels[cat]}</span><strong>To ${esc(outletMap.get(Number(first.request_outlet_id))||'Café')}</strong></div><small>Ordered ${new Date(first.requested_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small></div>
        <div class="extra-time-dispatch-lines">${items.map(r=>`<div class="extra-time-dispatch-line" data-request-id="${r.id}"><span>${esc(r.item_name)} <small>${esc(displayQty(r))}</small></span><input class="dispatch-qty" aria-label="${esc(r.item_name)} prepared" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0" value="${r.category==='CHICKEN_PATTY'?'':Number(r.requested_qty)}"><em>${esc(r.unit)}</em></div>`).join('')}</div>
        <label class="extra-time-field">Prepared by<select class="prepared-by"><option value="">Select staff</option>${staff.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        ${pay?`<div class="extra-time-pay-basis"><label>${cat==='CHICKEN_PATTY'?'Whole chickens processed':'Pieces prepared'}<input class="prep-qty" type="number" min="0" step="1" inputmode="decimal" placeholder="0"></label><label>Rate ₹<input class="prep-rate" type="number" min="0" step="0.01" inputmode="decimal" value="${getRate(cat)}"></label><span>${cat==='CHICKEN_PATTY'?'Chicken':'Pc'} · payment basis</span></div>`:'<div class="extra-time-note compact">Juice dispatch is tracked without a preparation payment entry.</div>'}
        <div class="extra-time-actions inline"><button class="primary dispatch-confirm" type="button">Confirm & Dispatch</button><button class="secondary dispatch-message" type="button" disabled>Generate Message</button></div>
        <div class="dispatch-preview whatsapp-preview" hidden><div class="whatsapp-preview-head"><strong>Dispatch message</strong><button class="summary-add copy-dispatch" type="button">Copy</button></div><textarea readonly></textarea></div>
        <p class="dispatch-status form-error" hidden></p>
      </section>`;
    }).join('');
    panel.querySelectorAll('.extra-time-dispatch').forEach(card=>{card.querySelector('.dispatch-confirm').onclick=()=>confirmDispatch(card);card.querySelector('.dispatch-message').onclick=()=>generateDispatchMessage(card);});
  }

  async function confirmDispatch(card){
    const cat=card.dataset.category,status=card.querySelector('.dispatch-status'),preparedBy=card.querySelector('.prepared-by').value;
    if(!preparedBy){status.textContent='Select who prepared this batch.';status.hidden=false;return;}
    const prepQty=cat==='JUICES'?null:Number(card.querySelector('.prep-qty')?.value||0);
    const prepRate=cat==='JUICES'?null:Number(card.querySelector('.prep-rate')?.value||0);
    if(cat!=='JUICES'&&prepRate<0){status.textContent='Rate cannot be negative.';status.hidden=false;return;}
    if(cat!=='JUICES'&&prepQty<=0){status.textContent='Enter the preparation quantity used for Transfers payment.';status.hidden=false;return;}
    if(cat==='SNACKS'&&prepQty!==[...card.querySelectorAll('.dispatch-qty')].reduce((sum,i)=>sum+Number(i.value||0),0)){status.textContent='Pieces prepared must equal the snack pieces dispatched.';status.hidden=false;return;}
    const lines=[...card.querySelectorAll('.extra-time-dispatch-line')].map(r=>({request_id:Number(r.dataset.requestId),qty:Number(r.querySelector('.dispatch-qty').value||0),unit:r.querySelector('em').textContent}));
    if(lines.some(x=>x.qty<=0)){status.textContent='Dispatch quantities must be greater than zero.';status.hidden=false;return;}
    const btn=card.querySelector('.dispatch-confirm');btn.disabled=true;btn.textContent='Dispatching…';status.hidden=true;
    const {error}=await supabase.rpc('dispatch_transfer',{p_outlet_id:outletId,p_prepared_by:preparedBy,p_lines:lines.map(x=>({request_id:x.request_id,qty:x.qty})),p_prep_qty:prepQty,p_rate:prepRate});
    if(error){btn.disabled=false;btn.textContent='Confirm & Dispatch';status.textContent=error.message;status.hidden=false;return;}
    if(cat!=='JUICES')setRate(cat,prepRate);
    card.querySelectorAll('input,select').forEach(x=>x.disabled=true);btn.textContent='Dispatched ✓';card.querySelector('.dispatch-message').disabled=false;
    if(status.hidden){status.textContent=cat==='JUICES'?'Dispatch saved ✓':'Dispatch saved ✓ · Transfers payment linked';status.className='dispatch-status summary-inline-status ok';status.hidden=false;}
  }

  function generateDispatchMessage(card){
    const destination=card.querySelector('.extra-time-dispatch-head strong').textContent.replace(/^To /,'');
    const lines=[...card.querySelectorAll('.extra-time-dispatch-line')].map(r=>`• ${r.querySelector('span').childNodes[0].textContent.trim()}: ${Number(r.querySelector('.dispatch-qty').value)} ${r.querySelector('em').textContent}`);
    const text=`Transfers Dispatch\n${outletMap.get(outletId)||'Café'} → ${destination}\n${lines.join('\n')}\nDispatched ✓`;
    const box=card.querySelector('.dispatch-preview');box.hidden=false;box.querySelector('textarea').value=text;
    box.querySelector('.copy-dispatch').onclick=async()=>{await navigator.clipboard.writeText(text);box.querySelector('.copy-dispatch').textContent='Copied ✓';};
  }

  async function drawReceive(){
    panel.innerHTML='<div class="loading">Loading incoming transfers…</div>';
    const {data:requests,error}=await supabase.from('extra_time_requests').select('id,request_group,source_outlet_id,category,item_name,requested_at,extra_time_dispatches(id,dispatched_qty,dispatch_unit,dispatched_at)').eq('request_outlet_id',outletId).eq('status','DISPATCHED').order('requested_at',{ascending:true});
    if(error){panel.innerHTML=`<p class="form-error">${esc(error.message)}</p>`;return;}
    const groups=new Map();(requests||[]).forEach(r=>{const key=`${r.request_group}|${r.source_outlet_id}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);});
    if(!groups.size){panel.innerHTML='<div class="extra-time-empty"><strong>Nothing awaiting receipt</strong><span>Dispatched items will appear here.</span></div>';return;}
    panel.innerHTML='<div class="extra-time-note">Check what arrived against the dispatched quantities. Enter 0 for an item that did not arrive and add a note for any difference.</div>'+[...groups.values()].map(items=>`<section class="extra-time-dispatch receive-card"><div class="extra-time-dispatch-head"><div><span>Awaiting receipt</span><strong>From ${esc(outletMap.get(Number(items[0].source_outlet_id))||'Café')}</strong></div><small>Requested ${new Date(items[0].requested_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small></div><div class="extra-time-dispatch-lines">${items.map(r=>{const d=r.extra_time_dispatches?.[0];return `<div class="extra-time-dispatch-line" data-request-id="${r.id}" data-expected="${d?Number(d.dispatched_qty):''}"><span>${esc(r.item_name)}<small>Dispatched ${d?Number(d.dispatched_qty):'—'} ${esc(d?.dispatch_unit||'')}</small></span><input class="received-qty" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${esc(r.item_name)} received" value="${d?Number(d.dispatched_qty):''}"><em>${esc(d?.dispatch_unit||'')}</em></div>`}).join('')}</div><label class="extra-time-field">Difference or delivery note<input class="receipt-note" type="text" placeholder="Optional when everything matches"></label><button class="primary receive-confirm" type="button">Confirm Received</button><p class="dispatch-status form-error" hidden></p></section>`).join('');
    panel.querySelectorAll('.receive-card').forEach(card=>card.querySelector('.receive-confirm').onclick=()=>confirmReceipt(card));
  }

  async function confirmReceipt(card){
    const status=card.querySelector('.dispatch-status'),lines=[...card.querySelectorAll('.extra-time-dispatch-line')].map(row=>({request_id:Number(row.dataset.requestId),qty:Number(row.querySelector('.received-qty').value),entered:row.querySelector('.received-qty').value!=='' ,expected:Number(row.dataset.expected)}));
    if(lines.some(x=>!x.entered||!Number.isFinite(x.qty)||x.qty<0||!Number.isFinite(x.expected))){status.textContent='Enter valid received quantities for every item.';status.hidden=false;return;}
    const note=card.querySelector('.receipt-note').value.trim();
    if(lines.some(x=>x.qty!==x.expected)&&!note){status.textContent='Add a note explaining the difference.';status.hidden=false;return;}
    const btn=card.querySelector('.receive-confirm');btn.disabled=true;btn.textContent='Saving…';status.hidden=true;
    const {error}=await supabase.rpc('receive_transfer',{p_outlet_id:outletId,p_lines:lines.map(x=>({request_id:x.request_id,qty:x.qty})),p_note:note||null});
    if(error){status.textContent=error.message;status.hidden=false;btn.disabled=false;btn.textContent='Confirm Received';return;}
    card.remove();if(!panel.querySelector('.receive-card'))drawReceive();
  }

  async function drawPayments(){
    panel.innerHTML='<div class="loading">Loading preparation payments…</div>';
    if(!isReviewer)return;
    const {data,error}=await supabase.from('extra_time_payments').select('id,category,basis_qty,basis_unit,rate,amount,status,staff_user_id,created_at,extra_time_dispatches!inner(dispatched_at,extra_time_requests!inner(request_group,requested_at,source_outlet_id,request_outlet_id))').order('created_at',{ascending:false}).limit(300);
    if(error){panel.innerHTML=`<p class="form-error">${esc(error.message)}</p>`;return;}
    const rows=(data||[]).filter(p=>{const r=p.extra_time_dispatches?.extra_time_requests;return Number(r?.source_outlet_id)===outletId||Number(r?.request_outlet_id)===outletId;}).sort((a,b)=>new Date(b.extra_time_dispatches.extra_time_requests.requested_at)-new Date(a.extra_time_dispatches.extra_time_requests.requested_at));
    const groups=[...new Set(rows.map(p=>p.extra_time_dispatches.extra_time_requests.request_group))];
    const {data:groupItems,error:groupError}=groups.length?await supabase.from('extra_time_requests').select('request_group,category,item_name').in('request_group',groups):{data:[]};
    if(groupError){panel.innerHTML=`<p class="form-error">${esc(groupError.message)}</p>`;return;}
    const itemNames=(p)=>(groupItems||[]).filter(x=>x.request_group===p.extra_time_dispatches.extra_time_requests.request_group&&x.category===p.category).map(x=>x.item_name).join(', ');
    const names=new Map((staffUsers||[]).map(u=>[u.id,u.name]));
    panel.innerHTML='<div class="extra-time-note">Preparation payments, ordered by when the original request was sent. These are review records, not automatically added to salary.</div>'+(rows.length?rows.map(p=>{const r=p.extra_time_dispatches.extra_time_requests;return `<section class="extra-time-dispatch"><div class="extra-time-dispatch-head"><div><span>${esc(names.get(p.staff_user_id)||'Staff')} · ${esc(p.status)}</span><strong>${esc(labels[p.category]||p.category)} · ${money(p.amount)}</strong></div><small>Ordered ${new Date(r.requested_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small></div><p class="payment-details">${esc(itemNames(p))} · ${Number(p.basis_qty)} ${esc(p.basis_unit)} × ${money(p.rate)}<br>Dispatch ${new Date(p.extra_time_dispatches.dispatched_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} · ${esc(outletMap.get(Number(r.source_outlet_id))||'Café')} → ${esc(outletMap.get(Number(r.request_outlet_id))||'Café')}</p></section>`}).join(''):'<div class="extra-time-empty"><strong>No payment entries</strong></div>');
  }

  async function draw(){if(tab==='request')await drawRequest();else if(tab==='dispatch')await drawDispatch();else if(tab==='receive')await drawReceive();else await drawPayments();}
  draw();
}
