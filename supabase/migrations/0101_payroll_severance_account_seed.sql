-- =====================================================================
-- 0101 — เฟส 9b กลุ่ม BF (docs/06-accounting-features-roadmap.md, T161)
--   Seed รหัสบัญชีใหม่ที่ payroll_settings.severance_expense_account_code แนะนำให้เลือก:
--     - '5312' ค่าชดเชยเลิกจ้างพนักงาน (ค่าใช้จ่าย)
--
--   ★ additive ล้วน (on conflict do nothing ทำงานร่วมกับ unique index (tenant_id, code) where
--     deleted_at is null ของ migration 0063) — apply ซ้ำได้ (idempotent) ไม่สร้างซ้ำ, mirror 0084 เดิม
--   ★ ไม่ใส่รหัสนี้ใน PROTECTED_CODES (lib/accounting/chart-accounts-data.ts) — นักบัญชีแก้ชื่อ/หมวด/ลบ
--     เองผ่านหน้าจัดการผังเดิมได้ตามปกติ (self-service, mirror 0084)
-- =====================================================================

insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select t.id, v.code, v.name, v.category, v.is_bank, v.sort_order
from public.tenants t
cross join (values
  ('5312', 'ค่าชดเชยเลิกจ้างพนักงาน', 'ค่าใช้จ่าย', false, 78)
) as v(code, name, category, is_bank, sort_order)
on conflict (tenant_id, code) where deleted_at is null do nothing;

notify pgrst, 'reload schema';
