-- 0117 — ธง "เดาฝั่งซื้อ/ขาย" (Feature A: ตัดสินซื้อ/ขายฉลาดขึ้น)
--   decideEntrySide ชั้น 3 (heuristic) เดาว่าเป็น "บิลซื้อ" เมื่อผู้ขายไม่ใช่ลูกค้าเรา + ไม่ตรงผู้ซื้อ
--   → mark side_guessed=true เพื่อ (1) โชว์ badge "🤖 เดา" ในหน้าลงบันทึกบัญชี
--     (2) กันไม่ให้ถูก batch-confirm อัตโนมัติ (ต้องคนตรวจก่อนยืนยัน)
--   default false = ค่าเดิม/ตัดสินแบบเป๊ะ (เลขภาษี/ชื่อ) ไม่ถือว่าเดา
alter table public.bill_entries
  add column if not exists side_guessed boolean not null default false;

comment on column public.bill_entries.side_guessed is
  'true = ฝั่งซื้อ/ขายมาจาก heuristic ชั้น 3 (เดา) ต้องให้คนตรวจก่อนยืนยัน · false = ตัดสินเป๊ะ/แก้เอง';
