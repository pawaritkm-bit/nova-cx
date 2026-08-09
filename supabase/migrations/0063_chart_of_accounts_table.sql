-- =====================================================================
-- 0063 — ผังบัญชี (chart_of_accounts) : ย้ายจาก hardcode (lib/accounting/chart-of-accounts.ts) → DB table
-- =====================================================================
-- บริบท: เฟส 1 ส่วน A (docs/06-accounting-features-roadmap.md) — ผังบัญชีเดิมเป็น module constant
--   คงที่กลางระบบ (75 รายการ) แก้ไม่ได้เลยนอกจากแก้โค้ด. ย้ายเป็นตาราง tenant-scoped ให้ admin/executive
--   จัดการได้จริงผ่านหน้า UI (เพิ่ม/แก้ชื่อ/สลับหมวดเงินฝาก/soft-delete — ยกเว้นรหัส "โครงสร้าง" ที่ engine
--   บัญชีอื่นผูก hardcode ไว้ตรง ๆ เช่น VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้ — guard ที่ชั้น data layer
--   lib/accounting/chart-accounts-data.ts ไม่ใช่ DB constraint)
--
--   ★ tenant-scoped (1 tenant = 1 สำนักงานบัญชี ดูแลลูกค้าหลายบริษัท) — ผังบัญชี "ใช้ร่วมทุกลูกค้า"
--     หมายถึงร่วมกันทุกลูกค้าภายใน tenant เดียวเท่านั้น (ไม่มี concept ผังข้าม tenant)
--   ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
--   ★ seed ให้ทุก tenant ที่มีอยู่แล้วได้ผังเริ่มต้นครบ 75 รายการทันทีที่ apply (ไม่ต้องรันสคริปต์แยก)
--     — ค่าที่ seed แปลงตรงจาก CHART_OF_ACCOUNTS เดิมใน lib/accounting/chart-of-accounts.ts (generate
--     ด้วยสคริปต์ชั่วคราว ไม่ commit กันพิมพ์มือพลาด/ตกหล่นแถว)
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.chart_of_accounts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null,
  name        text not null,
  category    text not null,           -- ป้ายหมวดไทย (สินทรัพย์/หนี้สิน/ส่วนของผู้ถือหุ้น/รายได้/ค่าใช้จ่าย/อื่น ๆ)
  is_bank     boolean not null default false,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create unique index if not exists uq_chart_of_accounts_tenant_code
  on public.chart_of_accounts (tenant_id, code) where deleted_at is null;
create index if not exists idx_chart_of_accounts_tenant_sort
  on public.chart_of_accounts (tenant_id, sort_order) where deleted_at is null;

