-- UI-only release: retain the existing schema and permissions.
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',146) $f$;
