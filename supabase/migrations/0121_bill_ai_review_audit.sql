-- 0121 — เก็บผล AI ก่อน/หลังนักบัญชีแก้ เพื่อวัด accuracy จริงโดยไม่เรียก AI เพิ่ม
create table if not exists public.bill_ai_review_audits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  entry_id          uuid not null references public.bill_entries(id) on delete cascade,
  ai_snapshot       jsonb not null,
  reviewed_snapshot jsonb not null,
  created_at        timestamptz not null default now(),
  unique (tenant_id, entry_id)
);

create index if not exists idx_bill_ai_review_audits_tenant_created
  on public.bill_ai_review_audits (tenant_id, created_at desc);

alter table public.bill_ai_review_audits enable row level security;
revoke all on public.bill_ai_review_audits from anon, authenticated;
grant all on public.bill_ai_review_audits to service_role;
notify pgrst, 'reload schema';
