-- =====================================================================
-- 0022 — ติดตามการส่ง invitation ทาง LINE (notification worker / chunk 3)
--   - first_sent_at   : เวลาส่งครั้งแรกสำเร็จ (ใช้คำนวณ "ผ่าน 1 วัน" ก่อนเตือน)
--   - last_reminded_at: เวลาที่เตือนอัตโนมัติล่าสุด (คู่กับ reminder_count)
-- reminder_count มีอยู่แล้ว (0006) — เตือนอัตโนมัติจำกัด 1 ครั้ง (FR-SC-04)
-- =====================================================================

alter table public.survey_invitations
  add column if not exists first_sent_at    timestamptz,
  add column if not exists last_reminded_at timestamptz;

-- index ช่วย reminder scan: หา invitation ที่ส่งแล้วแต่ยังไม่ตอบ/ยังไม่เตือน
create index if not exists idx_survey_inv_reminder
  on public.survey_invitations (status, reminder_count, first_sent_at)
  where deleted_at is null;
