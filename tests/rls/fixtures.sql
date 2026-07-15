-- =====================================================================
-- fixtures.sql — ข้อมูลเสริมสำหรับ RLS/permission test (idempotent)
--   ต้องรันหลัง supabase/seed.sql (base seed)
--   เพิ่ม: tenant#2 (ทดสอบ cross-tenant) + ลูกค้าที่ไม่มีผู้ดูแล (ทดสอบ scope)
-- =====================================================================

-- ลูกค้า tenant#1 ที่ "ไม่มี" customer_assignment → นักบัญชีไม่ควรเห็น, executive เห็น
insert into public.customers (id, tenant_id, customer_code, name, status) values
  ('70000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','C-0003','บริษัท ค (ไม่มีผู้ดูแล)','active')
on conflict (id) do nothing;

-- ---------- Tenant #2 (แยกกอง ทดสอบ tenant isolation) ----------
insert into public.tenants (id, name, status) values
  ('22222222-2222-2222-2222-222222222222','Tenant Two','active')
on conflict (id) do nothing;

insert into public.roles (id, tenant_id, code, name) values
  ('2a000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','accountant','นักบัญชี (T2)'),
  ('2a000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','executive','ผู้บริหาร (T2)')
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, first_name, employee_type) values
  ('3a000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','T2 นักบัญชี','accountant')
on conflict (id) do nothing;

insert into public.users (id, tenant_id, auth_user_id, employee_id, role_id, email, is_active) values
  ('5a000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','6a000000-0000-0000-0000-000000000003','3a000000-0000-0000-0000-000000000002','2a000000-0000-0000-0000-000000000003','t2.accountant@finovas.demo',true)
on conflict (id) do nothing;

insert into public.customers (id, tenant_id, customer_code, name, status) values
  ('7a000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','T2-0001','ลูกค้า T2','active')
on conflict (id) do nothing;

insert into public.customer_assignments (tenant_id, customer_id, employee_id, role, valid_from, valid_to) values
  ('22222222-2222-2222-2222-222222222222','7a000000-0000-0000-0000-000000000001','3a000000-0000-0000-0000-000000000002','member','2025-01-01',null)
on conflict do nothing;
