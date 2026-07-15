-- =====================================================================
-- 0015 — QC#1 MEDIUM#3: กัน audit/activity spoof
--   - authenticated ตั้ง actor_user_id เป็นคนอื่นไม่ได้ (บังคับ = ตนเอง)
--   - มี SECURITY DEFINER function log_audit()/log_case_activity() ให้เขียนถูกต้อง
--   - service_role (งานระบบ) bypass RLS → ตั้ง actor เป็น null/ระบบได้
-- =====================================================================

-- ---------------------------------------------------------------------
-- users.id ของ user ปัจจุบัน (แตกต่างจาก auth.uid())
-- ---------------------------------------------------------------------
create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.is_active
    and u.deleted_at is null
  limit 1
$$;

-- ---------------------------------------------------------------------
-- RESTRICTIVE insert: บังคับ actor_user_id = ตนเอง (กัน spoof)
--   service_role bypass RLS → policy นี้ไม่กระทบงานระบบ
-- ---------------------------------------------------------------------
create policy audit_insert_self on public.audit_logs
  as restrictive for insert to authenticated
  with check (actor_user_id = public.current_user_id());

create policy case_log_insert_self on public.case_activity_logs
  as restrictive for insert to authenticated
  with check (actor_user_id = public.current_user_id());

-- ---------------------------------------------------------------------
-- log_audit(): เขียน audit อย่างปลอดภัย (actor/tenant มาจาก context เสมอ)
--   SECURITY DEFINER + fixed search_path
-- ---------------------------------------------------------------------
create or replace function public.log_audit(
  p_action      text,
  p_resource    text,
  p_resource_id uuid default null,
  p_meta        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource, resource_id, meta)
  values (public.current_tenant_id(), public.current_user_id(), p_action, p_resource, p_resource_id, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- log_case_activity(): timeline เคส (actor/tenant จาก context)
-- ---------------------------------------------------------------------
create or replace function public.log_case_activity(
  p_case_id uuid,
  p_action  text,
  p_note    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.case_activity_logs (tenant_id, case_id, actor_user_id, action, note)
  values (public.current_tenant_id(), p_case_id, public.current_user_id(), p_action, p_note)
  returning id into v_id;
  return v_id;
end;
$$;

-- grant execute เฉพาะ authenticated/service_role
revoke execute on function public.current_user_id() from public;
revoke execute on function public.log_audit(text, text, uuid, jsonb) from public;
revoke execute on function public.log_case_activity(uuid, text, text) from public;
grant execute on function public.current_user_id() to authenticated, service_role;
grant execute on function public.log_audit(text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function public.log_case_activity(uuid, text, text) to authenticated, service_role;
