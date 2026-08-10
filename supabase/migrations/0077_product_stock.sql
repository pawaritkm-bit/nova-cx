-- =====================================================================
-- 0077 — เฟส 8 ส่วน X (docs/06-accounting-features-roadmap.md, หมวด 0.1–0.14)
--   สต็อกสินค้าคงเหลือ + ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ (Inventory / Stock) — โครงข้อมูล
--
--   ★ 0.6 ที่สำคัญที่สุด: ตารางในไฟล์นี้เป็น "ชั้นติดตามจำนวน+มูลค่าคงเหลือ" คู่ขนานเท่านั้น — ไม่มี
--     write path ใดกระทบบัญชีแยกประเภท/งบการเงินเลย (ผังบัญชีเดิมยังเป็นระบบสต็อกสิ้นงวด/Periodic)
--   ★ 0.4 bill_entry_lines.quantity (nullable) — บิลเดิม/บรรทัดเดิมที่ไม่มี quantity ยังทำงานปกติทุกอย่าง
--   ★ 0.10 products.category (nullable text อิสระ) — ไม่มี category เดิม → รายงานเข้ากลุ่ม default "สินค้า"
--   ★ 0.11 product_opening_balances mirror account_opening_balances (migration 0054) เป๊ะ — ไม่มีคอลัมน์
--     วันที่ (ถือเป็น "ก่อนรายการเคลื่อนไหวทั้งหมดเสมอ") unique ต่อ (customer_id, product_id)
--   ★ 0.5/0.12 product_stock_movements — ไม่เก็บยอดสะสม/cache ใด ๆ (replay ล้วนที่ชั้น pure function
--     lib/accounting/product-stock.ts::computeStockLedger) · สต็อกติดลบไม่ block (ไม่มี constraint กัน
--     ยอดคงเหลือติดลบใน DB — ตรวจ/เตือนที่ชั้น application เท่านั้น)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable 2 จุด + สร้างตารางใหม่ 2 ตัว ไม่แตะตาราง/flow เดิมเลย
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0.4: bill_entry_lines.quantity (nullable) — นักบัญชีกรอกเพิ่มเฉพาะบรรทัดที่ผูก product_id และต้องการ
--   ให้กระทบสต็อก (ไม่บังคับกรอกทุกบรรทัด — บรรทัดเดิม/บรรทัดที่ไม่สนใจสต็อกยังว่างได้ตามปกติ)
-- ---------------------------------------------------------------------
alter table public.bill_entry_lines
  add column if not exists quantity numeric;

-- ---------------------------------------------------------------------
-- 0.10: products.category (nullable text อิสระ) — ค่า default ตอนแสดงรายงาน = "สินค้า" (ที่ชั้น application)
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists category text;

-- ---------------------------------------------------------------------
-- 0.11: product_opening_balances — ยอดยกมาสต็อกต่อสินค้า ต่อลูกค้า (mirror 0054 เป๊ะ ไม่มีคอลัมน์วันที่)
-- ---------------------------------------------------------------------
create table if not exists public.product_opening_balances (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)   on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id  uuid not null references public.products(id)  on delete cascade,
  quantity    numeric not null default 0,
  unit_cost   numeric not null default 0 check (unit_cost >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_product_opening_balances_tenant_customer
  on public.product_opening_balances (tenant_id, customer_id)
  where deleted_at is null;

-- ★ กันยอดยกมาซ้ำ: 1 ลูกค้า ผูก 1 สินค้าได้ครั้งเดียว (ที่ยังไม่ลบ) — รองรับ select-then-upsert
create unique index if not exists uq_product_opening_balances_active
  on public.product_opening_balances (customer_id, product_id)
  where deleted_at is null;

create trigger trg_product_opening_balances_updated before update on public.product_opening_balances
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 0.5/0.12: product_stock_movements — รายการเคลื่อนไหวสต็อก (replay ล้วน ไม่เก็บยอดสะสม)
--   movement_type: purchase (รับจากบิลซื้อ) | sale (จ่ายจากบิลขาย) | adjustment_in/adjustment_out (ปรับปรุงมือ)
--   quantity      : บวกเสมอ (ทิศทางกำหนดจาก movement_type ไม่ใช่เครื่องหมาย)
--   unit_cost     : ราคาต่อหน่วยตอนรับเข้า (purchase/adjustment_in) · null สำหรับรายการจ่ายออก (ใช้ต้นทุน
--                   ถ่วงเฉลี่ยเคลื่อนที่ ณ ขณะนั้นตอน replay แทน)
--   source_bill_entry_line_id : อ้างอิงบรรทัดบิลต้นทาง (0.7/0.8 — เฉพาะ purchase/sale จากปุ่ม manual-trigger
--                   ที่หน้ารายการบิล) · null = ปรับปรุงมือ (ไม่มีต้นทาง)
-- ---------------------------------------------------------------------
create table if not exists public.product_stock_movements (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id)   on delete cascade,
  customer_id                 uuid not null references public.customers(id) on delete cascade,
  product_id                  uuid not null references public.products(id)  on delete cascade,
  movement_type               text not null
                                check (movement_type in ('purchase','sale','adjustment_in','adjustment_out')),
  quantity                    numeric not null check (quantity > 0),
  unit_cost                   numeric check (unit_cost is null or unit_cost >= 0),
  source_bill_entry_line_id   uuid references public.bill_entry_lines(id) on delete set null,
  memo                        text,
  movement_date               date not null,
  created_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);

create index if not exists idx_product_stock_movements_product
  on public.product_stock_movements (tenant_id, customer_id, product_id, movement_date)
  where deleted_at is null;
create index if not exists idx_product_stock_movements_source_line
  on public.product_stock_movements (source_bill_entry_line_id)
  where source_bill_entry_line_id is not null and deleted_at is null;

-- =====================================================================
-- RLS: tenant isolation (pattern 0046/0051/0054)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard accounting access)
--   service_role  : all
-- =====================================================================
alter table public.product_opening_balances enable row level security;
alter table public.product_stock_movements  enable row level security;

create policy tenant_read on public.product_opening_balances for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.product_stock_movements for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.product_opening_balances from anon;
revoke all on public.product_stock_movements  from anon;

grant select on public.product_opening_balances to authenticated;
grant select on public.product_stock_movements  to authenticated;

grant all on public.product_opening_balances to service_role;
grant all on public.product_stock_movements  to service_role;

-- reload PostgREST schema cache (ตาราง/คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
