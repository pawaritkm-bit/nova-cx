-- =====================================================================
-- 0064 — สินค้า/บริการ (products) : Product Master ต่อ tenant
-- =====================================================================
-- บริบท: เฟส 1 ส่วน B (docs/06-accounting-features-roadmap.md) — เพิ่มตัวช่วย "เลือกสินค้า/บริการ"
--   ในบรรทัดบิล เพื่อ prefill รายละเอียด+รหัสบัญชีที่ใช้ลงบัญชีเป็นประจำ — ★ ไม่กระทบ engine บัญชี
--   ที่มีอยู่แล้วแม้แต่จุดเดียว (bill_entry_lines ยังคำนวณจาก amount/vat/wht ต่อบรรทัดเหมือนเดิมทุกอย่าง)
--
--   ★ tenant-scoped (เหมือนผังบัญชี — 1 tenant = 1 สำนักงานบัญชี ดูแลลูกค้าหลายบริษัท)
--   ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
--   ★ default_account_code = "ข้อความ" ตรงตัวอักษรกับ chart_of_accounts.code เท่านั้น (ไม่ใช้ FK จริง —
--     pattern เดียวกับ bill_entry_lines.account_code เดิม ที่ engine อ่านชื่อ/รหัสที่เก็บไว้ ณ ตอนนั้น
--     ไม่ join สดกับผังปัจจุบันเสมอ) — ใช้แค่ตอน "เลือกสินค้าใหม่"/prefill เท่านั้น
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.products (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  sku                   text,
  name                  text not null,
  unit                  text,
  default_price         numeric(14,2),
  default_account_code  text,     -- ตรงตัวอักษรกับ chart_of_accounts.code (ไม่ใช่ FK จริง)
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

create unique index if not exists uq_products_tenant_sku
  on public.products (tenant_id, sku) where deleted_at is null and sku is not null;
create index if not exists idx_products_tenant_active
  on public.products (tenant_id) where deleted_at is null;

drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;
drop policy if exists tenant_read on public.products;
create policy tenant_read on public.products for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.products from anon;
grant select on public.products to authenticated;
grant all on public.products to service_role;

notify pgrst, 'reload schema';
