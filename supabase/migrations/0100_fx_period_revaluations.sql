-- เฟส 10b (docs/06-accounting-features-roadmap.md บรรทัด 5485-6084, 0.7) — unrealized FX revaluation
--   ปลายงวด + auto-reversing เต็มรูป — ไม่แก้ bill_entries.fx_rate เลย (เข้ากันได้กับ 0.9 เฟส 10a ที่ล็อกไว้)
--   ⚠️ เลข migration นี้ถูกจองเป็น 0100 (ไม่ใช่ 0091 ตามที่แผนเดิมเขียนไว้) เพราะมีงานคู่ขนานอื่นจองเลข
--   0091/0092 ไปก่อนแล้วจาก main เดียวกัน — ดูคำสั่งงานที่มอบหมายจริงของรอบนี้

create table if not exists public.fx_period_revaluations (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  -- ฝั่งบัญชี — 'sale' = ปรับปรุง AR (1140), 'purchase' = ปรับปรุง AP (2010) — ต้องแยกกันเสมอ (0.7)
  entry_type            text not null check (entry_type in ('sale','purchase')),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  period_end_date       date not null,
  closing_rate          numeric(18,6) not null check (closing_rate > 0 and closing_rate <= 100000),
  source                text not null check (source in ('bot','manual')),
  outstanding_fx_amount numeric(14,2) not null,     -- audit: ยอดคงค้าง fx ณ ตอนสร้าง (0.4)
  unrealized_amount     numeric(14,2) not null,     -- audit: กำไร(+)/ขาดทุน(−) ที่คำนวณได้ ณ ตอนสร้าง
  revaluation_je_id     uuid references public.manual_journal_entries(id) on delete set null,
  reversing_je_id       uuid references public.manual_journal_entries(id) on delete set null,
  -- cache สำหรับ list/แสดงผลเร็วเท่านั้น — guard ต้องเช็ค live status เสมอ ไม่เชื่อคอลัมน์นี้ตรง ๆ (0.12)
  status                text not null default 'reval_draft'
                          check (status in ('reval_draft','reversing_draft','reversing_confirmed','voided')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

-- กันสร้างซ้อนทับงวดเดียวกันของกลุ่มเดียวกัน (0.14: voided ไม่ถูกนับ กันหลังลบ JE แล้วสร้างใหม่ไม่ได้)
create unique index if not exists uq_fx_period_revaluations_group_period
  on public.fx_period_revaluations (tenant_id, customer_id, entry_type, currency, period_end_date)
  where deleted_at is null and status <> 'voided';

create index if not exists idx_fx_period_revaluations_group_latest
  on public.fx_period_revaluations (tenant_id, customer_id, entry_type, currency, period_end_date desc)
  where deleted_at is null;

create index if not exists idx_fx_period_revaluations_reval_je
  on public.fx_period_revaluations (tenant_id, revaluation_je_id)
  where deleted_at is null and revaluation_je_id is not null;
create index if not exists idx_fx_period_revaluations_reversing_je
  on public.fx_period_revaluations (tenant_id, reversing_je_id)
  where deleted_at is null and reversing_je_id is not null;

drop trigger if exists trg_fx_period_revaluations_updated on public.fx_period_revaluations;
create trigger trg_fx_period_revaluations_updated before update on public.fx_period_revaluations
  for each row execute function public.set_updated_at();

alter table public.fx_period_revaluations enable row level security;
drop policy if exists tenant_read on public.fx_period_revaluations;
create policy tenant_read on public.fx_period_revaluations for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.fx_period_revaluations from anon;
grant select on public.fx_period_revaluations to authenticated;
grant all on public.fx_period_revaluations to service_role;

notify pgrst, 'reload schema';
