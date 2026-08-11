-- =====================================================================
-- 0091 — เฟส 9b กลุ่ม BA (docs/06-accounting-features-roadmap.md, หมวด 0.3) — reframe จาก backlog เดิม
--   "ผู้ประกันตนมาตรา 39/40" (เข้าใจผิดข้อเท็จจริง — ม.39/40 ไม่เกี่ยวกับ payroll ของนายจ้างเลย) เป็น flag
--   ระดับพนักงานที่นักบัญชีพิจารณาเงื่อนไขเอง (เช่น พนักงานอายุเกิน 60 ที่ตกลงไม่ต่อประกันสังคม) — ไม่ผูก
--   เหตุผลทางกฎหมายใด ๆ ในระบบ นักบัญชีตัดสินใจเองเป็นรายพนักงาน
--
-- ใช้งาน: lib/accounting/payroll.ts::recalcRunLines ข้าม calcSsoContribution เมื่อ sso_exempt=true
--   (ตั้ง sso_employee=0, sso_employer=0) — ไม่แก้ calcSsoContribution เอง (เงื่อนไขก่อนเรียกเท่านั้น)
--
-- non-destructive: ALTER เพิ่มคอลัมน์เดียว default false — พนักงานเดิมทุกคนไม่ถูกยกเว้นโดยไม่ได้ตั้งใจ
-- =====================================================================

alter table public.payroll_employees
  add column if not exists sso_exempt boolean not null default false;

notify pgrst, 'reload schema';
