-- =====================================================================
-- 0086 — เฟส 10 ส่วน Z — ยอดต้นฉบับสกุลต่างประเทศต่อบรรทัด (ก่อน VAT) — nullable
--   amount (THB) เดิม = derive จาก fx_amount * bill_entries.fx_rate เมื่อ bill_entries.currency ไม่ null
--   (application layer เท่านั้น — ไม่มี generated column/trigger ระดับ DB ตาม pattern เดิมทั้งระบบที่ไม่ใช้
--   DB คำนวณ business logic)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable เดียว ไม่แตะข้อมูลเดิมเลย
-- =====================================================================

alter table public.bill_entry_lines
  add column if not exists fx_amount numeric(14,2);

notify pgrst, 'reload schema';
