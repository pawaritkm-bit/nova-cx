-- =====================================================================
-- 0045 — message_attachments : เก็บชื่อไฟล์เดิม (original_name) ของไฟล์แนบ
-- =====================================================================
-- บริบท (ต่อจาก 0043/0044 เฟส 1 ฝั่ง CX):
--   เดิม pipeline ดึงเก็บ "เฉพาะรูป" (attachment_type='image'). ตอนนี้ลูกค้าส่ง
--   "ไฟล์" (PDF/เอกสาร) เข้ามาด้วยแต่ระบบยังไม่ดึงเก็บ. เฟสนี้ขยายให้ดึงเก็บไฟล์
--   ด้วย และต้องโชว์ชื่อไฟล์เดิมให้ผู้ดูแลอ่านออก (เช่น "ใบกำกับภาษี ม.ค..pdf")
--
--   LINE ส่ง field `fileName` มากับ file message → ingest เก็บลงคอลัมน์นี้
--   (best-effort · ไม่มี = null). ใช้ตอนโชว์การ์ดไฟล์ + ตั้งชื่อไฟล์บน storage
--
--   ★ additive/optional: คอลัมน์ nullable ไม่มี default พิเศษ ไม่กระทบ flow เดิม
--     (รูปเดิมไม่มีชื่อไฟล์อยู่แล้ว → null ปกติ)
--   ★ PDPA: ชื่อไฟล์ = metadata ไว้โชว์เท่านั้น · ห้าม log ค่านี้ในโค้ด
-- =====================================================================

alter table public.message_attachments
  add column if not exists original_name text;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
