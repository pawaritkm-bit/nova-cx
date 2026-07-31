-- =====================================================================
-- 0048 — customers : ที่มาของเลขภาษี (tax_id_source) + เวลา sync กลับ NOVA Sale
-- =====================================================================
-- ⚠️ ทางเลือก (optional) — ยังไม่ apply. โค้ดปัจจุบัน "ไม่พึ่ง" คอลัมน์เหล่านี้
--    (saveCustomerTaxIdAction เขียนแค่ tax_id). apply เมื่อต้องการ track ที่มา/กันส่งซ้ำ
--    แล้วค่อยต่อโค้ดให้ set ค่าเหล่านี้ (ดูรายงาน)
--
-- บริบท (ต่อจาก 0047 customers.tax_id):
--   loop เก็บเลขภาษี — เลขภาษีของลูกค้าเข้ามาได้ 2 ทาง:
--     (ก) NOVA Sale ส่งมาผ่าน integration inbound (upsertCustomer.tax_id)
--     (ข) นักบัญชีกรอกเองในหน้า /chat-audit/accounting (saveCustomerTaxIdAction)
--   อยากแยกว่าเลขภาษีของลูกค้ารายไหน "นักบัญชีกรอกเอง" (ยังไม่มีใน NOVA Sale)
--   เพื่อ (1) รายงาน/ตรวจสอบ (2) กันส่งกลับ NOVA Sale ซ้ำ (เช็ค tax_id_synced_at)
--
--   ★ additive/optional: nullable ไม่มี default → ไม่กระทบ flow/ข้อมูลเดิม
--   ★ ไม่ทำ index — คิวรีใช้ตามลูกค้า (tenant_id, id) อยู่แล้ว
-- =====================================================================

alter table public.customers
  add column if not exists tax_id_source text
    check (tax_id_source is null or tax_id_source in ('nova_sales', 'manual'));

-- เวลา push เลขภาษีกลับ NOVA Sale ล่าสุด (กันส่งซ้ำ — set เมื่อ outbound สำเร็จ)
alter table public.customers
  add column if not exists tax_id_synced_at timestamptz;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
