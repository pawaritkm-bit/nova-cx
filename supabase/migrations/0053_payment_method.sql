-- =====================================================================
-- 0053 — วิธีจ่าย/รับเงินต่อบิล (payment_method → "บัญชีคู่" ฝั่งเครดิต)
-- =====================================================================
-- บริบท (ต่อจาก 0046 bill_entries / 0051 customer_bank_accounts):
--   หน้าลงบันทึกบัญชีเก็บ "ฝั่งเดบิต" (บัญชีค่าใช้จ่าย/สินทรัพย์ + VAT + หัก) อยู่แล้ว
--   แต่ยังขาด "บัญชีคู่ (เครดิต)" สำหรับ double-entry → เพิ่มวิธีจ่าย/รับเงินต่อบิล:
--     - cash     (เงินสด) → คู่กับ 1010 เงินสด
--     - transfer (โอน)    → คู่กับบัญชีเงินฝากธนาคารที่เลือก (customer_bank_accounts)
--     - credit   (เชื่อ)   → ซื้อ=2010 เจ้าหนี้การค้า · ขาย=1140 ลูกหนี้การค้า
--   ★ payment_bank_account_id ใช้เฉพาะ transfer (ธนาคารที่ใช้ของลูกค้ารายนั้น)
--   ★ null = ยังไม่ระบุ (worker เดาให้เป็นค่าแนะนำ ไม่ล็อก — นักบัญชีแก้ได้)
--
-- non-destructive: เพิ่ม 2 คอลัมน์ให้ bill_entries เท่านั้น (nullable) ไม่แตะ flow เดิม
-- =====================================================================

alter table public.bill_entries
  add column if not exists payment_method text
    check (payment_method in ('cash','transfer','credit') or payment_method is null),
  add column if not exists payment_bank_account_id uuid
    references public.customer_bank_accounts(id) on delete set null;

-- reload PostgREST schema cache (คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
