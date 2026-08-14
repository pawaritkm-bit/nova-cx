-- =====================================================================
-- 0112 — เติมฟิลด์สินค้า/บริการให้ครบเทียบเท่าโปรแกรมบัญชี desktop ทั่วไป
--
--   ผู้ใช้เทียบหน้าจอ "รายละเอียดสินค้า" ของโปรแกรมอื่นแล้วพบว่า products ของเรายังขาด:
--     - บาร์โค้ด (barcode)
--     - ชื่อภาษาอังกฤษ (name_en)
--     - ราคาขายหลายระดับ (ราคา 1 = default_price เดิม, เพิ่มราคา 2-5)
--     - สินค้าทดแทน (replacement_product_id — ชี้ไป products อีกแถวหนึ่ง)
--     - ประเภท VAT เริ่มต้นของสินค้า (default_vat_type) — ใช้ prefill vat_type ต่อบรรทัดบิลตอนเลือกสินค้า
--       (เดิม product picker prefill แค่ description + account_code เท่านั้น)
--
--   ★ ทุกคอลัมน์ nullable — ไม่ backfill อะไร ไม่มี breaking change
--   ★ default_vat_type: ใช้ค่าเดียวกับ bill_entry_lines.vat_type ('vat'/'novat') แต่ "nullable ไม่มี
--     default" โดยตั้งใจ (ต่างจาก pattern เดิมที่มักตั้ง default) — เพราะ EntryEditor จะใช้ค่านี้ prefill
--     vat_type ของบรรทัดบิลอัตโนมัติตอนเลือกสินค้า ถ้าตั้ง default='vat' ให้สินค้าเดิมทุกตัวที่ไม่เคยตั้งค่านี้
--     มาก่อน จะกลายเป็น "ตั้งใจเลือก VAT" ทันทีหลัง migrate แล้วไปเขียนทับ vat_type ของบรรทัดบิลอย่างผิดๆ
--     ตอนเลือกสินค้าเดิมที่เคยเป็น novat — null เท่านั้นที่แปลว่า "ยังไม่ตั้งค่า → ไม่ prefill" ปลอดภัยกับข้อมูลเดิม 100%
--   ★ replacement_product_id: on delete set null (สินค้าที่ถูกลบ/soft-delete ไม่ทำให้แถวอื่นพัง — แค่เลิกชี้)
--     ไม่ห้าม self-reference ที่ระดับ DB (กันไม่ให้ยากเกินจำเป็น) — ชั้น action/UI กันไม่ให้เลือกตัวเองแทน
-- non-destructive: เพิ่มคอลัมน์ nullable ใหม่ทั้งหมด ไม่แตะ/ลบของเดิม
-- =====================================================================

alter table public.products
  add column if not exists barcode text,
  add column if not exists name_en text,
  add column if not exists price_2 numeric(14,2),
  add column if not exists price_3 numeric(14,2),
  add column if not exists price_4 numeric(14,2),
  add column if not exists price_5 numeric(14,2),
  add column if not exists default_vat_type text,
  add column if not exists replacement_product_id uuid references public.products(id) on delete set null;

alter table public.products
  add constraint products_default_vat_type_check
  check (default_vat_type is null or default_vat_type in ('vat', 'novat'));

create index if not exists idx_products_replacement
  on public.products (tenant_id, replacement_product_id) where replacement_product_id is not null;

notify pgrst, 'reload schema';
