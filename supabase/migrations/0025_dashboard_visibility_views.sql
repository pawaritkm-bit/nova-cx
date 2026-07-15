-- =====================================================================
-- 0025 — Visibility views + dashboard aggregate facts (M2 chunk 5)
--   ชั้นการมองเห็น (§16 design, pseudonymous ไม่ใช่ anonymous 100% — C-07):
--     * ผู้ถูกประเมิน (นักบัญชี/เซล) เห็น "คะแนน + สรุป" แต่ "ไม่เห็นชื่อลูกค้า/PII"
--       — ทำที่ระดับ view/column (ตัดคอลัมน์ชื่อ/เบอร์/อีเมล/customer_id ออก)
--         ไม่ใช่ซ่อนที่ frontend (FR-DB-02/03, §15)
--     * exec เห็นทั้ง tenant, หัวหน้าเห็นทีม, สมาชิกเห็นของตน — บังคับ scope ใน WHERE
--
--   เทคนิค (security-definer view pattern):
--     view เป็นของ role postgres (เจ้าของตาราง → bypass RLS ของตารางต้นทาง)
--     ดังนั้น "ต้อง" ใส่ scope ในตัว WHERE เองด้วย helper จาก 0011
--     (current_tenant_id / current_role_code / current_employee_id / is_privileged /
--      can_access_customer) — helper เป็น SECURITY DEFINER + grant ให้ authenticated แล้ว
--     ทำให้เดิน scope ตาม auth.uid() ของผู้เรียกอย่างถูกต้อง (ไม่รั่วข้าม tenant/scope)
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_feedback_for_evaluatee — ★ มุมมองผู้ถูกประเมิน (นักบัญชี/เซล/หัวหน้าดูลูกทีม)
--   เห็นคะแนน (avg_score) + สรุปของ AI (sentiment/urgency/summary/categories)
--   ★ ไม่มี customer_id / ชื่อลูกค้า / เบอร์ / อีเมล — ตัด PII ที่ระดับคอลัมน์
--     (ผู้ถูกประเมินจึงโยงคะแนนกลับไปหา "ลูกค้ารายไหน" ไม่ได้)
--   ★ C1 (PDPA non-linkability): "ห้าม" expose response_id / key ใด ๆ ที่ join
--     กลับไปหา customer_id ได้ — response_id เคยหลุดมาแม้ dashboard ไม่ได้ใช้
--     (ผู้ถูกประเมินเอา response_id ไป join กับ view/ตารางที่มี customer_id
--      → โยง "คะแนน → ลูกค้า" ได้) จึงตัดออกจาก select
--   scope: privileged เห็นหมด / เจ้าตัวเห็นของตน / หัวหน้าเห็นของลูกทีม (team_members ปัจจุบัน)
-- ---------------------------------------------------------------------
create or replace view public.v_feedback_for_evaluatee as
select
  ee.id                as evaluation_id,
  ee.tenant_id,
  ee.employee_id,
  ee.subject_role,
  ee.avg_score,
  sr.submitted_at,
  si.survey_type,
  si.cycle_period      as cycle,
  af.sentiment,
  af.urgency,
  af.summary,
  af.categories,
  af.next_best_action
from public.employee_evaluations ee
join public.survey_responses sr
  on sr.id = ee.response_id and sr.deleted_at is null
left join public.survey_invitations si
  on si.id = sr.invitation_id and si.deleted_at is null
left join public.ai_feedback_analysis af
  on af.response_id = sr.id and af.deleted_at is null
where ee.deleted_at is null
  and ee.tenant_id = public.current_tenant_id()
  and (
    public.is_privileged()
    or ee.employee_id = public.current_employee_id()
    or (
      public.current_role_code() in ('acc_lead','sales_lead')
      and exists (
        select 1
        from public.team_members tm
        join public.teams t on t.id = tm.team_id
        where tm.employee_id = ee.employee_id
          and tm.valid_to is null
          and tm.deleted_at is null
          and t.lead_employee_id = public.current_employee_id()
      )
    )
  );

comment on view public.v_feedback_for_evaluatee is
  'ชั้นมองเห็นผู้ถูกประเมิน: คะแนน+สรุป AI ตัดชื่อ/customer_id/PII ออก (§16, FR-DB-02/03)';

