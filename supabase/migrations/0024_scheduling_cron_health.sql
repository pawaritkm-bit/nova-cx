-- =====================================================================
-- 0024 — Scheduling scan (E5 / chunk 4)
--   - ลงทะเบียน cron_health สำหรับ job scan-invitations (+ครอบ job อื่นให้ครบ)
--     เพื่อให้ alert "cron เงียบ" มีแถวอ้างอิงตั้งแต่ต้น (ไม่ต้องรอ cron ยิงรอบแรก)
--   - index ช่วยสแกนลูกค้า active (A ราย 3 เดือน / B ต้นเดือน) ให้เร็ว
-- ตาราง survey_invitations / job_queue / cron_health มีอยู่แล้ว (0006/0009/0022) —
-- migration นี้ "เสริม" เท่านั้น ไม่แก้โครงเดิม
-- =====================================================================

-- ลงทะเบียน cron jobs ใน cron_health (idempotent — ไม่ทับค่า last_run เดิม)
insert into public.cron_health (job_name, status)
values
  ('scan-invitations', 'unknown'),
  ('process-notifications', 'unknown'),
  ('process-ai', 'unknown'),
  ('health-ping', 'unknown')
on conflict (job_name) do nothing;

-- index: ค้นลูกค้าที่ active + ยังไม่ถูกลบ (candidate ของ scan) เร็วขึ้น
-- (partial index ตามเงื่อนไข scan → เล็ก + ตรงงาน)
create index if not exists idx_customers_active_scan
  on public.customers (tenant_id, service_start_date)
  where deleted_at is null and status = 'active';

-- index: หา invitation ตาม idempotency_key (guard ชั้นแรกก่อน insert) เร็วขึ้น
-- หมายเหตุ: มี unique(tenant_id, idempotency_key) อยู่แล้ว (0006) ซึ่ง back ด้วย index
-- ให้อยู่แล้ว — บล็อกนี้จึงเว้นไว้ ไม่สร้างซ้ำ
