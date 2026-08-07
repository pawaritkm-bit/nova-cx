-- 0056: ธง "AI เดาเติม" ต่อบรรทัด (ai_low_confidence)
-- ★ ที่มา: โหมดเติมเชิงรุก — AI เติมยอด/VAT/บัญชี "แม้ confidence ต่ำ" (>= 0.3) เพื่อลดช่องว่าง
--   คอลัมน์นี้ = true เมื่อบรรทัดนั้นมีช่องที่ "เดา" (conf ต่ำกว่าเกณฑ์มั่นใจ) → UI ติดป้าย "AI เดา — ตรวจ"
-- ★ default false: บิลเก่าคงเดิม (ไม่ถือว่าเดา) · มีผลเฉพาะบิลที่สกัดใหม่หลังจากนี้

ALTER TABLE public.bill_entry_lines
  ADD COLUMN IF NOT EXISTS ai_low_confidence boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bill_entry_lines.ai_low_confidence IS
  'true = AI เดาเติมช่องเสี่ยง (ยอด/VAT/บัญชี) แบบ confidence ต่ำ → ให้คนตรวจก่อนยืนยัน';

-- reload PostgREST schema cache (กัน API 500 "schema cache" หลังเพิ่มคอลัมน์)
NOTIFY pgrst, 'reload schema';
