export const shiftDay=(day,offset)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
export const shiftMonth=(month,offset)=>{const[y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+offset,1)).toISOString().slice(0,7);};
export const monthEnd=month=>{const[y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const fields=['gross_sales','net_sales','discounts','online_gross','online_net','cash_sales','direct_digital','operating_expenses','vendor_payments','staff_costs','savings','advances','cash_shortage','cash_excess','physical_cash'];
export function businessTotals(data,start,end,ids=data.outlets.map(o=>Number(o.id))){
  const selected=new Set(ids),rows=data.days.filter(d=>selected.has(Number(d.outlet_id))&&d.business_date>=start&&d.business_date<=end);
  const totals=Object.fromEntries(fields.map(field=>[field,rows.reduce((sum,r)=>sum+Number(r[field]||0),0)]));
  const summaries=rows.filter(d=>d.has_summary),coverage=[];
  // Preserve saved history, but flag channel differences beyond ₹2 rounding tolerance.
  const unreconciled=summaries.filter(d=>Math.abs(Number(d.net_sales||0)-(Number(d.cash_sales||0)+Number(d.direct_digital||0)+Number(d.online_net||0)-Number(d.discounts||0)))>2);
  for(const outlet of data.outlets.filter(o=>selected.has(Number(o.id)))){
    const first=outlet.first_activity||outlet.first_summary,startDate=first&&first>start?first:start;
    const expected=first&&first<=end&&end>=startDate?Math.round((new Date(end+'T12:00:00Z')-new Date(startDate+'T12:00:00Z'))/86400000)+1:0;
    const reported=new Set(summaries.filter(d=>Number(d.outlet_id)===Number(outlet.id)).map(d=>d.business_date)).size;
    coverage.push({id:Number(outlet.id),name:outlet.name,expected,reported,missing:Math.max(0,expected-reported)});
  }
  const expected=coverage.reduce((sum,o)=>sum+o.expected,0),reported=summaries.length;
  const costs=totals.operating_expenses+totals.vendor_payments+totals.staff_costs;
  return {...totals,costs,profit:reported?totals.net_sales-costs:null,retained:reported?totals.net_sales-costs-totals.savings-totals.advances:null,
    margin:reported&&totals.net_sales>0?(totals.net_sales-costs)/totals.net_sales*100:null,
    platform_reduction:totals.online_gross-totals.online_net,reported,expected,coverage,
    closed:summaries.filter(d=>d.is_closed).length,complete:expected>0&&reported===expected,unreconciled:unreconciled.length,
    reporting_ids:coverage.filter(o=>o.expected>0).map(o=>o.id).sort((a,b)=>a-b),
    daily_average:reported?totals.net_sales/reported:null};
}
export function comparableChange(current,previous,field='net_sales'){
  if(!current.complete||!previous.complete||current.unreconciled||previous.unreconciled||current.expected!==previous.expected||current.reporting_ids.join(',')!==previous.reporting_ids.join(','))return null;
  const baseline=Number(previous[field]);
  if(!Number.isFinite(baseline)||baseline<=0||current[field]===null)return null;
  return (Number(current[field])-baseline)/baseline*100;
}
export function dashboardPeriods(data,selectedDay=shiftDay(data.business_day,-1),historical=false){
  const currentMonth=(historical?selectedDay:data.business_day).slice(0,7),start=currentMonth+'-01',end=selectedDay<start?shiftDay(start,-1):selectedDay;
  const priorMonth=shiftMonth(currentMonth,-1),priorStart=priorMonth+'-01';
  const elapsed=end>=start?Number(end.slice(8)):0;
  const previousComparableEnd=elapsed?priorMonth+'-'+String(Math.min(elapsed,Number(monthEnd(priorMonth).slice(8)))).padStart(2,'0'):shiftDay(priorStart,-1);
  const current=businessTotals(data,start,end),previousComparable=businessTotals(data,priorStart,previousComparableEnd);
  // Equal elapsed days: compare the same number of calendar days in short months.
  const comparisonEnd=elapsed?currentMonth+'-'+String(Math.min(elapsed,Number(monthEnd(priorMonth).slice(8)))).padStart(2,'0'):end;
  const comparisonCurrent=businessTotals(data,start,comparisonEnd);
  return {currentMonth,start,end,current,priorMonth,priorStart,previousComparableEnd,comparisonEnd,previousComparable,comparisonCurrent,
    previousFull:businessTotals(data,priorStart,monthEnd(priorMonth)),elapsed,
    daily:businessTotals(data,selectedDay,selectedDay),previousDay:businessTotals(data,shiftDay(selectedDay,-1),shiftDay(selectedDay,-1)),
    previousWeek:businessTotals(data,shiftDay(selectedDay,-7),shiftDay(selectedDay,-7))};
}
export function groupedCosts(data,start,end){
  const grouped=new Map();
  for(const row of data.costs||[]){
    if(row.business_date<start||row.business_date>end)continue;
    const key=row.kind+'|'+String(row.label||'Uncategorised').trim().toLowerCase();
    const old=grouped.get(key)||{label:row.label||'Uncategorised',kind:row.kind,amount:0};
    old.amount+=Number(row.amount||0);grouped.set(key,old);
  }
  return [...grouped.values()].sort((a,b)=>b.amount-a.amount);
}
