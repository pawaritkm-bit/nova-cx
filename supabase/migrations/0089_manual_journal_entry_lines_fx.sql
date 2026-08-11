-- =====================================================================
-- 0089 — เฟส 10 ส่วน AA — metadata ล้วน (ไม่กระทบ debit/credit/isBalanced/mapper เดิมแม้แต่จุดเดียว) ใช้บอก
--   ที่มาของบรรทัด JV ที่เกี่ยวกับ FX (เช่น JV ที่แนะนำจาก fx.ts::suggestFxGainLossEntryInput) — nullable
--   ทั้งชุด บรรทัด JV ปกติที่ไม่เกี่ยว FX เลย ค่าเป็น null ทั้ง 3 คอลัมน์เสมอ (ไม่กระทบ manual JE เดิมทั้งหมด)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable + check constraint ไม่แตะข้อมูลเดิมเลย
-- =====================================================================

alter table public.manual_journal_entry_lines
  add column if not exists fx_currency text,
  add column if not exists fx_rate numeric(18,6),
  add column if not exists fx_amount numeric(14,2);

alter table public.manual_journal_entry_lines
  drop constraint if exists manual_je_lines_fx_currency_format;
alter table public.manual_journal_entry_lines
  add constraint manual_je_lines_fx_currency_format
    check (fx_currency is null or fx_currency ~ '^[A-Z]{3}$');

notify pgrst, 'reload schema';
