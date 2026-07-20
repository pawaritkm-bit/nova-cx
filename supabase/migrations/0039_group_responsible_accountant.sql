-- =====================================================================
-- 0039 — นักบัญชีผู้ดูแลกลุ่ม (responsible accountant ต่อกลุ่ม LINE)
-- =====================================================================
-- บริบท: หน้า chat-audit/admin จับคู่ "กลุ่ม LINE → ลูกค้า" ได้แล้ว
--   ตอนนี้เพิ่ม "นักบัญชีผู้ดูแลกลุ่ม" = พนักงานที่รับผิดชอบดูแลกลุ่มนี้
--
-- ★ ต่างจาก chat_members (สมาชิกจริงในกลุ่ม LINE ที่ผูก employee_id):
--     - chat_members = ใครอยู่ในกลุ่มจริง (มาจากข้อความ/LINE)
--     - responsible_employee_id = "ผู้ดูแล" ที่แอดมินกำหนด (อาจไม่ได้อยู่ในกลุ่มก็ได้)
--   ใช้สำหรับสรุป workload/รายงานว่าใครดูแลกลุ่มไหน
--
-- ON DELETE SET NULL: ลบพนักงาน → กลุ่มยังอยู่ แค่ไม่มีผู้ดูแล (ไม่ลบกลุ่มตาม)
alter table public.chat_groups
  add column if not exists responsible_employee_id uuid
    references public.employees(id) on delete set null;

-- index เฉพาะกลุ่มที่มีผู้ดูแล (partial) — ช่วย query "กลุ่มของนักบัญชีคนนี้"
create index if not exists idx_chat_groups_responsible
  on public.chat_groups(responsible_employee_id)
  where responsible_employee_id is not null;

comment on column public.chat_groups.responsible_employee_id is
  'นักบัญชีผู้ดูแลกลุ่ม (พนักงานที่รับผิดชอบ) — คนละเรื่องกับ chat_members ที่เป็นสมาชิกจริงในกลุ่ม';
