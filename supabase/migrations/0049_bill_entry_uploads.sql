-- =====================================================================
-- 0049 — ไฟล์ที่นักบัญชี "อัปโหลดเอง" แนบกับ bill_entries
-- =====================================================================
-- บริบท (ต่อจาก 0046 bill_entries):
--   หน้า /chat-audit/accounting เพิ่มปุ่ม "อัปโหลดไฟล์เอง" ให้นักบัญชีแนบเอกสาร
--   (Excel/PDF/รูป/CSV) ที่ไม่ได้มาทางไลน์ → สร้าง entry ใหม่ (source='manual')
--   พร้อมเก็บไฟล์ต้นฉบับใน Supabase Storage bucket `bills` ใต้โฟลเดอร์ manual/…
--
--   เดิม entry ผูกไฟล์บิลผ่าน attachment_id → message_attachments.drive_file_id
--   (บิลจากไลน์). entry ที่อัปเอง "ไม่มี" attachment_id — จึงเก็บ ref ไฟล์ตรงที่ entry:
--     upload_path : object path ใน bucket `bills` (ให้ UI เอาไป sign แสดง/ดาวน์โหลด)
--     upload_name : ชื่อไฟล์เดิมที่ผู้ใช้อัป (ไว้โชว์/ตั้งชื่อดาวน์โหลด)
--     upload_mime : MIME (แยกรูป=inline vs pdf/excel/csv=ปุ่มเปิด/ดาวน์โหลด)
--
-- non-destructive: เพิ่ม 3 คอลัมน์ (nullable) ไม่แตะข้อมูล/ตรรกะเดิม
-- ★ ไม่แตะ RLS/GRANT เดิม (0046 ครอบ bill_entries แล้ว — write ผ่าน service_role)
-- =====================================================================

alter table public.bill_entries
  add column if not exists upload_path text,
  add column if not exists upload_name text,
  add column if not exists upload_mime text;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
