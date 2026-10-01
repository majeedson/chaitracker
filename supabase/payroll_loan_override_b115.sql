-- B115: allow the payroll processor to reconcile the loan balance explicitly.
create or replace function private.apply_salary_loan_remaining_override()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if coalesce((new.payroll_details->>'loan_remaining_manual')::boolean,false) then
    new.loan_remaining:=coalesce((new.payroll_details->>'loan_remaining')::numeric,0);
    if new.loan_remaining<0 then raise exception 'Loan remaining cannot be negative'; end if;
  end if;
  return new;
end $function$;

revoke all on function private.apply_salary_loan_remaining_override() from public,anon,authenticated;
drop trigger if exists salary_records_loan_remaining_override on public.salary_records;
create trigger salary_records_loan_remaining_override
  before insert or update of loan_prev_balance,loan_deduct_this_month,payroll_details
  on public.salary_records for each row
  execute function private.apply_salary_loan_remaining_override();
