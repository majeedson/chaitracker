-- Defense in depth: remove inherited Data API table grants. Mutations are RPC-only.
revoke all on public.staff_advance_requests,public.staff_advance_deductions from public,anon,authenticated;
grant select on public.staff_advance_requests,public.staff_advance_deductions to authenticated;
