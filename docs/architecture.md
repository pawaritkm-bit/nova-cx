# NOVA-CX — สถาปัตยกรรม (Architecture)

> เอกสารนี้อธิบาย "ระบบจริงตามโค้ด" สำหรับผู้ดูแลต่อ
> เอกสารออกแบบเดิม (ERD/DB schema เต็ม/API spec ตั้งต้น) อยู่ที่ `docs/02-design.md`

---

## 1. ภาพรวม (House Stack)

```
                       ┌───────────────────────── Vercel (Next.js 15 App Router) ─────────────────────────┐
ลูกค้า (LINE)           │                                                                                   │
  │  Rich Menu/Flex     │  app/liff/survey/[token]  ── UI แบบประเมิน (มือถือ, client)                        │
  ├────────────────────▶│        │                                                                          │
  │  webhook event      │        ▼ fetch                                                                    │
  ├────────────────────▶│  app/api/*  (Route Handlers)                                                      │
  │                     │    ├─ /api/liff/survey/[token]  โหลด schema+auto-fill (service-role scoped)        │
  │                     │    ├─ /api/survey/submit        บันทึกคำตอบ→CSAT/NPS→enqueue AI                    │
  │                     │    ├─ /api/line/webhook/[oa]    verify signature→enqueue line_event                │
พนักงาน (เว็บ)          │    ├─ /api/dashboard/[role]     metrics ตามบทบาท (auth + RLS view)                  │
  │  Supabase Auth      │    ├─ /api/reports/export       CSV (allow-list)                                   │
  ├────────────────────▶│    ├─ /api/integrations/nova-sales/*  (x-api-key)                                  │
  │  /dashboard /admin  │    └─ /api/cron/*               (Bearer CRON_SECRET) — Vercel Cron                 │
  │                     │                                                                                   │
NOVA Sales ──x-api-key─▶│  lib/*  (โดเมนลอจิก: survey/ai/line/scheduling/dashboard/admin/integrations)       │
                       └───────────────────────────────────┬───────────────────────────────────────────────┘
                                                            │ @supabase/ssr (anon = RLS ตาม auth.uid / service-role = bypass)
                                                            ▼
                              ┌──────────────── Supabase Postgres ────────────────┐
                              │ ~41 ตาราง · RLS deny-by-default + tenant isolation │
                              │ pseudonymity views · RPC (SECURITY DEFINER)        │
                              │ job_queue · cron_health · audit_logs (append-only) │
                              └────────────────────────────────────────────────────┘
                                                            │
                                          OpenAI (redact ก่อนส่ง) ◀── lib/ai/*
                                          LINE Messaging API     ◀── lib/line/*
```

**หลักการเชื่อมต่อ Supabase มี 3 แบบ (`lib/supabase/`):**
- `client.ts` — browser client (anon key) ใช้ใน Client Components
- `server.ts › createClient()` — server client ผูก cookie ของ request → `auth.uid()` + **RLS ทำงานตามผู้ล็อกอิน** (ใช้กับ dashboard/report/admin-read)
- `server.ts › createServiceRoleClient()` — **ข้าม RLS** ใช้เฉพาะงานเบื้องหลัง: worker/cron, customer flow (scoped ด้วย token), integration, admin write

---

## 2. ส่วนประกอบหลัก (lib/) + หน้าที่

| โมดูล | ไฟล์สำคัญ | หน้าที่ |
|---|---|---|
| **env** | `lib/env.ts` | อ่าน env แบบไม่ throw ตอน import (degrade ได้), helper ต่อ OA/Supabase/NOVA Sales/appBaseUrl |
| **http** | `lib/http.ts` | `newRequestId`, `logServerError`, `serverErrorResponse`, `isValidCronAuth` |
| **auth** | `lib/auth/guard.ts` | ตรรกะ guard เส้นทาง (แยกจาก middleware เพื่อ test) — public prefix vs `/dashboard`,`/admin` |
| **survey** | `survey/{schema,conditional,scoring,submit,token,service,steps,types}.ts` | normalize versioned JSON → flatten คำถาม, conditional/exclusive, คำนวณ CSAT/NPS, validate ฝั่ง server, invitation token |
| **ai** | `ai/{redact,prompt,provider,openai,schema,guardrail,analyze,worker,case}.ts` | pipeline วิเคราะห์ (redact→prompt→OpenAI→Zod→guardrail), worker ดึง job, ตัดสินเปิดเคส + SLA |
| **scheduling** | `scheduling/{engine,eligibility}.ts` | cron scan ลูกค้า active → eligibility A/B → สร้าง invitation idempotent + enqueue |
| **line** | `line/{signature,webhook,events,routing,notify,messages,client}.ts` | verify HMAC, resolve tenant/OA, worker line_event, ส่ง push/flex + reminder, route OA↔survey type |
| **dashboard** | `dashboard/{queries,aggregate,redact,sample-size,session,sla,types}.ts` | ประกอบ metrics ตามบทบาท, ปิดชื่อลูกค้า, Sample Size guard |
| **admin** | `admin/{guard,service,schema}.ts` | allow-list (admin/executive), inject tenant จาก session, write ผ่าน service-role |
| **integrations** | `integrations/nova-sales{,-service}.ts` | contract + auth (x-api-key + tenant allowlist) + upsert customer/deal → ยิงแบบประเมิน C/D |
| **reports** | `reports/{index,csv}.ts` | build report + CSV (มี BOM ให้ Excel ไทยไม่เพี้ยน) |
| **pdpa / health** | `lib/pdpa.ts`, `lib/health.ts` | consent payload, health payload (validate ด้วย Zod) |

