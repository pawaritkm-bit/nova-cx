-- =====================================================================
-- 0044 — message_attachments : คัดกรองรูปด้วย AI (เก็บเฉพาะเอกสารการเงิน)
-- =====================================================================
-- บริบท (เฟส 1 ฝั่ง CX ต่อจาก 0043):
--   เดิม (0043) pipeline ดึงรูปบิลจาก LINE แล้วเก็บ "ทุกรูป" ขึ้น storage.
--   เฟสนี้เสียบ AI vision คัดกรองก่อนเก็บ: keep เฉพาะเอกสารการเงิน
--   (สลิปโอน/บิลเขียนมือ/บิลเงินสด/บิลซื้อ/บิลขาย) · ทิ้งรูปอื่น (เซลฟี่/
--   อาหาร/มีม/สกรีนช็อตแชต ฯลฯ)
--
--   ⚠️ กฎความปลอดภัย "keep-if-unsure": ทิ้งเฉพาะเมื่อ AI มั่นใจสูงว่าไม่ใช่
--     เอกสารการเงิน · ไม่แน่ใจ/ก้ำกึ่ง/พัง = เก็บไว้ก่อน (บังคับในโค้ด)
--
--   ★ degrade ปลอดภัย: ไม่มี OpenAI key → ข้ามการคัด เก็บทุกรูปเหมือนเดิม
--     คอลัมน์พวกนี้จะคง default (doc_checked=false, doc_kind=null) ไม่กระทบ flow เดิม
--
-- สิ่งที่ทำ:
--   1) เพิ่มคอลัมน์ผลการคัดใน message_attachments (doc_kind/doc_checked/doc_confidence)
--   2) index สำหรับ cron ไล่คัดย้อนหลัง (tenant + doc_checked) เฉพาะรูป
--   3) reload PostgREST schema cache
--
-- doc_kind: slip | handwritten | cash | purchase | sale | other | null
--   (null = ยังไม่คัด · other = คัดแล้วเป็น "ไม่ใช่เอกสารการเงิน")
-- =====================================================================

alter table public.message_attachments
  add column if not exists doc_kind        text,
  add column if not exists doc_checked     boolean not null default false,
  add column if not exists doc_confidence  real;

-- index สำหรับ cron ไล่คัดย้อนหลังรูปที่เก็บไปแล้วแต่ยังไม่ผ่าน AI (doc_checked=false)
--   เฉพาะรูป (video/audio/file ไม่คัดในเฟสนี้)
create index if not exists idx_message_attachments_doc_unchecked
  on public.message_attachments (tenant_id, doc_checked)
  where attachment_type = 'image';

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
