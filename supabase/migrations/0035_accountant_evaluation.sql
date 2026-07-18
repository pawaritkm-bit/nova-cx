-- =====================================================================
-- 0035 — Accountant Evaluation + Coaching (Phase 4) : ประเมินนักบัญชีจาก
--   หลักฐานในแชต + AI coach + หัวหน้า review/confirm + อุทธรณ์
--   ต่อจาก 0034 (conversation_cases + SLA)
--
-- โมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" — Phase 4:
--   aggregate ai_chat_analysis (flow/problems/sentiment) + conversation_cases
--     (SLA/resolution) ต่อ "นักบัญชี (owner) ต่อช่วง" → คะแนน 8 มิติ (ปรับน้ำหนัก)
--   → บันทึกเป็น "draft" (ai_draft) พร้อม evidence (อ้าง message_id) + coaching
--   → หัวหน้า confirm/edit/reject (manager_reviews) — ★ ห้ามลงโทษอัตโนมัติจากคะแนน AI
--   → นักบัญชียื่นอุทธรณ์ (evaluation_appeals) → หัวหน้า resolve
--   ★ ทุกการเปลี่ยนคะแนน audit ผ่าน audit_logs เดิม (0010, append-only)
--
-- ★ decision (analyst): accountant_evaluations แยกจาก employee_evaluations (0007)
--   0007 ผูก survey/response/pseudonymity แล้ว — นี่คือ "แหล่งคะแนนที่ 3" (จากแชต)
--   ยัดของแชตลง 0007 เสี่ยงพัง pseudonymity/RLS เดิม → แยกตารางใหม่ทั้งชุด
--
-- ★ RLS tier (สำคัญ): accountant เห็น eval "ของตัวเองเท่านั้น",
--   acc_lead เห็น "ทีมตัวเอง", executive/admin/auditor_qa เห็นทั้งหมด,
--   hr เห็นเฉพาะ "confirmed" (คะแนน ไม่เห็น evidence แชตดิบ)
--   → บังคับที่ RLS SELECT policy (tier-aware) + ซ้ำที่ app-layer (lib/evaluation/access.ts)
--
-- non-destructive:
--   - สร้างตารางใหม่ 6 ตัว + helper 4 ตัว + RPC 4 ตัว
--   - ALTER job_queue CHECK เพิ่มค่า 'evaluation' (คงค่าเดิมครบ)
--   ไม่แตะ employee_evaluations (0007) / survey / pseudonymity (0025/0027) / webhook
-- =====================================================================

-- ---------------------------------------------------------------------
-- helper: ผลรวมน้ำหนัก 8 มิติจาก jsonb (ใช้เป็น CHECK ว่ารวม = 100)
-- ---------------------------------------------------------------------
create or replace function public.eval_weight_total(p_weights jsonb)
returns numeric
language sql
immutable
as $$
  select
      coalesce((p_weights->>'correctness')::numeric, 0)
    + coalesce((p_weights->>'completeness')::numeric, 0)
    + coalesce((p_weights->>'sla')::numeric, 0)
    + coalesce((p_weights->>'clarity')::numeric, 0)
    + coalesce((p_weights->>'politeness')::numeric, 0)
    + coalesce((p_weights->>'ownership')::numeric, 0)
    + coalesce((p_weights->>'resolution')::numeric, 0)
    + coalesce((p_weights->>'sop')::numeric, 0)
$$;

-- ---------------------------------------------------------------------
-- helper: ตรวจว่าทุกค่าใน dimension_scores อยู่ในช่วง 0-100 (L2 — กันคะแนนปรับเพี้ยน)
--   ค่าที่ไม่ใช่ตัวเลขจะถูกข้าม; ว่าง = ผ่าน (true)
-- ---------------------------------------------------------------------
create or replace function public.eval_dimension_scores_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and((v.value)::numeric >= 0 and (v.value)::numeric <= 100), true)
  from jsonb_each_text(coalesce(p, '{}'::jsonb)) v
  where v.value ~ '^-?[0-9]+(\.[0-9]+)?$'
$$;

