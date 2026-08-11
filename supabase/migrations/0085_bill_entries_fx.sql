-- =====================================================================
-- 0085 — เฟส 10 ส่วน Z (docs/06-accounting-features-roadmap.md, 0.3/0.6/0.9)
--   สกุลเงิน + อัตราแลกเปลี่ยน "ตอนออกบิล" ต่อบิล — nullable, ไม่ backfill บิลเก่า (non-destructive)
--     currency=null (ค่าเริ่มต้น/บิลเก่าทุกใบ) = บิล THB ปกติ พฤติกรรมเดิม 100% ไม่เปลี่ยน
--
--   ★ เลขไฟล์นี้ต่างจากที่จองไว้ในแผน (0079) — เลข 0079-0084 ถูกเฟส 9 (payroll) ใช้ไปแล้วจริงก่อนเฟสนี้
--     (ดู 0.18 ของแผนเฟส 10 + คำเตือนท้ายแผนเฟส 9 — ยึด `ls supabase/migrations/` จริงเป็นหลักเสมอ)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable + check constraint ไม่แตะข้อมูลเดิมเลย
-- =====================================================================

alter table public.bill_entries
  add column if not exists currency text,
  add column if not exists fx_rate numeric(18,6);

alter table public.bill_entries
  drop constraint if exists bill_entries_currency_format;
alter table public.bill_entries
  add constraint bill_entries_currency_format
    check (currency is null or currency ~ '^[A-Z]{3}$');

alter table public.bill_entries
  drop constraint if exists bill_entries_fx_rate_range;
alter table public.bill_entries
  add constraint bill_entries_fx_rate_range
    check (fx_rate is null or (fx_rate > 0 and fx_rate <= 100000));

notify pgrst, 'reload schema';