-- ---------------------------------------------------------------------
-- v_dashboard_response_facts — fact ระดับ "คำเชิญ/คำตอบ" สำหรับ metric ภาพรวม
--   ขับ: Response Rate (นับ invitation vs responded), CSAT เฉลี่ย, NPS, sentiment
--   ★ C1 (PDPA): view นี้มี customer_id + response_id + คะแนน (csat/nps) อยู่ในแถวเดียว
--     = "score ผูกลูกค้า" โดยตรง → เปิดให้ "เฉพาะ privileged (admin/executive)" เท่านั้น
--     member (accountant/sales) ต้อง query ไม่ได้เลย (คืน 0 แถว) — member ใช้
--     v_feedback_for_evaluatee (คะแนนตัวเองไม่มีชื่อ) + v_customer_tracking (ชื่อ+สถานะ ไม่มีคะแนน)
--   ★ ไม่มีชื่อลูกค้า (มี customer_id เพื่อ join ต่อ/นับ unique เท่านั้น — ไม่ใช่ PII ชื่อ)
-- ---------------------------------------------------------------------
create or replace view public.v_dashboard_response_facts as
select
  si.tenant_id,
  si.id                as invitation_id,
  sr.id                as response_id,
  si.customer_id,
  si.survey_type,
  si.cycle_period,
  si.status            as invitation_status,
  sr.submitted_at,
  (sr.id is not null and sr.submitted_at is not null) as is_responded,
  (
    select round(avg(ss.score), 2)
    from public.satisfaction_scores ss
    where ss.response_id = sr.id and ss.deleted_at is null
  )                    as csat_overall,
  (
    select nps.score_0_10
    from public.nps_scores nps
    where nps.response_id = sr.id and nps.deleted_at is null
    limit 1
  )                    as nps_score,
  (
    select nps.category
    from public.nps_scores nps
    where nps.response_id = sr.id and nps.deleted_at is null
    limit 1
  )                    as nps_category,
  af.sentiment,
  af.urgency
from public.survey_invitations si
left join public.survey_responses sr
  on sr.invitation_id = si.id and sr.deleted_at is null
left join public.ai_feedback_analysis af
  on af.response_id = sr.id and af.deleted_at is null
where si.deleted_at is null
  and si.tenant_id = public.current_tenant_id()
  -- ★ C1: score ผูก customer_id → เฉพาะ privileged (admin/executive) เท่านั้น
  and public.is_privileged();

comment on view public.v_dashboard_response_facts is
  'fact คำเชิญ/คำตอบ สำหรับ Response Rate + CSAT + NPS (scope=privileged เท่านั้น; มี customer_id+score จึงกัน member โยงคะแนน→ลูกค้า)';

-- ---------------------------------------------------------------------
-- v_team_score_facts — คะแนนพนักงานผูกทีม (ปัจจุบัน) สำหรับเทียบทีม + internal review
--   ขับ: exec "CSAT รายทีม", หัวหน้าดูคะแนนลูกทีม
--   scope เหมือน scope_employee_evaluations: privileged / เจ้าตัว / หัวหน้าของทีม
--   ★ ไม่มีชื่อลูกค้า
-- ---------------------------------------------------------------------
create or replace view public.v_team_score_facts as
select
  ee.tenant_id,
  tm.team_id,
  t.name               as team_name,
  t.type               as team_type,
  ee.employee_id,
  e.first_name         as employee_first_name,
  e.nickname           as employee_nickname,
  ee.subject_role,
  ee.avg_score,
  si.survey_type,
  si.cycle_period,
  sr.submitted_at
from public.employee_evaluations ee
join public.employees e
  on e.id = ee.employee_id and e.deleted_at is null
join public.survey_responses sr
  on sr.id = ee.response_id and sr.deleted_at is null
left join public.survey_invitations si
  on si.id = sr.invitation_id and si.deleted_at is null
left join public.team_members tm
  on tm.employee_id = ee.employee_id
 and tm.valid_to is null
 and tm.deleted_at is null
left join public.teams t
  on t.id = tm.team_id and t.deleted_at is null
where ee.deleted_at is null
  and ee.tenant_id = public.current_tenant_id()
  and (
    public.is_privileged()
    or ee.employee_id = public.current_employee_id()
    or (
      public.current_role_code() in ('acc_lead','sales_lead')
      and exists (
        select 1
        from public.team_members tm2
        join public.teams t2 on t2.id = tm2.team_id
        where tm2.employee_id = ee.employee_id
          and tm2.valid_to is null
          and tm2.deleted_at is null
          and t2.lead_employee_id = public.current_employee_id()
      )
    )
  );

comment on view public.v_team_score_facts is
  'คะแนนพนักงานผูกทีมปัจจุบัน สำหรับเทียบทีม/internal review (ไม่มีชื่อลูกค้า)';

