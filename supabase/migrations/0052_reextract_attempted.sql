-- =====================================================================
-- 0052 — mark "ลองสกัดใหม่แล้ว" ให้ bill_entries (กัน reextract วนบิลเดิม)
-- =====================================================================
-- บริบท (บั๊กจาก production logs):
--   cron /api/cron/reextract-bills ยิงทุก 3 นาที แต่ทุกรอบได้ผลเท่ากันเป๊ะ
--   (scanned=10 updated=5 stillEmpty=5) จำนวนบิลว่าง (~281) ไม่ลดเลย.
--   สาเหตุ: reExtractIncompleteEntries เลือก entry ว่างโดยไล่ created_at asc
--   ทุกรอบ → เจอบิลหน้าคิว ~10 ใบที่ AI สกัดแล้วได้ค่าว่าง/null (รูปเบลอ
--   อ่านเลขไม่ได้) → เขียน line ทับแต่ยัง "ว่าง" → รอบหน้าเลือก 10 ใบเดิมซ้ำ
--   ไม่เคยขยับไปบิลที่อ่านได้ซึ่งอยู่หลังคิว.
--
--   วิธีแก้: เพิ่มคอลัมน์ reextract_attempted_at — reextract mark ว่า entry นี้
--   "พยายามสกัดใหม่แล้ว" หลังประมวลผลทุกใบ (updated/stillEmpty/สกัด null) แล้ว
--   selection ของ reextract ข้าม entry ที่ mark แล้ว (reextract_attempted_at is null)
--   → ไล่ไปข้างหน้าจนครบทุกใบ ~28 รอบ, ไม่วนซ้ำ, จบเองเมื่อ attempted หมด.
--
--   ★ กระทบเฉพาะเส้น reextract — backfillEntryAccounts (cron แยก) ไม่ได้กรอง
--     คอลัมน์นี้ จึงไม่ถูกกระทบ.
--
-- non-destructive: เพิ่ม 1 คอลัมน์ (nullable) ไม่แตะข้อมูล/ตรรกะเดิม
-- ★ ไม่แตะ RLS/GRANT เดิม (0046 ครอบ bill_entries แล้ว — write ผ่าน service_role)
-- =====================================================================

alter table public.bill_entries
  add column if not exists reextract_attempted_at timestamptz;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
