-- =====================================================================
-- 0108 — คลังสินค้าหลายที่ (wishlist ข้อ 8)
--   ★★ สโคปที่ยืนยัน: เพิ่ม "คลัง" เป็นมิติ tracking บน product_stock_movements เท่านั้น — ต้นทุนถ่วง
--   เฉลี่ยเคลื่อนที่ (moving average) ยัง "global ต่อสินค้า" เหมือนเดิมทุกประการ (ไม่แยกคำนวณต่อคลัง) —
--   computeStockLedger (lib/accounting/product-stock.ts) ไม่ต้องแก้อะไรเลย ยัง replay ทุก movement
--   ของสินค้านั้นรวมกันเหมือนเดิม 100%
--
--   ★ product_opening_balances ไม่แตะเลย — ยอดยกมาถือเป็นของ "คลังหลัก" (default warehouse) โดยนัย
--     เพื่อการรายงานเท่านั้น ไม่มีคอลัมน์ warehouse_id เพิ่ม (0.11 เดิมไม่มีคอลัมน์วันที่อยู่แล้ว เช่นกัน)
--   ★ ไม่แตะ bill_entry_lines/EntryEditor.tsx เลย (ไฟล์เสี่ยงสูงสุด/ใช้บ่อยที่สุด — mirror หลักการเฟส 8
--     เดิมที่ไม่แตะ accounting/actions.ts) — รายการจากบิล (purchase/sale) ผูกกับ "คลังหลัก" ของลูกค้า
--     อัตโนมัติเสมอ (getOrCreateDefaultWarehouse ที่ lib/accounting/product-stock.ts) — การเลือกคลังอื่น
--     ทำได้ผ่านฟอร์มปรับปรุงมือ + ฟอร์มโอนสินค้าระหว่างคลังเท่านั้น (ความเสี่ยงต่ำกว่า)
--   ★ เพิ่ม movement_type ใหม่ 2 ตัว transfer_in/transfer_out (แทนการใช้ adjustment_in/out ซ้ำ — เพื่อ
--     ป้าย UI ชัดเจนว่าเป็นการโอนคลัง ไม่ใช่ปรับปรุงยอดจริง) — คู่ transfer_out+transfer_in วันเดียวกัน
--     จำนวนเท่ากัน โดย transfer_in ใส่ unit_cost = ต้นทุนเฉลี่ยปัจจุบัน (คำนวณที่ชั้น TS ก่อนเรียก RPC) —
--     qty รวมทั้งสินค้าไม่เปลี่ยนแน่นอนเสมอ (out −Q, in +Q หักกันพอดี) ส่วน "มูลค่ารวม" (totalValue) จะไม่
--     เปลี่ยนก็ต่อเมื่อไม่มี movement อื่นของสินค้า/ลูกค้าเดียวกันแทรกระหว่างคำนวณต้นทุนเฉลี่ยกับตอนบันทึก
--     จริง (TOCTOU) และไม่ได้เลือกวันโอนย้อนหลังทั้งที่มี movement คั่นอยู่หลังจากนั้น — ยอมรับความคลาดเคลื่อน
--     นี้เหมือนกับ adjustment_in ที่ก็รับ unit_cost จากผู้ใช้ตรง ๆ เช่นกัน (ดูรายละเอียดที่ createStockTransfer
--     ใน lib/accounting/product-stock.ts)
--   ★ RPC create_stock_transfer — insert 2 แถว (out+in) ในทรานแซกชันเดียว (atomic) — mirror
--     set_bill_installment_plan (migration 0107) กันเคสล้มเหลวครึ่งทาง (มีแค่ out ไม่มี in ค้างอยู่)
-- =====================================================================

-- ---------------------------------------------------------------------
-- warehouses — คลังสินค้าต่อลูกค้า 1 ราย (ไม่ผูก tenant เดียวใช้ร่วมข้ามลูกค้า — คลังเป็นของลูกค้ารายนั้น)
-- ---------------------------------------------------------------------
create table if not exists public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)   on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  name        text not null check (char_length(trim(name)) > 0 and char_length(name) <= 200),
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_warehouses_tenant_customer
  on public.warehouses (tenant_id, customer_id)
  where deleted_at is null;