---

## 3. การไหลของข้อมูลหลัก (flows)

### 3.1 Survey submit → CSAT/NPS → AI → Case
1. LIFF โหลดฟอร์ม: `GET /api/liff/survey/[token]` → `getInvitationByToken` → `verifyInvitationAccess` (มีจริง/ยังไม่ตอบ/ไม่หมดอายุ/เจ้าของ) → คืน versioned JSON + auto-fill + (Form B) subjects จาก `assignee_snapshot`
2. ส่งคำตอบ: `POST /api/survey/submit` → Zod `submitPayloadSchema` → **consent บังคับ true** → `validateAnswers` (rating 1..scale, nps 0–10, exclusive option เลือกเดี่ยว, บังคับตอบ rating/nps) ฝั่ง server
3. คำนวณ `computeCsat` / `computeNps` → `persistSurveyResponse` (RPC `submit_survey_response` แบบ atomic, unique(invitation_id) กันซ้ำ → ตอบ 409) → เขียน consent → ปิด invitation → **enqueue `job_queue(ai_analysis)`**
4. Cron `POST /api/cron/process-ai` (ทุก 5 นาที) → `processAiAnalysisJobs`:
   claim job (optimistic, reclaim stale lock 5 นาที) → `loadResponseContext` (answers+scores+ชื่อ) → `analyzeFeedback`:
   redact PII (C-15) → residual-PII gate → prompt → `provider.generateJson` (json_schema) → Zod parse (retry 1) → guardrail post-filter (C-01..04) → High/Critical หรือ parse fail = `needs_human_review`
5. `persist_ai_analysis` (RPC) เขียน `ai_feedback_analysis` + เปิด `complaint_cases` ถ้า `shouldOpenCase(urgency)` พร้อม `computeSlaDueAt`
6. งานพังนับ attempts → backoff เชิงเส้น → ครบ `max_attempts` = `dead`

### 3.2 Scheduling (cron scan)
`POST /api/cron/scan-invitations` (รายวัน 01:30 UTC) → `runScheduling`:
โหลดลูกค้า active แบบ **pagination วนจนหมด** (กัน batch starvation) → scan A (`officeCycleDue` ราย 3 เดือนจาก service_start) + B (`accountantCyclePeriod` ต้นเดือน, ต้องมีผู้ดูแลปัจจุบัน) →
`invitationExists(idempotency_key)` กันซ้ำ → RPC `create_scheduled_invitation` (**atomic**: insert invitation + enqueue notification ใน transaction เดียว, on-conflict = ไม่ enqueue ซ้ำ) → อัปเดต `cron_health`
- isolate ต่อลูกค้า/ต่อชนิด (1 รายพัง ไม่ล้มทั้ง batch)
- A ไม่ผูก line_user (ส่งเข้ากลุ่ม); B เลือก line_user ที่ reachable (ไม่ block, ล่าสุด)

### 3.3 LINE webhook / notification
- `POST /api/line/webhook/[oa]` (oa=care|sale) → `verifyLineSignature` (HMAC-SHA256 timing-safe ด้วย channel secret) ไม่ผ่าน **401** → `resolveOaTenantId` → **enqueue `job_queue(line_event)` แล้ว return 200 ทันที** (trim PII จาก event ก่อนเก็บ)
- `POST /api/cron/process-notifications` (ทุก 5 นาที) → (1) `processLineEventJobs` (follow/unfollow → `line_users`) (2) `processNotificationJobs` (ส่งแบบประเมิน/เตือน + log `notification_logs` + retry) (3) `processReminders` (เตือน 1 ครั้ง/วัน)
- routing: A→Care/กลุ่ม, B→Care/ส่วนตัว, C/D→Sale/ส่วนตัว (`lib/line/routing.ts`)

### 3.4 NOVA Sales integration
- `POST /api/integrations/nova-sales/customer` → auth `x-api-key` (constant-time) + `checkTenantAllowed` → `upsertCustomer`(+lead) idempotent
- `POST /api/integrations/nova-sales/deal-status` → upsert opportunity + history → **Won ⇒ แบบประเมิน C, Lost ⇒ D** (enqueue invitation ผ่าน OA Sale) → คืน `survey_url` (เปิดเบราว์เซอร์ไหนก็ได้) · idempotent ด้วย `external_deal_id` + `dealInvitationIdempotencyKey`
- รองรับส่งชื่อเซล (`sales_employee_name`) แล้ว resolve → `employee_id` (roster ฝั่ง NOVA Sales เป็นชื่อ)

