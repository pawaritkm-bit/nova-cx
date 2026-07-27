-- =====================================================================
-- 0043 — message_attachments : เตรียมคอลัมน์ดึง binary รูปบิลขึ้น Google Drive
-- =====================================================================
-- บริบท (เฟส 1 ฝั่ง CX):
--   เดิม (0032) message_attachments เก็บแค่ metadata (line_content_id) ยังไม่ดึง
--   binary จริง. เฟสนี้เพิ่ม pipeline (cron) ดึงรูปจาก LINE → อัปขึ้น Google Drive
--   → บันทึกลิงก์/สถานะ. migration นี้เพิ่มคอลัมน์รองรับ state ของ pipeline เท่านั้น
--
--   ★ inert-by-default: ถ้าเจ้าของยังไม่ตั้ง env ของ Drive → cron เป็น no-op
--     คอลัมน์พวกนี้จะคง default 'pending' ไปเรื่อย ๆ ไม่มีผลต่อ flow เดิม
--
-- สิ่งที่ทำ:
--   1) เพิ่มคอลัมน์สถานะ/ผลลัพธ์การดึง+อัป Drive ใน message_attachments
--   2) index สำหรับ cron ไล่คิว (tenant + fetch_status) เฉพาะ attachment_type='image'
--   3) index สำหรับ dedup ด้วย sha256 (ไม่ unique — ตัดสิน dedup ใน code)
--
-- หมายเหตุ: มีคอลัมน์ `status` เดิมจาก 0032 อยู่แล้ว (pending/stored/failed/skipped)
--   แต่ pipeline ใหม่ใช้ `fetch_status` เป็นตัวหลัก เพื่อไม่ทับความหมายเดิม/ไม่แตะ flow เดิม
-- =====================================================================

alter table public.message_attachments
  add column if not exists sha256         text,
  add column if not exists bytes          integer,
  add column if not exists drive_file_id  text,
  add column if not exists drive_url      text,
  add column if not exists fetch_status   text not null default 'pending',
  add column if not exists fetch_error    text,
  add column if not exists fetch_attempts int  not null default 0,
  add column if not exists fetched_at     timestamptz;

-- check constraint แยกออกมา (add column + check inline ไม่รองรับใน add column if not exists)
--   ใช้ do-block กันรันซ้ำแล้ว error (constraint มีอยู่แล้ว)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'message_attachments_fetch_status_check'
  ) then
    alter table public.message_attachments
      add constraint message_attachments_fetch_status_check
      -- 'processing' = worker claim แถวไว้แล้ว (atomic lock) กัน cron รอบทับกันอัปซ้ำ
      check (fetch_status in ('pending', 'processing', 'stored', 'failed', 'skipped'));
  end if;
end $$;

-- index สำหรับ cron ไล่คิวรูปที่ยังไม่ได้ดึง (เฉพาะรูป — video/audio/file ข้ามในเฟสนี้)
create index if not exists idx_message_attachments_fetch_queue
  on public.message_attachments (tenant_id, fetch_status)
  where attachment_type = 'image';

-- index สำหรับ dedup ด้วย content hash (ไม่ unique — reuse ไฟล์เดิมเมื่อ sha256 ซ้ำใน tenant)
create index if not exists idx_message_attachments_sha256
  on public.message_attachments (tenant_id, sha256);

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
