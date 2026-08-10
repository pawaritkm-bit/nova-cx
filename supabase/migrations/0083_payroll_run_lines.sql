-- =====================================================================
-- 0083 — เฟส 9 ส่วน AD (docs/06-accounting-features-roadmap.md, หมวด 0.8/0.13)
--   บรรทัดต่อพนักงานของรอบเงินเดือน 1 รอบ — รายละเอียดต่อคน (ต่างจาก JE ที่รวมยอดทั้งรอบเป็นก้อนเดียว, 0.8)
--
--   ★ 0.13 gross_salary prefill จาก payroll_employees.base_salary ตอนสร้างรอบ แต่แก้ไขได้เสมอต่อบรรทัด
--     ก่อนกด "คำนวณ" (ไม่มีสูตร prorate อัตโนมัติในรอบแรก — นักบัญชีกรอกยอดที่ถูกต้องเอง)
--   ★ bonus_amount: รับค่าได้ตาม schema (nullable ทางเทคนิค แต่ default 0) — ★★ [ปิดสวิตช์ชั่วคราว 0.5]
--     ชั้นแอปพลิเคชัน (lib/accounting/payroll.ts) ปฏิเสธค่า > 0 จนกว่าจะ verify สูตรภาษีโบนัส (ทป.4/2528)
--     กับตัวอย่างอ้างอิงที่เชื่อถือได้จริง (T112) — ไม่ใช่ DB constraint (เผื่ออนาคตเปิดใช้งานไม่ต้อง migrate)
--   ★ ไม่ soft-delete แยก — ลบทั้งบรรทัดตรง ๆ ได้ตอนรอบยัง draft (ล็อกที่ชั้นแอปพลิเคชัน), ลบไม่ได้หลัง
--     finalized (JE สร้างไปแล้ว)
-- =====================================================================

create table if not exists public.payroll_run_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  run_id               uuid not null references public.payroll_runs(id) on delete cascade,
  payroll_employee_id  uuid not null references public.payroll_employees(id) on delete cascade,
  gross_salary         numeric(14,2) not null default 0 check (gross_salary >= 0),
  other_additions      numeric(14,2) not null default 0 check (other_additions >= 0),
  bonus_amount         numeric(14,2) not null default 0 check (bonus_amount >= 0),
  other_deductions     numeric(14,2) not null default 0 check (other_deductions >= 0),
  pit_withheld         numeric(14,2) not null default 0 check (pit_withheld >= 0),
  sso_employee         numeric(14,2) not null default 0 check (sso_employee >= 0),
  sso_employer         numeric(14,2) not null default 0 check (sso_employer >= 0),
  net_pay              numeric(14,2) not null default 0,
  created_at           timestamptz not null default now()
);
create unique index if not exists uq_payroll_run_lines_run_employee
  on public.payroll_run_lines (run_id, payroll_employee_id);
create index if not exists idx_payroll_run_lines_run
  on public.payroll_run_lines (tenant_id, run_id);

alter table public.payroll_run_lines enable row level security;
drop policy if exists tenant_read on public.payroll_run_lines;
create policy tenant_read on public.payroll_run_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_run_lines from anon;
grant select on public.payroll_run_lines to authenticated;
grant all    on public.payroll_run_lines to service_role;

notify pgrst, 'reload schema';
