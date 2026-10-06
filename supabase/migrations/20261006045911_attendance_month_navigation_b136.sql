-- B136: attendance month navigation and ascending history; no attendance data changes.
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',136) $$;
notify pgrst,'reload schema';
