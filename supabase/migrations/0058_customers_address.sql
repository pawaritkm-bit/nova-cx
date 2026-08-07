-- =====================================================================
-- 0058 — เพิ่มคอลัมน์ที่อยู่ลูกค้า (customers.address)
-- =====================================================================
-- บริบท:
--   รายงานภาษีซื้อ/ขาย (ฟอร์มราชการ) ต้องแสดง "ที่อยู่บริษัทลูกค้า" ในหัวรายงาน
--   ตาราง customers เดิมไม่มีคอลัมน์ address → เพิ่มแบบ non-destructive
--
--   * ที่อยู่ = ข้อความอิสระ (บรรทัดเดียว/หลายบรรทัด) กรอกโดยแอดมินผ่านฟอร์มแก้ลูกค้า
--   * ยังไม่มี RLS ใหม่ — ใช้ policy เดิมของตาราง customers (อ่านตาม tenant, เขียนผ่าน service_role)
--   * PDPA: ที่อยู่เป็น PII — โค้ดฝั่งแอปไม่ log ค่านี้
-- =====================================================================

alter table public.customers
  add column if not exists address text;

-- reload schema cache ของ PostgREST (กัน 500 "column not found in schema cache"
--   หลัง apply — ดูบทเรียนทีม supabase-schema-cache-reload)
notify pgrst, 'reload schema';
