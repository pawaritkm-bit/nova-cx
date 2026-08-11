-- =====================================================================
-- 0094 — เฟส 9b กลุ่ม BC/ข้อ3 (docs/06-accounting-features-roadmap.md, หมวด 0.5)
--   `payroll_monthly_filings` — เอนทิตีใหม่ เป็นเจ้าของสถานะยื่น ภ.ง.ด.1/สปส.1-10 ตัวจริง (1 แถวต่อ
--   tenant+customer+ปี+เดือน) เพราะภาระผูกพันยื่นภาษี/ประกันสังคมเป็นรายเดือนเสมอไม่ว่าลูกค้าจะจ่ายเงินเดือน
--   ถี่แค่ไหน — `payroll_runs.filing_period_id` (migration 0095) ชี้มาที่แถวนี้ (หลายรอบจ่ายในเดือนเดียวกัน
--   ชี้แถวเดียวกันได้)
--
--   ★ unique (tenant_id, customer_id, period_year, period_month) — 1 หน่วยยื่นต่อเดือนต่อลูกค้าเท่านั้น
--   ★ pit_filed_by/sso_filed_by ชี้ public.employees (นักบัญชี Finovas ผู้กดยืนยัน) เหมือน payroll_runs เดิม
--     (0082) ไม่ใช่ payroll_employees (พนักงานลูกค้า)
--   ★ RLS mirror payroll_runs (0082) เป๊ะ — tenant_read select authenticated, revoke anon,
--     service_role เขียนได้ทุกกรณี (แอปเขียนผ่าน service-role client เหมือนตารางอื่นในเฟส 9 ทั้งหมด)
-- =====================================================================

create table if not exists public.payroll_monthly_filings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  period_year       int not null check (period_year between 2500 and 2700),
  period_month      int not null check (period_month between 1 and 12),
  pit_filing_status text not null default 'not_filed' check (pit_filing_status in ('not_filed', 'filed')),
  pit_filed_at      timestamptz,
  pit_filed_by      uuid references public.employees(id) on delete set null,
  sso_filing_status text not null default 'not_filed' check (sso_filing_status in ('not_filed', 'filed')),
  sso_filed_at      timestamptz,
  sso_filed_by      uuid references public.employees(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists uq_payroll_monthly_filings_period
  on public.payroll_monthly_filings (tenant_id, customer_id, period_year, period_month);
create index if not exists idx_payroll_monthly_filings_customer
  on public.payroll_monthly_filings (tenant_id, customer_id);

drop trigger if exists trg_payroll_monthly_filings_updated on public.payroll_monthly_filings;
create trigger trg_payroll_monthly_filings_updated before update on public.payroll_monthly_filings
  for each row execute function public.set_updated_at();

alter table public.payroll_monthly_filings enable row level security;
drop policy if exists tenant_read on public.payroll_monthly_filings;
create policy tenant_read on public.payroll_monthly_filings for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_monthly_filings from anon;
grant select on public.payroll_monthly_filings to authenticated;
grant all    on public.payroll_monthly_filings to service_role;

notify pgrst, 'reload schema';
