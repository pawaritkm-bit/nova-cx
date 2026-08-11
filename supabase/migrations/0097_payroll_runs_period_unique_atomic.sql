-- =====================================================================
-- 0097 — เฟส 9b กลุ่ม BC (แก้บั๊ก QC: race condition จริง หลัง 0096 ถอด unique constraint เดิมออกจาก DB)
--
--   ปัญหา: 0096 เอา partial unique index เดิมออกจาก payroll_runs แล้วย้าย guard ไปที่ชั้นแอปพลิเคชันล้วน ๆ
--   (createDraftRun::check-then-insert แบบธรรมดา ไม่ atomic) — พิสูจน์แล้วด้วยเทสต์ concurrent
--   (Promise.all 2 ครั้งพร้อมกัน) ว่าลูกค้า pay_frequency='monthly' (ค่า default ของทุกลูกค้าเดิม) สร้างรอบ
--   เงินเดือนซ้ำเดือน/ปีเดียวกันได้จริงถ้ามี 2 request มาชนกันพร้อมกัน (สำเร็จทั้ง 2 ครั้ง)
--
--   วิธีแก้: เก็บ atomicity ไว้ที่ DB เหมือนเดิม (ไม่ใช่ย้ายไปชั้นแอปทั้งหมด) — เพิ่มคอลัมน์ snapshot
--   `pay_frequency_snapshot` (copy ค่า payroll_settings.pay_frequency มาตอน insert แต่ละรอบ) แล้วสร้าง
--   partial unique index ใหม่เฉพาะแถวที่ snapshot เป็น 'monthly' เท่านั้น — insert ตรง ๆ ได้เหมือนเดิม
--   (ไม่ต้อง lock พิเศษ) แต่ได้ atomicity กลับมา 100% สำหรับลูกค้า monthly โดยไม่กระทบ non_monthly เลย
--   (unique index ไม่ครอบคลุมแถวที่ snapshot='non_monthly' จึงยังสร้างหลายรอบ/เดือนได้ตามเดิม)
--
--   ★ backfill แถวเดิม (สร้างก่อน migration นี้ apply) — ใช้ค่า payroll_settings.pay_frequency ปัจจุบันของ
--   ลูกค้านั้น ๆ เป็นตัวตั้งค่า snapshot ย้อนหลัง (ไม่มีข้อมูลว่าตอนสร้างรอบ ณ ขณะนั้น pay_frequency เป็นอะไร
--   แต่ในทางปฏิบัติทุกลูกค้าที่มีอยู่ก่อนเฟส 9b ยังเป็น 'monthly' เสมอ เพราะ non_monthly เพิ่งเปิดให้ตั้งค่าได้
--   ในเฟสนี้) — ลูกค้าที่ไม่มีแถว payroll_settings เลยได้ค่า default 'monthly' (ตรงกับ getSettings() ที่ชั้น
--   แอปพลิเคชันที่คืนค่า default เดียวกันเมื่อไม่มีแถว settings)
--   ★★★ พิสูจน์ก่อนสร้าง unique index จริง — ถ้ามีแถวซ้ำเดือน/ปีเดียวกันของลูกค้า monthly ค้างอยู่แล้ว (เผื่อเคย
--   เกิด race จริงในช่วงที่ 0096 apply ไปแล้วแต่ 0097 ยังไม่ apply) ต้อง raise exception ทันทีให้คนแก้ข้อมูลก่อน
--   ดีกว่าให้ create index ล้มเหลวแบบงง ๆ
-- =====================================================================

alter table public.payroll_runs
  add column if not exists pay_frequency_snapshot text not null default 'monthly'
    check (pay_frequency_snapshot in ('monthly', 'non_monthly'));

update public.payroll_runs pr
set pay_frequency_snapshot = coalesce(ps.pay_frequency, 'monthly')
from public.payroll_settings ps
where ps.tenant_id = pr.tenant_id and ps.customer_id = pr.customer_id
  and pr.pay_frequency_snapshot is distinct from coalesce(ps.pay_frequency, 'monthly');

do $$
declare
  dup_count int;
begin
  select count(*) into dup_count
  from (
    select tenant_id, customer_id, pay_period_year, pay_period_month
    from public.payroll_runs
    where deleted_at is null and pay_frequency_snapshot = 'monthly'
    group by tenant_id, customer_id, pay_period_year, pay_period_month
    having count(*) > 1
  ) d;

  if dup_count > 0 then
    raise exception
      'migration 0097: พบ % กลุ่มของ payroll_runs (monthly) ที่มีมากกว่า 1 รอบในเดือน/ปีเดียวกันอยู่แล้ว — ต้องแก้ข้อมูลซ้ำนี้ก่อน apply migration นี้ (ลบ/ย้ายรอบซ้ำก่อน)',
      dup_count;
  end if;
end $$;

drop index if exists public.idx_payroll_runs_period;

create unique index if not exists uq_payroll_runs_period_monthly
  on public.payroll_runs (tenant_id, customer_id, pay_period_year, pay_period_month)
  where deleted_at is null and pay_frequency_snapshot = 'monthly';

-- ★ index ธรรมดา (ไม่ unique) สำหรับ query listRuns/หา period ของลูกค้า non_monthly ให้เร็วเหมือนก่อน (0096
--   สร้าง idx_payroll_runs_period ไว้แล้วครอบคลุมทุก pay_frequency แต่ถูก drop ไปข้างบนเพราะ unique index
--   ใหม่ครอบคลุมกรณี monthly ได้อยู่แล้ว — เหลือสร้าง index แยกให้ non_monthly ใช้เช่นกัน กัน full scan)
create index if not exists idx_payroll_runs_period_non_monthly
  on public.payroll_runs (tenant_id, customer_id, pay_period_year, pay_period_month)
  where deleted_at is null and pay_frequency_snapshot = 'non_monthly';

notify pgrst, 'reload schema';
