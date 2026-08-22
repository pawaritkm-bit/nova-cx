-- 0119 — เพิ่มรหัสบัญชี "ค่าเช่า" + "ค่าธรรมเนียมวิชาชีพ" ให้ทุก tenant (Feature ก: WHT ให้ครบ)
--   ค่าเช่า → หัก ณ ที่จ่าย 5% · ค่าธรรมเนียมวิชาชีพ → 3% (แม็ปใน lib/accounting/wht.ts)
--   idempotent: on conflict (tenant_id, code) where deleted_at is null do nothing
insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select t.id, v.code, v.name, v.category, v.is_bank, v.sort_order
from public.tenants t
cross join (values
  ('5346','ค่าเช่า','ค่าใช้จ่าย',false,62),
  ('5347','ค่าธรรมเนียมวิชาชีพ','ค่าใช้จ่าย',false,62)
) as v(code, name, category, is_bank, sort_order)
on conflict (tenant_id, code) where deleted_at is null do nothing;

notify pgrst, 'reload schema';
