-- =====================================================================
-- 0059 — เพิ่มคอลัมน์เบอร์โทรติดต่อลูกค้า (customers.phone)
-- =====================================================================
-- บริบท:
--   ฟอร์มแก้ไขข้อมูลลูกค้า (หน้า /chat-audit/accounting) เพิ่มช่อง "เบอร์โทรติดต่อ"
--   และปุ่ม "ดึงจาก NOVA Sales" ที่เติมเบอร์โทร/ที่อยู่/ชื่อ ให้อัตโนมัติ
--   ตาราง customers เดิมไม่มีคอลัมน์ phone → เพิ่มแบบ non-destructive
--
--   * เบอร์โทร = ข้อความอิสระ (เก็บตามที่กรอก/ดึงมา ไม่บังคับรูปแบบ)
--   * ยังไม่มี RLS ใหม่ — ใช้ policy เดิมของตาราง customers (อ่านตาม tenant, เขียนผ่าน service_role)
--   * PDPA: เบอร์โทรเป็น PII — โค้ดฝั่งแอปไม่ log ค่านี้
-- =====================================================================

alter table public.customers
  add column if not exists phone text;

-- reload schema cache ของ PostgREST (กัน 500 "column not found in schema cache"
--   หลัง apply — ดูบทเรียนทีม supabase-schema-cache-reload)
notify pgrst, 'reload schema';
