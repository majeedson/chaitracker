-- Apply after the Build 113 client has replaced the old salary RPC calls.
-- Legacy owner endpoints must not write salary without posting advance deductions.
revoke execute on function public.finalize_salary_record(integer,date,date,date,uuid) from public,anon,authenticated;
revoke execute on function public.save_salary_record(varchar,integer,integer,date,date,date,
  integer,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,numeric,
  boolean,numeric,numeric,numeric,numeric,uuid,varchar) from public,anon,authenticated;
