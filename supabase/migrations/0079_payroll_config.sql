-- =====================================================================
-- 0079 — เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.4/0.6/0.16)
--   ระบบเงินเดือน (Payroll) — ตารางค่าคงที่ทางกฎหมาย (global, ไม่ผูก tenant):
--     - pit_tax_brackets: อัตราภาษีเงินได้บุคคลธรรมดาก้าวหน้า (มาตรา 50) 8 ขั้น
--     - sso_contribution_config: อัตรา/ฐานเงินสมทบประกันสังคม (มาตรา 33) — effective-dated
--
--   ★ เลข migration: ยืนยันจาก `ls supabase/migrations/ | sort -V | tail -20` ณ ตอน implement จริง
--     (2026-08-10) ล่าสุดคือ 0078 — เฟส 10 (FX) ที่แผนเดิมจองเลข 0079-0084 ไว้ **ยังไม่ apply จริง**
--     บนดิสก์ (ไม่มีไฟล์ 0079-0084 อยู่จริง) → เฟสนี้ (payroll) จึงใช้เลขต่อจาก 0078 ตรง ๆ คือ
--     0079-0084 แทน (ไม่ใช่ 0085-0090 ตามที่แผนเดิมเขียนไว้ล่วงหน้า — ยึด `ls` จริงตามหลัก 0.16)
--
--   ★★ 0.6 เหตุผลที่ตาราง 2 ตัวนี้ "ไม่มี tenant_id" (ต่างจากทุกตารางอื่นในระบบทั้งหมด — ไม่ใช่ช่องโหว่ RLS):
--     อัตราภาษี/ประกันสังคมเป็นตัวเลขตามกฎหมายไทยเดียวกันทุกสำนักงานบัญชี (tenant) — ไม่มี tenant ไหน
--     ปรับแก้เอง ต่างจาก chart_of_accounts ที่ tenant ปรับแก้เองได้ (migration 0063) → เขียน/แก้ได้เฉพาะ
--     service_role เท่านั้น (ไม่มี UI ให้ tenant แก้ค่าเหล่านี้ในรอบแรก — กฎหมายเปลี่ยนค่อย migrate ใหม่)
--     RLS select เปิดให้ "authenticated ทุกคนอ่านได้" (ไม่กรอง tenant) เพราะไม่มีอะไรต้องซ่อนต่อ tenant เลย
--
--   ★ 0.4/0.5: ค่าลดหย่อนส่วนบุคคลมาตรฐาน (60,000 บาท) + ค่าใช้จ่าย (เหมา 50% ไม่เกิน 100,000 บาท) เป็นค่า
--     คงที่ hardcode ในโค้ด (lib/accounting/payroll-tax.ts) ไม่ใช่ตารางนี้ — เฉพาะ "อัตราภาษีก้าวหน้า" และ
--     "อัตรา/ฐานประกันสังคม" ที่เปลี่ยนตามเวลาได้ (เช่น เพดานประกันสังคม 15,000→17,500 ตั้งแต่ 1 ม.ค. 2569 พ.ศ.)
--     จึงต้องเป็นตาราง effective-dated แทน hardcode (มิเรอร์บทเรียนเฟส 1 ที่ chart of accounts เคย hardcode)
--
--   ★★★ แก้ไขจากร่าง SQL เดิมในเอกสารแผน (สำคัญ — พบระหว่าง implement จริง): ร่างเดิมในเอกสารเขียนวันที่
--     `effective_from` เป็นเลขปี **พ.ศ.** ตรง ๆ ในค่า literal ของคอลัมน์ SQL `date` (เช่น '2560-01-01',
--     '2569-01-01') — ผิด เพราะทุกคอลัมน์ `date`/`timestamptz` ในระบบทั้งหมด (payroll_runs.pay_date,
--     fixed_assets.acquisition_date ฯลฯ) เก็บเป็นปี **ค.ศ. (Gregorian)** จริงเสมอ (ดู
--     `lib/accounting/recurring-journal.ts::todayIsoThai` — ชื่อมี "Thai" เพราะใช้ timezone Asia/Bangkok
--     เท่านั้น ไม่ใช่ปี พ.ศ.; การแปลงเป็น พ.ศ. ทำแค่ตอน **แสดงผล** ด้วย `+543` เช่น
--     `app/chat-audit/accounting/fixed-assets/export/route.ts::formatDateThai`) — ถ้า seed ด้วยปี พ.ศ.
--     ตรง ๆ (2560/2569 เป็นเลขปีในคอลัมน์ที่ระบบตีความแบบ ค.ศ.) จะกลายเป็นปี ค.ศ. 2560/2569 (อนาคตไกลมาก)
--     ทำให้ `effective_from <= pay_date` เทียบกับวันที่จ่ายจริงในปี ค.ศ. ปกติ (เช่น 2026) ไม่เจอแถวไหนเลย —
--     พังทั้ง `getEffectivePitBrackets`/`getEffectiveSsoConfig` เงียบ ๆ (คืน null ทุกครั้ง) → แปลงเป็น ค.ศ.
--     ที่ถูกต้องแล้วก่อน seed จริงด้านล่าง: 2560 พ.ศ. = 2017 ค.ศ., 2540 พ.ศ. = 1997 ค.ศ., 2569 พ.ศ. = 2026 ค.ศ.
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะตาราง/flow เดิมเลย
-- =====================================================================

