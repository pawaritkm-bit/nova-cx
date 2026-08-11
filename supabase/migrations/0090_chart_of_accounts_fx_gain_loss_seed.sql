-- =====================================================================
-- 0090 — เฟส 10 (0.4) — additive seed เข้า chart_of_accounts ทุก tenant ที่มีอยู่แล้ว (pattern เดียวกับ
--   migration 0063) — ไม่ใส่ใน PROTECTED_CODES (chart-accounts-data.ts) — นักบัญชี/แอดมินแก้ชื่อ/หมวด/ลบ
--   เองได้ตามปกติ — sort_order คำนวณต่อ tenant (max(sort_order)+1) กันชนกับรายการเดิมที่ sort_order ตายตัวอยู่แล้ว
--
-- non-destructive: INSERT ... ON CONFLICT DO NOTHING — idempotent, ไม่แก้ไข/ลบข้อมูลเดิมเลย
-- =====================================================================

insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select
  t.id,
  '4025',
  'กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน',
  'รายได้',
  false,
  coalesce(
    (select max(c.sort_order) + 1 from public.chart_of_accounts c
     where c.tenant_id = t.id and c.deleted_at is null),
    1
  )
from public.tenants t
on conflict (tenant_id, code) where deleted_at is null do nothing;

notify pgrst, 'reload schema';