-- ---------------------------------------------------------------------
-- evaluation_weights ★ — config น้ำหนัก 8 มิติต่อ tenant (ปรับผ่าน admin)
--   weights : jsonb map มิติ→น้ำหนัก (รวมต้อง = 100 บังคับด้วย CHECK)
--   default (แนะนำ): correctness 20 / completeness 10 / sla 15 / clarity 10 /
--                    politeness 10 / ownership 15 / resolution 10 / sop 10 = 100
--   is_active : ชุดน้ำหนักที่ใช้งานอยู่ (1 tenant ควรมี active เดียว — บังคับด้วย partial unique)
-- ---------------------------------------------------------------------
create table if not exists public.evaluation_weights (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null default 'default',
  weights     jsonb not null default
                '{"correctness":20,"completeness":10,"sla":15,"clarity":10,"politeness":10,"ownership":15,"resolution":10,"sop":10}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  -- ★ ผลรวมน้ำหนักต้อง = 100 (กัน misconfig ทำ overall เพี้ยน)
  constraint chk_eval_weights_sum_100 check (public.eval_weight_total(weights) = 100)
);
create index if not exists idx_eval_weights_tenant on public.evaluation_weights(tenant_id);
-- 1 tenant มีชุด active ได้ชุดเดียว
create unique index if not exists uq_eval_weights_active
  on public.evaluation_weights(tenant_id)
  where is_active and deleted_at is null;
