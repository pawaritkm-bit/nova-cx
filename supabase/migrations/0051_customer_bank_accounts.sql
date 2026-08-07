-- =====================================================================
-- 0051 — บัญชีเงินฝากธนาคาร "ต่อลูกค้า" (customer_bank_accounts)
-- =====================================================================
-- บริบท (ต่อจาก 0050 ผังบัญชีต่อบรรทัด):
--   ผังบัญชีกลาง (lib/accounting/chart-of-accounts.ts) มีบัญชีเงินฝากธนาคาร 3 รายการ
--   (code 1020/1025/1030) ที่เดิมเก็บ "เลขบัญชีจริงของบริษัทเดียว" เป็นชื่อบัญชี
--   → ใช้ร่วมทุกลูกค้าไม่ได้ (เลขบัญชีหลุดข้ามบริษัท = PDPA).
--
--   เฟสนี้ genericize ผังกลาง (ชื่อเป็น "เงินฝากธนาคาร #1/#2/#3") แล้วย้าย
--   "เลขบัญชีจริง" มาเก็บต่อลูกค้าในตารางนี้ — 1 ลูกค้ามีได้หลายบัญชีเงินฝาก
--   (ผูกกับรหัสผังเงินฝาก account_code เช่น 1020). หน้าตรวจบิลเลือกบัญชีของ
--   "ลูกค้าเจ้าของบิล" เท่านั้น (ไม่เห็นของบริษัทอื่น).
--
--   ★ tenant-scoped + RLS (pattern 0046/0050): authenticated อ่านอย่างเดียว,
--     write ผ่าน service_role (server action ที่ guard admin + customer scope).
--   ★ soft-delete (deleted_at) เหมือน bill_entries — ไม่ลบจริง.
--
-- non-destructive: สร้างตารางใหม่ตัวเดียว ไม่แตะตาราง/flow เดิม
-- =====================================================================

-- ---------------------------------------------------------------------
-- customer_bank_accounts — บัญชีเงินฝากธนาคารของลูกค้า (1 แถว = 1 บัญชี)
--   account_code : รหัสผังบัญชีเงินฝาก (1020/1025/1030) ที่บัญชีนี้ผูกอยู่
--   bank_name    : ชื่อธนาคาร/ชื่อบัญชี (เช่น "กสิกรไทย") — โชว์ใน picker
--   account_no   : เลขที่บัญชี (เช่น 210-1-77368-2)
--   sort         : ลำดับแสดง (น้อย→มากก่อน)
-- ---------------------------------------------------------------------
create table if not exists public.customer_bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id)   on delete cascade,
  customer_id  uuid not null references public.customers(id) on delete cascade,
  account_code text not null,
  bank_name    text,
  account_no   text,
  sort         int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- list ตาม tenant/ลูกค้า (เฉพาะที่ยังไม่ลบ)
create index if not exists idx_customer_bank_accounts_tenant_customer
  on public.customer_bank_accounts (tenant_id, customer_id)
  where deleted_at is null;

-- ★ กันบัญชีซ้ำ: 1 ลูกค้า ผูก 1 รหัสผังเงินฝากได้ครั้งเดียว (ที่ยังไม่ลบ)
create unique index if not exists uq_customer_bank_accounts_active
  on public.customer_bank_accounts (customer_id, account_code)
  where deleted_at is null;

create trigger trg_customer_bank_accounts_updated before update on public.customer_bank_accounts
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0046/0050)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin)
--   service_role  : all
-- =====================================================================
alter table public.customer_bank_accounts enable row level security;

create policy tenant_read on public.customer_bank_accounts for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- GRANT posture (pattern 0046)
revoke all on public.customer_bank_accounts from anon;
grant select on public.customer_bank_accounts to authenticated;
grant all    on public.customer_bank_accounts to service_role;

-- reload PostgREST schema cache (ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
