-- =====================================================================
-- 0081 — เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.11)
--   ตั้งค่าบัญชีที่ใช้เมื่อสร้างรายการบัญชี (JE) จากรอบเงินเดือน — 1 แถวต่อ (tenant, customer)
--
--   ★ 0.11 รหัสบัญชีไม่ hardcode FK จริง (เก็บเป็น text ตรงกับ chart_of_accounts.code — mirror
--     fixed_assets/0076 และ manual_journal_entry_lines เดิม) เลือกผ่าน AccountCombobox เท่านั้น —
--     ค่า default ที่แนะนำ (5310/2910 มีอยู่แล้ว, 5311/2050 seed ใหม่ใน 0084) ยังแก้เป็นรหัสอื่นได้เสมอ
--   ★ other_deductions_account_code/net_pay_account_code เป็น nullable ตั้งใจ (ยังไม่ตั้งได้ตอนเริ่มต้น
--     แต่บังคับกรอก net_pay_account_code ก่อนสร้าง JE ได้จริง — validate ที่ชั้นแอปพลิเคชัน lib/accounting/
--     payroll.ts ไม่ใช่ DB constraint)
-- =====================================================================

create table if not exists public.payroll_settings (
  id                                uuid primary key default gen_random_uuid(),
  tenant_id                         uuid not null references public.tenants(id) on delete cascade,
  customer_id                       uuid not null references public.customers(id) on delete cascade,
  salary_expense_account_code       text not null default '5310',
  sso_employer_expense_account_code text not null default '5311',
  sso_payable_account_code          text not null default '2050',
  pit_payable_account_code          text not null default '2910',
  other_deductions_account_code     text,
  net_pay_account_code              text,
  net_pay_is_paid_immediately       boolean not null default false,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);
create unique index if not exists uq_payroll_settings_tenant_customer
  on public.payroll_settings (tenant_id, customer_id);

drop trigger if exists trg_payroll_settings_updated on public.payroll_settings;
create trigger trg_payroll_settings_updated before update on public.payroll_settings
  for each row execute function public.set_updated_at();

alter table public.payroll_settings enable row level security;
drop policy if exists tenant_read on public.payroll_settings;
create policy tenant_read on public.payroll_settings for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_settings from anon;
grant select on public.payroll_settings to authenticated;
grant all    on public.payroll_settings to service_role;

notify pgrst, 'reload schema';
