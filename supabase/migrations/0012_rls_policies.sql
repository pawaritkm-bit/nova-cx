-- =====================================================================
-- 0012 — Enable RLS + Policies (deny-by-default + tenant isolation)
--   ชั้น 1: PERMISSIVE tenant isolation ทุกตาราง (tenant_id = current_tenant_id())
--   ชั้น 2: RESTRICTIVE scope บนตารางสำคัญ (customers, survey_responses,
--           employee_evaluations, complaint_cases) => narrow ด้วย AND
--   append-only (survey_answers, case_activity_logs, audit_logs): select+insert เท่านั้น
-- =====================================================================

-- สิทธิ์ตารางระดับ Postgres (RLS ยังบังคับ row-level ต่ออีกชั้น)
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;

-- ---------------------------------------------------------------------
-- tenants — ตัวมันเองคือ tenant (ใช้ id แทน tenant_id)
-- ---------------------------------------------------------------------
alter table public.tenants enable row level security;
create policy tenant_isolation on public.tenants for all to authenticated
  using (id = public.current_tenant_id())
  with check (id = public.current_tenant_id());

-- ---------------------------------------------------------------------
-- ชั้น 1: tenant isolation แบบมาตรฐาน (ตารางที่มี tenant_id)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'branches','roles','permissions','role_permissions','users',
    'employees','teams','team_members',
    'customers','customer_contacts','line_users','customer_services',
    'customer_assignments','sales_leads','sales_opportunities','sales_status_history',
    'survey_templates','survey_versions','survey_questions','survey_question_options',
    'survey_campaigns','survey_invitations','survey_responses',
    'employee_evaluations','satisfaction_scores','nps_scores',
    'feedback_categories','feedback_tags','ai_feedback_analysis',
    'complaint_cases','case_assignments','follow_up_tasks',
    'job_queue','notification_logs',
    'consent_records','do_not_contact_records'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy tenant_isolation on public.%I for all to authenticated
        using (tenant_id = public.current_tenant_id())
        with check (tenant_id = public.current_tenant_id());
    $f$, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- append-only tables: SELECT + INSERT เท่านั้น (ไม่มี UPDATE/DELETE policy)
--   -> UPDATE/DELETE ถูกปฏิเสธโดย RLS + trigger prevent_update_delete()
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  append_only text[] := array['survey_answers','case_activity_logs','audit_logs'];
begin
  foreach t in array append_only loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy tenant_select on public.%I for select to authenticated
        using (tenant_id = public.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy tenant_insert on public.%I for insert to authenticated
        with check (tenant_id = public.current_tenant_id());
    $f$, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- cron_health — ระดับระบบ (ไม่มี tenant_id); ให้พนักงานที่ล็อกอินอ่านได้
-- ---------------------------------------------------------------------
alter table public.cron_health enable row level security;
create policy cron_health_read on public.cron_health for select to authenticated
  using (true);

-- =====================================================================
-- ชั้น 2: RESTRICTIVE scope (narrow ด้วย AND บนตารางสำคัญ)
-- =====================================================================

-- customers — เห็นเฉพาะลูกค้าที่อยู่ในความรับผิดชอบ (C-10)
create policy scope_customers on public.customers as restrictive for all to authenticated
  using (public.can_access_customer(id))
  with check (public.can_access_customer(id));

-- survey_responses — ตามลูกค้าที่เข้าถึงได้
create policy scope_survey_responses on public.survey_responses as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

-- complaint_cases — ตามลูกค้า (privileged เห็นหมด; customer_id null => เฉพาะ privileged)
create policy scope_complaint_cases on public.complaint_cases as restrictive for all to authenticated
  using (
    public.is_privileged()
    or (customer_id is not null and public.can_access_customer(customer_id))
  )
  with check (
    public.is_privileged()
    or (customer_id is not null and public.can_access_customer(customer_id))
  );

-- employee_evaluations — เจ้าตัวเห็นของตน / หัวหน้าเห็นของลูกทีม / privileged เห็นหมด
create policy scope_employee_evaluations on public.employee_evaluations as restrictive for all to authenticated
  using (
    public.is_privileged()
    or employee_id = public.current_employee_id()
    or (
      public.current_role_code() in ('acc_lead','sales_lead')
      and exists (
        select 1
        from public.team_members tm
        join public.teams t on t.id = tm.team_id
        where tm.employee_id = employee_evaluations.employee_id
          and tm.valid_to is null
          and tm.deleted_at is null
          and t.lead_employee_id = public.current_employee_id()
      )
    )
  )
  with check (public.is_privileged());
