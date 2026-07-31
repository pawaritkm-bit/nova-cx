-- =====================================================================
-- 0047 — customers : เพิ่มเลขประจำตัวผู้เสียภาษี (tax_id) ของลูกค้า
-- =====================================================================
-- บริบท (ต่อจาก 0046 ลงบันทึกบัญชี ภาษีซื้อ/ขาย):
--   เดิม customers ไม่มีช่องเลขภาษี → worker จับ "ลูกค้าเราอยู่ฝั่งซื้อหรือขาย"
--   ได้แค่ fuzzy ชื่อ (AI อ่านชื่อไทยเพี้ยนบ่อย เช่น "ยูนิเวิร์ส"→"ยูนิไวส์")
--   → จับไม่ตรง กลายเป็น unspecified เกือบทั้งหมด.
--
--   เฟสนี้เพิ่ม customers.tax_id ให้ NOVA Sales ส่งเลขภาษี 13 หลักมาเก็บได้
--   → decideEntrySide ใช้ tax_id เทียบ seller/buyer ที่ AI อ่าน (แม่นกว่าชื่อมาก)
--
--   ★ additive/optional: คอลัมน์ nullable ไม่มี default ไม่กระทบ flow เดิม
--     (ลูกค้าเดิมที่ยังไม่มีเลขภาษี = null → ตกไป fallback fuzzy ชื่อเหมือนเดิม)
--   ★ ไม่ทำ unique — เลขภาษีอาจซ้ำได้ในทางปฏิบัติ (สาขา/ข้อมูลไม่ครบ) + dedup ลูกค้า
--     ทำผ่าน external_ref/customer_code อยู่แล้ว (ไม่ผูกกับ tax_id)
-- =====================================================================

alter table public.customers
  add column if not exists tax_id text;

-- index ช่วยค้นลูกค้าจากเลขภาษี (worker/รายงาน) — ไม่ unique
create index if not exists idx_customers_tax_id
  on public.customers (tenant_id, tax_id)
  where tax_id is not null;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
