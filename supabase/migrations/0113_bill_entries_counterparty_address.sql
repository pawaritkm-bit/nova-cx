-- =====================================================================
-- 0113 — เพิ่มที่อยู่คู่ค้า (counterparty_address) ใน bill_entries
--
--   ต่อเนื่องจาก PR #37 (แก้ layout ไฟล์ .txt ภ.ง.ด.53 ให้ตรงกับไฟล์ตัวอย่างจริง) — ไฟล์ตัวอย่าง
--   จริงมีช่อง "ที่อยู่" ผู้ถูกหักภาษี แต่ bill_entries ไม่เคยเก็บข้อมูลนี้เลย ทำให้ช่องนี้ว่างเปล่า
--   เสมอในไฟล์ export (lib/accounting/rd-export.ts, WhtRecord.address)
--
--   ให้นักบัญชีพิมพ์กรอกเองตอนแก้ไขบิลที่มีการหักภาษี ณ ที่จ่าย (EntryEditor.tsx) แล้วเก็บไว้ใช้ตอน
--   export ภ.ง.ด.3/53 — mirror pattern เดียวกับ sales_documents.counterparty_address (0070)
--
-- non-destructive: เพิ่มคอลัมน์ nullable ใหม่ ไม่แตะ/ลบของเดิม
-- =====================================================================

alter table public.bill_entries
  add column if not exists counterparty_address text;

notify pgrst, 'reload schema';
