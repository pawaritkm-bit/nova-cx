-- =====================================================================
-- 0095 — เฟส 9b กลุ่ม BC/ข้อ3 (docs/06-accounting-features-roadmap.md, หมวด 0.5)
--   `payroll_runs.filing_period_id` — ผูกรอบจ่ายเข้ากับหน่วยยื่นรายเดือน (payroll_monthly_filings, 0094)
--   + backfill non-destructive: สร้าง 1 แถว payroll_monthly_filings ต่อ payroll_runs ที่มีอยู่แล้วทุกแถว
--   (วันนี้เป็น 1:1 เป๊ะ เพราะยังไม่มีลูกค้า non_monthly) คัดลอกค่า pit_filing_status/pit_filed_at/
--   pit_filed_by/sso_* เดิมมาโดยไม่มีการสูญหายข้อมูล แล้วผูก filing_period_id กลับเข้า payroll_runs
--
--   ★★★ T135 บังคับ: ต้องพิสูจน์ด้วย query จริงว่าค่า backfill ตรงกับต้นฉบับเป๊ะทุกแถวก่อนถือว่า migration
--     นี้เสร็จ — ทำเป็น DO block ที่รันจริงทุกครั้งที่ apply migration นี้ (ไม่ใช่แค่คอมเมนต์ยืนยันด้วยปาก):
--     ถ้าพบ mismatch หรือแถวที่ deleted_at is null ตัวใดไม่ได้ filing_period_id เลย จะ raise exception ทันที
--     (ทั้ง migration/transaction rollback) ดีกว่าปล่อยให้ข้อมูลไม่ตรงกันเงียบ ๆ แล้วนักบัญชีเจอทีหลัง
--   ★ idempotent — insert ... on conflict do nothing (unique index period ของ 0094) + update เฉพาะแถวที่
--     filing_period_id is null เท่านั้น → รัน migration นี้ซ้ำได้โดยไม่สร้างข้อมูลซ้ำ/ไม่พังอะไรเพิ่ม
--   ★ คอลัมน์เดิม pit_filing_status/pit_filed_at/pit_filed_by/sso_* บน payroll_runs **ไม่ถูกลบ** (เก็บไว้เป็น
--     deprecated แค่หยุดเขียนต่อจากแอปพลิเคชันหลังจากนี้ — กันโค้ดเก่า/รายงานเก่าที่อาจยัง query ตรง ๆ พัง)
--   ★ filing_period_id เก็บเป็น nullable ต่อไป (ไม่บังคับ not null) — เผื่อแถว soft-deleted เก่าที่ไม่ถูก
--     backfill ครบ ไม่ให้ migration ล้มเหลวเพราะแถวที่ลบไปแล้ว — lib/accounting/payroll.ts เขียนโค้ดให้ตั้งค่านี้
--     เสมอสำหรับรอบใหม่ทุกรอบหลังจากนี้ (ทั้งลูกค้า monthly/non_monthly)
-- =====================================================================

alter table public.payroll_runs
  add column if not exists filing_period_id uuid references public.payroll_monthly_filings(id) on delete set null;

insert into public.payroll_monthly_filings
  (tenant_id, customer_id, period_year, period_month,
   pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by)
select tenant_id, customer_id, pay_period_year, pay_period_month,
       pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by
from public.payroll_runs
where deleted_at is null
on conflict (tenant_id, customer_id, period_year, period_month) do nothing;

update public.payroll_runs pr
set filing_period_id = pmf.id
from public.payroll_monthly_filings pmf
where pr.tenant_id = pmf.tenant_id and pr.customer_id = pmf.customer_id
  and pr.pay_period_year = pmf.period_year and pr.pay_period_month = pmf.period_month
  and pr.filing_period_id is null;

-- ★★★ พิสูจน์ความถูกต้องจริงตอน apply (ไม่ใช่แค่ทฤษฎี) — ล้มทั้ง migration ถ้าไม่ตรง/ไม่ครบ
do $$
declare
  mismatch_count int;
  missing_count  int;
begin
  select count(*) into mismatch_count
  from public.payroll_runs pr
  join public.payroll_monthly_filings pmf on pmf.id = pr.filing_period_id
  where pr.deleted_at is null
    and (
      pr.pit_filing_status is distinct from pmf.pit_filing_status or
      pr.pit_filed_at      is distinct from pmf.pit_filed_at or
      pr.pit_filed_by      is distinct from pmf.pit_filed_by or
      pr.sso_filing_status is distinct from pmf.sso_filing_status or
      pr.sso_filed_at      is distinct from pmf.sso_filed_at or
      pr.sso_filed_by      is distinct from pmf.sso_filed_by
    );

  select count(*) into missing_count
  from public.payroll_runs
  where deleted_at is null and filing_period_id is null;

  if mismatch_count > 0 then
    raise exception
      'migration 0095: พบ % แถวของ payroll_runs ที่ pit/sso filing status ไม่ตรงกับ payroll_monthly_filings ที่ backfill มา',
      mismatch_count;
  end if;

  if missing_count > 0 then
    raise exception
      'migration 0095: พบ % แถวของ payroll_runs (deleted_at is null) ที่ยังไม่ได้ filing_period_id หลัง backfill',
      missing_count;
  end if;
end $$;

notify pgrst, 'reload schema';
