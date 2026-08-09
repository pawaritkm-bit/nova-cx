-- =====================================================================
-- 0071 — mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้า
-- =====================================================================
-- บริบท: เฟส 5 ส่วน Q (docs/06-accounting-features-roadmap.md) — ผังบัญชี/สินค้า (chart_of_accounts/
--   products, migration 0063/0064) เป็น tenant-scoped (ใช้ร่วมทุกลูกค้าในเชิงนิยาม) แต่ FlowAccount
--   ของแต่ละลูกค้าเป็นบัญชีแยกกันจริง (credential ต่อลูกค้า M2) → รหัสฝั่ง FlowAccount ของแต่ละลูกค้า
--   ไม่จำเป็นตรงกัน (decision 0.9) → mapping ต้อง scope ต่อ (tenant_id, customer_id)
--
--   ★ ไม่ soft-delete (decision 0.10) — เป็น config lookup ธรรมดา เทียบเท่า
--     customers.flowaccount_client_id ที่ overwrite/null ตรง ๆ ไม่ต้องมี audit trail
--   ★ กรอกแบบ manual text-entry (decision 0.12) — ไม่ live-fetch จาก FlowAccount
--   ★ สิทธิ์แก้ mapping — per-customer เหมือน credential (decision 0.11) ไม่ใช่ admin-only
--
-- non-destructive: สร้างตารางใหม่ 2 ตัว ไม่แตะตาราง/flow เดิม
-- =====================================================================

-- mapping ผังบัญชี nova-cx → FlowAccount ต่อลูกค้า (scope: tenant + customer, ดู decision 0.9)
create table if not exists public.flowaccount_account_map (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  customer_id               uuid not null references public.customers(id) on delete cascade,
  account_code              text not null,   -- ตรงตัวกับ chart_of_accounts.code (ไม่ใช่ FK จริง — เหมือน bill_entry_lines.account_code)
  flowaccount_account_code  text not null,   -- รหัสบัญชีฝั่ง FlowAccount ของลูกค้ารายนี้ (กรอกเอง — ดู decision 0.12)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create unique index if not exists uq_flowaccount_account_map
  on public.flowaccount_account_map (tenant_id, customer_id, account_code);
drop trigger if exists trg_flowaccount_account_map_updated on public.flowaccount_account_map;
create trigger trg_flowaccount_account_map_updated before update on public.flowaccount_account_map
  for each row execute function public.set_updated_at();

-- mapping สินค้า/บริการ nova-cx → FlowAccount ต่อลูกค้า
create table if not exists public.flowaccount_product_map (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  customer_id            uuid not null references public.customers(id) on delete cascade,
  product_id             uuid not null references public.products(id) on delete cascade,
  flowaccount_product_id text not null,  -- id ฝั่ง FlowAccount (เก็บเป็น text — parse เป็น number ตอนสร้าง payload)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_flowaccount_product_map
  on public.flowaccount_product_map (tenant_id, customer_id, product_id);
drop trigger if exists trg_flowaccount_product_map_updated on public.flowaccount_product_map;
create trigger trg_flowaccount_product_map_updated before update on public.flowaccount_product_map
  for each row execute function public.set_updated_at();

-- RLS: tenant isolation (pattern 0051 customer_bank_accounts)
alter table public.flowaccount_account_map enable row level security;
drop policy if exists tenant_read on public.flowaccount_account_map;
create policy tenant_read on public.flowaccount_account_map for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.flowaccount_account_map from anon;
grant select on public.flowaccount_account_map to authenticated;
grant all    on public.flowaccount_account_map to service_role;

alter table public.flowaccount_product_map enable row level security;
drop policy if exists tenant_read on public.flowaccount_product_map;
create policy tenant_read on public.flowaccount_product_map for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.flowaccount_product_map from anon;
grant select on public.flowaccount_product_map to authenticated;
grant all    on public.flowaccount_product_map to service_role;

notify pgrst, 'reload schema';
