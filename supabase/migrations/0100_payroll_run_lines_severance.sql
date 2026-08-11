-- =====================================================================
-- 0100 — เฟส 9b กลุ่ม BF (docs/06-accounting-features-roadmap.md, T160) — ค่าตอบแทนเลิกจ้าง/ชดเชย
--   ★★★ เสี่ยงกฎหมายสูงสุดของเฟส 9b (ต้องผ่าน gate 0.2 ก่อนเปิดใช้เครื่องคำนวณภาษีจริงกับเงินจริง)
--
--   - payroll_run_lines.severance_amount:        ค่าชดเชยเลิกจ้าง (ก่อนหักภาษี) ที่นักบัญชีกรอกได้เสมอ
--     เหมือน bonus_amount เดิม (0.13) — ไม่ผูกกับสวิตช์ ENABLE_SEVERANCE_TAX_CALC (แยกจาก field ภาษี)
--   - payroll_run_lines.severance_pit_withheld:  ภาษีหัก ณ ที่จ่ายของค่าชดเชย — คำนวณจริงต่อเมื่อ
--     ENABLE_SEVERANCE_TAX_CALC=true เท่านั้น (ชั้นแอปพลิเคชัน lib/accounting/payroll.ts) ไม่ใช่ DB
--     constraint (เผื่ออนาคตเปิดใช้งานไม่ต้อง migrate ซ้ำ, mirror 0083 เดิมของ bonus_amount ก่อน T112)
--   - payroll_settings.severance_expense_account_code: รหัสบัญชีค่าใช้จ่ายค่าชดเชย (nullable — บังคับ
--     ตั้งค่าก่อนสร้าง JE ได้จริงถ้ามี severance_amount>0 เท่านั้น, validate ที่ชั้นแอปพลิเคชัน mirror
--     other_deductions_account_code เดิม)
--
--   ★ non-destructive: ALTER เพิ่มคอลัมน์ใหม่ default 0/null ทุกแถวเดิม — ลูกค้าเดิมทุกรายไม่ได้รับ
--     ผลกระทบใด ๆ (severance_amount=0 → ไม่มีผลต่อ net_pay/JE เดิมเลย, พิสูจน์พีชคณิตใน payroll.ts)
-- =====================================================================

alter table public.payroll_run_lines
  add column if not exists severance_amount        numeric(14,2) not null default 0 check (severance_amount >= 0),
  add column if not exists severance_pit_withheld   numeric(14,2) not null default 0 check (severance_pit_withheld >= 0);

alter table public.payroll_settings
  add column if not exists severance_expense_account_code text;

notify pgrst, 'reload schema';
