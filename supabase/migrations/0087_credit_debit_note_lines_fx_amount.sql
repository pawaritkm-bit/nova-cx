-- =====================================================================
-- 0087 — เฟส 10 ส่วน AA — mirror 0086 แต่สำหรับ CN/DN (0.10) — amount derive จาก fx_amount * fx_rate ของ
--   "บิลต้นฉบับ" (join ผ่าน credit_debit_notes.entry_id -> bill_entries.fx_rate) ไม่ใช่อัตราวันออก CN/DN
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable เดียว ไม่แตะข้อมูลเดิมเลย
-- =====================================================================

alter table public.credit_debit_note_lines
  add column if not exists fx_amount numeric(14,2);

notify pgrst, 'reload schema';