create table if not exists public.pit_tax_brackets (
  id             uuid primary key default gen_random_uuid(),
  effective_from date not null,
  bracket_order  int not null,
  income_from    numeric(14,2) not null,
  income_to      numeric(14,2),                 -- null = ไม่มีเพดาน (ขั้นสูงสุด)
  rate_percent   numeric(5,2) not null,
  created_at     timestamptz not null default now(),
  unique (effective_from, bracket_order)
);

create table if not exists public.sso_contribution_config (
  id                      uuid primary key default gen_random_uuid(),
  effective_from          date not null unique,
  employee_rate_percent   numeric(5,2) not null default 5.00,
  employer_rate_percent   numeric(5,2) not null default 5.00,
  wage_floor              numeric(14,2) not null default 1650.00,
  wage_ceiling            numeric(14,2) not null,
  created_at              timestamptz not null default now()
);

-- seed อัตราภาษีก้าวหน้าปัจจุบัน (ไม่เปลี่ยนมานาน — 8 ขั้น, มาตรา 50 ประมวลรัษฎากร)
-- ★ effective_from = 2017-01-01 ค.ศ. (= 1 ม.ค. 2560 พ.ศ. — ปีที่ตารางภาษีก้าวหน้าปัจจุบันมีผลบังคับใช้)
insert into public.pit_tax_brackets (effective_from, bracket_order, income_from, income_to, rate_percent)
values
  ('2017-01-01', 1,       0,  150000, 0),
  ('2017-01-01', 2,  150001,  300000, 5),
  ('2017-01-01', 3,  300001,  500000, 10),
  ('2017-01-01', 4,  500001,  750000, 15),
  ('2017-01-01', 5,  750001, 1000000, 20),
  ('2017-01-01', 6, 1000001, 2000000, 25),
  ('2017-01-01', 7, 2000001, 5000000, 30),
  ('2017-01-01', 8, 5000001, null,    35)
on conflict (effective_from, bracket_order) do nothing;

-- seed SSO — ceiling เดิม 15000 (ตั้งแต่ 1997-01-01 ค.ศ. = 2540 พ.ศ.) + ceiling ใหม่ 17500
-- (ตั้งแต่ 2026-01-01 ค.ศ. = 1 ม.ค. 2569 พ.ศ.)
insert into public.sso_contribution_config (effective_from, employee_rate_percent, employer_rate_percent, wage_floor, wage_ceiling)
values
  ('1997-01-01', 5.00, 5.00, 1650.00, 15000.00),
  ('2026-01-01', 5.00, 5.00, 1650.00, 17500.00)
on conflict (effective_from) do nothing;

alter table public.pit_tax_brackets       enable row level security;
alter table public.sso_contribution_config enable row level security;

-- ★ 0.6: policy "authenticated ทุกคนอ่านได้" ตั้งใจ (ไม่กรอง tenant_id เพราะตารางนี้ไม่มี tenant_id เลย —
--   ข้อมูลกฎหมายไทยเดียวกันทุกสำนักงานบัญชี ไม่ใช่ข้อมูลของลูกค้า/tenant รายใดรายหนึ่ง) — ไม่ใช่ช่องโหว่
drop policy if exists authenticated_read on public.pit_tax_brackets;
create policy authenticated_read on public.pit_tax_brackets for select to authenticated using (true);
drop policy if exists authenticated_read on public.sso_contribution_config;
create policy authenticated_read on public.sso_contribution_config for select to authenticated using (true);
revoke all on public.pit_tax_brackets       from anon;
revoke all on public.sso_contribution_config from anon;
grant select on public.pit_tax_brackets       to authenticated;
grant select on public.sso_contribution_config to authenticated;
grant all    on public.pit_tax_brackets       to service_role;
grant all    on public.sso_contribution_config to service_role;

notify pgrst, 'reload schema';
