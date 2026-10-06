// Administrative planning only. Source data must never be bundled into the app.
import {sourceTime} from './daily-summary-import.mjs';
const norm=s=>String(s??'').trim().toLowerCase();
const money=v=>{const n=Number(v||0);if(!Number.isFinite(n)||n<0)throw Error('Invalid salary amount: '+v);return Math.round(n*100)/100;};
const day=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||new Date(v+'T12:00Z').toISOString().slice(0,10)!==v)throw Error('Invalid salary date: '+v);return v;};
const match=(list,name,outlet)=>{const candidates=list.filter(x=>norm(x.name)===norm(name)&&x.outlet_id===outlet);if(candidates.length!==1)throw Error('Ambiguous salary person: '+name);return candidates[0];};
const numeric={basic_salary:'BasicSalary',holiday_pay:'HolidayPay',present_days:'PresentDays',absent_days:'AbsentDays',absent_deduction:'AbsentDeduction',late_mins:'LateMins',late_penalty:'LatePenalty',petty_advance:'PettyAdvance',ot_credit:'OTCredit',loan_prev_balance:'LoanPrevBalance',loan_deduct_this_month:'LoanDeductThisMonth',loan_remaining:'LoanRemaining',net_salary:'NetSalary',period_days:'PeriodDays'};
export function buildSalaryImport({values,database,summaryPayments=[],links=[],spreadsheetId,asOf}){
 if(!spreadsheetId||!values?.[0]||['SalaryID','Timestamp','Outlet','StaffName','PeriodStart','PeriodEnd','PayDate','NetSalary','PettyAdvance'].some(h=>!values[0].includes(h)))throw Error('Salary source headers required');
 const source=values.slice(1).map((v,i)=>({...Object.fromEntries(values[0].map((h,j)=>[h,v[j]??''])),row:i+2})).filter(r=>r.SalaryID);
 const ids=new Set(),groups=new Map(),usedLinks=new Set();
 for(const r of source){
  if(ids.has(r.SalaryID))throw Error('Repeated salary ID');ids.add(r.SalaryID);
  r.outlet_id=match(database.outlets,r.Outlet,undefined).id;
  const allPeople=database.staff.filter(s=>norm(s.name)===norm(r.StaffName));
  const localPeople=allPeople.filter(s=>s.outlet_id===r.outlet_id);
  const people=localPeople.length?localPeople:allPeople;
  const prior=database.salaries.find(p=>p.id===r.SalaryID||p.legacy_salary_id===r.SalaryID);
  const historicalIds=[...new Set(database.salaries.filter(p=>p.outlet_id===r.outlet_id&&people.some(s=>s.id===p.staff_id)).map(p=>p.staff_id))];
  r.staff_id=prior?.staff_id||(people.length===1?people[0].id:historicalIds.length===1?historicalIds[0]:null);
  if(!allPeople.some(s=>s.id===r.staff_id))throw Error('Ambiguous salary person: '+r.StaffName);
  day(r.PeriodStart);day(r.PeriodEnd);day(r.PayDate);sourceTime(r.Timestamp);
  if(r.PeriodEnd<r.PeriodStart||r.PayDate>(asOf||'9999-12-31'))throw Error('Invalid or future salary payment');
  r.cycle=r.PeriodStart.slice(0,7);const key=[r.outlet_id,r.staff_id,r.cycle].join('|'),group=groups.get(key)||[];group.push(r);groups.set(key,group);
 }
 const plan=[];
 for(const group of groups.values()){
  // The owner specified the last recorded entry wins. Sheet timestamps can be backdated.
  const winner=group.at(-1);
  const existingWinner=database.salaries.find(p=>p.legacy_salary_id===winner.SalaryID||p.id===winner.SalaryID);
  const winnerId=existingWinner?.id||winner.SalaryID;
  for(const r of group){
   const before=database.salaries.find(p=>p.legacy_salary_id===r.SalaryID||p.id===r.SalaryID)||null;
   let record=null,disposition='superseded_duplicate';
   if(r===winner){
    const approved=links.filter(l=>l.salary_source_id===r.SalaryID).map(l=>{
     const p=summaryPayments.find(p=>Number(p.id)===Number(l.summary_staff_id));
     if(!p||p.outlet_id!==r.outlet_id||p.staff_id!==r.staff_id||p.payout_type!=='Salary'||usedLinks.has(p.id))throw Error('Invalid or reused summary salary link');
     usedLinks.add(p.id);return {id:p.id,summary_id:p.summary_id,business_date:day(p.business_date),amount:money(p.amount)};
    });
    if(approved.length>1)throw Error('Multiple summary payments need manual reconciliation');
    const paymentDay=approved[0]?.business_date||r.PayDate;
    record={...(before||{}),id:winnerId,outlet_id:r.outlet_id,staff_id:r.staff_id,period_start:r.PeriodStart,period_end:r.PeriodEnd,pay_date:r.PayDate,...Object.fromEntries(Object.entries(numeric).map(([field,col])=>[field,money(r[col])])),late_penalty_waived:/^(yes|true|1)$/i.test(r.LatePenaltyWaived),saved_by:database.users.find(u=>norm(u.name)===norm(r.SavedBy)&&u.outlet_id===r.outlet_id)?.id||before?.saved_by||null,saved_by_name:r.SavedBy||null,legacy_salary_id:r.SalaryID,payroll_status:'PAID',payment_method:before?.payment_method||null,payment_reference:before?.payment_reference||null,paid_at:paymentDay+'T12:00:00+05:30',created_at:before?.created_at||sourceTime(r.Timestamp),payroll_details:{...(before?.payroll_details||{}),salary_sheet_import:{spreadsheet_id:spreadsheetId,source_row:r.row,source_salary_id:r.SalaryID,cycle_month:r.cycle,owner_confirmed_paid:true,payment_date_basis:approved.length?'daily_summary':'sheet_pay_date',advance_deduction:money(r.PettyAdvance),summary_salary_links:approved,superseded:false}}};
    disposition=before?'confirmed_paid':'inserted_paid';
   }else if(before){
    record={...before,payroll_details:{...(before.payroll_details||{}),salary_sheet_import:{spreadsheet_id:spreadsheetId,source_row:r.row,cycle_month:r.cycle,superseded:true,superseded_by:winnerId}}};
   }
   plan.push({source_row:r.row,source_values:Object.fromEntries(values[0].map(h=>[h,r[h]])),salary_record_id:record?.id||r.SalaryID,disposition,before_record:record?before:null,record});
  }
 }
 if(usedLinks.size!==links.length)throw Error('Salary link does not reference a selected monthly record');
 return plan.sort((a,b)=>a.source_row-b.source_row);
}
export function salaryReconciliationCandidates(plan,payments){
 return plan.filter(p=>p.record?.payroll_status==='PAID'&&p.disposition!=='superseded_duplicate').map(p=>({salary_source_id:p.source_values.SalaryID,staff_id:p.record.staff_id,net:p.record.net_salary,pay_date:p.record.pay_date,candidates:payments.filter(x=>x.outlet_id===p.record.outlet_id&&x.staff_id===p.record.staff_id&&x.payout_type==='Salary'&&Number(x.amount)>=p.record.net_salary*.5&&Number(x.amount)<=p.record.net_salary*1.5&&Math.abs(Date.parse(x.business_date)-Date.parse(p.record.pay_date))<=21*86400000).map(x=>({id:x.id,date:x.business_date,amount:x.amount,difference:p.record.net_salary-Number(x.amount)}))}));
}