-- กันชื่อคลังซ้ำ (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ในลูกค้าเดียวกัน (เฉพาะที่ยังไม่ลบ)
create unique index if not exists uq_warehouses_customer_name
  on public.warehouses (customer_id, lower(name))
  where deleted_at is null;

-- กันมีคลัง default ซ้ำ 2 คลังต่อลูกค้า (เฉพาะที่ยังไม่ลบ) — getOrCreateDefaultWarehouse พึ่ง constraint นี้
create unique index if not exists uq_warehouses_customer_default
  on public.warehouses (customer_id)
  where is_default = true and deleted_at is null;

create trigger trg_warehouses_updated before update on public.warehouses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- product_stock_movements.warehouse_id — nullable (แถวเก่า backfill ด้านล่าง, แถวใหม่ resolve จาก
--   getOrCreateDefaultWarehouse/ฟอร์มปรับปรุงมือ/ฟอร์มโอนคลังเสมอ ไม่ปล่อย null ต่อจากนี้)
-- ---------------------------------------------------------------------
alter table public.product_stock_movements
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;

create index if not exists idx_product_stock_movements_warehouse
  on public.product_stock_movements (warehouse_id)
  where warehouse_id is not null and deleted_at is null;

-- เพิ่ม transfer_in/transfer_out เข้า check constraint เดิม (ชื่อ auto-named ตอน migration 0077)
alter table public.product_stock_movements drop constraint if exists product_stock_movements_movement_type_check;
alter table public.product_stock_movements add constraint product_stock_movements_movement_type_check
  check (movement_type in ('purchase','sale','adjustment_in','adjustment_out','transfer_in','transfer_out'));

-- ---------------------------------------------------------------------
-- backfill: สร้าง "คลังหลัก" ให้เฉพาะ (tenant, customer) ที่มีรายการเคลื่อนไหว/ยอดยกมาอยู่แล้วจริง
--   (ไม่ pre-create ให้ทุกแถวใน customers — กันแถวเปล่าสำหรับลูกค้าที่ไม่เคยแตะสต็อกเลย) แล้ว backfill
--   warehouse_id ของรายการเคลื่อนไหวเดิมทั้งหมดให้ชี้ไปที่คลังหลักนั้น
-- ---------------------------------------------------------------------
-- ★ on conflict do nothing (mirror 0030/0063/0070 ฯลฯ) — migration ต้องรันซ้ำได้ปลอดภัย (เช่น กรณี
--   apply ซ้ำหลัง error กลางทาง) โดยไม่ throw unique violation จาก uq_warehouses_customer_name
insert into public.warehouses (tenant_id, customer_id, name, is_default, is_active)
select distinct tenant_id, customer_id, 'คลังหลัก', true, true
from (
  select tenant_id, customer_id from public.product_stock_movements where deleted_at is null
  union
  select tenant_id, customer_id from public.product_opening_balances where deleted_at is null
) pairs
on conflict (customer_id, lower(name)) where deleted_at is null do nothing;

update public.product_stock_movements m
set warehouse_id = w.id
from public.warehouses w
where w.tenant_id = m.tenant_id
  and w.customer_id = m.customer_id
  and w.is_default = true
  and m.warehouse_id is null;

-- ---------------------------------------------------------------------
-- create_stock_transfer — โอนสินค้าระหว่างคลัง 1 สินค้า (out จากคลังต้นทาง + in เข้าคลังปลายทาง) แบบ
--   atomic ในทรานแซกชันเดียว — unit_cost ฝั่ง in ต้องเป็นต้นทุนเฉลี่ย ณ ขณะโอน (คำนวณที่ชั้น TS ก่อนเรียก
--   — computeStockLedger) เพื่อให้ยอดรวมทั้งสินค้าไม่เปลี่ยนหลังโอน
-- ---------------------------------------------------------------------
create or replace function public.create_stock_transfer(
  p_tenant_id         uuid,
  p_customer_id       uuid,
  p_product_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_movement_date     date,
  p_memo              text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.product_stock_movements
    (tenant_id, customer_id, product_id, warehouse_id, movement_type, quantity, unit_cost, movement_date, memo)
  values
    (p_tenant_id, p_customer_id, p_product_id, p_from_warehouse_id, 'transfer_out', p_quantity, null, p_movement_date, p_memo);

  insert into public.product_stock_movements
    (tenant_id, customer_id, product_id, warehouse_id, movement_type, quantity, unit_cost, movement_date, memo)
  values
    (p_tenant_id, p_customer_id, p_product_id, p_to_warehouse_id, 'transfer_in', p_quantity, p_unit_cost, p_movement_date, p_memo);
end;
$$;

-- =====================================================================
-- RLS: tenant isolation (pattern 0046/0051/0054/0077)
-- =====================================================================
alter table public.warehouses enable row level security;

create policy tenant_read on public.warehouses for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.warehouses from anon;
grant select on public.warehouses to authenticated;
grant all on public.warehouses to service_role;

notify pgrst, 'reload schema';
