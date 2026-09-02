-- 0129 — สมองจำผังบัญชี "แยกตามลูกค้า" (★ 2026-09-02 ผู้ใช้: ทุกบริษัทลงบัญชีไม่เหมือนกัน
--   ให้จับจากพฤติกรรมการคีย์ของลูกค้า/นักบัญชีแต่ละราย — ไม่เอากฎของพี่สวยไปทับบริษัทอื่น)
--
-- customer_id null = กฎเก่าระดับสำนักงาน (legacy): ใช้ fallback เฉพาะ match_type='tax'
--   (เลขภาษีคู่ค้าเป็นข้อเท็จจริง ไม่ขึ้นกับลูกค้า) · name/amount ต้องเป็นกฎของลูกค้ารายนั้นเท่านั้น

alter table line_account_rules
  add column if not exists customer_id uuid references customers(id) on delete cascade;

-- แทน unique เดิม (tenant, entry_type, match_type, match_key, account_code)
-- ด้วยชุดที่รวม customer_id (NULLS NOT DISTINCT — กันแถว legacy ซ้ำกันเอง)
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'line_account_rules'::regclass and contype = 'u'
  loop
    execute format('alter table line_account_rules drop constraint %I', c.conname);
  end loop;
end $$;

create unique index if not exists uq_line_account_rules_scoped
  on line_account_rules (tenant_id, customer_id, entry_type, match_type, match_key, account_code)
  nulls not distinct;

create index if not exists idx_line_account_rules_lookup
  on line_account_rules (tenant_id, customer_id, entry_type, match_type, match_key);

comment on column line_account_rules.customer_id is
  'ลูกค้าเจ้าของกฎ (0129) — null = กฎ legacy ระดับสำนักงาน ใช้ fallback เฉพาะ match_type=tax';
