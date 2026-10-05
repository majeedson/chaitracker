-- B135: People collapses inactive staff by default; no staff data changes.
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',135) $$;
notify pgrst,'reload schema';
