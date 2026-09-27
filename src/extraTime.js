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
  let tab='request',manual={CHICKEN_PATTY:[],SNACKS:[],JUICES:[]},lastSaved=[];
  const rateKey=category=>'cafetracker-transfer-rate:'+category;
  const getRate=category=>{const saved=Number(localStorage.getItem(rateKey(category)));return saved>0?saved:(category==='CHICKEN_PATTY'?20:category==='SNACKS'?2:0);};
  const setRate=(category,value)=>localStorage.setItem(rateKey(category),String(value));

  view.innerHTML=`
    <div class="extra-time-page">
      <div class="compact-heading"><span class="eyebrow">Inter-café preparation</span><h2>Transfers</h2><p>${esc(outletMap.get(outletId)||'Café')}</p></div>
      <div class="extra-time-toggle"><button class="active" data-et-tab="request">Request</button><button data-et-tab="dispatch">Dispatch</button><button data-et-tab="receive">Receive</button></div>
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
    const {data:awaitingReceipt}=await supabase.from('extra_time_requests').select('id,request_group,source_outlet_id,category,item_name,requested_qty,unit').eq('request_outlet_id',outletId).eq('status','DISPATCHED').order('requested_at',{ascending:false});
    const receiptGroups=new Map();
    (awaitingReceipt||[]).forEach(r=>{if(!receiptGroups.has(r.request_group))receiptGroups.set(r.request_group,[]);receiptGroups.get(r.request_group).push(r);});
    const receiptHtml=[...receiptGroups.values()].map(items=>`<div class="extra-time-receipt" data-receipt-ids="${items.map(x=>x.id).join(',')}"><div><strong>Incoming from ${esc(outletMap.get(Number(items[0].source_outlet_id))||'Café')}</strong><small>${items.map(x=>esc(x.item_name)+' '+Number(x.requested_qty)+' '+esc(x.unit)).join(' · ')}</small></div><button type="button" class="secondary receipt-confirm">Received ✓</button></div>`).join('');
    panel.innerHTML=`
      <div class="extra-time-note">Enter only what this café needs. Saving creates the request; WhatsApp is optional.</div>
      ${['CHICKEN_PATTY','SNACKS','JUICES'].map(requestSection).join('')}
      ${receiptHtml?`<div class="extra-time-receipts"><span class="eyebrow">Awaiting receipt</span>${receiptHtml}</div>`:''}
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
    panel.querySelectorAll('.receipt-confirm').forEach(btn=>btn.onclick=async()=>{
      const row=btn.closest('.extra-time-receipt'),ids=row.dataset.receiptIds.split(',').map(Number);
      btn.disabled=true;btn.textContent='Saving…';
      const {error}=await supabase.from('extra_time_requests').update({status:'RECEIVED',received_at:new Date().toISOString()}).in('id',ids);
      if(error){btn.disabled=false;btn.textContent='Received ✓';alert(error.message);return;}
      row.remove();
    });
  }

  async function saveRequest(){
    const status=panel.querySelector('#extraTimeStatus'),btn=panel.querySelector('#saveExtraRequest');
    const entered=[...panel.querySelectorAll('[data-et-request]')].map(i=>({category:i.dataset.category,item_name:i.dataset.name,unit:i.dataset.unit,requested_qty:i.dataset.category==='CHICKEN_PATTY'?(i.checked?1:0):Number(i.value||0)})).filter(x=>x.requested_qty>0);
    if(!entered.length){status.textContent='Choose at least one item.';status.hidden=false;return;}
    const invalid=entered.find(x=>sourceForItem(x.category,x.item_name)===outletId);
    if(invalid){status.textContent=labels[invalid.category]+' is prepared at this café, so it does not need an inter-café request.';status.hidden=false;return;}
    btn.disabled=true;btn.textContent='Saving…';status.hidden=true;
    const group=crypto.randomUUID();
    const rows=entered.map(x=>({...x,request_group:group,request_outlet_id:outletId,source_outlet_id:sourceForItem(x.category,x.item_name),requested_by:profile.id,status:'REQUESTED'}));
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
        <div class="extra-time-dispatch-head"><div><span>${labels[cat]}</span><strong>To ${esc(outletMap.get(Number(first.request_outlet_id))||'Café')}</strong></div><small>${new Date(first.requested_at).toLocaleString()}</small></div>
        <div class="extra-time-dispatch-lines">${items.map(r=>`<div class="extra-time-dispatch-line" data-request-id="${r.id}"><span>${esc(r.item_name)} <small>Requested ${Number(r.requested_qty)} ${esc(r.unit)}</small></span><input class="dispatch-qty" type="number" min="0.01" step="0.01" inputmode="decimal" value="${Number(r.requested_qty)}"><em>${esc(r.unit)}</em></div>`).join('')}</div>
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
    if(cat!=='JUICES')setRate(cat,prepRate);
    if(cat!=='JUICES'&&prepQty<=0){status.textContent='Enter the preparation quantity used for Transfers payment.';status.hidden=false;return;}
    const lines=[...card.querySelectorAll('.extra-time-dispatch-line')].map(r=>({request_id:Number(r.dataset.requestId),qty:Number(r.querySelector('.dispatch-qty').value||0),unit:r.querySelector('em').textContent}));
    if(lines.some(x=>x.qty<=0)){status.textContent='Dispatch quantities must be greater than zero.';status.hidden=false;return;}
    const btn=card.querySelector('.dispatch-confirm');btn.disabled=true;btn.textContent='Dispatching…';status.hidden=true;
    const dispatchRows=lines.map((x,i)=>({request_id:x.request_id,prepared_by:preparedBy,prep_qty:i===0?prepQty:null,prep_unit:i===0&&prepQty?(cat==='CHICKEN_PATTY'?'Chicken':'Pc'):null,dispatched_qty:x.qty,dispatch_unit:x.unit,dispatched_by:profile.id}));
    const {data:dispatches,error}=await supabase.from('extra_time_dispatches').insert(dispatchRows).select('id,request_id,dispatched_qty,dispatch_unit');
    if(error){btn.disabled=false;btn.textContent='Confirm & Dispatch';status.textContent=error.message;status.hidden=false;return;}
    const ids=lines.map(x=>x.request_id);
    const {error:updateError}=await supabase.from('extra_time_requests').update({status:'DISPATCHED'}).in('id',ids);
    if(updateError){status.textContent=updateError.message;status.hidden=false;btn.disabled=false;btn.textContent='Confirm & Dispatch';return;}
    if(cat!=='JUICES'&&dispatches?.length){
      const {error:payError}=await supabase.from('extra_time_payments').insert({dispatch_id:dispatches[0].id,staff_user_id:preparedBy,category:cat,basis_qty:prepQty,basis_unit:cat==='CHICKEN_PATTY'?'Chicken':'Pc',rate:prepRate,status:'READY'});
      if(payError){status.textContent='Dispatched, but payment entry needs attention: '+payError.message;status.hidden=false;}
    }
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

  async function draw(){if(tab==='request')await drawRequest();else await drawDispatch();}
  draw();
}
