# Build 128 payroll and access corrections

This release fixes the defects reviewed against `462452ab2bff03ee55a0588762d4e8642eb4a388`. Historical payroll, advance and transfer records are not automatically rewritten.

## Confirmed rules

- Three days off retain full monthly basic. More than three offs use days worked × basic ÷ 30, capped at basic, in both 30- and 31-day periods.
- Unused paid offs earn holiday duty at basic ÷ 30. Missing or conflicting attendance does not generate holiday pay automatically.
- Half days deduct basic ÷ 60. Approved half-day leave waives all lateness on that date. An unpunched half-day leave remains unrecorded pending reconciliation.
- Daily lateness tiers: through 15 minutes = zero, 16–30 = half an hour, above 30 = ceiling(minutes ÷ 60). Sum daily hours and deduct at basic ÷ 360, rounding the monetary result once.
- Advance EMI begins in the salary period containing payout. Later payouts are excluded; missed installments carry forward. New payouts preserve their joining anchor against profile corrections.
- Earlier petty advances, approved advance EMI and loan deductions remain separate. Overtime remains an explicit owner credit. Explicit owner overrides remain editable.

## Exact defect-to-fix mapping

| Priority | Defect | Implementation |
| --- | --- | --- |
| P1 | Summary Advance payout bypassed approval/EMI | Migration `save_daily_summary`; app `renderDailySummary` preserves legacy rows unchanged and routes new advances through approval/payout |
| P1 | Prior overlapping payroll appeared current | Migration `get_salary_payroll_context` selects by start month and carries the prior loan balance |
| P1 | February clamping lost days for joins 29–31 | `src/payrollRules.js`: `salaryPeriodEnd`; migration `private.salary_period_start`, `salary_period_containing`, `salary_period_end` |
| P1 | Staff and owner disagreed on three offs/holiday duty | Migration `get_salary_estimate_internal`, `save_salary_payroll`; app `renderSalary`, `renderOwnerSalaryProcessor` |
| P1 | Approved full leave without punches was ignored | Migration `get_salary_estimate_internal`; app `renderSalary` displays leave-only estimates; calendar flags conflicting punches |
| P1 | Aggregated late tiers and half-day waivers disagreed | Migration `private.payroll_late_hours`, `get_salary_estimate_internal`, `get_attendance_calendar`, `save_salary_payroll`; app chargeable-hours override |
| P1 | Draft net omitted EMI shown in its details | Migration `save_salary_payroll` includes EMI in net/totals without posting until finalization |
| P1 | Future advances/calendar EMI crossed rolling periods | Migration `private.advance_due`, `get_salary_estimate_v2`, `pay_staff_advance` use actual payout and period end |
| P1 | Date/amount/selection revisions detached posted ledgers | Migration `save_salary_payroll` locks posted dates/transfer amounts/selections; app blocks payment with unsaved changes |
| P1 | Oldest-300 transfer limit omitted newer earnings | Migration `get_salary_transfer_payments`; `src/payrollData.js`: `loadSalaryTransfers` filters server-side and pages by ID |
| P2 | Summary grant exposed colleagues' reasons/EMI | Remove `advance_summary_reconciliation`; `get_summary_advances` returns only reconciliation fields |
| P2 | Profile lost selected staff/unsaved salary; stale saves overwrote salary/access | App `renderPeople`, `renderWorkspace`, `renderSalary`, `renderAttendance`; migration `owner_save_staff_profile` saves atomically and rejects stale snapshots |
| Release | No frontend/database release gate | `scripts/check-release.mjs`, `.github/workflows/deploy-pages.yml`, runtime `get_app_release`; app, HTML and manifest all Build 128 |

Salary access remains independent of the five configurable domains, including Transfers. The legacy combined profile updater and calendar-only finalizer cannot be called by browser clients.

Existing payrolls retain their original café when staff profiles move café. An owner may edit a READY transfer before first posting; finalization records that amount in both salary and payment ledger, then locks it.

## Verification and deployment

Run `npm ci`, `npm test`, `npm run check:release` and `npm run build`. The 36 tests use synthetic local PGlite PostgreSQL fixtures and DOM mocks; they do not write production business data.

1. Apply `supabase/migrations/20261002125447_payroll_access_b128.sql` to the existing Build 127 database. Older root SQL files describe historical migrations, not a fresh bootstrap.
2. Confirm `get_app_release()` returns schema build 128. Run `npm run check:database` with the normal public Supabase URL/key and review security/performance advisors.
3. Publish the matching frontend. CI blocks publication against an older/missing schema release; runtime Salary, People and Summary also refuse to open against an older schema.
4. Smoke-check Staff with Summary granted/Transfers revoked, Manager with Summary revoked, and Owner profile-to-payroll navigation. Refresh editors opened before the update.

The migration changes payroll functions and removes the broad Summary policy, adding one nullable repayment anchor column. Existing finalized/paid records and their postings are preserved. Historical discrepancies require explicit reconciliation. Old browser profile saves are rejected after migration until users refresh.

Keep database and frontend changes together. Rolling back only the frontend restores obsolete calls; restoring older SQL would also restore the reviewed vulnerabilities. Pause payroll writes during a coordinated rollback.
