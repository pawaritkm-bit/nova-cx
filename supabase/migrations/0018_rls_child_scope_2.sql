-- =====================================================================
-- 0018 — QC(security)#2: ปิด scope ตารางลูกที่เหลือให้ครบ C-10
--   ผูกผ่าน parent (case_id / opportunity_id) หรือ customer_id ตรง
--   ทุก helper เป็น SECURITY DEFINER → ไม่เกิด RLS recursion
--
-- ⚠️ FLOW NOTE (สำหรับ M2 — LIFF/survey สาธารณะ):
--   0013 revoke สิทธิ์ตารางจาก role `anon` ทั้งหมด → หน้า LIFF ลูกค้า
--   "ห้าม" อ่าน/เขียนผ่าน anon key ตรง ต้องผ่าน API server (service-role
--   หรือ token-scoped endpoint) เท่านั้น มิฉะนั้นฟอร์มจะพังเพราะ RLS/GRANT
-- =====================================================================

-- ---------------------------------------------------------------------
-- HIGH#1: case_activity_logs — timeline/note เคส ต้อง scope ตาม parent case
-- ---------------------------------------------------------------------
create policy scope_case_activity_logs on public.case_activity_logs
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.complaint_cases c
    where c.id = case_activity_logs.case_id
      and (public.is_privileged()
           or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
  ))
  with check (exists (
    select 1 from public.complaint_cases c
    where c.id = case_activity_logs.case_id
      and (public.is_privileged()
           or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
  ));

-- ---------------------------------------------------------------------
-- MEDIUM#2: case_assignments + follow_up_tasks — scope ผ่าน case_id
-- ---------------------------------------------------------------------
create policy scope_case_assignments on public.case_assignments
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.complaint_cases c
    where c.id = case_assignments.case_id
      and (public.is_privileged()
           or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
  ))
  with check (exists (
    select 1 from public.complaint_cases c
    where c.id = case_assignments.case_id
      and (public.is_privileged()
           or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
  ));

-- follow_up_tasks.case_id nullable → task ที่ไม่ผูกเคส = เฉพาะ privileged
create policy scope_follow_up_tasks on public.follow_up_tasks
  as restrictive for all to authenticated
  using (
    public.is_privileged()
    or (case_id is not null and exists (
      select 1 from public.complaint_cases c
      where c.id = follow_up_tasks.case_id
        and (public.is_privileged()
             or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
    ))
  )
  with check (
    public.is_privileged()
    or (case_id is not null and exists (
      select 1 from public.complaint_cases c
      where c.id = follow_up_tasks.case_id
        and (public.is_privileged()
             or (c.customer_id is not null and public.can_access_customer(c.customer_id)))
    ))
  );

-- ---------------------------------------------------------------------
-- MEDIUM#3: sales_status_history — scope เดียวกับ sales_opportunities
-- ---------------------------------------------------------------------
create policy scope_sales_status_history on public.sales_status_history
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.sales_opportunities o
    where o.id = sales_status_history.opportunity_id
      and (public.is_privileged()
           or o.sales_employee_id = public.current_employee_id()
           or (o.customer_id is not null and public.can_access_customer(o.customer_id)))
  ))
  with check (exists (
    select 1 from public.sales_opportunities o
    where o.id = sales_status_history.opportunity_id
      and (public.is_privileged()
           or o.sales_employee_id = public.current_employee_id()
           or (o.customer_id is not null and public.can_access_customer(o.customer_id)))
  ));

-- ---------------------------------------------------------------------
-- MEDIUM#4: customer_assignments — กัน enumerate ลูกค้า+โครงทีมทั้ง tenant
--   can_access_customer() รวม is_privileged() อยู่แล้ว
-- ---------------------------------------------------------------------
create policy scope_customer_assignments on public.customer_assignments
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

-- ---------------------------------------------------------------------
-- MEDIUM#5: audit_logs — อ่านได้เฉพาะ privileged (insert self เดิมคงไว้)
-- ---------------------------------------------------------------------
create policy audit_select_privileged on public.audit_logs
  as restrictive for select to authenticated
  using (public.is_privileged());
