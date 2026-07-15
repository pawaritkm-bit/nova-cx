-- =====================================================================
-- 0016 — QC#1 LOW: index FK ที่ขาด + search_path ใน trigger functions + comments
-- =====================================================================

-- ---------------------------------------------------------------------
-- index FK ที่ยังขาด (ช่วย join/รายงาน)
-- ---------------------------------------------------------------------
create index if not exists idx_survey_resp_version
  on public.survey_responses(survey_template_version);
create index if not exists idx_survey_inv_version
  on public.survey_invitations(survey_version_id);
create index if not exists idx_cases_response
  on public.complaint_cases(response_id);

-- ---------------------------------------------------------------------
-- hardening: fix search_path ใน trigger functions (กัน search_path hijack)
--   CREATE OR REPLACE ไม่กระทบ trigger ที่ผูกไว้แล้ว
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.prevent_update_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'ตาราง % เป็น append-only: แก้ไข/ลบ/truncate ไม่ได้', tg_table_name;
end;
$$;

-- ---------------------------------------------------------------------
-- documentation: บันทึกข้อยกเว้นการออกแบบ (soft-delete / append-only / cron_health)
-- ---------------------------------------------------------------------
comment on table public.audit_logs is
  'append-only immutable (ไม่มี updated_at/deleted_at โดยตั้งใจ; กัน update/delete/truncate ด้วย trigger + RLS)';
comment on table public.survey_answers is
  'append-only (C-09 ห้ามลบ/แก้คำตอบลูกค้า; ไม่มี soft-delete)';
comment on table public.case_activity_logs is
  'append-only timeline (ไม่มี soft-delete; กัน update/delete/truncate ด้วย trigger)';
comment on table public.cron_health is
  'health-check ระดับระบบ: ไม่ผูก tenant_id และไม่มี deleted_at โดยตั้งใจ';

-- หมายเหตุ RBAC (M1): role_permissions เป็น catalog แต่การ enforce จริงใน RLS
-- ยังอิง role-code (executive/acc_lead/... ) แบบ hardcode ใน helper functions
-- => ยอมรับได้สำหรับ M1; เฟสถัดไปค่อยขับ policy ด้วย catalog (role_permissions.scope)
comment on table public.role_permissions is
  'RBAC catalog + scope. M1: RLS enforce ด้วย role-code (hardcode ใน helper); เฟสถัดไปขับด้วย catalog';