create trigger trg_eval_weights_updated before update on public.evaluation_weights
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- accountant_evaluations ★ — คะแนนนักบัญชีจากแชต (แหล่งที่ 3, แยกจาก 0007)
--   scope             : case | daily | weekly | monthly (รายเคส/วัน/สัปดาห์/เดือน)
--   dimension_scores  : jsonb map 8 มิติ (0-100 ต่อมิติ)
--   status flow       : ai_draft → manager_confirmed | manager_edited | rejected
--                       → appealed → appeal_resolved
--                       ★ ai_draft = ยังไม่มีผลลงโทษ (รอหัวหน้า confirm)
--   needs_review      : true เสมอตอนสร้าง (ห้ามใช้คะแนน AI ลงโทษอัตโนมัติ)
-- ---------------------------------------------------------------------
create table if not exists public.accountant_evaluations (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  employee_id           uuid not null references public.employees(id) on delete cascade,
  scope                 text not null default 'case'
                          check (scope in ('case','daily','weekly','monthly')),
  conversation_case_id  uuid references public.conversation_cases(id) on delete set null,
  period_start          timestamptz,
  period_end            timestamptz,
  overall_score         numeric(5,2) check (overall_score between 0 and 100),
  dimension_scores      jsonb not null default '{}'::jsonb,
  strengths             jsonb not null default '[]'::jsonb,
  improvements          jsonb not null default '[]'::jsonb,
  better_examples       jsonb not null default '[]'::jsonb,
  confidence            numeric(4,3),
  status                text not null default 'ai_draft'
                          check (status in ('ai_draft','manager_confirmed','manager_edited',
                                            'rejected','appealed','appeal_resolved')),
  needs_review          boolean not null default true,
  model                 text,
  provider              text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index if not exists idx_acc_eval_tenant on public.accountant_evaluations(tenant_id);
create index if not exists idx_acc_eval_employee on public.accountant_evaluations(employee_id);
create index if not exists idx_acc_eval_case on public.accountant_evaluations(conversation_case_id);
create index if not exists idx_acc_eval_status on public.accountant_evaluations(status);
-- idempotency: มี "ร่าง" (ai_draft) ต่อเคสได้ 1 ใบ (ประเมินซ้ำ = update ร่างเดิม ไม่สร้างซ้ำ)
create unique index if not exists uq_acc_eval_draft_case
  on public.accountant_evaluations(conversation_case_id)
  where scope = 'case' and status = 'ai_draft' and deleted_at is null
        and conversation_case_id is not null;
-- idempotency: ร่างรายช่วง (daily/weekly/monthly) 1 ใบต่อ (พนักงาน+scope+ช่วง)
create unique index if not exists uq_acc_eval_draft_period
  on public.accountant_evaluations(employee_id, scope, period_start, period_end)
  where scope in ('daily','weekly','monthly') and status = 'ai_draft' and deleted_at is null;
create trigger trg_acc_eval_updated before update on public.accountant_evaluations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- evaluation_evidence — หลักฐานต่อมิติ (อ้าง chat_message + เวลา)
--   impact : gain (ทำได้ดี → บวก) | loss (ต้องปรับ → ลบ)
--   ★ hr "ไม่เห็น" ตารางนี้ (เห็นแค่คะแนน confirmed ไม่เห็น evidence แชตดิบ)
-- ---------------------------------------------------------------------
create table if not exists public.evaluation_evidence (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  evaluation_id    uuid not null references public.accountant_evaluations(id) on delete cascade,
  chat_message_id  uuid references public.chat_messages(id) on delete set null,
  dimension        text not null,
  impact           text not null default 'loss' check (impact in ('gain','loss')),
  note             text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_eval_evidence_tenant on public.evaluation_evidence(tenant_id);
create index if not exists idx_eval_evidence_eval on public.evaluation_evidence(evaluation_id);
create index if not exists idx_eval_evidence_message on public.evaluation_evidence(chat_message_id);

-- ---------------------------------------------------------------------
-- manager_reviews — บันทึกการ review ของหัวหน้า (confirm/edit/reject)
--   append-only timeline: หัวหน้าทำรายการกี่ครั้งก็เก็บครบ (audit)
-- ---------------------------------------------------------------------
create table if not exists public.manager_reviews (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  evaluation_id             uuid not null references public.accountant_evaluations(id) on delete cascade,
  reviewer_employee_id      uuid references public.employees(id) on delete set null,
  action                    text not null check (action in ('confirm','edit','reject')),
  adjusted_dimension_scores jsonb,
  adjusted_overall          numeric(5,2) check (adjusted_overall between 0 and 100),
  note                      text,
  reviewed_at               timestamptz not null default now(),
  created_at                timestamptz not null default now()
);
create index if not exists idx_mgr_review_tenant on public.manager_reviews(tenant_id);
create index if not exists idx_mgr_review_eval on public.manager_reviews(evaluation_id);
-- append-only: ห้ามแก้/ลบ (เหมือน case_status_history) — เป็นหลักฐาน review
create trigger trg_mgr_review_immutable before update or delete on public.manager_reviews
  for each row execute function public.prevent_update_delete();
create trigger trg_mgr_review_no_truncate before truncate on public.manager_reviews
  for each statement execute function public.prevent_update_delete();

-- ---------------------------------------------------------------------
-- coaching_recommendations — คำแนะนำจาก AI coach (โทน coach ไม่จับผิด)
-- ---------------------------------------------------------------------
create table if not exists public.coaching_recommendations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  evaluation_id    uuid references public.accountant_evaluations(id) on delete cascade,
  period           text,
  strengths        jsonb not null default '[]'::jsonb,
  improvements     jsonb not null default '[]'::jsonb,
  example_answers  jsonb not null default '[]'::jsonb,
  checklist        jsonb not null default '[]'::jsonb,
  repeated_errors  jsonb not null default '[]'::jsonb,
  training_topics  jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists idx_coaching_tenant on public.coaching_recommendations(tenant_id);
create index if not exists idx_coaching_employee on public.coaching_recommendations(employee_id);
create index if not exists idx_coaching_eval on public.coaching_recommendations(evaluation_id);

-- ---------------------------------------------------------------------
-- evaluation_appeals — คำอุทธรณ์ของนักบัญชี + การ resolve ของหัวหน้า
--   status : submitted → reviewing → accepted | rejected
-- ---------------------------------------------------------------------
create table if not exists public.evaluation_appeals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  evaluation_id    uuid not null references public.accountant_evaluations(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  reason           text not null,
  status           text not null default 'submitted'
                     check (status in ('submitted','reviewing','accepted','rejected')),
  manager_response text,
  resolved_by      uuid references public.employees(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists idx_eval_appeal_tenant on public.evaluation_appeals(tenant_id);
create index if not exists idx_eval_appeal_eval on public.evaluation_appeals(evaluation_id);
create index if not exists idx_eval_appeal_employee on public.evaluation_appeals(employee_id);
-- 1 evaluation มีคำอุทธรณ์ที่ยัง active (submitted/reviewing) ได้ครั้งเดียว
create unique index if not exists uq_eval_appeal_active
  on public.evaluation_appeals(evaluation_id)
  where status in ('submitted','reviewing');
create trigger trg_eval_appeal_updated before update on public.evaluation_appeals
  for each row execute function public.set_updated_at();

-- =====================================================================
-- job_queue.queue CHECK : เพิ่ม 'evaluation' (คงค่าเดิมครบ)
-- =====================================================================
alter table public.job_queue drop constraint if exists job_queue_queue_check;
alter table public.job_queue add constraint job_queue_queue_check
  check (queue in ('notification','ai_analysis','line_event','chat_analysis',
                   'case_notification','evaluation'));

-- ★ กัน job evaluation ซ้อนต่อเคส (scan overlap) ตั้งแต่ชั้น DB
--   อนุญาต pending/processing ได้ 1 งานต่อ conversation_case_id — scan จับ 23505 → skip
--   (งานรายช่วง period ไม่มี conversation_case_id = NULL → Postgres ถือ NULL distinct ไม่ชนกัน)
create unique index if not exists uq_job_queue_evaluation_active
  on public.job_queue ((payload->>'conversation_case_id'))
  where queue = 'evaluation' and status in ('pending','processing');

-- =====================================================================
-- helper functions (SECURITY DEFINER) — tier visibility ของ accountant_evaluations
--   ★ กัน recursion/search_path hijack เหมือน 0011
-- =====================================================================

-- บทบาทที่เห็น "eval ทั้งหมด" ใน tenant (ผู้ตรวจ/ผู้บริหาร)
create or replace function public.current_is_eval_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role_code() in ('admin','executive','auditor_qa')
$$;

-- current user (acc_lead) เป็นหัวหน้าทีมของ employee เป้าหมายไหม
--   = role acc_lead AND employee นั้นอยู่ในทีม (ปัจจุบัน) ที่ตนเป็น lead
create or replace function public.is_eval_team_lead_of(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.current_role_code() = 'acc_lead'
    and exists (
      select 1
      from public.team_members tm
      join public.teams t on t.id = tm.team_id
      where tm.employee_id = p_employee_id
        and tm.deleted_at is null
        and tm.valid_to is null
        and t.deleted_at is null
        and t.lead_employee_id = public.current_employee_id()
    )
$$;

-- เห็น "คะแนน" ของ eval ของ employee นี้ได้ไหม (tier)
--   privileged → true; hr → เฉพาะ confirmed; acc_lead → ทีมตน หรือของตัวเอง;
--   accountant/อื่น → เฉพาะของตัวเอง
create or replace function public.can_view_accountant_eval(p_employee_id uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.current_is_eval_privileged()
    or (
      public.current_role_code() = 'hr'
      and p_status in ('manager_confirmed','manager_edited','appeal_resolved')
    )
    or public.is_eval_team_lead_of(p_employee_id)
    or p_employee_id = public.current_employee_id()
$$;

-- เห็น "หลักฐานแชตดิบ" (evidence/coaching/appeal) ของ employee นี้ได้ไหม
--   ★ เหมือน eval แต่ตัด hr ออก (hr เห็นแค่คะแนน ไม่เห็น evidence แชต)
create or replace function public.can_view_eval_evidence(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.current_is_eval_privileged()
    or public.is_eval_team_lead_of(p_employee_id)
    or p_employee_id = public.current_employee_id()
$$;

-- =====================================================================
-- RLS — enable + tier-aware SELECT policies
--   worker/scanner/server-action เขียนผ่าน service_role (bypass RLS)
--   ★ authenticated เขียนตรงไม่ได้ (ไม่มี write policy) — บังคับผ่าน RPC/service_role
-- =====================================================================
alter table public.evaluation_weights        enable row level security;
alter table public.accountant_evaluations     enable row level security;
alter table public.evaluation_evidence        enable row level security;
alter table public.manager_reviews            enable row level security;
alter table public.coaching_recommendations   enable row level security;
alter table public.evaluation_appeals         enable row level security;

-- evaluation_weights : config ระดับ tenant — อ่านได้ทั้ง tenant (แก้ผ่าน service_role/admin)
create policy tenant_read on public.evaluation_weights for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- accountant_evaluations : ★ tier — accountant เห็นเฉพาะของตัวเอง
create policy tier_read on public.accountant_evaluations for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.can_view_accountant_eval(employee_id, status)
  );

-- evaluation_evidence : ผูก tier ของ eval แม่ + ตัด hr (ไม่เห็น evidence แชต)
create policy tier_read on public.evaluation_evidence for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.accountant_evaluations e
      where e.id = evaluation_id
        and public.can_view_eval_evidence(e.employee_id)
    )
  );

-- manager_reviews : ผูก tier ของ eval แม่ (คะแนน) — hr เห็น review ของ eval ที่ confirmed
create policy tier_read on public.manager_reviews for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.accountant_evaluations e
      where e.id = evaluation_id
        and public.can_view_accountant_eval(e.employee_id, e.status)
    )
  );

-- coaching_recommendations : own/team/privileged (ตัด hr — เป็นเครื่องมือ coach ของนักบัญชี)
create policy tier_read on public.coaching_recommendations for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.can_view_eval_evidence(employee_id)
  );

-- evaluation_appeals : ผู้ยื่น (ตัวเอง)/หัวหน้าทีม/privileged
create policy tier_read on public.evaluation_appeals for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.can_view_eval_evidence(employee_id)
  );

