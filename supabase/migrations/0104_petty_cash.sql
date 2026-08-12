-- =====================================================================
-- 0104 — wishlist ข้อ 3: เงินสดย่อย (petty cash, ระบบ imprest)
--   petty_cash_funds   — ตั้งค่ากองทุนเงินสดย่อย 1 กองทุนต่อ (tenant, customer) — เก็บยอดเงินสดย่อย
--     คงที่ (float_amount), บัญชีเงินสดย่อย (cash_account_code), บัญชีต้นทาง (source_account_code)
--     ที่ใช้เติมเงินคืนตอนเคลียร์ — ★ ไม่เก็บยอดคงเหลือ (คำนวณสดจาก float_amount − ยอด voucher ที่ยัง
--     pending เสมอ เหมือน billOutstanding — กันข้อมูลไม่ตรงกันจาก 2 แหล่ง)
--   petty_cash_vouchers — รายการเบิก/ใช้เงินสดย่อยทีละใบ (ใบสำคัญจ่ายย่อย) — status='pending' จนกว่าจะ
--     ถูกเคลียร์รวมเป็น manual JE ใบเดียว (settled_je_id) แล้วเปลี่ยนเป็น 'settled'
--
--   ★ รหัสบัญชีไม่ hardcode FK จริง (เก็บเป็น text ตรงกับ chart_of_accounts.code — mirror
--     platform_report_settings/payroll_settings) เลือกผ่าน AccountCombobox เท่านั้น
--   ★ ค่า default cash_account_code='1015' (เงินสดย่อย, seed ไว้แล้วจาก migration 0063)
-- =====================================================================

create table if not exists public.petty_cash_funds (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  fund_name           text not null default 'เงินสดย่อย',
  float_amount        numeric(14,2) not null default 0 check (float_amount >= 0),
  cash_account_code   text not null default '1015',
  source_account_code text not null default '1020',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists uq_petty_cash_funds_tenant_customer
  on public.petty_cash_funds (tenant_id, customer_id);

drop trigger if exists trg_petty_cash_funds_updated on public.petty_cash_funds;
create trigger trg_petty_cash_funds_updated before update on public.petty_cash_funds
  for each row execute function public.set_updated_at();

create table if not exists public.petty_cash_vouchers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  fund_id             uuid not null references public.petty_cash_funds(id) on delete cascade,
  voucher_date        date not null,
  description         text,
  category_account_code text not null,
  amount              numeric(14,2) not null check (amount > 0),
  receipt_no          text,
  status              text not null default 'pending' check (status in ('pending', 'settled')),
  settled_je_id        uuid references public.manual_journal_entries(id) on delete set null,
  settled_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists idx_petty_cash_vouchers_fund
  on public.petty_cash_vouchers (fund_id) where deleted_at is null;
create index if not exists idx_petty_cash_vouchers_tenant_customer
  on public.petty_cash_vouchers (tenant_id, customer_id) where deleted_at is null;

drop trigger if exists trg_petty_cash_vouchers_updated on public.petty_cash_vouchers;
create trigger trg_petty_cash_vouchers_updated before update on public.petty_cash_vouchers
  for each row execute function public.set_updated_at();

alter table public.petty_cash_funds enable row level security;
drop policy if exists tenant_read on public.petty_cash_funds;
create policy tenant_read on public.petty_cash_funds for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.petty_cash_funds from anon;
grant select on public.petty_cash_funds to authenticated;
grant all    on public.petty_cash_funds to service_role;

alter table public.petty_cash_vouchers enable row level security;
drop policy if exists tenant_read on public.petty_cash_vouchers;
create policy tenant_read on public.petty_cash_vouchers for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.petty_cash_vouchers from anon;
grant select on public.petty_cash_vouchers to authenticated;
grant all    on public.petty_cash_vouchers to service_role;

notify pgrst, 'reload schema';
