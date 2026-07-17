# NOVA-CX — API Reference

> Route Handlers จริงใน `app/api/*` (+ `app/auth/logout`) — เขียนจากโค้ด
> ทุก route มี `dynamic = "force-dynamic"`; response เป็น JSON เว้นแต่ระบุเป็นไฟล์
> รูปแบบ error ทั่วไป: `{ "error": "<code>", "message"?: "...", "request_id"?: "..." }`
> การยืนยันตัวตน 4 แบบ: **session** (Supabase Auth cookie) · **invitation token** · **`Authorization: Bearer $CRON_SECRET`** · **header `x-api-key`**

---

## Public / System

### `GET /api/health`
health check — ไม่ต้อง auth
- **200** `{ status: "ok"|"degraded", timestamp, checks:{ env, database:"skipped"|"connected"|"unreachable", databaseError? } }`
- `ok` = env ครบ + query `cron_health` ได้ · `degraded` = ยังไม่ตั้ง env / ต่อ DB ไม่ได้

```bash
curl https://nova-cx.vercel.app/api/health
```

---

## Survey (ลูกค้า / preview)

### `GET /api/liff/survey/[token]`
โหลดแบบประเมินตาม invitation token (customer flow, service-role scoped)
- ตรวจ token: มีจริง + ยังไม่ตอบ + ไม่หมดอายุ + (owner-binding — ปัจจุบันยังไม่บังคับ line userId)
- **200** `{ token, survey_type, survey_slug, version:{id,version_no}, schema, questions[], reference:{customer_code,name,business_name,service_start_date}|null, subjects[] }`
  (Form B: `subjects` = ผู้ถูกประเมินจาก assignee snapshot)
- **404** `not_found` · **403** `forbidden`/`expired` · **503** ยังไม่ตั้ง service-role

### `POST /api/survey/submit`
บันทึกคำตอบ (idempotent)
- **body** `{ token: string(≥10), answers: Record<code, number|string|string[]|boolean|null>, consent: true, lineUserId?: string }`
- validate ฝั่ง server: rating 1..scale, nps 0–10, exclusive option เลือกเดี่ยว, บังคับตอบ rating/nps
- **201** `{ ok:true, response_id, csat, nps }` → enqueue AI analysis
- **400** `validation_error` / `consent_required` / `answer_invalid` · **404** `not_found` · **409** `already_responded` · **403** `forbidden` · **503** ยังไม่ตั้ง Supabase

```bash
curl -X POST https://nova-cx.vercel.app/api/survey/submit \
  -H 'content-type: application/json' \
  -d '{"token":"<invitation_token>","consent":true,"answers":{"overall":5,"nps":9}}'
```

### `GET /api/survey/template?type=...`
โหลด template ที่ active (preview/dev/admin — ต้องมี service-role)
- **type** = `office|accountant|sales-won|sales-lost` หรือ `A|B|C|D` · optional `&tenant_id=`
- **200** `{ survey_type, template:{id,name}, version:{id,version_no}, schema, questions[] }`
- **400** `invalid_type` · **404** `not_found` · **503**

---

## LINE Webhook

### `POST /api/line/webhook/[oa]` (oa = `care` | `sale`)
- verify `x-line-signature` (HMAC-SHA256 timing-safe ด้วย channel secret ของ OA) → **enqueue `job_queue(line_event)` → return 200 ทันที**
- **200** `{ status:"ok", enqueued:<n> }` (event ว่าง/ไม่มี tenant/persist ไม่ได้ = ตอบ 200 กัน LINE retry, log ไว้)
- **401** `invalid_signature` · **404** `unknown_oa` · **503** ยังไม่ตั้ง channel secret

---

## Dashboard / Reports (พนักงาน — ต้องมี session)

### `GET /api/dashboard/[role]`
- **role** ∈ `executive|acc_lead|accountant|sales_lead|sales|cs|admin` (ใช้ validate เท่านั้น — **composition จริงมาจากบทบาทใน session**)
- **200** `{ role, from_session, data }` (data = exec/lead/member view ตามบทบาท; อ่านผ่าน RLS/view)
- **400** `invalid_role` · **401** `unauthorized` (ไม่มี session) · **403** `forbidden` (ไม่มีบทบาทพนักงาน) · **503** db_unavailable

### `GET /api/reports/export?type=monthly|team&cycle=YYYY-MM&survey_type=A`
- export **CSV** (มี BOM ให้ Excel ไทยไม่เพี้ยน); allow-list: executive/admin/acc_lead/sales_lead/cs
- **200** ไฟล์ CSV (`content-disposition: attachment`) · **400** `invalid_type` · **401** · **403** `forbidden` (member/ไม่มีบทบาท) · **503**

---

## Integration: NOVA Sales → NOVA-CX
auth: header `x-api-key = NOVA_SALES_API_KEY` (constant-time) + `payload.tenant_id` ต้องตรง `NOVA_SALES_TENANT_ID` (ถ้าตั้ง)

