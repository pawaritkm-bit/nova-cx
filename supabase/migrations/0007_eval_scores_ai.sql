-- =====================================================================
-- 0007 — Evaluation / Scores / AI
--        employee_evaluations, satisfaction_scores, nps_scores,
--        feedback_categories, feedback_tags, ai_feedback_analysis
-- =====================================================================

-- ---------------------------------------------------------------------
-- employee_evaluations — คะแนนต่อ employee (employee_id จาก snapshot ★)
-- ---------------------------------------------------------------------
create table public.employee_evaluations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  response_id   uuid not null references public.survey_responses(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  subject_role  text not null default 'unknown' check (subject_role in ('lead','member','team','unknown')),
  avg_score     numeric(4,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_emp_eval_tenant on public.employee_evaluations(tenant_id);
create index idx_emp_eval_response on public.employee_evaluations(response_id);
create index idx_emp_eval_employee on public.employee_evaluations(employee_id);
create trigger trg_emp_eval_updated before update on public.employee_evaluations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- satisfaction_scores — CSAT ต่อข้อ/ภาพรวม
-- ---------------------------------------------------------------------
create table public.satisfaction_scores (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  response_id   uuid not null references public.survey_responses(id) on delete cascade,
  dimension     text not null,                     -- ชื่อมิติ/ข้อ หรือ 'overall'
  score         numeric(4,2) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_csat_tenant on public.satisfaction_scores(tenant_id);
create index idx_csat_response on public.satisfaction_scores(response_id);
create trigger trg_csat_updated before update on public.satisfaction_scores
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- nps_scores — NPS (0-10 + หมวด)
-- ---------------------------------------------------------------------
create table public.nps_scores (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  response_id   uuid not null references public.survey_responses(id) on delete cascade,
  score_0_10    integer not null check (score_0_10 between 0 and 10),
  category      text not null check (category in ('promoter','passive','detractor')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (response_id)
);
create index idx_nps_tenant on public.nps_scores(tenant_id);
create trigger trg_nps_updated before update on public.nps_scores
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- feedback_categories / feedback_tags — แคตตาล็อกจัดหมวด
-- ---------------------------------------------------------------------
create table public.feedback_categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  code          text not null,
  label         text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, code)
);
create index idx_fb_cat_tenant on public.feedback_categories(tenant_id);
create trigger trg_fb_cat_updated before update on public.feedback_categories
  for each row execute function public.set_updated_at();

create table public.feedback_tags (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  code          text not null,
  label         text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, code)
);
create index idx_fb_tag_tenant on public.feedback_tags(tenant_id);
create trigger trg_fb_tag_updated before update on public.feedback_tags
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- ai_feedback_analysis — ผลวิเคราะห์ของน้อง NOVA
-- ★ แยก customer_facts / ai_assumptions / evidence (C-03)
-- ---------------------------------------------------------------------
create table public.ai_feedback_analysis (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  response_id         uuid not null references public.survey_responses(id) on delete cascade,
  summary             text,
  sentiment           text check (sentiment in ('positive','neutral','negative')),
  urgency             text check (urgency in ('critical','high','medium','positive')),
  customer_facts      jsonb not null default '[]'::jsonb,  -- ★ ข้อเท็จจริงจากลูกค้า
  ai_assumptions      jsonb not null default '[]'::jsonb,  -- ★ ข้อสันนิษฐาน AI
  evidence            jsonb not null default '[]'::jsonb,  -- ★ อ้างอิงคำพูด
  categories          jsonb not null default '[]'::jsonb,
  next_best_action    text,
  draft_reply         text,
  confidence          numeric(4,3),
  model               text,
  provider            text,
  needs_human_review  boolean not null default false,
  validated           boolean not null default false,      -- ผ่าน Zod หรือไม่
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (response_id)
);
create index idx_ai_analysis_tenant on public.ai_feedback_analysis(tenant_id);
create index idx_ai_analysis_urgency on public.ai_feedback_analysis(urgency);
create trigger trg_ai_analysis_updated before update on public.ai_feedback_analysis
  for each row execute function public.set_updated_at();