-- =====================================================================
-- GRANT posture (pattern 0013) — ตารางสร้างหลัง 0013 ต้องตั้งชัดเจน
--   anon          : ปฏิเสธทั้งหมด (deny-by-default)
--   authenticated : SELECT เท่านั้น (write ผ่าน RPC/service_role — กันปลอมคะแนน/review)
--   service_role  : all (worker/server-action เบื้องหลัง)
-- =====================================================================
revoke all on public.evaluation_weights       from anon;
revoke all on public.accountant_evaluations    from anon;
revoke all on public.evaluation_evidence       from anon;
revoke all on public.manager_reviews           from anon;
revoke all on public.coaching_recommendations  from anon;
revoke all on public.evaluation_appeals        from anon;

grant select on public.evaluation_weights       to authenticated;
grant select on public.accountant_evaluations    to authenticated;
grant select on public.evaluation_evidence       to authenticated;
grant select on public.manager_reviews           to authenticated;
grant select on public.coaching_recommendations  to authenticated;
grant select on public.evaluation_appeals        to authenticated;

grant all on public.evaluation_weights       to service_role;
grant all on public.accountant_evaluations    to service_role;
grant all on public.evaluation_evidence       to service_role;
grant all on public.manager_reviews           to service_role;
grant all on public.coaching_recommendations  to service_role;
grant all on public.evaluation_appeals        to service_role;

