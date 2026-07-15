# NOVA Customer Experience System (nova-cx)

ระบบประเมินความพึงพอใจและติดตามคุณภาพบริการของ Finovas Accounting ผ่าน LINE OA
พร้อม AI Assistant "น้อง NOVA" ที่ช่วยพูดคุย เก็บข้อมูล และสรุปผลให้ทีมบริการ
เพื่อยกระดับประสบการณ์ลูกค้าอย่างต่อเนื่อง

> สถานะ: **M1 — โครงหลักรันได้** (Next.js + Supabase, Auth/RBAC/RLS foundation, migration + seed, health check)
> เฟสถัดไป (M2+): Survey engine, LIFF/LINE, AI, Case, Dashboard

House Stack: Next.js (App Router) + TypeScript + Tailwind · Supabase (Postgres + Auth + RLS) · Vercel · OpenAI (ผ่าน abstraction)

---

## โครงสร้างโปรเจกต์

```
app/                 Next.js App Router (landing + /api/health)
lib/                 supabase client (server/client) + env helper
middleware.ts        refresh session พนักงาน (Supabase Auth)
supabase/
  migrations/        DDL 17 ไฟล์ (0001–0017) — 41 ตาราง + RLS/RBAC + hardening
  seed.sql           demo data (1 tenant, 7 role, แบบประเมิน A/B/C/D)
tests/               vitest: unit (env/health/zod) + RLS/permission (ต้องมี DB)
.github/workflows/   CI (typecheck + lint + test + build)
vercel.json          Vercel cron (health-ping) + function maxDuration
docs/                เอกสารออกแบบ (อย่าแก้จากโค้ด)
prototype/           ต้นแบบ HTML เดิม (อย่าแก้)
```

---

## การรัน (dev)

1. คัดลอก env:
   ```bash
   cp .env.example .env.local
   ```
   แล้วเติมค่า Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
   > ยังไม่ตั้ง env ก็รัน dev ได้ — `/api/health` จะตอบ `degraded` อย่างสุภาพ (ไม่ crash)

2. ติดตั้ง + รัน:
   ```bash
   npm install
   npm run dev          # http://localhost:3000
   ```

3. ตรวจคุณภาพก่อนส่งงาน:
   ```bash
   npm run typecheck    # tsc --noEmit
   npm run lint         # eslint (next lint)
   npm test             # vitest (unit; RLS test ข้ามถ้าไม่มี DATABASE_URL)
   npm run build        # production build
   ```

4. Health check:
   ```
   GET /api/health
   → ok        : ตั้ง env ครบ + ต่อ DB ได้
   → degraded  : ยังไม่ตั้ง env หรือ query ไม่ได้ (เช่น ยัง apply migration ไม่ครบ)
   ```

---

## การ apply migration (ต้องมี Supabase project + env)

migration/seed ต้องรันบน **Postgres ของ Supabase จริง** (เครื่อง dev นี้ยังไม่มี instance)

**ตัวเลือก A — Supabase CLI (แนะนำ):**
```bash
supabase link --project-ref <PROJECT_REF>
supabase db reset          # apply migrations 0001–0012 ตามลำดับ + รัน seed.sql
```
> `db reset` รันไฟล์ใน `supabase/migrations/` เรียงชื่อ แล้วต่อด้วย `supabase/seed.sql`

**ตัวเลือก B — รันผ่าน psql เอง:**
```bash
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f supabase/seed.sql
```

**หลัง apply ตารางใหม่ ถ้า API ขึ้น 500 "schema cache"** ให้ reload:
```sql
notify pgrst, 'reload schema';
```

### หมายเหตุสำคัญเรื่อง Auth (M1)
- `users.auth_user_id` ใน seed เป็น **UUID placeholder** — ต้องผูกกับผู้ใช้จริงใน Supabase Auth ภายหลัง
  (M1 ยังไม่มีหน้า login; RLS จะทำงานเต็มรูปเมื่อ user ล็อกอินและ `auth.uid()` ตรงกับ `users.auth_user_id`)
- RLS เปิดทุกตาราง (deny-by-default + tenant isolation) — role `anon`/ที่ยังไม่ล็อกอินจะเห็น 0 แถว

---

## การทดสอบ (test)

```bash
npm test                      # unit test (env/health/zod) — รันได้ทันที
```

