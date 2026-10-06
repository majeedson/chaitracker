import {bindItemAdder,escapeCatalogue as e} from './vendorCatalogue.js';

export async function renderVendorPurchases(view,client,profile,{outletId,businessDate,catalogue}) {
  const money=n=>Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  view.innerHTML=`<div class="section-heading"><div><span class="eyebrow">Operations</span><h2>Purchases</h2></div><span class="soft-badge">${e(businessDate)}</span></div><div class="order-quick-summary" id="purchaseQuickSummary">₹0.00 entered</div><div id="purchaseVendorCards"></div><section class="subsection"><h3>Today's purchases</h3><div id="purchaseHistory"></div></section>`;
  const cards=view.querySelector('#purchaseVendorCards');
  const updateTotals=()=>{
    let total=0;
    cards.querySelectorAll('.purchase-vendor-card').forEach(card=>{
      const invoice=card.dataset.mode==='invoice';
      const amount=invoice?Number(card.querySelector('.vendor-invoice').value||0):[...card.querySelectorAll('.vendor-purchase-row')].reduce((n,r)=>n+(r.querySelector('.purchase-include').checked?Number(r.querySelector('.purchase-amount').value||0):0),0);
      card.querySelector('.vendor-purchase-total').textContent='₹'+money(amount);
      const selected=invoice?'Invoice':[...card.querySelectorAll('.purchase-include:checked')].length+' selected';
      card.querySelector('.vendor-card-meta').textContent=selected+' · ₹'+money(amount);total+=amount;
    });view.querySelector('#purchaseQuickSummary').textContent='₹'+money(total)+' entered';
  };
  const row=item=>{
    const el=view.ownerDocument.createElement('div');el.className='vendor-purchase-row';el.dataset.id=item.item_id;
    el.innerHTML=`<label class="purchase-item-name"><input class="purchase-include" type="checkbox"><span><strong>${e(item.item_name)}</strong><small>${e(item.category_name||'Other')}${item.last_price!=null?' · Last ₹'+money(item.last_price)+'/'+e(item.unit):''}</small></span></label><label>Qty<input class="purchase-qty" type="number" inputmode="decimal" min="0" max="1000000" step="any" placeholder="0"></label><span class="purchase-unit">${e(item.unit)}</span><label>Total ₹<input class="purchase-amount" type="number" inputmode="decimal" min="0" max="1000000000" step="0.01" placeholder="0.00"></label>`;
    const qty=el.querySelector('.purchase-qty'),amount=el.querySelector('.purchase-amount'),include=el.querySelector('.purchase-include');let automatic=true;
    qty.oninput=()=>{include.checked=Number(qty.value)>0;if(automatic&&item.last_price!=null)amount.value=(Number(qty.value||0)*Number(item.last_price)).toFixed(2);updateTotals();};
    amount.oninput=()=>{automatic=amount.value==='';include.checked=true;updateTotals();};include.onchange=updateTotals;return el;
  };
  const history=async()=>{
    const {data,error}=await client.from('purchases').select('id,vendor_name,item_id,qty,unit,invoice_amount,entry_type,items(name)').eq('outlet_id',outletId).eq('business_date',businessDate).order('created_at',{ascending:false}).limit(100);
    const target=view.querySelector('#purchaseHistory');
    if(error){target.textContent=error.message;return;}
    target.innerHTML=(data||[]).filter(p=>!(catalogue.cigarette_item_ids||[]).includes(p.item_id)).map(p=>`<div class="purchase-history-line"><span><strong>${e(p.items?.name||catalogue.items.find(i=>String(i.item_id)===String(p.item_id))?.item_name||'Invoice')}</strong><small>${e(p.vendor_name)}${p.entry_type==='item'?' · '+e(p.qty)+' '+e(p.unit):''}</small></span><b>₹${money(p.invoice_amount)}</b></div>`).join('')||'<div class="notice">No purchases recorded today.</div>';
  };
  for(const vendor of catalogue.vendors){
    const card=view.ownerDocument.createElement('details');card.className='order-category-group purchase-vendor-card';card.dataset.vendorId=vendor.id;card.dataset.mode='item';
    card.innerHTML=`<summary><span><strong>${e(vendor.name)}</strong><small class="vendor-card-meta">0 selected · ₹0.00</small></span><button type="button" class="order-add-item" aria-label="Add item to ${e(vendor.name)}">+</button></summary><div class="order-category-body"><div class="purchase-tabs"><button type="button" class="purchase-tab active" data-mode="item">Items</button><button type="button" class="purchase-tab" data-mode="invoice">Invoice total</button></div><div class="vendor-items"></div><div class="vendor-invoice-area" hidden><label>Invoice total ₹<input class="vendor-invoice" type="number" inputmode="decimal" min="0" max="1000000000" step="0.01" placeholder="0.00"></label></div><div class="category-add-panel" hidden></div><div class="order-category-actions"><button class="summary-add purchase-add-item" type="button">＋ Add item</button><strong class="vendor-purchase-total">₹0.00</strong><button class="primary save-vendor-purchase" type="button">Save purchase</button></div><div class="purchase-message" role="status" hidden></div></div>`;
    const area=card.querySelector('.vendor-items'),panel=card.querySelector('.category-add-panel');
    catalogue.items.filter(i=>Number(i.vendor_id)===Number(vendor.id)).forEach(i=>area.append(row(i)));
    const add=()=>{card.open=true;panel.hidden=!panel.hidden;if(!panel.hidden){bindItemAdder(panel,{client,outletId,module:'purchase',vendor,catalogue,onAdded:async item=>{let el=[...area.children].find(r=>r.dataset.id===String(item.item_id));if(!el){el=row(item);area.append(el);}card.querySelector('[data-mode="item"]').click();el.querySelector('.purchase-include').checked=true;el.querySelector('.purchase-qty').focus();updateTotals();}});panel.querySelector('input').focus();}};
    card.querySelector('.order-add-item').onclick=event=>{event.preventDefault();event.stopPropagation();add();};card.querySelector('.purchase-add-item').onclick=add;
    card.querySelectorAll('[data-mode]').forEach(btn=>btn.onclick=()=>{card.dataset.mode=btn.dataset.mode;card.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b===btn));area.hidden=btn.dataset.mode==='invoice';card.querySelector('.vendor-invoice-area').hidden=btn.dataset.mode!=='invoice';updateTotals();});
    card.querySelector('.vendor-invoice').oninput=updateTotals;
    card.querySelector('.save-vendor-purchase').onclick=async()=>{
      const button=card.querySelector('.save-vendor-purchase'),message=card.querySelector('.order-category-body > [role="status"]');message.hidden=true;
      const selected=[...area.querySelectorAll('.vendor-purchase-row')].filter(r=>r.querySelector('.purchase-include').checked);
      const entries=card.dataset.mode==='invoice'?[{entry_type:'invoice',item_id:null,qty:0,unit:'',invoice_amount:Number(card.querySelector('.vendor-invoice').value)}]:selected.map(r=>({entry_type:'item',item_id:r.dataset.id,qty:Number(r.querySelector('.purchase-qty').value),unit:catalogue.items.find(i=>String(i.item_id)===r.dataset.id)?.unit,invoice_amount:Number(r.querySelector('.purchase-amount').value)}));
      if(!entries.length||entries.some(p=>!Number.isFinite(p.qty)||!Number.isFinite(p.invoice_amount)||p.invoice_amount<0||p.invoice_amount>1000000000||p.qty>1000000||(p.entry_type==='invoice'?p.invoice_amount<=0:p.qty<=0))){message.textContent='Enter a valid quantity for each selected item, or a positive invoice total.';message.hidden=false;return;}
      button.disabled=true;button.textContent='Saving…';card.querySelectorAll('input,button').forEach(el=>el.disabled=true);
      try{
        const {data,error}=await client.rpc('save_purchase_entries',{p_outlet_id:outletId,p_business_date:businessDate,p_user_id:profile.id,p_vendor_name:vendor.name,p_entries:entries});if(error)throw error;
        if(Number(data)!==entries.length)throw Error('Some entries could not be saved. Refresh before retrying.');
        selected.forEach(r=>{r.querySelector('.purchase-include').checked=false;r.querySelector('.purchase-qty').value='';r.querySelector('.purchase-amount').value='';});card.querySelector('.vendor-invoice').value='';
        entries.filter(p=>p.entry_type==='item'&&p.invoice_amount>0).forEach(p=>{const item=catalogue.items.find(i=>String(i.item_id)===p.item_id);item.last_price=p.invoice_amount/p.qty;});
        message.className='purchase-message success';message.textContent='Purchase saved.';message.hidden=false;updateTotals();await history();
      }catch(err){message.className='purchase-message error';message.textContent=err.message||'Could not save purchase.';message.hidden=false;}finally{card.querySelectorAll('input,button').forEach(el=>el.disabled=false);button.textContent='Save purchase';}
    };cards.append(card);
  }
  updateTotals();await history();
}