-- ---------------------------------------------------------------------
-- v_dashboard_case_facts — เคสร้องเรียน (scoped) สำหรับ exec/หัวหน้า
--   ขับ: เคสเร่งด่วน, สรุปสถานะเคส, เวลาปิดเคส, ลูกค้าเสี่ยงยกเลิก (retention)
--   ★ แสดง customer_code (รหัสธุรกิจ) ไม่แสดงชื่อบุคคล/เบอร์/อีเมล
--     (เปิด "ตัวตนเต็ม" ต้องผ่าน endpoint audit ตาม FR-PD-04 — TODO chunk ถัดไป)
--   ★ C1 (PDPA): view นี้ผูก customer_id + post_resolution_csat (คะแนนหลังปิดเคส)
--     → เปิดให้ "เฉพาะ privileged (admin/executive)" เท่านั้น; member query ไม่ได้ (0 แถว)
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
  -- ★ C1: เคสผูก customer_id + คะแนน → เฉพาะ privileged (admin/executive) เท่านั้น
  and public.is_privileged();

comment on view public.v_dashboard_case_facts is
  'เคสร้องเรียน (scope=privileged เท่านั้น) สำหรับ dashboard; แสดง customer_code ไม่ใช่ชื่อบุคคล/PII';

-- ---------------------------------------------------------------------
-- v_customer_tracking — ★ รายการติดตามลูกค้า "ที่ตนดูแล" (นักบัญชี/เซล/หัวหน้า)
--   ขับ: ประเมินแล้ว/ยังไม่ประเมิน + โทรตาม (เฉพาะคนยังไม่ประเมิน)
--   ★ view นี้ "แสดงชื่อลูกค้า" ได้ เพราะเป็นลูกค้าในความรับผิดชอบของตน (งาน CRM ปกติ)
--     — ต่างจาก v_feedback_for_evaluatee ที่ตัดชื่อออก:
--       tracking = "ใครยังไม่ตอบ ต้องโทรตาม" (ไม่ผูกกับคะแนน)
--       feedback = "คะแนน/ความเห็น" (ไม่ผูกกับชื่อ)
--       จึงโยง "คะแนน → ชื่อลูกค้า" ไม่ได้ (pseudonymous คงอยู่)
--   scope: can_access_customer (เห็นเฉพาะลูกค้าของตน/ทีม; exec เห็นหมด)
--   has_phone: มีเบอร์ในระบบไหม (ciphertext) — เลขจริงถอดที่ชั้นแอปด้วย CREDENTIAL_ENC_KEY
-- ---------------------------------------------------------------------
create or replace view public.v_customer_tracking as
select
  si.tenant_id,
  si.id                as invitation_id,
  si.customer_id,
  c.name               as customer_name,
  c.customer_code,
  si.survey_type,
  si.cycle_period,
  si.status            as invitation_status,
  (sr.id is not null and sr.submitted_at is not null) as is_responded,
  si.reminder_count,
  si.first_sent_at,
  si.last_reminded_at,
  si.created_at        as invited_at,
  exists (
    select 1
    from public.customer_contacts ct
    where ct.customer_id = si.customer_id
      and ct.deleted_at is null
      and ct.phone_enc is not null
  )                    as has_phone
from public.survey_invitations si
join public.customers c
  on c.id = si.customer_id and c.deleted_at is null
left join public.survey_responses sr
  on sr.invitation_id = si.id and sr.deleted_at is null
where si.deleted_at is null
  and si.tenant_id = public.current_tenant_id()
  and public.can_access_customer(si.customer_id);

comment on view public.v_customer_tracking is
  'รายการติดตามลูกค้าที่ตนดูแล (ประเมินแล้ว/ยังไม่/โทรตาม); แสดงชื่อได้ (ลูกค้าของตน) แต่ไม่ผูกกับคะแนน';

-- ---------------------------------------------------------------------
-- สิทธิ์อ่าน view: authenticated (scope บังคับใน WHERE) + service_role
--   view เป็นของ postgres → bypass RLS ตารางต้นทาง; scope อยู่ใน WHERE แล้ว
-- ---------------------------------------------------------------------
grant select on public.v_feedback_for_evaluatee   to authenticated, service_role;
grant select on public.v_dashboard_response_facts to authenticated, service_role;
grant select on public.v_team_score_facts         to authenticated, service_role;
grant select on public.v_dashboard_case_facts     to authenticated, service_role;
grant select on public.v_customer_tracking        to authenticated, service_role;
