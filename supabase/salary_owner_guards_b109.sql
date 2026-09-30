-- Owner-only legacy RPCs must continue to work after table writes are revoked.
alter function public.owner_update_staff(integer,text,integer,text,numeric,date,boolean,jsonb,text)
  security definer set search_path = public, pg_temp;
alter function public.owner_reset_staff_pin_setup(integer)
  security definer set search_path = public, pg_temp;

create or replace function public.save_salary_record(
  p_id varchar,p_outlet_id integer,p_staff_id integer,p_period_start date,
  p_period_end date,p_pay_date date,p_period_days integer,p_basic_salary numeric,
  p_holiday_pay numeric,p_holiday_days numeric,p_present_days numeric,
  p_absent_days numeric,p_absent_deduction numeric,p_late_mins integer,
  p_late_hours_edited numeric,p_late_penalty numeric,p_late_penalty_waived boolean,
  p_petty_advance numeric,p_ot_credit numeric,p_loan_prev_balance numeric,
  p_loan_deduct_this_month numeric,p_saved_by uuid,p_saved_by_name varchar)
returns public.salary_records language plpgsql security definer set search_path = '' as $function$
declare v_row public.salary_records; v_late numeric; v_loan_remaining numeric; v_net numeric;
begin
  if not private.is_admin() or p_saved_by is distinct from private.actor_id() then
    raise exception 'Owner access required';
  end if;
  if not exists(select 1 from public.staff where id=p_staff_id and outlet_id=p_outlet_id) then
    raise exception 'Staff does not belong to this café';
  end if;
  if p_basic_salary <= 0 then raise exception 'Basic salary is required'; end if;
  v_late := case when coalesce(p_late_penalty_waived,false) then 0 else coalesce(p_late_penalty,0) end;
  v_loan_remaining := greatest(0,coalesce(p_loan_prev_balance,0)-coalesce(p_loan_deduct_this_month,0));
  v_net := coalesce(p_basic_salary,0)+coalesce(p_holiday_pay,0)+coalesce(p_ot_credit,0)
           -coalesce(p_absent_deduction,0)-v_late-coalesce(p_petty_advance,0)
           -coalesce(p_loan_deduct_this_month,0);
  insert into public.salary_records(
    id,outlet_id,staff_id,period_start,period_end,pay_date,period_days,
    basic_salary,holiday_pay,holiday_days,present_days,absent_days,absent_deduction,
    late_mins,late_hours_edited,late_penalty,late_penalty_waived,
    petty_advance,ot_credit,loan_prev_balance,loan_deduct_this_month,loan_remaining,
    net_salary,saved_by,saved_by_name,created_at
  ) values(
    p_id,p_outlet_id,p_staff_id,p_period_start,p_period_end,p_pay_date,p_period_days,
    p_basic_salary,coalesce(p_holiday_pay,0),coalesce(p_holiday_days,0),
    coalesce(p_present_days,0),coalesce(p_absent_days,0),coalesce(p_absent_deduction,0),
    coalesce(p_late_mins,0),coalesce(p_late_hours_edited,0),v_late,coalesce(p_late_penalty_waived,false),
    coalesce(p_petty_advance,0),coalesce(p_ot_credit,0),coalesce(p_loan_prev_balance,0),
    coalesce(p_loan_deduct_this_month,0),v_loan_remaining,v_net,p_saved_by,p_saved_by_name,now()
  ) on conflict(outlet_id,staff_id,period_start) do update set
    period_end=excluded.period_end,pay_date=excluded.pay_date,period_days=excluded.period_days,
    basic_salary=excluded.basic_salary,holiday_pay=excluded.holiday_pay,holiday_days=excluded.holiday_days,
    present_days=excluded.present_days,absent_days=excluded.absent_days,absent_deduction=excluded.absent_deduction,
    late_mins=excluded.late_mins,late_hours_edited=excluded.late_hours_edited,late_penalty=excluded.late_penalty,
    late_penalty_waived=excluded.late_penalty_waived,petty_advance=excluded.petty_advance,ot_credit=excluded.ot_credit,
    loan_prev_balance=excluded.loan_prev_balance,loan_deduct_this_month=excluded.loan_deduct_this_month,
    loan_remaining=excluded.loan_remaining,net_salary=excluded.net_salary,saved_by=excluded.saved_by,
    saved_by_name=excluded.saved_by_name,created_at=now()
  returning * into v_row;
  return v_row;
end $function$;

revoke all on function public.save_salary_record(varchar,integer,integer,date,date,date,
  integer,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,numeric,
  boolean,numeric,numeric,numeric,numeric,uuid,varchar) from public,anon;
grant execute on function public.save_salary_record(varchar,integer,integer,date,date,date,
  integer,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,numeric,
  boolean,numeric,numeric,numeric,numeric,uuid,varchar) to authenticated;
