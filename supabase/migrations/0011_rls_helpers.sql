-- =====================================================================
-- 0011 — RLS helper functions (security definer)
-- อ่าน tenant/role/employee ของ user ปัจจุบัน + ตรวจ scope
-- ทุก function เป็น SECURITY DEFINER + fixed search_path เพื่อ:
--   (1) เลี่ยง recursion กับ RLS ของ users
--   (2) กัน search_path hijack
-- =====================================================================

-- ---------------------------------------------------------------------
-- tenant ของ user ปัจจุบัน (จาก auth.uid())
-- ---------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.tenant_id
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.is_active
    and u.deleted_at is null
  limit 1
$$;

-- ---------------------------------------------------------------------
-- role code ของ user ปัจจุบัน
-- ---------------------------------------------------------------------
create or replace function public.current_role_code()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.code
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.auth_user_id = auth.uid()
    and u.is_active
    and u.deleted_at is null
  limit 1
$$;

-- ---------------------------------------------------------------------
-- employee_id ที่ผูกกับ user ปัจจุบัน (อาจ null สำหรับ admin ที่ไม่ใช่ employee)
-- ---------------------------------------------------------------------
create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.employee_id
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.is_active
    and u.deleted_at is null
  limit 1
$$;

-- ---------------------------------------------------------------------
-- สิทธิ์เต็ม tenant: admin + executive (เห็น aggregate ทั้ง tenant)
-- ---------------------------------------------------------------------
create or replace function public.is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role_code() in ('admin','executive')
$$;

-- ---------------------------------------------------------------------
-- ตรวจว่า user ปัจจุบันเข้าถึงลูกค้ารายนี้ได้ (ชั้น scope)
--  - privileged (admin/exec): ได้ทั้ง tenant
--  - lead (acc_lead/sales_lead): ลูกค้าที่มีผู้ดูแลอยู่ในทีมที่ตนเป็นหัวหน้า (ปัจจุบัน)
--  - อื่น ๆ (accountant/sales/cs): ลูกค้าที่ตนเป็นผู้ดูแลปัจจุบัน (customer_assignments)
-- ใช้ผู้ดูแล "ปัจจุบัน" (valid_to is null) — history ใช้ตอนผูกคะแนน ไม่ใช่ scope การมองเห็น
-- ---------------------------------------------------------------------
create or replace function public.can_access_customer(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_privileged()
    or exists (
      -- ตนเป็นผู้ดูแลปัจจุบันของลูกค้า
      select 1
      from public.customer_assignments ca
      where ca.customer_id = target_customer_id
        and ca.employee_id = public.current_employee_id()
        and ca.valid_to is null
        and ca.deleted_at is null
    )
    or (
      -- ตนเป็นหัวหน้าทีม และลูกค้ามีผู้ดูแลอยู่ในทีมนั้น (ปัจจุบัน)
      public.current_role_code() in ('acc_lead','sales_lead')
      and exists (
        select 1
        from public.customer_assignments ca
        join public.teams t on t.id = ca.team_id
        where ca.customer_id = target_customer_id
          and ca.valid_to is null
          and ca.deleted_at is null
          and t.lead_employee_id = public.current_employee_id()
      )
    )
$$;
