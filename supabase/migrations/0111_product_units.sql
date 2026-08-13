-- =====================================================================
-- 0111 — หลายหน่วยนับต่อสินค้า (Product Units) — wishlist backlog ข้อ 2
--
--   สินค้า 1 รายการมี "หน่วยหลัก" อยู่แล้ว (products.unit เดิม — ไม่แตะ/ไม่ migrate ข้อมูลเดิม) และ
--   สามารถเพิ่ม "หน่วยย่อย/ใหญ่" เพิ่มเติมได้ต่อสินค้า พร้อมตัวคูณแปลงกลับเป็นหน่วยหลัก (factor_to_base)
--   เช่น สินค้า "ผ้าไหม" หน่วยหลัก = ชิ้น (factor 1 โดยนัย) + เพิ่ม "โหล" (factor_to_base=12) + "ลัง"
--   (factor_to_base=288) ได้ตามต้องการ
--
--   ★ ตามที่ระบุไว้แล้วตอนสร้าง stock engine (เฟส 8 ส่วน Y, 0.3): "ไม่ทำระบบแปลงหน่วย ... เป็น
--     backlog แยกถ้าจำเป็นจริง" — นี่คือ backlog นั้น
--   ★ ออกแบบให้กระทบ product-stock.ts น้อยที่สุด: bill_entry_lines.quantity/product_stock_movements
--     .quantity ยังคง "หน่วยหลักเสมอ" เหมือนเดิมทุกอย่าง (ไม่มีคอลัมน์ unit ใน product_stock_movements)
--     — การแปลงหน่วยเกิดขึ้น "ตอนสร้าง movement จากบิล" เท่านั้น (คูณด้วย factor_to_base ก่อน insert)
--     ดังนั้น moving-average cost math (computeStockLedger) ไม่ต้องแก้เลยแม้แต่บรรทัดเดียว
--   ★ bill_entry_lines.unit_id = null (ค่าเริ่มต้น/บิลเก่าทุกใบ) หมายถึง "กรอกเป็นหน่วยหลักอยู่แล้ว"
--     (factor = 1) — เข้ากันได้ย้อนหลัง 100% ไม่กระทบบิลที่มีอยู่แล้วเลย
--   ★ ไม่กระทบ engine บัญชี (amount/vat/wht ต่อบรรทัดยังเป็นของจริงเหมือนเดิมทุกอย่าง) — ตารางนี้แค่ช่วย
--     "แปลงจำนวน" ก่อนบันทึกสต็อกเท่านั้น
--
-- non-destructive: สร้างตารางใหม่ + เพิ่มคอลัมน์ nullable ใหม่ 1 คอลัมน์ ไม่แตะ/ลบของเดิม
-- =====================================================================

create table if not exists public.product_units (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  product_id       uuid not null references public.products(id) on delete cascade,
  unit_name        text not null,
  -- จำนวนหน่วยหลัก (products.unit) ต่อ 1 หน่วยนี้ — เช่น "โหล" → 12 (1 โหล = 12 ชิ้น)
  factor_to_base   numeric(14,4) not null check (factor_to_base > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create unique index if not exists uq_product_units_product_name
  on public.product_units (tenant_id, product_id, unit_name) where deleted_at is null;
create index if not exists idx_product_units_product
  on public.product_units (tenant_id, product_id) where deleted_at is null;

drop trigger if exists trg_product_units_updated on public.product_units;
create trigger trg_product_units_updated before update on public.product_units
  for each row execute function public.set_updated_at();

-- ★ หน่วยที่กรอกบรรทัดนี้ (null = หน่วยหลักของสินค้า, factor=1) — ไม่บังคับ, ไม่กระทบบิลเก่า
alter table public.bill_entry_lines
  add column if not exists unit_id uuid references public.product_units(id) on delete set null;

alter table public.product_units enable row level security;

drop policy if exists tenant_read on public.product_units;
create policy tenant_read on public.product_units for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.product_units from anon;
grant select on public.product_units to authenticated;
grant all on public.product_units to service_role;

notify pgrst, 'reload schema';
