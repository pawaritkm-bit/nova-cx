-- =====================================================================
-- 0055 — เพิ่ม 'cheque' (เช็ค) ในวิธีจ่าย/รับเงินของบิล
-- =====================================================================
-- บริบท (ต่อจาก 0053 payment_method):
--   เพิ่มวิธีจ่าย/รับเงินแบบ "เช็ค" ให้ครบ 4 ตัวเลือกต่อฝั่งบิล
--     - บิลขาย:  เงินสด · เช็ค · เงินโอน · ลูกหนี้ (credit)
--     - บิลซื้อ:  เงินสด · เช็ค · เงินโอน · เจ้าหนี้ (credit)
--   บัญชีคู่ (เครดิต/เดบิต) ของเช็ค:
--     - ขาย → 1155 เช็ครับล่วงหน้า
--     - ซื้อ → 2220 เช็คสั่งจ่ายล่วงหน้า
--
-- non-destructive: แค่ขยาย check constraint ของ payment_method ให้รับ 'cheque'
--   (ค่าเดิม cash/transfer/credit ยังใช้ได้ · null = ยังไม่ระบุ)
-- =====================================================================

-- ลบ check constraint เดิม (auto-name จาก 0053) แล้วเพิ่มใหม่รวม 'cheque'
alter table public.bill_entries
  drop constraint if exists bill_entries_payment_method_check;

alter table public.bill_entries
  add constraint bill_entries_payment_method_check
    check (payment_method in ('cash','cheque','transfer','credit') or payment_method is null);

-- reload PostgREST schema cache (กัน API มองไม่เห็นการเปลี่ยน constraint)
notify pgrst, 'reload schema';
