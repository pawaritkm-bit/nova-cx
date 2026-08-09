-- เฟส 3 ส่วน J (docs/06-accounting-features-roadmap.md, หมวด 0.3-0.9/1.1)
-- ใบลดหนี้/ใบเพิ่มหนี้ (Credit Note / Debit Note) — จำกัดเฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น
-- 1 บิล (bill_entries) ออก CN/DN ซ้ำได้หลายใบ (1-ต่อ-กลาย เหมือน bill_payments)

create table if not exists public.credit_debit_notes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  entry_id      uuid not null references public.bill_entries(id) on delete cascade,
  -- customer_id สำเนาจาก bill_entries ตอนสร้าง (กรองเร็ว/สโคป — pattern เดียวกับ bill_payments.customer_id
  -- ความจริงของสิทธิ์ยังอ่านสดผ่าน getNoteEntryScope เสมอ ไม่ใช้สำเนานี้ตัดสิน)
  customer_id   uuid references public.customers(id) on delete set null,
  doc_type      text not null check (doc_type in ('credit_note','debit_note')),
  doc_date      date not null,
  doc_no        text,
  reason        text not null,
  status        text not null default 'draft' check (status in ('draft','confirmed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  deleted_at    timestamptz
);
create index if not exists idx_credit_debit_notes_tenant_entry
  on public.credit_debit_notes (tenant_id, entry_id) where deleted_at is null;
create index if not exists idx_credit_debit_notes_tenant_customer_date
  on public.credit_debit_notes (tenant_id, customer_id, doc_date) where deleted_at is null;

create table if not exists public.credit_debit_note_lines (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references public.credit_debit_notes(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  description   text,
  account_code  text not null,
  account_name  text,
  amount        numeric(14,2) not null default 0,
  vat_amount    numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_credit_debit_note_lines_note
  on public.credit_debit_note_lines (tenant_id, note_id);

drop trigger if exists trg_credit_debit_notes_updated on public.credit_debit_notes;
create trigger trg_credit_debit_notes_updated before update on public.credit_debit_notes
  for each row execute function public.set_updated_at();
drop trigger if exists trg_credit_debit_note_lines_updated on public.credit_debit_note_lines;
create trigger trg_credit_debit_note_lines_updated before update on public.credit_debit_note_lines
  for each row execute function public.set_updated_at();

alter table public.credit_debit_notes       enable row level security;
alter table public.credit_debit_note_lines  enable row level security;
drop policy if exists tenant_read on public.credit_debit_notes;
create policy tenant_read on public.credit_debit_notes for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.credit_debit_note_lines;
create policy tenant_read on public.credit_debit_note_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.credit_debit_notes       from anon;
revoke all on public.credit_debit_note_lines  from anon;
grant select on public.credit_debit_notes       to authenticated;
grant select on public.credit_debit_note_lines  to authenticated;
grant all on public.credit_debit_notes       to service_role;
grant all on public.credit_debit_note_lines  to service_role;

notify pgrst, 'reload schema';
