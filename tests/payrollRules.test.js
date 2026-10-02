import test from 'node:test';
import assert from 'node:assert/strict';
import {salaryStartForMonth,salaryPeriodEnd,latePenaltyFromHours,chargeableLateHours,latePenalty,holidayDutyDays,balanceAttendance,payrollAbsenceDeduction} from '../src/payrollRules.js';

test('late tiers use the stated inclusive boundaries',()=>{
  for(const [minutes,hours] of [[0,0],[15,0],[16,.5],[30,.5],[31,1],[60,1],[61,2],[120,2],[121,3],[180,3],[181,4]]){
    assert.equal(chargeableLateHours(minutes),hours,`${minutes} minutes`);
  }
  assert.equal(latePenalty(15000,16),21);
  assert.equal(latePenalty(15000,61),83);
});

test('joining day anchors each selected salary month',()=>{
  assert.equal(salaryStartForMonth('2026-10','2025-07-07'),'2026-10-07');
  assert.equal(salaryStartForMonth('2027-02','2025-01-31'),'2027-02-28');
});

test('unused days off become holiday duty and fourth absence prorates basic',()=>{
  assert.deepEqual([0,1,2,3,4].map(holidayDutyDays),[3,2,1,0,0]);
  assert.equal(payrollAbsenceDeduction(15000,3,31),0);
  assert.equal(payrollAbsenceDeduction(15000,4,31),1500);
});

test('editing either attendance count balances the period',()=>{
  assert.deepEqual(balanceAttendance(31,'absent_days',2),{present:29,absent:2});
  assert.deepEqual(balanceAttendance(31,'present_days',28),{present:28,absent:3});
  assert.deepEqual(balanceAttendance(30,'absent_days',35),{present:0,absent:30});
});


test('every joining anchor has contiguous periods, including leap years and short months',()=>{
  for(const year of [2026,2027,2028])for(let day=1;day<=31;day++)for(let month=1;month<=12;month++) {
    const joining=`2025-01-${String(day).padStart(2,'0')}`,key=`${year}-${String(month).padStart(2,'0')}`;
    const nextMonth=new Date(Date.UTC(year,month,1)).toISOString().slice(0,7);
    const start=salaryStartForMonth(key,joining),end=salaryPeriodEnd(start,joining);
    const next=new Date(end+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
    assert.equal(next.toISOString().slice(0,10),salaryStartForMonth(nextMonth,joining));
  }
  assert.equal(salaryPeriodEnd('2026-09-10','2025-01-07'),'2026-10-09');
  assert.equal(latePenaltyFromHours(15000,3*chargeableLateHours(16)),63);
});
