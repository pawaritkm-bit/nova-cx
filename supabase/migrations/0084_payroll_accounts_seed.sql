-- =====================================================================
-- 0084 — เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, T107)
--   Seed รหัสบัญชีใหม่ที่ payroll_settings แนะนำเป็นค่าเริ่มต้น (2 รหัส) ให้ทุก tenant ที่มีอยู่แล้ว
--     - '2050' เงินสมทบประกันสังคมค้างนำส่ง (หนี้สิน)
--     - '5311' เงินสมทบประกันสังคม (ส่วนนายจ้าง) (ค่าใช้จ่าย)
--   '5310 เงินเดือนพนักงาน' และ '2910 ภาษีหัก ณ ที่จ่าย' มีอยู่แล้วจาก migration 0063 — ไม่ต้อง seed ซ้ำ
--
--   ★ additive ล้วน (on conflict do nothing ทำงานร่วมกับ unique index (tenant_id, code) where
--     deleted_at is null ของ migration 0063) — apply ซ้ำได้ (idempotent) ไม่สร้างซ้ำ
--   ★ ไม่ใส่ 2 รหัสนี้ใน PROTECTED_CODES (lib/accounting/chart-accounts-data.ts) ตามที่ตั้งใจ (0.4 หมวด
--     บริบทของเฟสนี้) — นักบัญชีแก้ชื่อ/หมวด/ลบเองผ่านหน้าจัดการผังเดิมได้ตามปกติ (self-service)
-- =====================================================================

insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select t.id, v.code, v.name, v.category, v.is_bank, v.sort_order
from public.tenants t
cross join (values
  ('2050', 'เงินสมทบประกันสังคมค้างนำส่ง', 'หนี้สิน', false, 76),
  ('5311', 'เงินสมทบประกันสังคม (ส่วนนายจ้าง)', 'ค่าใช้จ่าย', false, 77)
) as v(code, name, category, is_bank, sort_order)
on conflict (tenant_id, code) where deleted_at is null do nothing;

notify pgrst, 'reload schema';
