-- =====================================================================
-- 0076 — เฟส 7 ส่วน V (docs/06-accounting-features-roadmap.md, หมวด 0.1–0.13)
--   ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติแบบเส้นตรง (straight-line) — ต่อยอด
--   manual_journal_entries เดิม (เฟส 1 ส่วน C, migration 0066) 100% ไม่แตะ engine เดิมเลย
--
--   ★ occurrence ค่าเสื่อมที่ cron/ปุ่ม "สร้างตอนนี้" สร้างให้ เป็น status='draft' เสมอ (0.3) — ไม่มีทาง
--     auto-confirm เข้าบัญชีจริงโดยไม่มีคนกดยืนยัน (แอปพลิเคชันเลเยอร์บังคับ ไม่ใช่ DB constraint)
--   ★ ยอดต่อรอบไม่คงที่ตลอดไป (0.5) — งวดสุดท้ายเป็น "plug" กันเศษสตางค์ค้าง (ต่างจาก recurring JE เฟส 6):
--     amount = least(monthly_depreciation, remaining) โดย remaining = cost - salvage - accumulated ก่อนหน้า
--     รับประกันว่าค่าเสื่อมสะสมรวมทั้งหมด = cost - salvage เป๊ะเสมอ ไม่มีเศษตกค้าง
--   ★ ทรัพย์สินที่ตัดค่าเสื่อมครบแล้ว (0.6): next_dep_date=null แต่ status ยังเป็น 'active' (ยังไม่จำหน่าย)
--   ★ claim_fixed_asset_depreciation() เป็น atomic RPC (for update skip locked, mirror
--     claim_recurring_je_occurrence เฟส 6/migration 0073 เป๊ะ) — reuse public.add_months_clamped()
--     เดิมจาก migration 0073 ตรง ๆ ไม่สร้างฟังก์ชันซ้ำ — SECURITY DEFINER, service_role เท่านั้น
--   ★ fixed_asset_id บน manual_journal_entries เป็น metadata ล้วน (nullable, on delete set null)
--     ไม่ถูกใช้ในการคำนวณบัญชีใด ๆ (0.9) — ไม่กระทบ mapper toJournalLines/toJournalPosting เดิม
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) + ALTER เพิ่มคอลัมน์ nullable บน
--   manual_journal_entries เท่านั้น ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.fixed_assets (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  customer_id              uuid not null references public.customers(id) on delete cascade,
  name                     text not null,
  asset_account_code       text not null,
  accum_dep_account_code   text not null,
  dep_expense_account_code text not null,
  acquisition_date         date not null,
  cost                     numeric(14,2) not null check (cost > 0),
  salvage_value            numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months       int not null check (useful_life_months > 0),
  monthly_depreciation     numeric(14,2) not null,  -- คำนวณ+เก็บตอนสร้าง (0.1) — งวดสุดท้ายเป็น plug (0.5)
  accumulated_depreciation numeric(14,2) not null default 0,
  -- null = ไม่มีรอบถัดไปให้สร้าง (ตัดค่าเสื่อมครบแล้ว 0.6 หรือจำหน่ายแล้ว) — advance โดย RPC claim เท่านั้น
  next_dep_date            date,
  status                   text not null default 'active' check (status in ('active','disposed')),
  disposal_date            date,
  disposal_proceeds        numeric(14,2),
  disposal_entry_id        uuid references public.manual_journal_entries(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  constraint fixed_assets_salvage_lt_cost check (salvage_value < cost)
);
create index if not exists idx_fixed_assets_tenant_customer
  on public.fixed_assets (tenant_id, customer_id) where deleted_at is null;
create index if not exists idx_fixed_assets_due
  on public.fixed_assets (tenant_id, next_dep_date)
  where deleted_at is null and status = 'active' and next_dep_date is not null;

create table if not exists public.fixed_asset_depreciation_log (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  asset_id         uuid not null references public.fixed_assets(id) on delete cascade,
  period           date not null,  -- เดือนที่คิดค่าเสื่อม (วันที่ 1 ของเดือนนั้น)
  amount           numeric(14,2),
  status           text not null check (status in ('generated','failed')),
  message          text,
  manual_entry_id  uuid references public.manual_journal_entries(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_fixed_asset_dep_log_asset
  on public.fixed_asset_depreciation_log (tenant_id, asset_id, period);

-- ★ link occurrence/disposal → ทรัพย์สินต้นทาง (metadata ล้วน — ไม่กระทบ mapper ใด ๆ, ดู 0.9)
alter table public.manual_journal_entries
  add column if not exists fixed_asset_id uuid
    references public.fixed_assets(id) on delete set null;

drop trigger if exists trg_fixed_assets_updated on public.fixed_assets;
create trigger trg_fixed_assets_updated before update on public.fixed_assets
  for each row execute function public.set_updated_at();

-- ★ 0.4/0.5: claim แบบ atomic (for update skip locked) — กัน cron/ปุ่มมือชนกันสร้างซ้ำ
--   reuse public.add_months_clamped() ที่มีอยู่แล้วจาก migration 0073 ตรง ๆ ไม่สร้างฟังก์ชันซ้ำ
create or replace function public.claim_fixed_asset_depreciation(
  p_tenant_id  uuid,
  p_asset_id   uuid,
  p_today      date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.fixed_assets%rowtype;
  v_remaining numeric(14,2);
  v_amount numeric(14,2);
  v_new_accum numeric(14,2);
  v_new_next date;
begin
  select * into v_row
  from public.fixed_assets
  where id = p_asset_id and tenant_id = p_tenant_id
    and deleted_at is null and status = 'active'
    and next_dep_date is not null and next_dep_date <= p_today
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  v_remaining := round((v_row.cost - v_row.salvage_value - v_row.accumulated_depreciation)::numeric, 2);
  if v_remaining <= 0 then
    -- กันเคสผิดปกติ (ไม่ควรเกิดถ้า invariant ถูกรักษาไว้เสมอ) — เคลียร์รอบถัดไปแทนสร้างยอด 0
    update public.fixed_assets set next_dep_date = null where id = p_asset_id and tenant_id = p_tenant_id;
    return jsonb_build_object('claimed', false);
  end if;

  v_amount := least(v_row.monthly_depreciation, v_remaining);  -- ★ 0.5 งวดสุดท้ายเป็น plug
  v_new_accum := round((v_row.accumulated_depreciation + v_amount)::numeric, 2);

  if round((v_row.cost - v_row.salvage_value - v_new_accum)::numeric, 2) <= 0 then
    v_new_next := null;  -- ★ 0.6 ตัดค่าเสื่อมครบแล้ว — ไม่มีรอบถัดไป
  else
    v_new_next := public.add_months_clamped(v_row.next_dep_date, 1);
  end if;

  update public.fixed_assets
     set accumulated_depreciation = v_new_accum, next_dep_date = v_new_next
   where id = p_asset_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'claimed', true,
    'period', v_row.next_dep_date,
    'amount', v_amount,
    'customer_id', v_row.customer_id,
    'name', v_row.name,
    'dep_expense_account_code', v_row.dep_expense_account_code,
    'accum_dep_account_code', v_row.accum_dep_account_code
  );
end;
$$;

revoke all on function public.claim_fixed_asset_depreciation(uuid, uuid, date) from public;
grant execute on function public.claim_fixed_asset_depreciation(uuid, uuid, date) to service_role;

comment on function public.claim_fixed_asset_depreciation(uuid, uuid, date) is
  'สร้างรายการค่าเสื่อมราคาอัตโนมัติแบบ atomic — increment accumulated_depreciation + advance next_dep_date
   ในทีเดียว (เฟส 7, 0.4/0.5) — mirror claim_recurring_je_occurrence ของเฟส 6';

alter table public.fixed_assets                  enable row level security;
alter table public.fixed_asset_depreciation_log   enable row level security;
drop policy if exists tenant_read on public.fixed_assets;
create policy tenant_read on public.fixed_assets for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.fixed_asset_depreciation_log;
create policy tenant_read on public.fixed_asset_depreciation_log for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.fixed_assets                from anon;
revoke all on public.fixed_asset_depreciation_log from anon;
grant select on public.fixed_assets                to authenticated;
grant select on public.fixed_asset_depreciation_log to authenticated;
grant all    on public.fixed_assets                to service_role;
grant all    on public.fixed_asset_depreciation_log to service_role;

notify pgrst, 'reload schema';
