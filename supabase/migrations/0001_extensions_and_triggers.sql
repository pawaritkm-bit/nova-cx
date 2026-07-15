-- =====================================================================
-- 0001 — Extensions + generic trigger functions
-- NOVA-CX (M1) — รันเป็นลำดับที่ 1
-- =====================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "citext";         -- email/ code case-insensitive

-- ---------------------------------------------------------------------
-- อัปเดต updated_at อัตโนมัติทุกครั้งที่ UPDATE
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- ห้ามแก้ไข/ลบ (append-only) — ใช้กับ audit_logs, case_activity_logs, survey_answers
-- ให้ผลแม้กับ service_role (bypass RLS) จึงเป็น immutability จริง
-- ---------------------------------------------------------------------
create or replace function public.prevent_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ตาราง % เป็น append-only: แก้ไข/ลบไม่ได้', tg_table_name;
end;
$$;
