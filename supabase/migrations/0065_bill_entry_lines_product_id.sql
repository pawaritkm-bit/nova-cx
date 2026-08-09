-- =====================================================================
-- 0065 — เพิ่มคอลัมน์ product_id (FK nullable) บน bill_entry_lines
-- =====================================================================
-- บริบท: เฟส 1 ส่วน B (docs/06-accounting-features-roadmap.md) — เก็บว่าบรรทัดบิลนี้ "เลือกสินค้า"
--   รายการไหนจากตาราง products (ถ้ามี) — ใช้แค่ prefill ตอนแก้บิล/ตรวจสอบย้อนหลัง ไม่กระทบการคำนวณ
--   ใด ๆ ของ engine บัญชี (amount/vat/wht ต่อบรรทัดยังเป็นของจริงที่ engine ใช้เหมือนเดิม)
--
--   ★ on delete set null — สินค้าที่ถูกลบจริง (ไม่ใช่ soft-delete ปกติ) ไม่ทำให้บรรทัดบิลพัง
--   ★ สินค้าที่ soft-delete (deleted_at ตั้งค่า) ยังมี id เดิมอยู่ — บรรทัดเก่ายังอ้างอิงได้ตามปกติ
--     (UI แค่ไม่โชว์สินค้านั้นในตัวเลือกใหม่ ไม่ลบข้อมูลเก่า)
--
-- non-destructive: เพิ่มคอลัมน์ nullable (add column if not exists) ไม่แตะ query/flow เดิม
-- =====================================================================

alter table public.bill_entry_lines
  add column if not exists product_id uuid references public.products(id) on delete set null;

notify pgrst, 'reload schema';