### `POST /api/integrations/nova-sales/customer`
upsert ลูกค้า (+lead) idempotent
- **body** `{ tenant_id(uuid), name, external_customer_id?, customer_code?, business_name?, service_start_date?, status?:"active"|"cancelled"|"prospect", contact?:{name,phone,email}, lead?:{external_lead_id?,name?,source?,owner_employee_id?} }`
- **201/200** `{ ok:true, customer_id, created, lead_id }`
- **400** `validation_error` · **401** unauthorized · **403** forbidden(tenant) · **503** (ยังไม่ตั้ง key/Supabase)

### `POST /api/integrations/nova-sales/deal-status`
upsert opportunity + history; **Won ⇒ แบบประเมิน C, Lost ⇒ D** (enqueue ผ่าน OA Sale)
- **body** `{ tenant_id(uuid), external_deal_id, status:"open"|"won"|"lost", customer_id?|customer_code? (อย่างน้อยหนึ่ง), external_lead_id?, sales_employee_id?|sales_employee_name?, stage?, amount?, closed_at? }`
- **201/200** `{ ok:true, opportunity_id, created, status_changed, previous_status, sales_employee, invitation:{id,created,survey_type}|null, survey_url|null }`
- **400** `validation_error` · **401** · **403** · **503**

```bash
curl -X POST https://nova-cx.vercel.app/api/integrations/nova-sales/deal-status \
  -H "x-api-key: $NOVA_SALES_API_KEY" -H 'content-type: application/json' \
  -d '{"tenant_id":"<uuid>","external_deal_id":"D-1001","status":"won","customer_code":"C-001","sales_employee_name":"มะปราง"}'
```

---

## Cron (Vercel Cron — ต้อง `Authorization: Bearer $CRON_SECRET`)
รับทั้ง GET/POST; **ไม่ตั้ง `CRON_SECRET` = 503 (fail-closed)**, auth ผิด = 401, ไม่มี service-role env = `skipped`, error = ตอบ 200 + `status:"error"` (กัน retry loop)

| endpoint | schedule (UTC) | ผลลัพธ์สำเร็จ |
|---|---|---|
| `POST /api/cron/scan-invitations` | `30 1 * * *` | `{ status:"ok", timestamp, office:{scanned,created,existed,skipped,noTemplate,failed}, accountant:{...} }` |
| `POST /api/cron/process-ai` | `*/5 * * * *` | `{ status:"ok", processed, done, failed, dead, skipped, reason? }` |
| `POST /api/cron/process-notifications` | `*/5 * * * *` | `{ status:"ok", events, notifications, reminders }` |
| `POST /api/cron/health-ping` | `0 1 * * *` | `{ status:"ok", timestamp }` (อัปเดต `cron_health`) |

```bash
curl -X POST https://nova-cx.vercel.app/api/cron/scan-invitations \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Auth

### `POST /auth/logout`
signOut + `303` redirect ไป `/login` (ใช้ผ่าน `<form method="post" action="/auth/logout">`)

---

## ฟังก์ชันหลักฝั่ง lib (สำหรับ dev ที่ต่อยอด)

| ฟังก์ชัน | ไฟล์ | อินพุต → เอาต์พุต |
|---|---|---|
| `analyzeFeedback(provider, input)` | `lib/ai/analyze.ts` | context (survey_type, scores, answers, knownNames) → `{ result(AiAnalysisResult), provider, model, violations, parseFailed }` (redact→AI→Zod→guardrail) |
| `processAiAnalysisJobs({db,provider})` | `lib/ai/worker.ts` | ดึง `job_queue(ai_analysis)` batch → persist + เปิดเคส → `WorkerSummary` |
| `runScheduling({db})` | `lib/scheduling/engine.ts` | scan A/B → สร้าง invitation idempotent + enqueue → `RunSchedulingSummary` |
| `verifyInvitationAccess(input)` | `lib/survey/token.ts` | invitation+requester → `{ok:true}` \| `{ok:false, reason}` |
| `validateAnswers(questions,answers,required?)` | `lib/survey/submit.ts` | → `{ok, errors[]}` (server-side validate) |
| `verifyLineSignature(secret,rawBody,sig)` | `lib/line/signature.ts` | → boolean (HMAC timing-safe) |
| `oaForSurveyType(type)` / `channelForSurveyType(type)` | `lib/line/routing.ts` | A/B→care, C/D→sale ; A→group, อื่น→user |
| `checkNovaSalesAuth(headers,envKey)` / `checkTenantAllowed(t,allowed)` | `lib/integrations/nova-sales.ts` | → AuthResult / boolean |
| `requireAdminContext(db)` | `lib/admin/guard.ts` | → `{tenantId, role}` หรือ throw `AdminAuthError` (allow-list admin/executive) |
| `buildHealthPayload(args)` | `lib/health.ts` | → `HealthPayload` (validate ด้วย Zod) |
