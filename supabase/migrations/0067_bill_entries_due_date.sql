-- เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md, 0.7/E1)
-- เพิ่มวันครบกำหนดชำระ (due_date) ต่อบิล — nullable, ไม่ backfill บิลเก่า (non-destructive)
--   มีผลเชิงความหมายเฉพาะบิลเชื่อ (payment_method='credit') แต่กรอกได้ทุก payment_method ระดับ DB

alter table public.bill_entries
  add column if not exists due_date date;

-- index ช่วยสแกนรายงานอายุหนี้ (กรองบิลเชื่อที่ยังไม่ปิด ตามลูกค้า/วันครบกำหนด)
create index if not exists idx_bill_entries_due_date
  on public.bill_entries (tenant_id, due_date)
  where deleted_at is null and payment_method = 'credit';

notify pgrst, 'reload schema';
