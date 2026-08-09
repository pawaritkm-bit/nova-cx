-- =====================================================================
-- 0072 — เพิ่มชนิดเอกสารบิลซื้อ/ค่าใช้จ่ายให้ CHECK constraint ของ FlowAccount sync
-- =====================================================================
-- บริบท: เฟส 5 ส่วน P (docs/06-accounting-features-roadmap.md, T29) — เพิ่ม doc_type ใหม่
--   'purchase_bill' (บิลซื้อเชื่อ ยังไม่จ่าย) / 'cash_expense' (จ่ายเงินสดแล้ว) ให้ทั้ง
--   bill_entries.flowaccount_doc_type และ flowaccount_sync_log.doc_type ที่ 0061 ตั้ง check
--   ไว้แค่ ('tax_invoice','cash_sale') เท่านั้น
--
--   ★ ชื่อ constraint ยืนยันจาก DB จริงแล้วก่อน apply (ไม่ได้เดา) — ตรวจด้วย:
--     `supabase db query --linked "select conname, pg_get_constraintdef(oid) ... from pg_constraint ..."`
--     ผลตรวจจริง (2026-08-08):
--       bill_entries: conname = bill_entries_flowaccount_doc_type_check
--       flowaccount_sync_log: conname = flowaccount_sync_log_doc_type_check
--     ตรงกับที่แผน (decision 0.16 / ร่าง SQL หมวด 1.2) ตั้งสมมติฐานไว้เป๊ะ — ไม่ต้องแก้ชื่อ
--
-- non-destructive: แก้แค่ CHECK constraint (ขยายชุดค่าที่ยอมรับ) ไม่แตะแถวข้อมูลเดิม/ค่าเดิมยังใช้ได้ปกติ
-- =====================================================================

alter table public.bill_entries
  drop constraint if exists bill_entries_flowaccount_doc_type_check;
alter table public.bill_entries
  add constraint bill_entries_flowaccount_doc_type_check
  check (flowaccount_doc_type in ('tax_invoice','cash_sale','purchase_bill','cash_expense')
         or flowaccount_doc_type is null);

alter table public.flowaccount_sync_log
  drop constraint if exists flowaccount_sync_log_doc_type_check;
alter table public.flowaccount_sync_log
  add constraint flowaccount_sync_log_doc_type_check
  check (doc_type in ('tax_invoice','cash_sale','purchase_bill','cash_expense') or doc_type is null);

notify pgrst, 'reload schema';