### 3.5 Dashboard / Report (พนักงาน)
- middleware refresh session + guard `/dashboard`,`/admin` (ไม่มี session → redirect `/login?redirect=`)
- `GET /api/dashboard/[role]` — **บทบาทมาจาก session เท่านั้น** (ไม่เชื่อ `[role]` param เลือก composition); ไม่มี session→401, ไม่มีบทบาท→403; อ่านผ่าน view/RLS ตาม `auth.uid()`
- `GET /api/reports/export` — allow-list export (executive/admin/acc_lead/sales_lead/cs); member→403; ข้อมูล scope ด้วย view เสมอ

---

## 4. การตัดสินใจเชิงออกแบบสำคัญ + เหตุผล

| การตัดสินใจ | เหตุผล |
|---|---|
| **degrade แทน crash** (env ไม่ครบ → 503/skip/dev mode) | build/health/deploy ไม่ล้มระหว่างตั้งค่า; เปิด service เป็นส่วน ๆ ได้ |
| **job_queue ในตาราง Postgres** (ไม่ใช้ QStash เฟสแรก) | volume ระดับร้อย–พันราย/รอบยังไม่ต้องมี broker แยก; ลดชิ้นส่วน; สลับ QStash ได้ภายหลัง |
| **RPC (SECURITY DEFINER) สำหรับ write หลายตาราง** (`submit_survey_response`, `create_scheduled_invitation`, `persist_ai_analysis`) | ทำ atomic ใน transaction เดียว (invitation+enqueue / analysis+case) กัน state ค้างครึ่งทาง |
| **cron endpoint ตอบ 200 แม้ error** (log ไว้) | กัน Vercel Cron/LINE retry loop; monitor จับจาก `cron_health` + log |
| **service-role + token-scoped สำหรับ customer flow** | หลัง migration 0013 revoke สิทธิ์ตารางจาก `anon` → LIFF ห้ามแตะ DB ด้วย anon key ตรง ต้องผ่าน API |
| **บทบาท dashboard จาก session เท่านั้น** | กันปลอม `?role=` เลือกชุดข้อมูล; ต่อให้ปลอม param ข้อมูลยังบังคับด้วย RLS/view ตาม `auth.uid()` |
| **redact PII ก่อนส่ง AI + residual-PII gate** | PDPA (C-15); ถ้ายังพบ PII ตกค้าง = บล็อกไม่ส่ง external AI แล้วบังคับมนุษย์ตรวจ |
| **pseudonymity views + column grants (0025/0027)** | นักบัญชี/เซลไม่เห็นชื่อลูกค้าที่ระดับ view/column ไม่ใช่ frontend |
| **assignee snapshot ใน invitation + assignment effective-dated** | ผูก feedback กับผู้ดูแล **ณ เวลาที่เกิดบริการจริง** (temporal binding) แม้ย้ายทีมภายหลัง |
| **inject deps ใน worker/engine/analyze** | unit test ได้โดยไม่ต้องมี env/network จริง (db/provider/now/token) |

---

## 5. หนี้ทางเทคนิค / TODO ที่ยังค้าง (จากคอมเมนต์ในโค้ด)

- **Owner-binding เต็มรูป (🟠#5)**: ปัจจุบัน `verifyInvitationAccess` ส่ง `requesterLineUserId: null` (ไม่ใช้ LINE userId จาก client ตัดสินสิทธิ์ เพราะ spoof ได้) — ยังพึ่งความลับของ token; ต้อง verify LINE ID token → `line_users.id` ใน chunk ที่มี LINE env ครบ
- **Rate limiting**: brief กำหนดไว้ (E12) แต่ยังไม่เห็น implementation ที่ endpoint สาธารณะ
- **Reports XLSX/PDF**: ปัจจุบัน export เป็น **CSV** เท่านั้น (`lib/reports/csv.ts`); XLSX/PDF = Later
- **Decrypt phone / `CREDENTIAL_ENC_KEY`**: PII เก็บ `_enc`; flow ถอดรหัสเพื่อแสดง/ติดต่อยังไม่ครบ
- **FR-PD-04 (Admin เปิดตัวตน + audit บังคับ)**: ยังไม่มี endpoint `/api/admin/customer/[id]/identity` ตาม design spec
- **Real user provisioning**: `seed.sql` ใช้ `auth_user_id` เป็น UUID placeholder — ต้องผูกกับ Supabase Auth จริง (สร้าง user + map) ผ่านหน้า Admin/สคริปต์
- **RBAC จาก catalog**: `role_permissions` เป็น catalog แต่ RLS ยัง enforce ด้วย role-code ใน helper (hardcode) — เฟสถัดไปขับ policy ด้วย catalog
- **Office group id ต่อลูกค้า**: A ยัง fallback `LINE_CARE_OFFICE_GROUP_ID` ระดับ env — ควรเก็บ group id ต่อลูกค้า/สำนักงานใน DB
- **urgency=medium → follow_up_tasks**: worker ยังเปิดเป็นเคส (ยังไม่แยกเป็น task ตาม design)
