-- B131: People selects deleted_at for archived records. Keep all sensitive columns private.
grant select(deleted_at) on public.users to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_build',131)
$$;
notify pgrst,'reload schema';
