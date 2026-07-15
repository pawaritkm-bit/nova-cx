-- =====================================================================
-- 0027 — ปิดต้นตอจริงของ Critical pseudonymity (residual base-table linkage)
--        + คืนสิทธิ์ role `cs` ดูเคสร้องเรียน
--
-- บริบท (ทำไม view-layer fix 0025 ยังปิดไม่สนิท):
--   ผู้ใช้ที่ล็อกอินทุกคน = Postgres role `authenticated` (app role อยู่ใน data)
--   member (accountant/sales) query "ตารางฐานตรง" ผ่าน PostgREST ด้วย session ตน:
--     employee_evaluations (RLS เห็นแถว employee_id=ตน → ได้ response_id)
--       → survey_responses (RLS can_access_customer=true สำหรับลูกค้าที่ตนดูแล
--          → ได้ customer_id / invitation_id) → customers → ชื่อ
--     ⇒ โยง "คะแนนของฉัน ↔ ชื่อลูกค้า" ได้ (ละเมิด pseudonymity FR-DB-02/03, C-07)
--   การตัด response_id ที่ "view" (0025) ไม่ช่วย เพราะ member ไม่ได้อ่านผ่าน view
--   แต่ยิง base table ตรง
--
-- แนวทาง (surgical, column-level REVOKE — ไม่แตะ RLS policy เดิม):
--   survey_responses เป็น "สะพานเดียว" ที่แปลง response_id → ตัวตนลูกค้า
--   (คอลัมน์ที่โยง: customer_id ตรง ๆ, invitation_id → survey_invitations.customer_id)
--   ตารางคะแนนลูก (satisfaction_scores/nps_scores/ai_feedback_analysis/survey_answers)
--   ผูกด้วย response_id เท่านั้น ไม่มี customer_id/invitation_id → ไม่ใช่สะพาน
--   ⇒ REVOKE SELECT(customer_id, invitation_id) บน survey_responses จาก authenticated
--     ทำให้ member ถือ response_id ได้ แต่ "ต่อ" ไปหาลูกค้าจาก base table ไม่ได้อีก
--
-- ปลอดภัยไหม (ยืนยันด้วยการ grep โค้ด):
--   * ไม่มี "scoped client (anon+cookie=authenticated)" ที่อ่าน survey_responses เลย
--     — ที่เดียวที่อ่านคือ lib/ai/worker.ts และรันผ่าน service-role (bypass RLS/grant)
--       (เรียกจาก app/api/cron/process-ai/route.ts ด้วย createServiceRoleClient)
--   * dashboard/report อ่านผ่าน "security-definer view" (0025) ซึ่ง view เป็นของ postgres
--     → column-level REVOKE จาก authenticated ไม่กระทบการอ่านผ่าน view
--       (exec เห็น customer_id/response_id ใน v_dashboard_response_facts ได้ตามเดิม;
--        member เห็น v_feedback_for_evaluatee / v_customer_tracking ได้ตามเดิม)
--   ⇒ REVOKE นี้ไม่ทำให้ read ที่ชอบด้วยกฎพังแม้แต่ทางเดียว
-- =====================================================================

-- ---------------------------------------------------------------------
-- งาน A — ตัด base-table linkage: REVOKE คอลัมน์สะพานบน survey_responses
--   คงคอลัมน์ที่ไม่โยงตัวตน (id/tenant_id/submitted_at/... ) ให้ authenticated
--   อ่านได้ตามเดิม — เผื่ออนาคตมี scoped read ที่ไม่ต้องรู้ลูกค้า ก็ไม่พัง
-- ---------------------------------------------------------------------
revoke select (customer_id)   on public.survey_responses from authenticated;
revoke select (invitation_id) on public.survey_responses from authenticated;

comment on column public.survey_responses.customer_id is
  '★ pseudonymity (0027): REVOKE SELECT จาก authenticated — member โยงคะแนน→ลูกค้าจาก base table ไม่ได้ (อ่านได้เฉพาะ service-role/security-definer view)';
comment on column public.survey_responses.invitation_id is
  '★ pseudonymity (0027): REVOKE SELECT จาก authenticated — กัน hop response→invitation→customer_id (อ่านได้เฉพาะ service-role/security-definer view)';

-- ---------------------------------------------------------------------
-- งาน B — คืนสิทธิ์ role `cs` (customer service) ให้เห็นเคสร้องเรียน
--   ปัญหา: 0025 ตั้ง v_dashboard_case_facts เป็น WHERE is_privileged() เท่านั้น
--     → cs เห็นเคส 0 แถว ทั้งที่ "งานหลักของ cs คือจัดการเคสร้องเรียน"
--   แก้ "เฉพาะ view นี้": เปิดให้ cs ด้วย (is_privileged() OR role='cs')
--     ใช้ helper current_role_code() (0011, SECURITY DEFINER, grant authenticated แล้ว)
--   ★ v_dashboard_response_facts (คะแนนดิบผูกลูกค้า) "คง is_privileged() เท่านั้น"
--     — cs ไม่ต้องเห็น score-analytics ผูกลูกค้า (ไม่แตะในไฟล์นี้)
--   ★ view นี้แสดง customer_code (รหัสธุรกิจ) ไม่ใช่ชื่อบุคคล/เบอร์/อีเมล — ตัวตนเต็มต้องผ่าน audit
-- ---------------------------------------------------------------------
create or replace view public.v_dashboard_case_facts as
select
  cc.tenant_id,
  cc.id                as case_id,
  cc.case_no,
  cc.customer_id,
  c.customer_code,
  cc.type,
  cc.level,
  cc.status,
  cc.sla_due_at,
  cc.created_at,
  cc.closed_at,
  cc.post_resolution_csat
from public.complaint_cases cc
left join public.customers c
  on c.id = cc.customer_id and c.deleted_at is null
where cc.deleted_at is null
  and cc.tenant_id = public.current_tenant_id()
  -- ★ privileged (admin/executive) เห็นหมด + cs (งานจัดการเคส) เห็นด้วย
  and (public.is_privileged() or public.current_role_code() = 'cs');

comment on view public.v_dashboard_case_facts is
  'เคสร้องเรียน (scope=privileged + cs) สำหรับ dashboard; แสดง customer_code ไม่ใช่ชื่อบุคคล/PII';

-- create or replace view คงสิทธิ์เดิมไว้ แต่ประกาศซ้ำเพื่อความชัดเจน/idempotent
grant select on public.v_dashboard_case_facts to authenticated, service_role;
