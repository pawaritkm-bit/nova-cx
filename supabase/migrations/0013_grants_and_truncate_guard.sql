-- =====================================================================
-- 0013 — QC#1: ลด attack surface ของ GRANT + กัน TRUNCATE + จำกัดสิทธิ์เขียน tenants
--   (HIGH#1, MEDIUM#4, MEDIUM#5)
-- =====================================================================

-- ---------------------------------------------------------------------
-- MEDIUM#4 + HIGH#1: จัดสิทธิ์ตารางใหม่
--   - authenticated: เฉพาะ select/insert/update/delete (ตัด TRUNCATE/REFERENCES/TRIGGER)
--   - service_role: คง all (งานเบื้องหลัง/worker)
--   - anon: revoke ทั้งหมด (deny-by-default ตั้งแต่ชั้น GRANT — ไม่พึ่ง RLS อย่างเดียว)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------
-- HIGH#1: statement trigger กัน TRUNCATE บนตาราง append-only
--   RLS คุม TRUNCATE ไม่ถึง และ service_role bypass RLS → ต้องกันด้วย trigger
--   prevent_update_delete() raise exception เสมอ (ใช้ได้ทั้ง row/statement)
-- ---------------------------------------------------------------------
create trigger trg_audit_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.prevent_update_delete();

create trigger trg_survey_answers_no_truncate
  before truncate on public.survey_answers
  for each statement execute function public.prevent_update_delete();

create trigger trg_case_log_no_truncate
  before truncate on public.case_activity_logs
  for each statement execute function public.prevent_update_delete();

-- ---------------------------------------------------------------------
-- MEDIUM#5: จำกัด UPDATE tenants เฉพาะ admin/executive (is_privileged())
--   RESTRICTIVE เฉพาะ command UPDATE → AND กับ tenant_isolation เดิม
--   (select/insert/delete ไม่ถูกกระทบจาก policy นี้)
-- ---------------------------------------------------------------------
create policy tenants_update_privileged on public.tenants
  as restrictive for update to authenticated
  using (public.is_privileged())
  with check (public.is_privileged());

-- ---------------------------------------------------------------------
-- MEDIUM#4: จำกัดสิทธิ์ execute helper functions (จาก 0011)
--   ปกติ function grant execute ให้ public → revoke แล้วให้เฉพาะ authenticated/service_role
--   (trigger functions ไม่ต้อง grant — PostgreSQL ไม่เช็ค EXECUTE ตอน fire trigger)
-- ---------------------------------------------------------------------
do $$
declare
  fn text;
  fns text[] := array[
    'current_tenant_id()',
    'current_role_code()',
    'current_employee_id()',
    'is_privileged()',
    'can_access_customer(uuid)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function public.%s from public;', fn);
    execute format('grant execute on function public.%s to authenticated, service_role;', fn);
  end loop;
end
$$;
