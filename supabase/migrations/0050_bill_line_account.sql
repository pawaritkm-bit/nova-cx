-- =====================================================================
-- 0050 — ผังบัญชี (chart of accounts) ต่อบรรทัดรายการ bill_entry_lines
-- =====================================================================
-- บริบท (ต่อจาก 0046 bill_entry_lines):
--   หน้า /chat-audit/accounting (modal ตรวจ/แก้บิล) เพิ่มให้เลือก "บัญชี" จาก
--   ผังบัญชีมาตรฐานกลาง (lib/accounting/chart-of-accounts.ts — 75 บัญชี ใช้ร่วมทุกลูกค้า)
--   ตรงช่อง "รายละเอียด" ของแต่ละบรรทัด (combobox ค้นหา + เลือก).
--
--   ★ ผังบัญชีเป็นค่าคงที่ในโค้ด (ไม่ทำ DB table) — ที่นี่แค่เก็บ "ผลการเลือก" ต่อบรรทัด:
--     account_code : รหัสบัญชีที่เลือก (ล็อกเมื่อเลือกแล้ว — เปลี่ยนได้เฉพาะเลือกใหม่)
--     account_name : ชื่อบัญชี (prefill จากผัง แต่ผู้ใช้พิมพ์แก้ต่อบรรทัดได้)
--   คอลัมน์ description เดิมคงไว้ (ไม่ลบ) เพื่อความเข้ากันได้ย้อนหลัง —
--   ตอนบันทึก UI ยัง sync description = account_name ให้รายงาน/Excel เดิมไม่พัง
--
-- non-destructive: เพิ่ม 2 คอลัมน์ (nullable) ไม่แตะข้อมูล/ตรรกะเดิม
-- ★ ไม่แตะ RLS/GRANT เดิม (0046 ครอบ bill_entry_lines แล้ว — write ผ่าน service_role)
-- =====================================================================

alter table public.bill_entry_lines
  add column if not exists account_code text,
  add column if not exists account_name text;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
