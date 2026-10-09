-- B148: do not let other daily activity push saved orders out of the workspace.
-- Preserve the existing function's authorization checks and all business data.
do $migration$
declare definition text;old_fragment text := 'order by a.created_at desc limit 30)r)';
begin
 select pg_get_functiondef('private.cigarette_workspace(integer,date)'::regprocedure) into definition;
 if position(old_fragment in definition)=0 then raise exception 'Unexpected cigarette workspace definition';end if;
 execute replace(definition,old_fragment,'order by a.created_at desc)r)');
end $migration$;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',148) $f$;
