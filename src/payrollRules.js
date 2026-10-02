export const PAID_DAYS_OFF=3;
export const SALARY_DAY_DIVISOR=30;
export const SHIFT_HOURS=12;

export function salaryStartForMonth(month,joiningDate) {
  const [year,number]=month.split('-').map(Number);
  const day=Math.max(1,Number(joiningDate?.slice(8,10))||1);
  const last=new Date(Date.UTC(year,number,0)).getUTCDate();
  return `${month}-${String(Math.min(day,last)).padStart(2,'0')}`;
}

export function salaryPeriodEnd(start,joiningDate) {
  const [year,month,day]=start.split('-').map(Number);
  const anchor=joiningDate&&start===salaryStartForMonth(start.slice(0,7),joiningDate)?joiningDate:`2000-01-${String(day).padStart(2,'0')}`;
  const nextMonth=new Date(Date.UTC(year,month,1)).toISOString().slice(0,7);
  const next=new Date(salaryStartForMonth(nextMonth,anchor)+'T00:00:00Z');
  next.setUTCDate(next.getUTCDate()-1);
  return next.toISOString().slice(0,10);
}

export function latePenaltyFromHours(basic,hours) {
  return Math.round(Math.max(0,Number(hours)||0)*Math.max(0,Number(basic)||0)/(SALARY_DAY_DIVISOR*SHIFT_HOURS));
}

export function chargeableLateHours(minutes) {
  const late=Math.max(0,Number(minutes)||0);
  if(late<=15)return 0;
  if(late<=30)return .5;
  return Math.ceil(late/60);
}

export function holidayDutyDays(daysOff) {
  return Math.max(0,PAID_DAYS_OFF-Math.max(0,Number(daysOff)||0));
}

export function balanceAttendance(periodDays,changed,value) {
  const days=Math.max(0,Number(periodDays)||0);
  const entered=Math.min(days,Math.max(0,Number(value)||0));
  return changed==='absent_days'
    ?{present:days-entered,absent:entered}
    :{present:entered,absent:days-entered};
}

export function payrollAbsenceDeduction(basic,daysOff,periodDays) {
  const off=Math.max(0,Number(daysOff)||0),salary=Math.max(0,Number(basic)||0);
  if(off<=PAID_DAYS_OFF)return 0;
  return Math.round(salary-Math.min(salary,salary*Math.max(0,periodDays-off)/SALARY_DAY_DIVISOR));
}

export function latePenalty(basic,minutes) {
  return latePenaltyFromHours(basic,chargeableLateHours(minutes));
}
