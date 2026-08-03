-- =====================================================================
-- 0054 — ยอดยกมาต่อบัญชี ต่อลูกค้า (account_opening_balances)
-- =====================================================================
-- บริบท (เตรียมออกงบการเงิน double-entry):
--   เพื่อให้งบดุลสมดุล ต้องมี "ยอดยกมาต้นงวด" ต่อบัญชีต่อลูกค้า
--   (เงินสด/เงินฝาก/ลูกหนี้/เจ้าหนี้/ทุน/กำไรสะสม ยกมาจากงวดก่อน).
--
--   1 แถว = ยอดยกมาของ 1 บัญชี (account_code) ของ 1 ลูกค้า
--     opening_balance : ยอดยกมา (บวก=ยอดเดบิต / ลบ=ยอดเครดิต — ตามหลักบัญชี)
--     account_name    : ชื่อบัญชี ณ เวลานำเข้า (ผังกลางอาจปรับชื่อภายหลัง)
--
--   ★ tenant-scoped + RLS (pattern 0046/0051): authenticated อ่านอย่างเดียว,
--     write ผ่าน service_role (server action ที่ guard admin + customer scope).
--   ★ soft-delete (deleted_at) — ไม่ลบจริง.
--   ★ unique (customer_id, account_code) where ยังไม่ลบ — 1 ลูกค้า 1 บัญชี 1 ยอดยกมา
--
-- non-destructive: สร้างตารางใหม่ตัวเดียว ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.account_opening_balances (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id)   on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  account_code    text not null,
  account_name    text,
  opening_balance numeric(16,2) not null default 0,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

-- list ตาม tenant/ลูกค้า (เฉพาะที่ยังไม่ลบ)
create index if not exists idx_account_opening_balances_tenant_customer
  on public.account_opening_balances (tenant_id, customer_id)
  where deleted_at is null;

-- ★ กันยอดยกมาซ้ำ: 1 ลูกค้า ผูก 1 รหัสบัญชีได้ครั้งเดียว (ที่ยังไม่ลบ) — รองรับ upsert
create unique index if not exists uq_account_opening_balances_active
  on public.account_opening_balances (customer_id, account_code)
  where deleted_at is null;

create trigger trg_account_opening_balances_updated before update on public.account_opening_balances
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0046/0051)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin)
--   service_role  : all
-- =====================================================================
alter table public.account_opening_balances enable row level security;

create policy tenant_read on public.account_opening_balances for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- GRANT posture (pattern 0046/0051)
revoke all on public.account_opening_balances from anon;
grant select on public.account_opening_balances to authenticated;
grant all    on public.account_opening_balances to service_role;

-- reload PostgREST schema cache (ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
