# ChaiTracker

ChaiTracker is the operational web/PWA application for Teapot and ChaiCafe.

## Migration architecture
- Frontend: Vite + vanilla JavaScript
- Database: Supabase PostgreSQL
- Storage: Supabase Storage
- Authentication: Supabase Auth (migration from legacy name/PIN is planned)
- Legacy Apps Script app remains available during migration

## Development principles
- Preserve the existing ChaiTracker UI and workflows.
- Supabase is the target source of truth.
- Keep RLS enabled on every exposed public table. Add narrow policies and guarded RPCs for new workflows, and test anonymous, staff, manager, and owner access before deployment.
- Keep business-date logic, stock, purchases, attendance, daily summary, PO, delta and salary behavior aligned with the legacy application.
- Outlet opening hours support seasonal effective date ranges.

## Local development
1. Copy `.env.example` to `.env.local`.
2. Add the Supabase project URL and publishable/anon key.
3. Install dependencies with `npm install`.
4. Start with `npm run dev`.

Staging deployment refresh: latest login flow.