**RLS / permission test (E1 DoD)** ต้องมี Postgres ของ Supabase จริง (มี `auth.uid()`):
```bash
supabase db reset                          # apply migration + base seed
DATABASE_URL="postgres://postgres:...@db.<ref>.supabase.co:5432/postgres" npm test
```
- ไฟล์ `tests/rls/rls.test.ts` จะ **ถูก skip อัตโนมัติ** ถ้าไม่มี `DATABASE_URL`
- harness impersonate แต่ละ role (ตั้ง `request.jwt.claims.sub` + `set role authenticated`) แล้ว assert:
  tenant isolation ข้ามกอง, scope นักบัญชี (C-10), deny-by-default, anon ถูกปฏิเสธ, นักบัญชีแก้ tenant ไม่ได้
- `tests/rls/fixtures.sql` เพิ่ม tenant#2 + ลูกค้าไม่มีผู้ดูแล (idempotent) ให้ test เดินได้

> ยังต้อง **verify จริงบน Supabase** (เครื่อง dev นี้ไม่มี Postgres/CLI) — CI จะรันเฉพาะ unit; RLS test รันเมื่อ set `DATABASE_URL` เป็น secret

---

## ความปลอดภัย / PDPA
- ห้ามฝัง secret ในโค้ด — ใช้ `.env` (`.env*` อยู่ใน `.gitignore` ยกเว้น `.env.example`)
- PII (เบอร์/อีเมล) เก็บเป็น ciphertext ในคอลัมน์ `_enc` (เข้ารหัสด้วย `CREDENTIAL_ENC_KEY` ตั้งครั้งเดียวห้ามเปลี่ยน)
- **RLS hardening (0013–0015):**
  - `anon` ถูก revoke สิทธิ์ตารางทั้งหมด; `authenticated` ได้แค่ select/insert/update/delete (ไม่มี TRUNCATE)
  - append-only (`audit_logs`, `case_activity_logs`, `survey_answers`) กัน update/delete/**truncate** ด้วย trigger (แม้ service_role)
  - scope ตาม `can_access_customer()` ครอบ **ทุกตารางที่ผูกลูกค้า** (ตรงด้วย `customer_id` หรือผ่าน `response_id`)
  - `audit_logs`/`case_activity_logs` กัน spoof: authenticated ตั้ง `actor_user_id` เป็นคนอื่นไม่ได้ + มี `log_audit()`/`log_case_activity()` (SECURITY DEFINER)
  - `tenants` แก้ไขได้เฉพาะ admin/executive
- helper functions เป็น SECURITY DEFINER + fixed `search_path` (กัน hijack) + revoke execute จาก public
- **scope ครอบตารางลูกครบ (0014 + 0018):** case_activity_logs / case_assignments / follow_up_tasks (ผ่าน `case_id`), sales_status_history (ผ่าน `opportunity_id`), customer_assignments (`customer_id`), audit_logs อ่านได้เฉพาะ privileged
- **⚠️ M2 LIFF note:** 0013 revoke สิทธิ์ตารางจาก `anon` → หน้า survey สาธารณะผ่าน LIFF **ห้ามอ่าน/เขียนด้วย anon key ตรง** ต้องผ่าน API server (service-role หรือ token-scoped endpoint) เท่านั้น มิฉะนั้นฟอร์มพังเพราะ RLS/GRANT
- **หมายเหตุ RBAC (M1):** `role_permissions` เป็น catalog แต่ RLS ยัง enforce ด้วย role-code (hardcode ใน helper) — ยอมรับได้สำหรับ M1, เฟสถัดไปขับ policy ด้วย catalog
- **ERD note (0017):** `sales_leads.customer_id` **nullable** — ผูก customer เมื่อ lead convert เป็นลูกค้า (Won); Lost/ยังไม่ convert = null. มี `owner_employee_id` (เซลล์เจ้าของ) ใช้ทำ RLS scope per-lead: `is_privileged() OR sales_lead OR owner OR can_access_customer(customer_id)`

## Cron / Monitoring (E12)
- `vercel.json` ตั้ง Vercel Cron เรียก `/api/cron/health-ping` รายวัน → อัปเดต `cron_health.last_run_at` (โครง cron last-run alert)
- endpoint ตรวจ `Authorization: Bearer $CRON_SECRET`; ไม่มี service-role env ก็ไม่ล้ม (ตอบ skipped)
- M2+ จะเพิ่ม cron `scan-invitations` + worker (notification/ai-analysis) ต่อยอดจากโครงนี้
