-- =====================================================================
-- 0088 — เฟส 10 ส่วน AA (0.8/0.14) — fx_rate ที่นี่คือ "อัตราวันชำระ/settlement" คนละอัตรากับ
--   bill_entries.fx_rate (อัตราวันออกบิล) — amount (THB) เดิมยังหมายถึงยอดที่ตัด AR/AP (derive จาก
--   fx_amount * bill_entries.fx_rate ของบิลต้นทาง ไม่ใช่ fx_rate ของ payment นี้เอง — ผลต่างคือ realized
--   FX gain/loss ตาม 0.8)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable + check constraint + index ไม่แตะข้อมูลเดิมเลย
-- =====================================================================

alter table public.bill_payments
  add column if not exists currency text,
  add column if not exists fx_rate numeric(18,6),
  add column if not exists fx_amount numeric(14,2),
  add column if not exists fx_gain_loss_note_id uuid
    references public.manual_journal_entries(id) on delete set null;

alter table public.bill_payments
  drop constraint if exists bill_payments_currency_format;
alter table public.bill_payments
  add constraint bill_payments_currency_format
    check (currency is null or currency ~ '^[A-Z]{3}$');

alter table public.bill_payments
  drop constraint if exists bill_payments_fx_rate_range;
alter table public.bill_payments
  add constraint bill_payments_fx_rate_range
    check (fx_rate is null or (fx_rate > 0 and fx_rate <= 100000));

-- index ช่วยเช็คเร็วว่างวดนี้ "เคยแนะนำ JV กำไร/ขาดทุน FX ไปแล้วหรือยัง" (0.14)
create index if not exists idx_bill_payments_fx_gain_loss_note
  on public.bill_payments (tenant_id, fx_gain_loss_note_id)
  where deleted_at is null and fx_gain_loss_note_id is not null;

notify pgrst, 'reload schema';
