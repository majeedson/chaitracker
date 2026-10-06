import {cigaretteGroups} from './cigaretteMetrics.js';
import {businessTotals,comparableChange,dashboardPeriods,groupedCosts,shiftDay,shiftMonth,monthEnd} from './businessMetrics.js';
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>value===null||value===undefined?'—':'₹'+Number(value).toLocaleString('en-IN',{maximumFractionDigits:2});
const percent=value=>value===null?'—':Number(value).toFixed(1)+'%';
const dateLabel=day=>new Date(day+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const monthLabel=month=>new Date(month+'-01T12:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
const changeLabel=(change,label)=>change===null?`<span class="biz-kpi-note">${html(label)} · unavailable</span>`:`<span class="biz-change ${change>=0?'positive':'negative'}">${change>=0?'↑':'↓'} ${Math.abs(change).toFixed(1)}% ${html(label)}</span>`;
const status=t=>!t.reported?'No summary':t.unreconciled?'Check net sales':!t.complete?`${t.reported}/${t.expected} days recorded`:t.closed<t.reported?'Recorded · unclosed':'Closed';
const value=(t,field)=>t.reported?t[field]:null;
const navigate=(view,module,outletId)=>view.dispatchEvent(new CustomEvent('app:navigate',{bubbles:true,detail:{module,outletId}}));
export async function renderBusinessDashboard(view,supabase,profile){
  if(profile.access_class!=='ADMIN'){view.innerHTML='<h2>Admin access required</h2>';return;}
  const activeRequest={};view._businessDashboardRequest=activeRequest;
  const {data,error}=await supabase.rpc('get_business_dashboard',{p_outlet_id:profile.context_outlet_id?Number(profile.context_outlet_id):null});
  if(view._businessDashboardRequest!==activeRequest)return;
  if(error||!data?.business_day){view.innerHTML=`<h2>Business dashboard unavailable</h2><p class="form-error">${html(error?.message||'No business data available.')}</p><button id="retryBusinessDashboard" class="secondary" type="button">Retry</button>`;view.querySelector('#retryBusinessDashboard').onclick=()=>renderBusinessDashboard(view,supabase,profile);return;}
  const asOf=shiftDay(data.business_day,-1);
  const stored=profile._dashboardDay;
  let selectedDay=stored&&stored>=data.history_start&&stored<=asOf?stored:asOf,historical=selectedDay!==asOf;
  const operations={alerts:[],loaded:false};
  const render=()=>{
    const p=dashboardPeriods(data,selectedDay,historical),day=p.daily,mtd=p.current;
    const latest=data.outlets.map(o=>o.latest_summary).filter(Boolean).sort().at(-1);
    const sameWeekChange=comparableChange(day,p.previousWeek),monthChange=comparableChange(p.comparisonCurrent,p.previousComparable);
    const reported=day.reported,registered=data.outlets.length;
    const dailyCosts=reported||day.costs?day.costs:null;
    const costRows=groupedCosts(data,p.start,p.end).slice(0,5),topCost=costRows[0];
    const insights=[];
    const dayMissing=day.coverage.filter(o=>o.missing);
    if(!reported)insights.push({title:'Previous day has no sales summary',copy:`${latest?'Latest: '+dateLabel(latest):dateLabel(selectedDay)}`,module:'summary',outlet:data.outlets.find(o=>o.first_summary)?.id});
    else if(dayMissing.length)insights.push({title:'Complete the missing café summaries',copy:dayMissing.map(o=>o.name).join(', ')+': missing',module:'summary',outlet:dayMissing[0].id});
    if(mtd.expected>mtd.reported)insights.push({title:'Monthly comparison needs complete records',copy:`${mtd.reported}/${mtd.expected} days recorded`,module:'summary',outlet:mtd.coverage.find(o=>o.missing)?.id});
    if(reported&&day.closed<reported)insights.push({title:'Daily figures are provisional',copy:`${reported-day.closed} unclosed`,module:'summary',outlet:data.outlets.find(o=>data.days.some(d=>Number(d.outlet_id)===Number(o.id)&&d.business_date===selectedDay&&d.has_summary&&!d.is_closed))?.id});
    if(day.cash_shortage>0)insights.push({title:'Investigate the drawer shortage',copy:`${money(day.cash_shortage)} short · ${money(day.cash_excess)} excess`,module:'summary',outlet:data.outlets.find(o=>data.days.some(d=>Number(d.outlet_id)===Number(o.id)&&d.business_date===selectedDay&&Number(d.cash_shortage)>0))?.id});
    if(day.unreconciled||mtd.unreconciled||p.previousComparable.unreconciled)insights.push({title:'Reconcile saved net sales',copy:`${day.unreconciled} daily · ${mtd.unreconciled} monthly records`,module:'summary',outlet:profile.context_outlet_id||data.outlets.find(o=>o.first_summary)?.id});
    if(day.complete&&!day.unreconciled&&day.profit<0)insights.push({title:'Paid costs exceeded net sales',copy:`${money(-day.profit)} over sales`,module:'summary',outlet:profile.context_outlet_id});
    if(monthChange!==null&&monthChange<0)insights.push({title:'Net sales are behind last month',copy:`Down ${Math.abs(monthChange).toFixed(1)}%`,module:'dashboard'});
    if(Number(data.payroll_records_not_marked_paid)>0)insights.push({title:'Reconcile the payroll payment status',copy:`${data.payroll_records_not_marked_paid} unpaid · ${money(data.payroll_not_marked_paid)}`,module:'salary',outlet:profile.context_outlet_id||data.outlets.find(o=>o.first_summary)?.id});
    if(topCost&&mtd.reported)insights.push({title:'Largest recorded cost this month',copy:`${topCost.label} · ${money(topCost.amount)}`,module:topCost.kind==='Vendor'?'purchase':'summary',outlet:profile.context_outlet_id||data.outlets.find(o=>o.first_summary)?.id});
    const kpi=(label,amount,note,extra='',tone='')=>`<article class="biz-kpi ${tone}"><span>${html(label)}</span><strong>${money(amount)}</strong>${extra}</article>`;
    const selectedOutlet=data.outlets.length===1?data.outlets[0].name:'All cafés';
    const breakdown=[['Operating expenses',day.operating_expenses],['Vendor payments',day.vendor_payments],['Staff & paid payroll',day.staff_costs],['Pigmy savings',day.savings],['Staff advances',day.advances]];
    const history=Array.from({length:7},(_,i)=>{const month=shiftMonth(p.currentMonth,-i),end=i===0?p.end:monthEnd(month),t=businessTotals(data,month+'-01',end);return {month,t,end};});
    const trendStart=shiftDay(selectedDay,-13),trend=Array.from({length:14},(_,i)=>{const date=shiftDay(trendStart,i),t=businessTotals(data,date,date);return {date,t};});
    const trendMax=Math.max(1,...trend.map(x=>x.t.reported?x.t.net_sales:0));
    const perCafe=data.outlets.map(o=>({outlet:o,t:businessTotals(data,selectedDay,selectedDay,[Number(o.id)])})).sort((a,b)=>(b.t.reported-a.t.reported)||(b.t.net_sales-a.t.net_sales));
    view.innerHTML=`<div class="business-dashboard">
      <header class="biz-heading"><div><span class="eyebrow">${html(selectedOutlet)} · Owner overview</span><h2>${historical?'Business review':'Yesterday’s business'}</h2><p>${dateLabel(selectedDay)} · ${reported}/${registered} café summaries recorded</p></div><div class="biz-date-controls"><label>Date<input id="businessDashboardDay" type="date" min="${html(data.history_start)}" max="${asOf}" value="${selectedDay}"></label><button id="businessDashboardRefresh" class="ghost" type="button">Refresh</button></div></header>
      <div class="biz-data-status ${day.complete&&day.closed===reported?'complete':''}" role="status"><span>${!reported?'No sales summaries for this day':day.complete?`${day.closed}/${reported} summaries closed · ${day.closed===reported?'complete':'provisional'}`:'Some café summaries are missing · partial totals'}</span>${latest&&latest<selectedDay?`<button id="businessLatestDay" type="button">View latest recorded day · ${dateLabel(latest)}</button>`:''}</div>
      <section class="biz-kpi-grid" aria-label="Daily business figures">
        ${kpi('Net sales',value(day,'net_sales'),'Saved Daily Summary total',changeLabel(sameWeekChange,'vs same weekday'),'hero')}
        ${kpi('Profit estimate',day.profit,'Net sales less recorded operating payments',reported?`<span class="biz-kpi-note">Margin ${percent(day.margin)}</span>`:'',day.profit<0?'profit shortage negative':'profit')}
        ${kpi('Recorded costs',dailyCosts,'Expenses + vendors + staff payments')}
        ${kpi('Net after all outflows',day.retained,'After costs, pigmy savings & staff advances')}
        ${kpi('Gross sales',value(day,'gross_sales'),'Before platform adjustments & discounts')}
        ${kpi('Drawer shortage',value(day,'cash_shortage'),'Saved cash count versus expected cash',reported?`<span class="biz-kpi-note">Excess: ${money(day.cash_excess)}</span>`:'',day.cash_shortage>0?'shortage':'')}
      </section>
      ${day.unreconciled?'<p class="biz-small-note">Net sales need reconciliation</p>':''}
      <section class="biz-section"><div class="biz-section-heading"><div><h3>${historical?'Selected month':'This month'} · ${monthLabel(p.currentMonth)}</h3><p>${p.elapsed?`Through ${dateLabel(p.end)} · ${mtd.reported}/${mtd.expected} expected café-days recorded`:'The month has no completed business days yet.'}</p></div><span class="biz-period-change">${changeLabel(monthChange,'vs last month, same days')}</span></div>
        ${mtd.unreconciled||p.previousComparable.unreconciled?'<p class="biz-small-note">Check net sales</p>':''}<div class="biz-month-grid"><div><span>Net sales to date</span><strong>${money(value(mtd,'net_sales'))}</strong></div><div><span>Profit estimate to date</span><strong>${money(mtd.profit)}</strong></div><div><span>Average per recorded café-day</span><strong>${money(mtd.daily_average)}</strong></div><div><span>Last month · full total</span><strong>${money(value(p.previousFull,'net_sales'))}</strong><small>${p.previousFull.reported}/${p.previousFull.expected} café-days recorded</small></div></div>
        <div class="biz-comparison"><div><span>Same days this month</span><strong>${money(value(p.comparisonCurrent,'net_sales'))}</strong><small>${p.elapsed?dateLabel(p.start)+' – '+dateLabel(p.comparisonEnd):'No completed days'}</small></div><div><span>Same days last month</span><strong>${money(value(p.previousComparable,'net_sales'))}</strong><small>${p.elapsed?dateLabel(p.priorStart)+' – '+dateLabel(p.previousComparableEnd):'No completed days'}</small></div></div>
      </section>
      <section class="biz-section"><div class="biz-section-heading"><div><h3>Daily sales trend</h3><p>Last 14 days</p></div></div><figure class="biz-trend"><div class="biz-trend-bars">${trend.map(({date,t})=>`<div class="biz-trend-day" title="${html(dateLabel(date)+': '+(t.reported?money(t.net_sales)+' · '+status(t):'No summary'))}"><div class="biz-trend-bar ${!t.reported?'missing':!t.complete?'partial':''}" style="height:${t.reported?Math.max(3,t.net_sales/trendMax*100):4}%"></div><small>${Number(date.slice(8))}</small></div>`).join('')}</div><figcaption>${dateLabel(trendStart)} – ${dateLabel(selectedDay)} · <span>Solid: recorded</span> · <span>Dashed: missing</span></figcaption></figure></section>
      <section class="biz-section"><div class="biz-section-heading"><div><h3>Month-by-month performance</h3><p>Last 7 months</p></div></div><div class="biz-table-wrap"><table class="biz-table"><thead><tr><th>Month</th><th>Net sales</th><th>Costs paid</th><th>Profit estimate</th><th>Margin</th><th>Coverage</th></tr></thead><tbody>${history.map(({month,t})=>`<tr><th scope="row"><button type="button" data-biz-month="${month}">${html(monthLabel(month))}</button>${month===p.currentMonth?'<small>To date</small>':''}</th><td>${money(value(t,'net_sales'))}</td><td>${money(t.reported||t.costs?t.costs:null)}</td><td class="${t.profit<0?'negative':''}">${money(t.profit)}</td><td>${percent(t.margin)}</td><td><span class="biz-coverage ${t.complete?'':'partial'}">${t.reported}/${t.expected}</span>${t.unreconciled?'<small>Check net sales</small>':''}${t.reported&&t.closed<t.reported?'<small>Unclosed</small>':''}</td></tr>`).join('')}</tbody></table></div></section>
      <div class="biz-two-column"><section class="biz-section"><div class="biz-section-heading"><div><h3>Sales channels</h3><p>${dateLabel(selectedDay)}</p></div></div><dl class="biz-ledger"><div><dt>Cash sales</dt><dd>${money(value(day,'cash_sales'))}</dd></div><div><dt>UPI & own digital</dt><dd>${money(value(day,'direct_digital'))}</dd></div><div><dt>Swiggy & Zomato · gross</dt><dd>${money(value(day,'online_gross'))}</dd></div><div><dt>Swiggy & Zomato · recorded payouts</dt><dd>${money(value(day,'online_net'))}</dd></div><div><dt>Platform adjustments</dt><dd>${money(value(day,'platform_reduction'))}</dd></div><div><dt>Discounts</dt><dd>${money(value(day,'discounts'))}</dd></div></dl></section>
      <section class="biz-section"><div class="biz-section-heading"><div><h3>Where the money went</h3><p>${dateLabel(selectedDay)}</p></div></div><dl class="biz-ledger">${breakdown.map(([label,amount])=>`<div><dt>${html(label)}</dt><dd>${money(reported||amount?amount:null)}</dd></div>`).join('')}</dl></section></div>
      <section class="biz-section"><div class="biz-section-heading"><div><h3>Café performance</h3><p>${dateLabel(selectedDay)}</p></div></div><div class="biz-table-wrap"><table class="biz-table"><thead><tr><th>Café</th><th>Net sales</th><th>Profit estimate</th><th>Status / latest record</th></tr></thead><tbody>${perCafe.map(({outlet:o,t})=>`<tr><th scope="row"><button type="button" data-biz-cafe="${o.id}">${html(o.name)} ›</button></th><td>${money(value(t,'net_sales'))}</td><td>${money(t.profit)}</td><td>${!o.first_summary?'No sales history':html(status(t))}${!t.reported&&o.latest_summary?`<small>${dateLabel(o.latest_summary)}</small>`:''}</td></tr>`).join('')}</tbody></table></div></section>
      <div class="biz-two-column"><section class="biz-section"><div class="biz-section-heading"><div><h3>Owner actions</h3></div></div><div class="biz-actions">${insights.length?insights.map((a,i)=>`<button type="button" data-biz-action="${i}"><strong>${html(a.title)}</strong><span>${html(a.copy)}</span></button>`).join(''):'<p class="section-help">No financial exceptions in these records.</p>'}</div></section>
      <section class="biz-section"><div class="biz-section-heading"><div><h3>Largest costs · ${html(monthLabel(p.currentMonth))}</h3></div></div><dl class="biz-ledger">${costRows.length?costRows.map(c=>`<div><dt>${html(c.label)}<small>${html(c.kind)}</small></dt><dd>${money(c.amount)}</dd></div>`).join(''):'<p class="section-help">No costs recorded for this period.</p>'}</dl><div id="businessOperations"></div></section></div>
      <details class="biz-methodology"><summary>How these figures are calculated</summary><p>Net sales use the saved Daily Summary total. The current formula is cash + UPI + own digital + recorded platform payouts − discounts. Historical values are retained; differences from channel totals above ₹2 are flagged for reconciliation and affected growth comparisons are withheld. Gross sales use platform gross amounts instead of payouts.</p><p>Profit estimate = net sales − operating expenses − vendor payments − staff payments. Only paid payroll is included. Historical salary months use the last generated record, confirmed paid by the owner. Payment dates use linked summaries where available, otherwise the sheet PayDate. Net salary already deducts advances and loans; those deductions are not subtracted again. Reconciled summary salary entries are replaced in these totals by the generator amount, while original drawer records remain unchanged. Other matching payroll payments are counted once, by staff, date and amount. Unpaid finalized payroll is shown as an action, not a paid cost.</p><p>Pigmy savings and staff advances are excluded from profit and deducted separately in “Net after all outflows”. Invoice purchases are not deducted again on top of vendor payments. Profit is a cash basis estimate; it does not calculate inventory consumption or accrual profit.</p><p>Missing days are not treated as zero. Growth requires complete, reconciled records for the same reporting cafés and the same elapsed days. Open summaries are included and clearly marked as provisional. Coverage starts at each café’s first summary; cafés with no sales history do not enter growth calculations.</p></details>
    </div>`;
    view.querySelector('#businessDashboardDay').onchange=event=>{const day=event.target.value;if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day>asOf||day<data.history_start)return;selectedDay=day;historical=day!==asOf;profile._dashboardDay=day;render();};
    view.querySelector('#businessDashboardRefresh').onclick=()=>{view.querySelector('#businessDashboardRefresh').disabled=true;return renderBusinessDashboard(view,supabase,profile);};
    view.querySelector('#businessLatestDay')?.addEventListener('click',()=>{selectedDay=latest;historical=latest!==asOf;profile._dashboardDay=latest;render();});
    view.querySelectorAll('[data-biz-month]').forEach(button=>button.onclick=()=>{selectedDay=monthEnd(button.dataset.bizMonth)<asOf?monthEnd(button.dataset.bizMonth):asOf;historical=selectedDay!==asOf;profile._dashboardDay=selectedDay;render();});
    view.querySelectorAll('[data-biz-cafe]').forEach(button=>button.onclick=()=>navigate(view,'dashboard',Number(button.dataset.bizCafe)));
    view.querySelectorAll('[data-biz-action]').forEach(button=>button.onclick=()=>{const a=insights[Number(button.dataset.bizAction)];navigate(view,a.module,a.outlet);});
    renderOperations();
  };
  const renderOperations=()=>{
    const target=view.querySelector('#businessOperations');if(!target)return;
    target.innerHTML=`<div class="biz-operations"><h4>Today’s operations</h4>${!operations.loaded?'<p class="biz-small-note">Checking attendance and stock…</p>':operations.alerts.length?operations.alerts.map((a,i)=>`<button type="button" data-biz-operation="${i}"><strong>${html(a.outlet)}</strong><span>${html(a.text)}</span></button>`).join(''):'<p class="biz-small-note">No attendance or stock exceptions reported.</p>'}</div>`;
    target.querySelectorAll('[data-biz-operation]').forEach(button=>button.onclick=()=>{const a=operations.alerts[Number(button.dataset.bizOperation)];navigate(view,a.module,a.id);});
  };
  render();
  // Operational checks do not delay financial figures or turn missing data into an all-clear.
  const checks=await Promise.allSettled(data.outlets.map(async o=>{
    const [attendance,stock,cigarettes]=await Promise.all([
      supabase.rpc('get_attendance_calendar',{p_outlet_id:o.id,p_start_date:o.business_day,p_end_date:o.business_day,p_staff_id:null}),
      supabase.from('current_stock').select('item_id,minimum_stock,count_now,business_date').eq('outlet_id',o.id),
      supabase.rpc('get_cigarette_workspace',{p_outlet_id:o.id,p_date:shiftDay(o.business_day,-1)})
    ]);
    const alerts=[];
    if(attendance.error)alerts.push({id:o.id,outlet:o.name,text:'Attendance check unavailable',module:'attendance'});
    else {const rows=attendance.data||[];if(!rows.length)alerts.push({id:o.id,outlet:o.name,text:'No attendance records for today',module:'attendance'});const review=rows.filter(r=>r.status==='NEEDS_REVIEW').length,notIn=rows.filter(r=>r.status==='NOT_CHECKED_IN').length;if(review||notIn)alerts.push({id:o.id,outlet:o.name,text:`${review} need review · ${notIn} not checked in`,module:'attendance'});}
    if(stock.error)alerts.push({id:o.id,outlet:o.name,text:'Stock check unavailable',module:'stock'});
    else {if(!stock.data?.length)alerts.push({id:o.id,outlet:o.name,text:'No stock counts available',module:'stock'});const latest=new Map();for(const r of stock.data||[]){const old=latest.get(r.item_id);if(!old||r.business_date>old.business_date)latest.set(r.item_id,r);}const low=[...latest.values()].filter(r=>Number(r.minimum_stock)>0&&Number(r.count_now)<Number(r.minimum_stock)).length;if(low)alerts.push({id:o.id,outlet:o.name,text:`${low} items below minimum · based on latest counts`,module:'stock'});}
    if(cigarettes.error)alerts.push({id:o.id,outlet:o.name,text:'Cigarette check unavailable',module:'cigarettes'});
    else if(cigarettes.data?.items?.length){
     const day=cigarettes.data.day;
     if(!day?.closed_at)alerts.push({id:o.id,outlet:o.name,text:'Previous day cigarette closing pending',module:'cigarettes'});
     else {const report=day.report,groups=cigaretteGroups(report.brands,report.sales,Object.fromEntries(report.brands.map(b=>[b.item_id,b.closing])),shiftDay(o.business_day,-1));
      const missing=groups.reduce((n,g)=>n+Math.max(0,g.difference||0),0),excess=groups.reduce((n,g)=>n+Math.max(0,-(g.difference||0)),0);
      if(missing||excess)alerts.push({id:o.id,outlet:o.name,text:`Cigarettes: ${missing} unaccounted · ${excess} excess pieces`,module:'cigarettes'});
      if(groups.some(g=>!g.complete))alerts.push({id:o.id,outlet:o.name,text:'Cigarette SK check incomplete',module:'cigarettes'});
     }
    }
    return alerts;
  }));
  if(view._businessDashboardRequest!==activeRequest)return;
  operations.loaded=true;
  operations.alerts=checks.flatMap((r,i)=>r.status==='fulfilled'?r.value:[{id:data.outlets[i].id,outlet:data.outlets[i].name,text:'Operational checks unavailable',module:'attendance'}]);
  renderOperations();
}

