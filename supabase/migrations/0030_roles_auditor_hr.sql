-- =====================================================================
-- 0030 — เพิ่มบทบาท auditor_qa (ผู้ตรวจสอบ/QA) และ hr (ฝ่ายบุคคล)
--   รากฐานของโมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" (Phase 0)
--
-- non-destructive ทั้งหมด: ขยาย CHECK constraint + insert role + baseline read
--   (ไม่ drop ข้อมูล/ไม่แก้ตารางเดิมเชิงทำลาย) — apply ด้วย db push ได้
--
-- ★ ความปลอดภัย pseudonymity (survey เดิม):
--   บทบาทใหม่ 2 ตัวนี้ "ไม่ถูกใส่" ใน is_privileged() / current_role_code()
--   allow-list ใด ๆ ของ survey_responses/visibility views — จึงมองไม่เห็น
--   การโยงคะแนน↔ตัวตนลูกค้าของ survey เดิม (RLS scope เดิมจะปฏิเสธอัตโนมัติ
--   เพราะไม่ได้อยู่ใน allow-list และไม่มี customer_assignment)
--   สิทธิ์เข้าถึงแชต/คะแนนของโมดูลใหม่จะไปนิยามใน RLS ของตารางแชต (Phase ถัดไป)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) ขยาย CHECK constraint บน roles.code
--    ต้องคงค่าเดิมครบ 7 ตัว + เพิ่ม 2 ตัวใหม่ (auditor_qa, hr)
--    ชื่อ constraint เดิมของ inline check คือ roles_code_check (auto-named)
-- ---------------------------------------------------------------------
alter table public.roles drop constraint if exists roles_code_check;
alter table public.roles add constraint roles_code_check
  check (code in
    ('executive','acc_lead','accountant','sales_lead','sales','cs','admin',
     'auditor_qa','hr'));

-- ---------------------------------------------------------------------
-- 2) insert role rows 2 ตัวให้ทุก tenant ที่ยังไม่ถูกลบ (idempotent)
--    on conflict (tenant_id, code) do nothing → รันซ้ำได้ไม่ error
-- ---------------------------------------------------------------------
insert into public.roles (tenant_id, code, name)
select t.id, r.code, r.name
from public.tenants t
cross join (values
  ('auditor_qa', 'ผู้ตรวจสอบ/QA'),
  ('hr',         'ฝ่ายบุคคล')
) as r(code, name)
where t.deleted_at is null
on conflict (tenant_id, code) do nothing;

-- ---------------------------------------------------------------------
-- 3) baseline permission (read-only): ให้เห็นแค่ dashboard ก่อน
--    join permission ตาม code → insert เฉพาะ tenant ที่มี catalog permission
--    (permissions ถูก seed แยก; ถ้า tenant ยังไม่มี catalog ก็ข้ามไปเงียบ ๆ)
--    scope = 'own' (แคบสุด) — ยังไม่ให้สิทธิ์ทีม/ทั้ง tenant ในเฟสนี้
-- ---------------------------------------------------------------------
insert into public.role_permissions (tenant_id, role_id, permission_id, scope)
select ro.tenant_id, ro.id, p.id, 'own'
from public.roles ro
join public.permissions p
  on p.tenant_id = ro.tenant_id
 and p.code = 'dashboard.read'
where ro.code in ('auditor_qa', 'hr')
  and ro.deleted_at is null
on conflict (role_id, permission_id) do nothing;
