-- เฟส 6 ส่วน T (docs/06, หมวด 0.13–0.19) — กระทบยอดธนาคาร (Bank Reconciliation)
-- ★ match เก็บเป็นคอลัมน์บน bank_statement_lines ตรง ๆ (0.15) — ไม่แยกตาราง match (ลดความซับซ้อน,
--   1 statement line จับคู่ได้กับ 1 book line เท่านั้นในเฟสนี้ — ไม่รองรับ split/many-to-many)

create table if not exists public.bank_statement_import_batches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  bank_account_id uuid not null references public.customer_bank_accounts(id) on delete cascade,
  file_name       text,
  line_count      int not null default 0,
  imported_at     timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists idx_bank_stmt_batches_customer
  on public.bank_statement_import_batches (tenant_id, customer_id, bank_account_id)
  where deleted_at is null;

create table if not exists public.bank_statement_lines (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  bank_account_id       uuid not null references public.customer_bank_accounts(id) on delete cascade,
  batch_id              uuid references public.bank_statement_import_batches(id) on delete cascade,
  stmt_date             date not null,
  description           text,
  amount                numeric(14,2) not null,  -- + = เงินเข้า · − = เงินออก (0.13)
  -- snapshot การจับคู่ (0.15/0.16) — null ทั้งหมด = ยังไม่จับคู่
  matched_book_line_key text,
  matched_entry_id      uuid,
  matched_date          date,
  matched_amount        numeric(14,2),
  matched_at            timestamptz,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index if not exists idx_bank_stmt_lines_account_date
  on public.bank_statement_lines (tenant_id, bank_account_id, stmt_date) where deleted_at is null;
create index if not exists idx_bank_stmt_lines_batch
  on public.bank_statement_lines (tenant_id, batch_id) where deleted_at is null;

alter table public.bank_statement_import_batches enable row level security;
alter table public.bank_statement_lines          enable row level security;
create policy tenant_read on public.bank_statement_import_batches for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.bank_statement_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.bank_statement_import_batches from anon;
revoke all on public.bank_statement_lines          from anon;
grant select on public.bank_statement_import_batches to authenticated;
grant select on public.bank_statement_lines          to authenticated;
grant all    on public.bank_statement_import_batches to service_role;
grant all    on public.bank_statement_lines          to service_role;

notify pgrst, 'reload schema';
