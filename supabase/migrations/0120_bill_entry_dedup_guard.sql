-- 0120 — กันบิลซ้ำระดับฐานข้อมูล (เด็ดขาด) — Feature: ห้ามมีบิลซ้ำ
--   บิลซ้ำ = ไฟล์เดียวกัน (sha256) + ลูกค้าเดียวกัน + ยังไม่ลบ · ต่างลูกค้า/ไฟล์ต่าง = ไม่ซ้ำ (อนุญาต)
--   ★ เป็น backstop ระดับ DB — ต่อให้ race condition/สkip โค้ดพลาด ก็ insert ซ้ำไม่ได้ (23505)
--   ★ manual entry / ไม่มีไฟล์ต้นทาง = dedup_key null → ไม่ถูกบังคับ (unique มอง null เป็น distinct)
alter table public.bill_entries add column if not exists dedup_key text;

comment on column public.bill_entries.dedup_key is
  'ลายนิ้วมือไฟล์ต้นทาง (= message_attachments.sha256) สำหรับกันบิลซ้ำ · null = ไม่มีไฟล์/manual (ไม่บังคับ)';

-- backfill จาก sha256 ของ attachment ที่ผูกอยู่
update public.bill_entries be
set dedup_key = ma.sha256
from public.message_attachments ma
where be.attachment_id = ma.id
  and ma.sha256 is not null
  and be.dedup_key is null;

-- ★ unique เฉพาะบิลที่ยังไม่ลบ + มี dedup_key: 1 (ลูกค้า, ไฟล์) = 1 บิล
create unique index if not exists uq_bill_entries_dedup
  on public.bill_entries (tenant_id, customer_id, dedup_key)
  where deleted_at is null and dedup_key is not null;

notify pgrst, 'reload schema';
