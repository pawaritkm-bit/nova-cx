# NOVA-CX — ติดตั้ง / ตั้งค่า / Deploy

> อ่านคู่กับ `README.md` (quick start) และ `docs/architecture.md`
> **ห้ามใส่ค่า secret จริงในไฟล์นี้/ในโค้ด** — ใช้ `.env.local` (dev) และ Vercel env (prod)

---

## 1. Prerequisite

- Node.js 18.18+ (แนะนำ 20 LTS)
- `supabase` CLI (สำหรับ migration/seed) + Supabase project
- (ทางเลือก) OpenAI API key, LINE OA (Care/Sale) + LIFF, Vercel CLI

```bash
npm install
cp .env.example .env.local     # แล้วเติมค่า (ดูตารางข้อ 2)
```

---

## 2. Environment variables

รายการทั้งหมดมาจาก `.env.example` จริง (แต่ละกลุ่ม degrade แยกกันได้ — ตั้งเท่าที่ใช้)

### Supabase (จำเป็นเพื่อใช้งานจริง)
| ตัวแปร | คำอธิบาย |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL โปรเจกต์ Supabase (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key — ใช้กับ session พนักงาน (RLS ทำงานตาม `auth.uid()`) |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key — **ข้าม RLS** ใช้เฉพาะ worker/cron/customer-flow/integration/admin-write |

### LINE OA / LIFF (2 บัญชี: Care=A/B, Sale=C/D)
| ตัวแปร | คำอธิบาย |
|---|---|
| `LINE_CARE_CHANNEL_ID` / `LINE_CARE_CHANNEL_SECRET` / `LINE_CARE_CHANNEL_ACCESS_TOKEN` | OA Care — secret ใช้ verify webhook, token ใช้ยิง Messaging API |
| `LINE_CARE_LIFF_ID` | LIFF ID ของ OA Care (หน้า survey) |
| `LINE_SALE_CHANNEL_ID` / `LINE_SALE_CHANNEL_SECRET` / `LINE_SALE_CHANNEL_ACCESS_TOKEN` | OA Sale |
| `LINE_SALE_LIFF_ID` | LIFF ID ของ OA Sale |
| `LINE_CARE_OFFICE_GROUP_ID` | group id "กลุ่ม LINE สำนักงาน" (fallback ระดับ env สำหรับแบบประเมิน A) |
| `LINE_TENANT_ID` | tenant override สำหรับ webhook (เว้นว่าง = ใช้ tenant แรกในระบบ) |

### AI
| ตัวแปร | คำอธิบาย |
|---|---|
| `OPENAI_API_KEY` | ไม่ตั้ง = worker AI จะ skip (job คง pending) |
| `AI_PROVIDER` | default `openai` |
| `OPENAI_MODEL` | เว้นว่าง = `gpt-4o-mini` (รุ่น mini สำหรับสรุป/จัดหมวด) |

### Security / Cron / Integration
| ตัวแปร | คำอธิบาย |
|---|---|
| `CREDENTIAL_ENC_KEY` | กุญแจเข้ารหัส PII/credential — **ตั้งครั้งเดียว ห้ามเปลี่ยน** (ไม่งั้นถอดของเดิมไม่ออก) |
| `CRON_SECRET` | ส่งเป็น `Authorization: Bearer <CRON_SECRET>` — **ไม่ตั้ง = cron endpoint ปิด (503)** (fail-closed) |
| `NOVA_SALES_API_KEY` | secret ที่ NOVA Sales ส่งมาใน header `x-api-key` — ไม่ตั้ง = `/api/integrations/nova-sales/*` ตอบ 503 |
| `NOVA_SALES_TENANT_ID` | allowlist tenant ที่ผูกกับ API key (กัน key เดียวเขียนข้าม tenant) — ควรตั้งใน prod |

### อื่น ๆ
| ตัวแปร | คำอธิบาย |
|---|---|
| `NEXT_PUBLIC_APP_URL` | base URL ประกอบ `survey_url` (ใช้ในโค้ด `getAppBaseUrl`; ไม่ตั้ง → `https://$VERCEL_URL` → fallback prod) |
| `DATABASE_URL` | เฉพาะรัน DB-integration test (เว้นว่าง = ข้าม test กลุ่มนั้น) |

> `.gitignore` กัน `.env*` ทุกแบบยกเว้น `.env.example` — อย่า commit ค่าจริง

---

## 3. Database (Supabase)

### Migrations 0001–0028 (`supabase/migrations/`)
| กลุ่ม | ไฟล์ | ทำอะไร |
|---|---|---|
| Core schema | `0001` extensions+triggers · `0002` identity/tenant · `0003` employee/team · `0004` customer/line · `0005` assignment/sales · `0006` survey · `0007` eval/scores/ai · `0008` case · `0009` ops (job_queue/notification/cron_health) · `0010` pdpa/audit | ~41 ตาราง (UUID, tenant_id, soft delete) |
| RLS/RBAC | `0011` rls_helpers · `0012` rls_policies · `0013` grants+truncate_guard · `0014` rls_child_scope · `0015` audit_antispoof · `0018` rls_child_scope_2 | deny-by-default + tenant isolation + append-only guard |
| เสริม | `0016` low_priority · `0017` lead_customer_link · `0019` nova_sales_integration | lead↔customer, integration schema |
| RPC | `0020` survey_submit_rpc · `0021` ai_analysis_rpc · `0026` scheduled_invitation_rpc | write หลายตารางแบบ atomic (SECURITY DEFINER) |
| Tracking/AI | `0022` invitation_send_tracking · `0023` ai_analysis_grading+dedup · `0024` scheduling_cron_health | |
| Visibility | `0025` dashboard_visibility_views · `0027` pseudonymity_column_grants | view/column grants (ปิดชื่อลูกค้า) |
| Constraint | `0028` assignment_unique_current | 1 ผู้ดูแลปัจจุบันต่อ role |

### วิธี apply
```bash
supabase link --project-ref <PROJECT_REF>
supabase db push               # apply migrations ที่ยังไม่ลง (ทับ prod ได้ปลอดภัย)

# reset + seed demo (dev เท่านั้น — ล้างข้อมูล):
supabase db reset --linked     # รัน migrations เรียงชื่อ + ต่อด้วย supabase/seed.sql
```
ทางเลือกผ่าน psql:
```bash
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f supabase/seed.sql
```

### seed.sql (demo M1)
1 tenant (`Finovas Accounting`) · 7 roles + permission catalog + role→permission scope · 7 users (1/role) · teams/members · employees · `customer_assignments` (effective-dated + เคสย้ายทีม) · customers/contacts · sales leads/opps · **survey templates A/B/C/D (versioned JSON)**
> `users.auth_user_id` เป็น **UUID placeholder** — ต้องผูกกับ Supabase Auth จริงภายหลัง (RLS จะทำงานเต็มเมื่อ `auth.uid()` = `users.auth_user_id`)

### หมายเหตุ RLS / pseudonymity
- RLS เปิดทุกตาราง deny-by-default + บังคับ `tenant_id`; `anon` ถูก revoke สิทธิ์ตาราง (0013)
- append-only: `audit_logs`, `case_activity_logs`, `survey_answers` กัน update/delete/truncate ด้วย trigger (แม้ service_role)
- scope ตาม `can_access_customer()` ครอบทุกตารางที่ผูกลูกค้า; นักบัญชี/เซลไม่เห็นชื่อลูกค้า (view/column-level, 0025/0027)
- helper เป็น SECURITY DEFINER + fixed `search_path` + revoke execute จาก public

---

## 4. Deploy (Vercel)

- **Auto-deploy จาก `main`** (push → build → deploy). ตั้ง env ทั้งหมด (ข้อ 2) ใน Vercel Project Settings หรือผ่าน CLI:
  ```bash
  vercel env add <NAME> production
  vercel --prod            # redeploy ด้วยมือ (ถ้าต้องการ)
  ```
- **Vercel Cron** (`vercel.json`) — endpoint ทั้งหมดตรวจ `Authorization: Bearer $CRON_SECRET`:
  | path | schedule (UTC) | หน้าที่ |
  |---|---|---|
  | `/api/cron/health-ping` | `0 1 * * *` (รายวัน) | อัปเดต `cron_health.last_run_at` (เตือนเมื่อ cron เงียบ) |
  | `/api/cron/scan-invitations` | `30 1 * * *` (รายวัน) | scan A/B → สร้าง invitation + enqueue |
  | `/api/cron/process-ai` | `*/5 * * * *` | worker AI analysis |
  | `/api/cron/process-notifications` | `*/5 * * * *` | worker line_event + notification + reminder |
- `functions."app/api/**/route.ts".maxDuration = 60`
- security headers ตั้งใน `next.config.mjs` (HSTS เฉพาะ prod); **`/liff/*` ไม่ใส่ `X-Frame-Options`** เพื่อให้ LINE ฝัง LIFF ได้

---

## 5. Testing

```bash
npm test          # vitest run — unit ทั้งหมดรันได้ทันที (ไม่ต้องมี DB)
```
- ทดสอบครอบ: survey (schema/conditional/scoring/submit/token/steps), ai (redact/schema/guardrail/analyze/worker/case), line (signature/routing/notify/events/env), scheduling (engine/eligibility), dashboard (aggregate/redact/sample-size/queries/sla/views), admin (guard/schema/service), integrations (nova-sales + service), reports, auth, health, env
- **DB-integration test** (เช่น `tests/rls/rls.test.ts`, `tests/integrations/survey-db.test.ts`, `tests/dashboard/{views,migration-0027}.test.ts`) ต้อง Postgres จริง — **ถูก skip อัตโนมัติถ้าไม่ตั้ง `DATABASE_URL`**:
  ```bash
  supabase db reset                                   # apply migration + seed + fixtures
  DATABASE_URL="postgres://postgres:...@db.<ref>.supabase.co:5432/postgres" npm test
  ```
  harness impersonate แต่ละ role (ตั้ง `request.jwt.claims.sub` + `set role authenticated`) แล้ว assert tenant isolation / scope นักบัญชี (C-10) / deny-by-default / anon ถูกปฏิเสธ. `tests/rls/fixtures.sql` เพิ่ม tenant#2 + ลูกค้าไม่มีผู้ดูแล (idempotent)

---

## 6. Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `GET /api/health` = `degraded`, `database: skipped` | ยังไม่ตั้ง `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` → เติม env |
| `GET /api/health` = `degraded`, `database: unreachable` + error `schema cache` | apply migration ตารางใหม่แล้ว PostgREST ยังไม่รู้ → รัน `notify pgrst, 'reload schema';` |
| หน้า LIFF survey โหลดไม่ได้ / DB error | หลัง 0013 `anon` ถูก revoke → customer flow ต้องผ่าน API server (service-role/token-scoped) เท่านั้น; ตรวจว่าตั้ง `SUPABASE_SERVICE_ROLE_KEY` แล้ว |
| cron ยิงแล้วได้ `503 cron_disabled` | ยังไม่ตั้ง `CRON_SECRET` (fail-closed) → ตั้ง env |
| cron ได้ `401 unauthorized` | header ไม่ตรง → ต้องเป็น `Authorization: Bearer <CRON_SECRET>` |
| `/api/integrations/nova-sales/*` = 503 | ยังไม่ตั้ง `NOVA_SALES_API_KEY` |
| integration = `403 tenant_id ไม่ตรงกับ API key` | `payload.tenant_id` ≠ `NOVA_SALES_TENANT_ID` |
| webhook LINE = 401 `invalid_signature` | channel secret ไม่ตรง / body ถูกแก้ก่อน verify (ต้อง verify raw body) |
| survey submit = 409 `already_responded` | ตอบซ้ำ (unique invitation) — พฤติกรรมปกติ |
| survey submit = 400 `consent_required` | payload ต้องมี `consent: true` |
| AI job ค้าง `pending` ตลอด | ยังไม่ตั้ง `OPENAI_API_KEY` → worker skip (ตั้ง key แล้วรอบถัดไปจะรัน) |
| dashboard/report = 401/403 | ต้องมี session พนักงานจริง + บทบาทใน allow-list (member/ไม่มีบทบาท ถูกปฏิเสธ) |
