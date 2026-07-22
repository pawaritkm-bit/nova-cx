-- =====================================================================
-- 0042 — customer_code : เปลี่ยน unique เต็มเป็น partial unique index
-- =====================================================================
-- บริบท:
--   เดิม 0004 ตั้ง `unique (tenant_id, customer_code)` แบบเต็ม → ลูกค้าที่ถูก
--   soft-delete (deleted_at not null) หรือแถวที่ customer_code เป็น null ยัง "จองรหัส"
--   ทำให้ตอน NOVA Sales ดันลูกค้ารหัสเดิมกลับเข้ามาชน 23505 โดยไม่จำเป็น
--
--   requirement (ผู้ใช้ยืนยัน 2026-07-22): NOVA Sales เป็นเจ้าของรหัส —
--   ฝั่ง CX ต้องรับรหัสจริงที่ NOVA Sales ส่งเข้ามาได้เสมอ ไม่ใช่ออกรหัสใหม่ให้
--
-- สิ่งที่ทำ:
--   1) drop unique constraint เดิม (Postgres auto-name = customers_tenant_id_customer_code_key)
--   2) สร้าง partial unique index: บังคับ unique เฉพาะแถวที่ customer_code ไม่ null
--      และยังไม่ถูก soft-delete → ลูกค้าที่ลบแล้ว/รหัส null ไม่บล็อกรหัสอีกต่อไป
-- =====================================================================

-- 1) ปลด unique เต็มเดิม (ใช้ if exists กันพังถ้าชื่อ constraint ต่างจากที่คาด)
alter table public.customers
  drop constraint if exists customers_tenant_id_customer_code_key;

-- 2) partial unique index — unique เฉพาะรหัสที่ยัง active และไม่ใช่ null
create unique index if not exists customers_tenant_code_active_uidx
  on public.customers (tenant_id, customer_code)
  where customer_code is not null and deleted_at is null;

-- reload PostgREST schema cache (ตารางเดิม แต่ reload กัน API มองไม่เห็น index/constraint ใหม่)
notify pgrst, 'reload schema';
