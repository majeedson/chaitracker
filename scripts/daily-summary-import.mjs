// Administrative import planning only. Do not bundle source records into the app.
const key=(outlet,date)=>`${outlet}|${date}`;
const norm=s=>String(s??'').trim().toLowerCase();
function day(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s+'T12:00Z').toISOString().slice(0,10)!==s)throw Error('Invalid business date: '+s);return s;}
export function sourceTime(s){
 const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/);
 if(!m||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)throw Error('Invalid source timestamp: '+s);
 day(m.slice(1,4).join('-'));
 // Script-written timestamps are Indian café local time, independent of Sheet display timezone.
 return new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]-330,+m[6])).toISOString();
}
const amount=v=>{if(v===''||v===undefined||v===null)return null;const n=Number(v);if(!Number.isFinite(n))throw Error('Invalid amount: '+v);return Math.round(n*100)/100;};
const array=v=>{const a=JSON.parse(v||'[]');if(!Array.isArray(a))throw Error('Payment field must be an array');return a;};
const mode=v=>{const s=v||'Cash';if(!['Cash','UPI'].includes(s))throw Error('Unsupported payment mode: '+s);return s;};
function matchName(rows,name,outlet){const all=rows.filter(r=>norm(r.name)===norm(name)),local=all.filter(r=>r.outlet_id===outlet);return local.length===1?local[0]:all.length===1?all[0]:null;}
const numberFields={cash_sale:'CashSale',upi_sale:'UPISale',own_digital:'OwnDigital',discount:'Discount',net_sale:'NetSale',swiggy_payout:'SwiggyPayout',zomato_payout:'ZomatoPayout',opening_cash_system:'OpeningCashSystem',opening_cash_actual:'OpeningCashActual',physical_cash:'PhysicalCash',expected_cash:'ExpectedCash',short_excess:'ShortExcess'};
export function buildSummaryImport({values,database,staffPaymentValues=[],asOf}){
 const headers=values[0],source=values.slice(1).map((v,i)=>({...Object.fromEntries(headers.map((h,j)=>[h,v[j]??''])),_row:i+2})).filter(r=>r.SummaryID);
 const ids=new Map(),groups=new Map(),outlets=new Map(database.outlets.map(o=>[norm(o.name),o.id]));
 for(const r of source){day(r.BusinessDate);if(asOf&&r.BusinessDate>=asOf)throw Error('Unfinished/future business date: '+r.BusinessDate);r._time=sourceTime(r.Timestamp);if(ids.has(r.SummaryID))throw Error('Repeated SummaryID: '+r.SummaryID);ids.set(r.SummaryID,r);const k=key(norm(r.Outlet),r.BusinessDate),g=groups.get(k)||[];g.push(r);groups.set(k,g);}
 const ph=staffPaymentValues[0]||[],payments=staffPaymentValues.slice(1).map(v=>Object.fromEntries(ph.map((h,j)=>[h,v[j]??''])));
 const planned=[],used=new Set();
 for(const group of groups.values()){
  const winner=group.slice().sort((a,b)=>a._time.localeCompare(b._time)||a._row-b._row).at(-1),outlet=outlets.get(norm(winner.Outlet));
  if(!outlet)throw Error('Unknown outlet: '+winner.Outlet);
  const legacy=database.summaries.filter(d=>{const s=ids.get(d.id);return s&&norm(s.Outlet)===norm(winner.Outlet)&&s.BusinessDate===winner.BusinessDate;});
  const native=database.summaries.filter(d=>!ids.has(d.id)&&d.outlet_id===outlet&&d.business_date===winner.BusinessDate);
  if(legacy.length+native.length>1)throw Error('Multiple existing records for source business day: '+winner.BusinessDate);
  const before=legacy[0]||native[0]||null,id=before?.id||winner.SummaryID;
  if(used.has(id))throw Error('Target ID reused: '+id);used.add(id);
  // An existing native entry newer than the selected sheet submission remains authoritative.
  const keepNative=native.length&&Date.parse(native[0].created_at)>Date.parse(winner._time);
  let record=null;
  if(!keepNative){
   const summary={id,outlet_id:outlet,business_date:winner.BusinessDate,saved_by:matchName(database.users,winner.SavedBy,outlet)?.id||null,saved_by_name:winner.SavedBy||null,role:winner.Role||null,...Object.fromEntries(Object.entries(numberFields).map(([field,column])=>[field,amount(winner[column])])),swiggy_gross:amount(winner.SwiggyGross!==''?winner.SwiggyGross:winner.Swiggy),zomato_gross:amount(winner.ZomatoGross!==''?winner.ZomatoGross:winner.Zomato),summary_status:winner.SummaryStatus||'OPEN',is_closed:/^(true|yes|1)$/i.test(winner.IsClosed)||winner.SummaryStatus==='CLOSED',closed_by:matchName(database.users,winner.ClosedBy,outlet)?.id||null,closed_at:winner.ClosedAt?sourceTime(winner.ClosedAt):null,created_at:winner._time};
   if(!['OPEN','CLOSED','AUDITED'].includes(summary.summary_status))throw Error('Unknown summary status');
   const expense=array(winner.Expenses).map(e=>({category:String(e.category||'').trim()||'Uncategorised',amount:amount(e.amount),mode:mode(e.mode)}));
   const vendors=array(winner.VendorPayments).map(e=>({vendor_name:String(e.vendor||'').trim(),amount:amount(e.amount),mode:mode(e.mode)}));
   const staff=array(winner.StaffPayments).map(e=>{
    const matching=payments.filter(p=>p.Timestamp===winner.Timestamp&&p.BusinessDate===winner.BusinessDate&&norm(p.Outlet)===norm(winner.Outlet)&&norm(p.StaffName)===norm(e.staff)&&p.Type===e.type&&amount(p.Amount)===amount(e.amount));
    const modes=[...new Set(matching.map(p=>p.Mode))];if(!e.mode&&modes.length>1)throw Error('Conflicting staff payment modes');
    return {staff_name:String(e.staff||'').trim(),staff_id:matchName(database.staff,e.staff,outlet)?.id||null,payout_type:String(e.type||'').trim(),amount:amount(e.amount),mode:mode(e.mode||modes[0])};
   });
   if([...expense,...vendors,...staff].some(p=>p.amount===null)||expense.some(p=>!p.category)||vendors.some(p=>!p.vendor_name)||staff.some(p=>!p.staff_name||!p.payout_type))throw Error('Incomplete payment entry');
   record={summary,expenses:expense,vendors,staff_payments:staff};
  }
  for(const r of group){const selected=r===winner;planned.push({source_row:r._row,source_values:Object.fromEntries(headers.map(h=>[h,r[h]])),summary_id:id,disposition:selected?(keepNative?'newer_app_record':before?'updated':'inserted'):'superseded_duplicate',before_record:selected?before:null,record:selected?record:null});}
 }
 return planned.sort((a,b)=>a.source_row-b.source_row);
}
