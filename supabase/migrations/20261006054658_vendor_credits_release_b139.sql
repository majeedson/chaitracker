-- Release Credits after the independently published attendance-photo fix.
create or replace function public.get_app_release()
returns jsonb language sql stable set search_path='' as $$select jsonb_build_object('schema_build',139)$$;
grant execute on function public.get_app_release() to anon,authenticated;
