-- 0122 — ประวัติการเรียก AI สำหรับหน้า Admin (ไม่เก็บ prompt/response/ข้อมูลลูกค้า)
create table if not exists public.ai_usage_logs (
  id                   bigint generated always as identity primary key,
  source               text not null,
  provider             text not null,
  model                text not null,
  prompt_tokens        integer,
  output_tokens        integer,
  total_tokens         integer,
  estimated_cost_usd   numeric(14,8),
  estimated_cost_thb   numeric(14,6),
  price_is_estimate    boolean not null default true,
  created_at           timestamptz not null default now()
);

create index if not exists idx_ai_usage_logs_created on public.ai_usage_logs (created_at desc);
create index if not exists idx_ai_usage_logs_source_created on public.ai_usage_logs (source, created_at desc);

alter table public.ai_usage_logs enable row level security;
revoke all on public.ai_usage_logs from anon, authenticated;
grant all on public.ai_usage_logs to service_role;
notify pgrst, 'reload schema';
