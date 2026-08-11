-- =====================================================================
-- 0096 — เฟส 9b กลุ่ม BC/ข้อ3 (docs/06-accounting-features-roadmap.md, หมวด 0.5)
--   เอา unique constraint เดิม (tenant_id, customer_id, pay_period_year, pay_period_month) ออกจาก
--   payroll_runs ที่ระดับ DB — ต้องเอาออกจริงถึงจะสร้างหลายรอบ/เดือนได้ทางเทคนิคสำหรับลูกค้า non_monthly
--   แทนที่ด้วย index ธรรมดา (ไม่ unique) เพื่อยังช่วย query listRuns/หา period เดิมได้เร็วเหมือนก่อน
--
--   ★★★ ความปลอดภัยเดิมยังอยู่ — ย้ายไปคุมที่ชั้นแอปพลิเคชันแทน (lib/accounting/payroll.ts::createDraftRun,
--     T138): ลูกค้าที่ payroll_settings.pay_frequency='monthly' (ค่า default ของทุกรายที่มีอยู่ก่อนเฟสนี้)
--     ยัง**ถูกปฏิเสธ**สร้างรอบซ้ำเดือน/ปีเดียวกันเหมือนเดิมทุกประการ (reproduce ข้อความปฏิเสธเดิมเป๊ะ) —
--     เปิดสร้างหลายรอบ/เดือนได้เฉพาะลูกค้าที่ตั้งค่าเป็น 'non_monthly' เองเท่านั้น
-- =====================================================================

drop index if exists public.uq_payroll_runs_period;

create index if not exists idx_payroll_runs_period
  on public.payroll_runs (tenant_id, customer_id, pay_period_year, pay_period_month)
  where deleted_at is null;

notify pgrst, 'reload schema';
