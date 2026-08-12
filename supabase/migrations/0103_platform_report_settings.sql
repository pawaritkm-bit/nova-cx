-- =====================================================================
-- 0103 — ข้อ C ต่อเนื่อง: ตั้งค่าบัญชีสำหรับ auto-สร้างสมุดรายวัน (draft JE) จากรายงานแพลตฟอร์ม
--   1 แถวต่อ (tenant, customer) — mirror 0081_payroll_settings.sql ทุกจุด (รหัสบัญชีไม่ hardcode FK
--   จริง เก็บเป็น text ตรงกับ chart_of_accounts.code เลือกผ่าน AccountCombobox เท่านั้น)
--
--   ★ ทุกฟิลด์ required (ต่างจาก payroll_settings ที่บางฟิลด์ nullable) — เพราะทุกประเภทของรายงาน
--     แพลตฟอร์มต้องมีบัญชีลงให้ครบก่อนสร้าง JE ได้จริงเสมอ ไม่มีเคส "ยังไม่ตั้งได้ตอนเริ่มต้น" แบบ payroll
--   ★ ค่า default อ้างจากผังบัญชีมาตรฐานที่ seed ไว้แล้ว (migration 0063): 4010=ขายสินค้า,
--     5344=ค่าบริการแพลตฟอร์ม (commission), 5355=ค่าธรรมเนียมอื่นๆ (payment fee),
--     5341=ค่าขนส่ง (shipping), 5315=ค่าโฆษณา (ads), 5365=ค่าใช้จ่ายเบ็ดเตล็ด (penalty/other),
--     1020=เงินฝากธนาคาร #1 (clearing/net received) — ทุกค่า default ยังแก้เป็นรหัสอื่นได้เสมอ
-- =====================================================================

create table if not exists public.platform_report_settings (
  id                            uuid primary key default gen_random_uuid(),
  tenant_id                     uuid not null references public.tenants(id) on delete cascade,
  customer_id                  uuid not null references public.customers(id) on delete cascade,
  sales_account_code            text not null default '4010',
  commission_fee_account_code   text not null default '5344',
  payment_fee_account_code      text not null default '5355',
  shipping_fee_account_code     text not null default '5341',
  ads_fee_account_code          text not null default '5315',
  penalty_account_code          text not null default '5365',
  refund_account_code           text not null default '4010',
  other_account_code            text not null default '5365',
  clearing_account_code         text not null default '1020',
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create unique index if not exists uq_platform_report_settings_tenant_customer
  on public.platform_report_settings (tenant_id, customer_id);

drop trigger if exists trg_platform_report_settings_updated on public.platform_report_settings;
create trigger trg_platform_report_settings_updated before update on public.platform_report_settings
  for each row execute function public.set_updated_at();

alter table public.platform_report_settings enable row level security;
drop policy if exists tenant_read on public.platform_report_settings;
create policy tenant_read on public.platform_report_settings for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.platform_report_settings from anon;
grant select on public.platform_report_settings to authenticated;
grant all    on public.platform_report_settings to service_role;

notify pgrst, 'reload schema';