-- =====================================================================
-- persist_accountant_evaluation() — บันทึก eval draft แบบ atomic + idempotent
--   1) upsert accountant_evaluations (ถ้ามีร่าง ai_draft ตาม key อยู่แล้ว → update ร่างเดิม)
--   2) replace evaluation_evidence ของ eval (ลบเก่า→ใส่ใหม่ตาม p_evidence)
--   3) insert coaching_recommendations (ถ้ามี p_coaching)
--   4) audit_logs : action=eval_created หรือ eval_updated (append-only)
--   ★ status บังคับเป็น 'ai_draft' + needs_review=true เสมอ (ห้ามลงโทษอัตโนมัติ)
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================
create or replace function public.persist_accountant_evaluation(
  p_tenant_id             uuid,
  p_employee_id           uuid,
  p_scope                 text,
  p_conversation_case_id  uuid,
  p_period_start          timestamptz,
  p_period_end            timestamptz,
  p_overall_score         numeric,
  p_dimension_scores      jsonb,
  p_strengths             jsonb,
  p_improvements          jsonb,
  p_better_examples       jsonb,
  p_confidence            numeric,
  p_model                 text,
  p_provider              text,
  p_evidence              jsonb,   -- array {chat_message_id, dimension, impact, note, sent_at}
  p_coaching              jsonb,   -- {period,strengths,improvements,example_answers,checklist,repeated_errors,training_topics}
  p_actor_user_id         uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_eval_id   uuid;
  v_created   boolean := false;
  v_ev        jsonb;
  v_msg       uuid;
begin
  -- employee ต้องอยู่ใน tenant นี้ (กันเขียนข้าม tenant)
  if not exists (
    select 1 from public.employees where id = p_employee_id and tenant_id = p_tenant_id
  ) then
    raise exception 'employee_not_found' using errcode = 'P0002';
  end if;

  -- หา "ร่าง" (ai_draft) เดิมตาม idempotency key
  if p_scope = 'case' and p_conversation_case_id is not null then
    select id into v_eval_id
    from public.accountant_evaluations
    where tenant_id = p_tenant_id
      and conversation_case_id = p_conversation_case_id
      and scope = 'case' and status = 'ai_draft' and deleted_at is null
    limit 1
    for update;
  else
    select id into v_eval_id
    from public.accountant_evaluations
    where tenant_id = p_tenant_id
      and employee_id = p_employee_id
      and scope = p_scope
      and period_start is not distinct from p_period_start
      and period_end is not distinct from p_period_end
      and status = 'ai_draft' and deleted_at is null
    limit 1
    for update;
  end if;

  if v_eval_id is null then
    insert into public.accountant_evaluations (
      tenant_id, employee_id, scope, conversation_case_id, period_start, period_end,
      overall_score, dimension_scores, strengths, improvements, better_examples,
      confidence, status, needs_review, model, provider
    ) values (
      p_tenant_id, p_employee_id, p_scope, p_conversation_case_id, p_period_start, p_period_end,
      p_overall_score, coalesce(p_dimension_scores,'{}'::jsonb),
      coalesce(p_strengths,'[]'::jsonb), coalesce(p_improvements,'[]'::jsonb),
      coalesce(p_better_examples,'[]'::jsonb),
      p_confidence, 'ai_draft', true, p_model, p_provider
    )
    returning id into v_eval_id;
    v_created := true;
  else
    -- update ร่างเดิม (ประเมินซ้ำก่อนหัวหน้า confirm) — ★ ไม่แตะ eval ที่ confirmed แล้ว
    update public.accountant_evaluations
    set overall_score    = p_overall_score,
        dimension_scores = coalesce(p_dimension_scores,'{}'::jsonb),
        strengths        = coalesce(p_strengths,'[]'::jsonb),
        improvements     = coalesce(p_improvements,'[]'::jsonb),
        better_examples  = coalesce(p_better_examples,'[]'::jsonb),
        confidence       = p_confidence,
        model            = p_model,
        provider         = p_provider,
        needs_review     = true
    where id = v_eval_id;
  end if;

  -- replace evidence (ลบเก่า→ใส่ใหม่) — เฉพาะ message ที่อยู่ใน tenant เดียวกัน
  delete from public.evaluation_evidence where evaluation_id = v_eval_id;
  if p_evidence is not null and jsonb_typeof(p_evidence) = 'array' then
    for v_ev in select * from jsonb_array_elements(p_evidence)
    loop
      v_msg := null;
      if (v_ev ? 'chat_message_id') and nullif(v_ev->>'chat_message_id','') is not null then
        select id into v_msg from public.chat_messages
        where id = (v_ev->>'chat_message_id')::uuid and tenant_id = p_tenant_id;
      end if;
      insert into public.evaluation_evidence (
        tenant_id, evaluation_id, chat_message_id, dimension, impact, note, sent_at
      ) values (
        p_tenant_id, v_eval_id, v_msg,
        coalesce(nullif(v_ev->>'dimension',''), 'other'),
        coalesce(nullif(v_ev->>'impact',''), 'loss'),
        v_ev->>'note',
        nullif(v_ev->>'sent_at','')::timestamptz
      );
    end loop;
  end if;

  -- coaching (สร้างใหม่ทุกครั้งที่ประเมิน — เก็บเป็น timeline)
  if p_coaching is not null and jsonb_typeof(p_coaching) = 'object' then
    insert into public.coaching_recommendations (
      tenant_id, employee_id, evaluation_id, period,
      strengths, improvements, example_answers, checklist, repeated_errors, training_topics
    ) values (
      p_tenant_id, p_employee_id, v_eval_id, p_coaching->>'period',
      coalesce(p_coaching->'strengths','[]'::jsonb),
      coalesce(p_coaching->'improvements','[]'::jsonb),
      coalesce(p_coaching->'example_answers','[]'::jsonb),
      coalesce(p_coaching->'checklist','[]'::jsonb),
      coalesce(p_coaching->'repeated_errors','[]'::jsonb),
      coalesce(p_coaching->'training_topics','[]'::jsonb)
    );
  end if;

  -- audit (append-only) — บันทึกทุกครั้งที่สร้าง/แก้ร่าง
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource, resource_id, meta)
  values (
    p_tenant_id, p_actor_user_id,
    case when v_created then 'eval_created' else 'eval_updated' end,
    'accountant_evaluation', v_eval_id,
    jsonb_build_object('scope', p_scope, 'overall_score', p_overall_score,
                       'employee_id', p_employee_id, 'source', 'ai_draft')
  );

  return jsonb_build_object('evaluation_id', v_eval_id, 'created', v_created);
