-- =====================================================================
-- 0017 — ผูก sales_leads → customer (decision จากผู้ใช้)
--   - customer_id nullable: lead ที่ยังไม่ convert / Lost = null; Won = ผูกลูกค้า
--   - owner_employee_id: เซลล์เจ้าของ lead (ตาราง 0005 ยังไม่มี → เพิ่มที่นี่)
--   - ปรับ RLS scope ให้ per-lead (แทน role-based เดิมใน 0014)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) เพิ่มคอลัมน์ + FK + index
-- ---------------------------------------------------------------------
alter table public.sales_leads
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.sales_leads
  add column if not exists owner_employee_id uuid references public.employees(id) on delete set null;

create index if not exists idx_sales_leads_customer on public.sales_leads(customer_id);
create index if not exists idx_sales_leads_owner on public.sales_leads(owner_employee_id);

-- ---------------------------------------------------------------------
-- 2) ปรับ RLS scope ของ sales_leads (แทน policy role-based จาก 0014)
--   logic: privileged / หัวหน้าฝ่ายขาย / เจ้าของ lead / ผู้ดูแลลูกค้าที่ผูก
-- ---------------------------------------------------------------------
drop policy if exists scope_sales_leads on public.sales_leads;

create policy scope_sales_leads on public.sales_leads
  as restrictive for all to authenticated
  using (
    public.is_privileged()
    or public.current_role_code() = 'sales_lead'
    or owner_employee_id = public.current_employee_id()
    or (customer_id is not null and public.can_access_customer(customer_id))
  )
  with check (
    public.is_privileged()
    or public.current_role_code() = 'sales_lead'
    or owner_employee_id = public.current_employee_id()
    or (customer_id is not null and public.can_access_customer(customer_id))
  );

comment on column public.sales_leads.customer_id is
  'ผูกเมื่อ lead convert เป็นลูกค้า (Won); null = ยังไม่ convert/Lost';
comment on column public.sales_leads.owner_employee_id is
  'เซลล์เจ้าของ lead (ใช้ทำ RLS scope per-lead)';
