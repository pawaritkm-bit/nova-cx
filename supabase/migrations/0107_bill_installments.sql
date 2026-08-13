-- =====================================================================
-- 0107 — แผนงวดผ่อนชำระบนบิลเชื่อ AR/AP (wishlist ข้อ 7)
--   ★★★ เป็นแค่ "แผนอ้างอิง" (schedule) ต่อทับบิลเชื่อที่มีอยู่แล้ว — ไม่ใช่รายการทางบัญชี ไม่กระทบ
--   bill_payments/AR/AP/ledger เลยแม้แต่บรรทัดเดียว (การรับ/จ่ายเงินจริงยังผ่าน bill_payments เดิม
--   ทุกประการ) — สถานะ "ชำระแล้ว/เกินกำหนด/ยังไม่ครบกำหนด" ต่อ 1 งวดคำนวณสด ๆ เทียบยอดที่ชำระจริงสะสม
--   กับยอดตามแผนสะสม ณ งวดนั้น ไม่ persist ลง DB (ดู lib/accounting/bill-installments.ts)
--
-- ★ ตั้งใจไม่ทำ soft-delete (deleted_at) — แผนงวดชำระไม่ใช่ transaction ทางการเงิน (ต่างจาก bill_payments
--   ที่ต้อง void เก็บ audit trail) แก้แผนใหม่ = ลบแถวเดิมของบิลนั้นทั้งหมดแล้ว insert ชุดใหม่ (setInstallmentPlan)
-- =====================================================================

create table if not exists public.bill_installments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  entry_id        uuid not null references public.bill_entries(id) on delete cascade,
  installment_no  integer not null check (installment_no >= 1),
  due_date        date not null,
  planned_amount  numeric(14,2) not null check (planned_amount > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, entry_id, installment_no)
);
create index if not exists idx_bill_installments_entry on public.bill_installments(entry_id);
create index if not exists idx_bill_installments_tenant on public.bill_installments(tenant_id);

create trigger trg_bill_installments_updated before update on public.bill_installments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- set_bill_installment_plan — แทนที่แผนทั้งชุดของบิล 1 ใบแบบ atomic (ลบของเดิม + insert ชุดใหม่ในทรานแซกชัน
--   เดียวของ Postgres) — กัน 2 ความเสี่ยงที่พบตอน review: (1) insert ล้มเหลวหลัง delete สำเร็จ (JS สอง
--   คำสั่งแยกกัน ไม่มี transaction ครอบ → บิลเหลือไม่มีแผนเลย) (2) 2 คำขอพร้อมกันแก้แผนบิลเดียวกัน
--   ตัดสถานะกลางที่ผิดพลาดออกไปโดยธรรมชาติ (ฝั่งแรกที่ commit ก่อนเห็นผลถูกต้องเสมอ ไม่มีทาง "ครึ่ง ๆ กลาง ๆ")
-- ---------------------------------------------------------------------
create or replace function public.set_bill_installment_plan(
  p_tenant_id     uuid,
  p_entry_id      uuid,
  p_installments  jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.bill_installments
    where tenant_id = p_tenant_id and entry_id = p_entry_id;

  insert into public.bill_installments (tenant_id, entry_id, installment_no, due_date, planned_amount)
  select
    p_tenant_id,
    p_entry_id,
    (elem->>'installment_no')::int,
    (elem->>'due_date')::date,
    (elem->>'planned_amount')::numeric(14,2)
  from jsonb_array_elements(p_installments) as elem;
end;
$$;

notify pgrst, 'reload schema';
