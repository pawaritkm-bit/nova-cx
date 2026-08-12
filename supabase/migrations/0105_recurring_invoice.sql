-- =====================================================================
-- 0105 — เฟส wishlist ข้อ 4: ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ (Recurring Customer Invoicing)
--   ตั้งเทมเพลตใบแจ้งหนี้ให้สร้างซ้ำอัตโนมัติทุกเดือน/ไตรมาส/ปี (เช่น ค่าบริการรายเดือน)
--   → สร้างเป็น bill_entries (entry_type='sale') จริง ป้อนเข้า VAT/ลูกหนี้ค้างชำระ/รายงานต่าง ๆ
--   ต่อยอด lib/accounting/actions-lib.ts (upsertEntry/addLine) เดิม 100% ไม่แตะ engine เดิมเลย
--
--   ★ occurrence ที่ cron/ปุ่ม "สร้างตอนนี้" สร้างให้ เป็น status='draft' เสมอ — ไม่มีทาง auto-confirm
--     เข้าบัญชีจริงโดยไม่มีคนกดยืนยัน (แอปพลิเคชันเลเยอร์บังคับ ไม่ใช่ DB constraint — mirror 0073)
--   ★ claim_recurring_invoice_occurrence() เป็น atomic RPC (for update skip locked, pattern เดียวกับ
--     claim_recurring_je_occurrence ของ migration 0073) กัน cron/ปุ่มมือชนกันสร้างซ้ำ — SECURITY DEFINER,
--     service_role เท่านั้น · reuse public.add_months_clamped() เดิมตรง ๆ (ไม่ duplicate date math)
--   ★ recurring_invoice_template_id บน bill_entries เป็น metadata ล้วน (nullable, on delete set null)
--     ไม่ถูกใช้ในการคำนวณบัญชีใด ๆ — ไม่กระทบ mapper/รายงานเดิม
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) + ALTER เพิ่มคอลัมน์ nullable บน
--   bill_entries เท่านั้น ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.recurring_invoice_templates (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  -- คู่ค้าปลายทางที่จะออกใบแจ้งหนี้ให้ซ้ำ ๆ (เช่น "บริษัท ABC จำกัด")
  counterparty_name     text not null,
  counterparty_tax_id   text,
  notes                 text,
  frequency             text not null check (frequency in ('monthly','quarterly','yearly')),
  start_date            date not null,
  next_run_date         date not null,
  end_date              date,
  -- ครบกำหนดชำระกี่วันหลังวันที่ออกบิล (0 = ครบกำหนดวันเดียวกัน)
  due_days              int not null default 30 check (due_days >= 0),
  is_active             boolean not null default true,
  last_generated_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index if not exists idx_recurring_invoice_templates_due
  on public.recurring_invoice_templates (tenant_id, next_run_date)
  where deleted_at is null and is_active = true;
create index if not exists idx_recurring_invoice_templates_customer
  on public.recurring_invoice_templates (tenant_id, customer_id) where deleted_at is null;

create table if not exists public.recurring_invoice_template_lines (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.recurring_invoice_templates(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  description   text,
  -- บัญชีรายได้ของบรรทัดนี้ (ต้องอยู่หมวด "รายได้" — validate ที่ application layer)
  account_code  text not null,
  account_name  text,
  vat_type      text not null default 'vat' check (vat_type in ('vat','novat')),
  quantity      numeric(14,3) not null default 1 check (quantity > 0),
  unit_price    numeric(14,2) not null default 0 check (unit_price >= 0)
);
create index if not exists idx_recurring_invoice_template_lines_template
  on public.recurring_invoice_template_lines (tenant_id, template_id);

create table if not exists public.recurring_invoice_generation_log (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  template_id    uuid not null references public.recurring_invoice_templates(id) on delete cascade,
  run_date       date not null,
  status         text not null check (status in ('generated','failed')),
  message        text,
  bill_entry_id  uuid references public.bill_entries(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_recurring_invoice_gen_log_template
  on public.recurring_invoice_generation_log (tenant_id, template_id, run_date);

-- ★ link occurrence → เทมเพลตต้นทาง (metadata ล้วน — ไม่กระทบ mapper ใด ๆ)
alter table public.bill_entries
  add column if not exists recurring_invoice_template_id uuid
    references public.recurring_invoice_templates(id) on delete set null;

drop trigger if exists trg_recurring_invoice_templates_updated on public.recurring_invoice_templates;
create trigger trg_recurring_invoice_templates_updated before update on public.recurring_invoice_templates
  for each row execute function public.set_updated_at();

-- ★ claim แบบ atomic (for update skip locked) — กัน cron/ปุ่มมือชนกันสร้างซ้ำ (mirror 0073 เป๊ะ)
--   reuse public.add_months_clamped(date, int) เดิมจาก migration 0073 ตรง ๆ (ไม่ duplicate)
create or replace function public.claim_recurring_invoice_occurrence(
  p_tenant_id   uuid,
  p_template_id uuid,
  p_today       date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.recurring_invoice_templates%rowtype;
  v_months int;
  v_new_next date;
begin
  select * into v_row
  from public.recurring_invoice_templates
  where id = p_template_id and tenant_id = p_tenant_id
    and deleted_at is null and is_active = true
    and next_run_date <= p_today
    and (end_date is null or next_run_date <= end_date)
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  v_months := case v_row.frequency
    when 'monthly' then 1
    when 'quarterly' then 3
    else 12
  end;
  v_new_next := public.add_months_clamped(v_row.next_run_date, v_months);

  update public.recurring_invoice_templates
     set next_run_date = v_new_next, last_generated_at = now()
   where id = p_template_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'claimed', true,
    'run_date', v_row.next_run_date,
    'customer_id', v_row.customer_id,
    'counterparty_name', v_row.counterparty_name,
    'counterparty_tax_id', v_row.counterparty_tax_id,
    'notes', v_row.notes,
    'due_days', v_row.due_days
  );
end;
$$;

revoke all on function public.claim_recurring_invoice_occurrence(uuid, uuid, date) from public;
grant execute on function public.claim_recurring_invoice_occurrence(uuid, uuid, date) to service_role;

alter table public.recurring_invoice_templates       enable row level security;
alter table public.recurring_invoice_template_lines  enable row level security;
alter table public.recurring_invoice_generation_log  enable row level security;
drop policy if exists tenant_read on public.recurring_invoice_templates;
create policy tenant_read on public.recurring_invoice_templates for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.recurring_invoice_template_lines;
create policy tenant_read on public.recurring_invoice_template_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.recurring_invoice_generation_log;
create policy tenant_read on public.recurring_invoice_generation_log for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.recurring_invoice_templates       from anon;
revoke all on public.recurring_invoice_template_lines  from anon;
revoke all on public.recurring_invoice_generation_log  from anon;
grant select on public.recurring_invoice_templates       to authenticated;
grant select on public.recurring_invoice_template_lines  to authenticated;
grant select on public.recurring_invoice_generation_log  to authenticated;
grant all    on public.recurring_invoice_templates       to service_role;
grant all    on public.recurring_invoice_template_lines  to service_role;
grant all    on public.recurring_invoice_generation_log  to service_role;

notify pgrst, 'reload schema';