end;
$$;

revoke all on function public.persist_accountant_evaluation(uuid,uuid,text,uuid,timestamptz,timestamptz,numeric,jsonb,jsonb,jsonb,jsonb,numeric,text,text,jsonb,jsonb,uuid) from public;
grant execute on function public.persist_accountant_evaluation(uuid,uuid,text,uuid,timestamptz,timestamptz,numeric,jsonb,jsonb,jsonb,jsonb,numeric,text,text,jsonb,jsonb,uuid) to service_role;

-- =====================================================================
-- record_manager_review() — หัวหน้า confirm/edit/reject (atomic + audit)
--   insert manager_reviews + เปลี่ยน status ของ eval + audit_logs
--   confirm → manager_confirmed ; edit → manager_edited (+ปรับคะแนน) ; reject → rejected
--   ★ guard tier (นักบัญชีแก้ไม่ได้) บังคับที่ app-layer ก่อนเรียก RPC นี้
-- =====================================================================
create or replace function public.record_manager_review(
  p_tenant_id           uuid,
  p_evaluation_id       uuid,
  p_reviewer_emp_id     uuid,
  p_action              text,
  p_adjusted_dimension  jsonb,
  p_adjusted_overall    numeric,
  p_note                text,
  p_actor_user_id       uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_status  text;
  v_old_overall numeric;
  v_new_status  text;
begin
  if p_action not in ('confirm','edit','reject') then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  -- ★ defense-in-depth: reviewer ต้องอยู่ใน tenant เดียวกัน (กัน reviewer ข้าม tenant)
  if p_reviewer_emp_id is not null and not exists (
    select 1 from public.employees where id = p_reviewer_emp_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reviewer_not_in_tenant' using errcode = 'P0001';
  end if;

  -- ★ L2: adjusted_dimension_scores ต้องอยู่ 0-100
  if p_adjusted_dimension is not null
     and not public.eval_dimension_scores_valid(p_adjusted_dimension) then
    raise exception 'dimension_score_out_of_range' using errcode = 'P0001';
  end if;

  -- eval ต้องอยู่ใน tenant นี้ + ล็อกแถวกัน race
  select status, overall_score into v_old_status, v_old_overall
  from public.accountant_evaluations
  where id = p_evaluation_id and tenant_id = p_tenant_id and deleted_at is null
  for update;
  if not found then
    raise exception 'evaluation_not_found' using errcode = 'P0002';
  end if;

  -- ★ status guard: review/ทับได้เฉพาะ draft หรือหลัง confirm/edit เท่านั้น
  --   บล็อกการทับ eval ที่กำลังอุทธรณ์/ตัดสินอุทธรณ์แล้ว/ถูก reject
  if v_old_status not in ('ai_draft','manager_confirmed','manager_edited') then
    raise exception 'evaluation_not_reviewable' using errcode = 'P0001';
  end if;

  v_new_status := case p_action
    when 'confirm' then 'manager_confirmed'
    when 'edit'    then 'manager_edited'
    else 'rejected'
  end;

  insert into public.manager_reviews (
    tenant_id, evaluation_id, reviewer_employee_id, action,
    adjusted_dimension_scores, adjusted_overall, note
  ) values (
    p_tenant_id, p_evaluation_id, p_reviewer_emp_id, p_action,
    p_adjusted_dimension, p_adjusted_overall, p_note
  );

  update public.accountant_evaluations
  set status = v_new_status,
      needs_review = false,
      -- edit → ใช้คะแนนที่หัวหน้าปรับ (ถ้าส่งมา) ทับคะแนน AI
      overall_score = case
        when p_action = 'edit' and p_adjusted_overall is not null
          then p_adjusted_overall else overall_score end,
      dimension_scores = case
        when p_action = 'edit' and p_adjusted_dimension is not null
          then p_adjusted_dimension else dimension_scores end
  where id = p_evaluation_id;

  -- ★ audit ทุกการเปลี่ยนคะแนน/สถานะ (append-only)
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource, resource_id, meta)
  values (
    p_tenant_id, p_actor_user_id, 'eval_' || p_action,
    'accountant_evaluation', p_evaluation_id,
    jsonb_build_object(
      'from_status', v_old_status, 'to_status', v_new_status,
      'old_overall', v_old_overall, 'adjusted_overall', p_adjusted_overall,
      'reviewer_employee_id', p_reviewer_emp_id
    )
  );

  return jsonb_build_object('evaluation_id', p_evaluation_id,
                            'from_status', v_old_status, 'to_status', v_new_status);
end;
$$;

revoke all on function public.record_manager_review(uuid,uuid,uuid,text,jsonb,numeric,text,uuid) from public;
grant execute on function public.record_manager_review(uuid,uuid,uuid,text,jsonb,numeric,text,uuid) to service_role;

-- =====================================================================
-- submit_evaluation_appeal() — นักบัญชียื่นอุทธรณ์ (atomic + audit)
--   insert evaluation_appeals + เปลี่ยน status eval → appealed + audit
--   ★ guard: p_employee_id ต้อง = เจ้าของ eval (บังคับที่ app-layer + ตรวจซ้ำใน RPC)
-- =====================================================================
create or replace function public.submit_evaluation_appeal(
  p_tenant_id      uuid,
  p_evaluation_id  uuid,
  p_employee_id    uuid,
  p_reason         text,
  p_actor_user_id  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner   uuid;
  v_status  text;
  v_appeal  uuid;
begin
  select employee_id, status into v_owner, v_status
  from public.accountant_evaluations
  where id = p_evaluation_id and tenant_id = p_tenant_id and deleted_at is null
  for update;
  if not found then
    raise exception 'evaluation_not_found' using errcode = 'P0002';
  end if;

  -- ★ อุทธรณ์ได้เฉพาะเจ้าของ eval
  if v_owner <> p_employee_id then
    raise exception 'not_evaluation_owner' using errcode = 'P0001';
  end if;
  -- อุทธรณ์ได้เฉพาะหลังหัวหน้าตัดสิน (confirmed/edited) — draft ยังไม่มีผลให้อุทธรณ์
  if v_status not in ('manager_confirmed','manager_edited') then
    raise exception 'evaluation_not_appealable' using errcode = 'P0001';
  end if;

  insert into public.evaluation_appeals (tenant_id, evaluation_id, employee_id, reason)
  values (p_tenant_id, p_evaluation_id, p_employee_id, p_reason)
  returning id into v_appeal;

  update public.accountant_evaluations
  set status = 'appealed'
  where id = p_evaluation_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, resource, resource_id, meta)
  values (
    p_tenant_id, p_actor_user_id, 'eval_appeal_submitted',
    'accountant_evaluation', p_evaluation_id,
    jsonb_build_object('appeal_id', v_appeal, 'from_status', v_status)
  );

  return jsonb_build_object('appeal_id', v_appeal, 'evaluation_id', p_evaluation_id);
end;
$$;

revoke all on function public.submit_evaluation_appeal(uuid,uuid,uuid,text,uuid) from public;
grant execute on function public.submit_evaluation_appeal(uuid,uuid,uuid,text,uuid) to service_role;

-- =====================================================================
-- resolve_evaluation_appeal() — หัวหน้าตัดสินคำอุทธรณ์ (atomic + audit)
--   update evaluation_appeals (accepted/rejected) + eval status → appeal_resolved
--   accepted + ปรับคะแนน → ทับ overall/dimension ; audit ครบ
-- =====================================================================
create or replace function public.resolve_evaluation_appeal(
  p_tenant_id           uuid,
  p_appeal_id           uuid,
  p_resolver_emp_id     uuid,
  p_decision            text,        -- accepted | rejected
  p_manager_response    text,
  p_adjusted_overall    numeric,
  p_adjusted_dimension  jsonb,
  p_actor_user_id       uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_eval_id  uuid;
  v_status   text;
begin
  if p_decision not in ('accepted','rejected') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;

  -- ★ defense-in-depth: resolver ต้องอยู่ใน tenant เดียวกัน
  if p_resolver_emp_id is not null and not exists (
    select 1 from public.employees where id = p_resolver_emp_id and tenant_id = p_tenant_id
  ) then
    raise exception 'resolver_not_in_tenant' using errcode = 'P0001';
  end if;

  -- ★ L2: adjusted_dimension_scores ต้องอยู่ 0-100
  if p_adjusted_dimension is not null
     and not public.eval_dimension_scores_valid(p_adjusted_dimension) then
    raise exception 'dimension_score_out_of_range' using errcode = 'P0001';
  end if;

  select evaluation_id, status into v_eval_id, v_status
  from public.evaluation_appeals
  where id = p_appeal_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'appeal_not_found' using errcode = 'P0002';
  end if;
  if v_status not in ('submitted','reviewing') then
    raise exception 'appeal_already_resolved' using errcode = 'P0001';
  end if;

  update public.evaluation_appeals
  set status = p_decision,
      manager_response = p_manager_response,
      resolved_by = p_resolver_emp_id,
      resolved_at = now()
  where id = p_appeal_id;

  update public.accountant_evaluations
  set status = 'appeal_resolved',
      overall_score = case
        when p_decision = 'accepted' and p_adjusted_overall is not null
          then p_adjusted_overall else overall_score end,
      dimension_scores = case
        when p_decision = 'accepted' and p_adjusted_dimension is not null
          then p_adjusted_dimension else dimension_scores end
  where id = v_eval_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, resource, resource_id, meta)
  values (
    p_tenant_id, p_actor_user_id, 'eval_appeal_' || p_decision,
    'accountant_evaluation', v_eval_id,
    jsonb_build_object('appeal_id', p_appeal_id, 'resolver_employee_id', p_resolver_emp_id,
                       'adjusted_overall', p_adjusted_overall)
  );

  return jsonb_build_object('appeal_id', p_appeal_id, 'evaluation_id', v_eval_id,
                            'decision', p_decision);
end;
$$;

revoke all on function public.resolve_evaluation_appeal(uuid,uuid,uuid,text,text,numeric,jsonb,uuid) from public;
grant execute on function public.resolve_evaluation_appeal(uuid,uuid,uuid,text,text,numeric,jsonb,uuid) to service_role;

comment on function public.persist_accountant_evaluation(uuid,uuid,text,uuid,timestamptz,timestamptz,numeric,jsonb,jsonb,jsonb,jsonb,numeric,text,text,jsonb,jsonb,uuid) is
  'บันทึก accountant_evaluation draft (idempotent) + evidence + coaching + audit (Phase 4)';
comment on function public.record_manager_review(uuid,uuid,uuid,text,jsonb,numeric,text,uuid) is
  'หัวหน้า confirm/edit/reject evaluation (atomic + manager_reviews + audit) (Phase 4)';
comment on function public.submit_evaluation_appeal(uuid,uuid,uuid,text,uuid) is
  'นักบัญชียื่นอุทธรณ์ evaluation (เฉพาะเจ้าของ, atomic + audit) (Phase 4)';
comment on function public.resolve_evaluation_appeal(uuid,uuid,uuid,text,text,numeric,jsonb,uuid) is
  'หัวหน้าตัดสินคำอุทธรณ์ (accepted/rejected, atomic + audit) (Phase 4)';
