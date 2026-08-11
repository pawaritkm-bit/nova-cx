-- =====================================================================
-- 0098 — เฟส 9b กลุ่ม BG/ข้อ7 (docs/06-accounting-features-roadmap.md, หมวด 0.6, T169)
--   `payroll_filing_reminders` — log กันแจ้งเตือนซ้ำวันครบกำหนดยื่น ภ.ง.ด.1/สปส.1-10
--
--   ★ ไม่ reuse `job_queue` (ผูกกับ LINE survey เฉพาะทาง — ดูคอมเมนต์เต็มใน
--   lib/accounting/payroll-filing-reminders.ts) — สร้างเอนทิตีใหม่แยกอิสระสมบูรณ์ ไม่มี LINE/อีเมลออกจริง
--   ★ unique (filing_period_id, kind, reminder_stage) — กัน cron รันซ้ำวันเดียวกัน (หรือหลายครั้งในวันเดียว)
--   insert แถวเดิมซ้ำ — สร้างแถวใหม่ได้เมื่อ stage เปลี่ยน (due_soon → due_today → overdue) เท่านั้น
--   ★ เป็น log ล้วน (append-only, ไม่มี update) — mirror `recurring_journal_generation_log` (0073): ไม่มี
--   updated_at/trigger
--   ★ RLS mirror payroll_monthly_filings (0094) เป๊ะ — tenant_read select authenticated, revoke anon,
--   service_role เขียนได้ทุกกรณี (cron เขียนผ่าน service-role client เท่านั้น)
-- =====================================================================

create table if not exists public.payroll_filing_reminders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  filing_period_id  uuid not null references public.payroll_monthly_filings(id) on delete cascade,
  kind              text not null check (kind in ('pit', 'sso')),
  reminder_stage    text not null check (reminder_stage in ('due_soon', 'due_today', 'overdue')),
  deadline          date not null,
  created_at        timestamptz not null default now()
);

create unique index if not exists uq_payroll_filing_reminders_dedup
  on public.payroll_filing_reminders (filing_period_id, kind, reminder_stage);
create index if not exists idx_payroll_filing_reminders_tenant
  on public.payroll_filing_reminders (tenant_id);
create index if not exists idx_payroll_filing_reminders_period
  on public.payroll_filing_reminders (filing_period_id);

alter table public.payroll_filing_reminders enable row level security;
drop policy if exists tenant_read on public.payroll_filing_reminders;
create policy tenant_read on public.payroll_filing_reminders for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_filing_reminders from anon;
grant select on public.payroll_filing_reminders to authenticated;
grant all    on public.payroll_filing_reminders to service_role;

notify pgrst, 'reload schema';
