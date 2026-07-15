-- =====================================================================
-- 0006 — Survey (versioned) : templates, versions, questions, options,
--        campaigns, invitations, responses, answers
-- ★ versioned JSON schema + snapshot ผู้ดูแล + unique กันซ้ำ
-- =====================================================================

-- ---------------------------------------------------------------------
-- survey_templates — 4 ประเภท A/B/C/D
-- ---------------------------------------------------------------------
create table public.survey_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  survey_type   text not null check (survey_type in ('A','B','C','D')),
  name          text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, survey_type)
);
create index idx_survey_templates_tenant on public.survey_templates(tenant_id);
create trigger trg_survey_templates_updated before update on public.survey_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_versions — โครง + conditional logic เป็น JSONB (versioned)
-- ---------------------------------------------------------------------
create table public.survey_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  template_id   uuid not null references public.survey_templates(id) on delete cascade,
  version_no    integer not null,
  schema_json   jsonb not null default '{}'::jsonb,   -- โครงฟอร์ม+conditional rule
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (template_id, version_no)
);
create index idx_survey_versions_tenant on public.survey_versions(tenant_id);
create index idx_survey_versions_template on public.survey_versions(template_id);
create trigger trg_survey_versions_updated before update on public.survey_versions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_questions — คำถามแต่ละข้อ (normalized เผื่อ query/รายงาน)
-- ---------------------------------------------------------------------
create table public.survey_questions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  version_id    uuid not null references public.survey_versions(id) on delete cascade,
  code          text not null,
  text          text not null,
  type          text not null check (type in ('rating','single','multi','open','nps')),
  order_no      integer not null default 0,
  config_json   jsonb not null default '{}'::jsonb,   -- conditional/topic follow-up
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (version_id, code)
);
create index idx_survey_questions_tenant on public.survey_questions(tenant_id);
create index idx_survey_questions_version on public.survey_questions(version_id);
create trigger trg_survey_questions_updated before update on public.survey_questions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_question_options — ตัวเลือก; is_exclusive = "ยังไม่พบปัญหา" (เลือกเดี่ยว)
-- ---------------------------------------------------------------------
create table public.survey_question_options (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  question_id   uuid not null references public.survey_questions(id) on delete cascade,
  value         text not null,
  label         text not null,
  is_exclusive  boolean not null default false,
  order_no      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (question_id, value)
);
create index idx_survey_options_tenant on public.survey_question_options(tenant_id);
create index idx_survey_options_question on public.survey_question_options(question_id);
create trigger trg_survey_options_updated before update on public.survey_question_options
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_campaigns — รอบการส่ง
-- ---------------------------------------------------------------------
create table public.survey_campaigns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  survey_type   text not null check (survey_type in ('A','B','C','D')),
  cycle_label   text not null,                     -- เช่น '2026-Q3', '2026-07'
  period_start  date,
  period_end    date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_survey_campaigns_tenant on public.survey_campaigns(tenant_id);
create trigger trg_survey_campaigns_updated before update on public.survey_campaigns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_invitations ★
-- - snapshot ผู้ดูแล ณ วัน trigger (assignee_snapshot)
-- - idempotency_key กัน cron สร้างซ้ำ
-- - token ผูก line_user + หมดอายุ + single-use
-- - UNIQUE(customer_id, survey_type, cycle_period) กันซ้ำ (FR-SC-05)
-- ---------------------------------------------------------------------
create table public.survey_invitations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  campaign_id        uuid references public.survey_campaigns(id) on delete set null,
  customer_id        uuid not null references public.customers(id) on delete cascade,
  line_user_id       uuid references public.line_users(id) on delete set null,
  survey_type        text not null check (survey_type in ('A','B','C','D')),
  survey_version_id  uuid not null references public.survey_versions(id),
  opportunity_id     uuid references public.sales_opportunities(id) on delete set null, -- สำหรับ C/D (1 ครั้ง/ดีล)
  cycle_period       text not null,                -- ใช้ทำ unique
  assignee_snapshot  jsonb not null default '[]'::jsonb, -- ★ ผู้ดูแล ณ วัน trigger
  token              text not null unique,
  token_expires_at   timestamptz,
  status             text not null default 'pending'
                     check (status in ('pending','sent','opened','responded','expired')),
  reminder_count     integer not null default 0,
  idempotency_key    text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (customer_id, survey_type, cycle_period),  -- ★ FR-SC-05
  unique (tenant_id, idempotency_key)
);
create index idx_survey_inv_tenant on public.survey_invitations(tenant_id);
create index idx_survey_inv_customer on public.survey_invitations(customer_id);
create index idx_survey_inv_status on public.survey_invitations(status);
create trigger trg_survey_inv_updated before update on public.survey_invitations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_responses — 1 response ต่อ invitation (single-use)
-- เก็บ survey_template_version ทุกคำตอบ (FR-SV-09)
-- ---------------------------------------------------------------------
create table public.survey_responses (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  invitation_id            uuid not null references public.survey_invitations(id) on delete cascade,
  customer_id              uuid not null references public.customers(id) on delete cascade,
  survey_template_version  uuid not null references public.survey_versions(id), -- ★ version snapshot
  identity_mode            text not null default 'limited_display'
                           check (identity_mode in ('identified','limited_display')),
  submitted_at             timestamptz,
  is_locked                boolean not null default false,
  edit_window_expires_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (invitation_id)                            -- 1 response ต่อ invitation
);
create index idx_survey_resp_tenant on public.survey_responses(tenant_id);
create index idx_survey_resp_customer on public.survey_responses(customer_id);
create trigger trg_survey_resp_updated before update on public.survey_responses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- survey_answers — คำตอบรายข้อ (append-only, ห้ามลบ/แก้ C-09)
-- ---------------------------------------------------------------------
create table public.survey_answers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  response_id   uuid not null references public.survey_responses(id) on delete cascade,
  question_code text not null,
  value_json    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index idx_survey_answers_tenant on public.survey_answers(tenant_id);
create index idx_survey_answers_response on public.survey_answers(response_id);
-- append-only: กันแก้/ลบ แม้ service_role
create trigger trg_survey_answers_immutable before update or delete on public.survey_answers
  for each row execute function public.prevent_update_delete();
