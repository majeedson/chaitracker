export const escapeCatalogue = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Both operational screens use the same create/reuse flow. Existing items are never renamed.
export function bindItemAdder(panel, {client, outletId, module, vendor, catalogue, onAdded}) {
  const e=escapeCatalogue;
  panel.innerHTML=`<form class="catalogue-item-form"><label>Item name<input name="item_name" type="search" maxlength="150" required placeholder="Find or add item" autocomplete="off"></label><div class="catalogue-matches"></div><div class="catalogue-fields"><label>Category<select name="category_id" required><option value="">Select category</option>${catalogue.categories.map(c=>`<option value="${c.id}">${e(c.name)}</option>`).join('')}<option value="new">＋ New category</option></select></label><label>Unit<select name="unit" required>${['Pc','Pack','Box','kg','g','L','ml'].map(u=>`<option>${u}</option>`).join('')}<option value="other">Other</option></select></label></div><label class="catalogue-new-category" hidden>New category<input name="category_name" maxlength="100"></label><label class="catalogue-other-unit" hidden>Unit name<input name="custom_unit" maxlength="30"></label><div class="catalogue-actions"><button type="submit" class="secondary">Add item</button><button type="button" class="ghost catalogue-cancel">Cancel</button></div><div class="purchase-message" role="status" hidden></div></form>`;
  const form=panel.querySelector('form'),name=form.elements.item_name,results=panel.querySelector('.catalogue-matches'),message=panel.querySelector('[role="status"]');
  const notify=text=>{message.textContent=text;message.hidden=false;};
  form.elements.category_id.onchange=()=>{const newCategory=form.elements.category_id.value==='new';panel.querySelector('.catalogue-new-category').hidden=!newCategory;form.elements.category_name.required=newCategory;};
  form.elements.unit.onchange=()=>{const custom=form.elements.unit.value==='other';panel.querySelector('.catalogue-other-unit').hidden=!custom;form.elements.custom_unit.required=custom;};
  panel.querySelector('.catalogue-cancel').onclick=()=>{panel.hidden=true;};
  const finish=async item=>{await onAdded(item);panel.hidden=true;};
  name.oninput=()=>{
    const q=name.value.trim().toLowerCase();message.hidden=true;
    const matches=q?catalogue.items.filter(i=>Number(i.vendor_id)===Number(vendor.id)&&i.item_name.toLowerCase().includes(q)).slice(0,8):[];
    results.innerHTML=matches.map(i=>`<button type="button" class="category-add-result" data-id="${e(i.item_id)}"><span>${e(i.item_name)}</span><small>${e(i.category_name)} · ${e(i.unit)}</small></button>`).join('');
    results.querySelectorAll('button').forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{await finish(catalogue.items.find(i=>String(i.item_id)===btn.dataset.id));}catch(err){notify(err.message);btn.disabled=false;}});
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const button=form.querySelector('[type="submit"]');button.disabled=true;message.hidden=true;
    try {
      const existing=catalogue.items.find(i=>Number(i.vendor_id)===Number(vendor.id)&&i.item_name.trim().replace(/\s+/g,' ').toLowerCase()===name.value.trim().replace(/\s+/g,' ').toLowerCase());
      if(existing){await finish(existing);return;}
      const {data,error}=await client.rpc('add_vendor_catalogue_item',{p_outlet_id:outletId,p_module:module,p_vendor_id:Number(vendor.id),p_name:name.value.trim(),p_category_id:form.elements.category_id.value==='new'?null:Number(form.elements.category_id.value),p_category_name:form.elements.category_id.value==='new'?form.elements.category_name.value.trim():null,p_unit:form.elements.unit.value==='other'?form.elements.custom_unit.value.trim():form.elements.unit.value});
      if(error)throw error;
      const item=data;
      if(!catalogue.items.some(i=>String(i.item_id)===String(item.item_id)))catalogue.items.push(item);
      if(!catalogue.categories.some(c=>Number(c.id)===Number(item.category_id)))catalogue.categories.push({id:item.category_id,name:item.category_name});
      await finish(item);
    }catch(err){notify(err.message||'Could not add item.');}finally{button.disabled=false;}
  };
}
