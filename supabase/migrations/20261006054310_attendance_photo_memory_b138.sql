-- Client photo compression release; no attendance or payroll data changes.
CREATE OR REPLACE FUNCTION public.get_app_release()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $$ select jsonb_build_object('schema_build',138) $$;
