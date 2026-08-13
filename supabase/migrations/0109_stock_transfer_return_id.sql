-- =====================================================================
-- 0109 — create_stock_transfer คืน id แถว transfer_in ที่สร้างจริง (แก้จุดที่รีวิวพบ: เดิม
--   returns void แล้วชั้น TS ส่งคืน id หลอก ๆ (echo ค่า input กลับ ไม่ใช่ id แถวจริง) — สร้างความสับสน
--   ให้คนอ่านโค้ดในอนาคต (lib/accounting/product-stock.ts::createStockTransfer)
--
--   ★ เปลี่ยน return type ต้อง drop function เดิมก่อน (create or replace เปลี่ยน return type ไม่ได้)
--   ★ ตั้งใจคืน id ฝั่ง "transfer_in" (แถวที่สินค้าไปถึงคลังปลายทาง) เป็นตัวแทนผลลัพธ์การโอน — ไม่มีผลต่อ
--     พฤติกรรมการโอน (ยัง insert 2 แถวแบบ atomic ในทรานแซกชันเดียวเหมือนเดิมทุกประการ)
-- =====================================================================

drop function if exists public.create_stock_transfer(uuid, uuid, uuid, uuid, uuid, numeric, numeric, date, text);

create function public.create_stock_transfer(
  p_tenant_id         uuid,
  p_customer_id       uuid,
  p_product_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_movement_date     date,
  p_memo              text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_in_id uuid;
begin
  insert into public.product_stock_movements
    (tenant_id, customer_id, product_id, warehouse_id, movement_type, quantity, unit_cost, movement_date, memo)
  values
    (p_tenant_id, p_customer_id, p_product_id, p_from_warehouse_id, 'transfer_out', p_quantity, null, p_movement_date, p_memo);

  insert into public.product_stock_movements
    (tenant_id, customer_id, product_id, warehouse_id, movement_type, quantity, unit_cost, movement_date, memo)
  values
    (p_tenant_id, p_customer_id, p_product_id, p_to_warehouse_id, 'transfer_in', p_quantity, p_unit_cost, p_movement_date, p_memo)
  returning id into v_in_id;

  return v_in_id;
end;
$$;

notify pgrst, 'reload schema';