drop trigger if exists trg_chart_of_accounts_updated on public.chart_of_accounts;
create trigger trg_chart_of_accounts_updated before update on public.chart_of_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- seed 75 รายการเดิมให้ทุก tenant ที่มีอยู่แล้ว (แปลงตรงจาก lib/accounting/chart-of-accounts.ts)
--   on conflict ทำงานร่วมกับ unique index ข้างบน (tenant_id, code) where deleted_at is null
-- ---------------------------------------------------------------------
insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select t.id, v.code, v.name, v.category, v.is_bank, v.sort_order
from public.tenants t
cross join (values
  ('1010','เงินสด','สินทรัพย์',false,1),
  ('1015','เงินสดย่อย','สินทรัพย์',false,2),
  ('1020','เงินฝากธนาคาร #1','สินทรัพย์',true,3),
  ('1025','เงินฝากธนาคาร #2','สินทรัพย์',true,4),
  ('1030','เงินฝากธนาคาร #3','สินทรัพย์',true,5),
  ('1140','ลูกหนี้การค้า','สินทรัพย์',false,6),
  ('1145','สำรองหนี้สูญ','สินทรัพย์',false,7),
  ('1150','ลูกหนี้อื่น ๆ','สินทรัพย์',false,8),
  ('1151','ภาษีหัก ณ ที่จ่าย','สินทรัพย์',false,9),
  ('1154','ภาษีซื้อ','สินทรัพย์',false,10),
  ('1155','เช็ครับล่วงหน้า','สินทรัพย์',false,11),
  ('1156','ลูกหนี้กรมสรรพากร','สินทรัพย์',false,12),
  ('1160','บัตรเครดิต','สินทรัพย์',false,13),
  ('1210','ค่าใช้จ่ายจ่ายล่วงหน้า','สินทรัพย์',false,14),
  ('1215','รายได้ค้างรับ','สินทรัพย์',false,15),
  ('1216','ภาษีถูกหัก ณ ที่จ่าย','สินทรัพย์',false,16),
  ('1220','ภาษีซื้อที่ยังไม่ถึงกำหนด','สินทรัพย์',false,17),
  ('1510','สินค้าสำเร็จรูป','สินทรัพย์',false,18),
  ('1610','ที่ดิน','สินทรัพย์',false,19),
  ('1615','อาคาร','สินทรัพย์',false,20),
  ('1615.1','ค่าเสื่อมสะสม-อาคาร','สินทรัพย์',false,21),
  ('1640','อุปกรณ์สำนักงาน','สินทรัพย์',false,22),
  ('1640.1','ค่าเสื่อมสะสม-อุปกรณ์สำนักงาน','สินทรัพย์',false,23),
  ('1645','รถยนต์','สินทรัพย์',false,24),
  ('1645.1','ค่าเสื่อมสะสม-รถยนต์','สินทรัพย์',false,25),
  ('2010','เจ้าหนี้การค้า','หนี้สิน',false,26),
  ('2015','เจ้าหนี้อื่น ๆ','หนี้สิน',false,27),
  ('2035','เงินปันผลค้างจ่าย','หนี้สิน',false,28),
  ('2040','ค่าใช้จ่ายค้างจ่าย','หนี้สิน',false,29),
  ('2045','ภาษีเงินได้ค้างจ่าย','หนี้สิน',false,30),
  ('2110','หุ้นกู้','หนี้สิน',false,31),
  ('2210','รายได้รับล่วงหน้า','หนี้สิน',false,32),
  ('2220','เช็คสั่งจ่ายล่วงหน้า','หนี้สิน',false,33),
  ('2900','ภาษีขาย','หนี้สิน',false,34),
  ('2910','ภาษีหัก ณ ที่จ่าย','หนี้สิน',false,35),
  ('2920','เจ้าหนี้สรรพากร','หนี้สิน',false,36),
  ('3010','ทุนเรือนหุ้น','ส่วนของผู้ถือหุ้น',false,37),
  ('3020','กำไรสะสม','ส่วนของผู้ถือหุ้น',false,38),
  ('4010','ขายสินค้า','รายได้',false,39),
  ('4010.1','รับคืนและส่วนลด','รายได้',false,40),
  ('4010.2','ส่วนลดจ่าย','รายได้',false,41),
  ('4020','รายได้อื่น ๆ','รายได้',false,42),
  ('4210','ดอกเบี้ยเงินฝากธนาคาร','รายได้',false,43),
  ('5010','ซื้อสินค้า','ค่าใช้จ่าย',false,44),
  ('5010.1','ส่งคืนและส่วนลด','ค่าใช้จ่าย',false,45),
  ('5010.2','ส่วนลดรับ','ค่าใช้จ่าย',false,46),
  ('5010.3','ค่าขนส่งเมื่อซื้อ','ค่าใช้จ่าย',false,47),
  ('5310','เงินเดือนพนักงาน','ค่าใช้จ่าย',false,48),
  ('5315','ค่าโฆษณา','ค่าใช้จ่าย',false,49),
  ('5320','ค่าไฟฟ้า','ค่าใช้จ่าย',false,50),
  ('5325','ค่าน้ำประปา','ค่าใช้จ่าย',false,51),
  ('5330','ค่าโทรศัพท์','ค่าใช้จ่าย',false,52),
  ('5335','ค่าไปรษณีย์','ค่าใช้จ่าย',false,53),
  ('5336','ค่าใช้จ่ายสำนักงาน','ค่าใช้จ่าย',false,54),
  ('5337','ค่าบริการค่าขนส่ง','ค่าใช้จ่าย',false,55),
  ('5338','ค่าอบรมหลักสูตรต่างๆ','ค่าใช้จ่าย',false,56),
  ('5340','ค่าน้ำมัน','ค่าใช้จ่าย',false,57),
  ('5341','ค่าขนส่ง','ค่าใช้จ่าย',false,58),
  ('5342','ค่าบริการ','ค่าใช้จ่าย',false,59),
  ('5343','ค่าบริการเครื่องถ่ายเอกสาร','ค่าใช้จ่าย',false,60),
  ('5344','ค่าบริการแพลตฟอร์ม','ค่าใช้จ่าย',false,61),
  ('5345','ค่าบำรุงรักษายานพาหนะ','ค่าใช้จ่าย',false,62),
  ('5350','วัสดุอุปกรณ์สำนักงานสิ้นเปลือง','ค่าใช้จ่าย',false,63),
  ('5351','ค่าปรับปรุงต่อเติมสำนักงาน','ค่าใช้จ่าย',false,64),
  ('5352','ค่าซ่อมแซม','ค่าใช้จ่าย',false,65),
  ('5355','ค่าธรรมเนียมอื่น ๆ','ค่าใช้จ่าย',false,66),
  ('5360','ดอกเบี้ยจ่าย','ค่าใช้จ่าย',false,67),
  ('5365','ค่าใช้จ่ายเบ็ดเตล็ด','ค่าใช้จ่าย',false,68),
  ('5366','ค่าใช้จ่ายในการขาย','ค่าใช้จ่าย',false,69),
  ('5370','ค่าเสื่อมราคา-อาคาร','ค่าใช้จ่าย',false,70),
  ('5375','ค่าเสื่อมราคา-อุปกรณ์สำนักงาน','ค่าใช้จ่าย',false,71),
  ('5380','ค่าเสื่อมราคา-รถยนต์','ค่าใช้จ่าย',false,72),
  ('5385','ค่าเผื่อหนี้สูญ','ค่าใช้จ่าย',false,73),
  ('5910','ภาษีเงินได้','ค่าใช้จ่าย',false,74),
  ('6000','ค่าใช้จ่ายต้องห้าม','อื่น ๆ',false,75)
) as v(code, name, category, is_bank, sort_order)
on conflict (tenant_id, code) where deleted_at is null do nothing;

-- =====================================================================
-- RLS: tenant isolation (pattern 0057/0054)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin/executive)
--   service_role  : all
-- =====================================================================
alter table public.chart_of_accounts enable row level security;

drop policy if exists tenant_read on public.chart_of_accounts;
create policy tenant_read on public.chart_of_accounts for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all    on public.chart_of_accounts from anon;
grant  select on public.chart_of_accounts to authenticated;
grant  all    on public.chart_of_accounts to service_role;

-- reload PostgREST schema cache (ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
