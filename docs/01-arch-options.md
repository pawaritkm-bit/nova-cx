# NOVA-CX — ทางเลือกสถาปัตยกรรม (01-arch-options.md)

หลักการตัดสินใจ: ยึด House Stack (Next.js App Router + Supabase + Vercel + OpenAI), ส่งมอบเร็ว/ดูแลง่าย, ไม่ over-engineer สำหรับ MVP แต่เผื่อทางขยาย, และเคารพข้อบังคับ PDPA + audit + anti-bias ในโจทย์

---

## จุดที่ 1 — Survey Engine (โครงสร้างแบบสอบถาม)

**ตัวเลือก**
- **A. Hardcode 4 ฟอร์ม (A/B/C/D)** — โครงคำถามเขียนใน TypeScript/React ตรงๆ
- **B. Config-driven เต็มรูป** — schema builder + admin UI สร้าง/แก้ฟอร์มได้เองทุกอย่าง
- **C. Config-driven แบบ versioned JSON ใน DB (ไม่มี builder UI)** — เก็บโครงฟอร์มเป็น JSON schema ในตาราง `survey_templates/survey_versions`, seed จาก migration, render ด้วย engine กลางตัวเดียว, แก้ผ่าน migration/seed ไม่ใช่ UI

| เกณฑ์ | A Hardcode | B Full builder | C Versioned JSON (ไม่มี builder) |
|---|---|---|---|
| ความเร็วในการทำ | เร็วสุด | ช้าสุด | เร็ว-ปานกลาง |
| ดูแลรักษาง่าย | แย่ (แก้คำถาม=แก้โค้ด+deploy) | ดีถ้าเสถียร | ดี (แก้ JSON/seed) |
| ขยายต่อได้ | ต่ำ | สูงสุด | สูง (เพิ่มฟอร์ม=เพิ่ม version) |
| เหมาะกับผู้ใช้ | เท่ากันปลายทาง | ดี (แอดมินแก้เอง) | เท่ากันปลายทาง |
| ความเสี่ยง | ผูกคำตอบเก่ากับโค้ดใหม่ยาก | scope creep บาน | ต้องออกแบบ schema+validator ให้ดี |

โจทย์บังคับ "เก็บ survey_template_version ทุกคำตอบ" อยู่แล้ว → hardcode จะขัดกับ requirement นี้ทันที และ conditional logic (คะแนน 1-2 เปิดคำถามเพิ่ม, "ยังไม่พบปัญหา" เลือกเดี่ยว) ควรอยู่ใน schema ไม่ใช่กระจายในโค้ด

**✅ แนะนำ: C** — versioned JSON schema ใน DB + render engine กลาง + Zod validator แต่ **ยังไม่ทำ builder UI ใน MVP** (แก้ฟอร์มผ่าน seed/migration). ได้ทั้ง versioning ตามข้อบังคับ, conditional logic รวมศูนย์, และไม่บานเป็นโปรเจกต์ทำ form-builder. อัปเกรดเป็น B ทีหลังได้โดยไม่ต้องรื้อ data model

---

## จุดที่ 2 — Background Jobs / Scheduler

**ตัวเลือก**
- **A. Vercel Cron + queue table ใน Postgres** — cron ยิงเป็นนาที/ชั่วโมง, endpoint ดึงงานจากตาราง `job_queue` (status/attempts/run_at/locked_at) ทำทีละ batch, retry ด้วยตัวเอง
- **B. External queue (Upstash QStash / Redis)** — ส่ง message เข้า QStash, มี delay/retry/DLQ ในตัว
- **C. Supabase pg_cron + Edge Functions / pg_net** — schedule ในฐานข้อมูล เรียก function โดยตรง

| เกณฑ์ | A Vercel Cron+PG queue | B QStash | C pg_cron+Edge |
|---|---|---|---|
| ความเร็วในการทำ | เร็ว (ไม่มี service ใหม่) | ปานกลาง | ปานกลาง |
| ดูแลรักษาง่าย | ดี (ทุกอย่างในที่เดียว, query ดู job ได้) | ต้องดู dashboard นอก | ต้องเขียน Deno แยก runtime |
| ขยายต่อได้ | พอเพียงระดับ MVP-กลาง | สูง (throughput/DLQ ดี) | ปานกลาง |
| เหมาะกับทีม (House Stack) | ตรงสุด | เพิ่ม vendor+cost | แยก mental model |
| ความเสี่ยง | cron อาจไม่ยิง/งานยาว >maxDuration | vendor lock, ค่าใช้จ่าย | debug ยาก, cron เงียบ |

บทเรียนทีม (memory) มีเคส "cron ไม่ยิง" อยู่แล้ว → ต้องมี health check + last-run monitoring ไม่ว่าเลือกทางไหน. งาน AI analysis เป็น async หนัก ควรแยก worker endpoint + timeout เผื่อ

**✅ แนะนำ: A (Vercel Cron + Postgres queue table)** สำหรับ MVP — ไม่มี vendor เพิ่ม, ตรวจสอบ/retry/audit ผ่าน SQL ได้ตรงๆ, เข้ากับ RLS+audit_log. เสริม: แยก 2 คิว (notification / ai-analysis), มี `attempts+max_attempts+dead_letter`, มี cron health-check row + แจ้งเตือนถ้า last_run ค้าง. เตรียม interface คิวให้สลับไป **QStash** ได้ถ้า volume โต (ถือเป็น Phase ถัดไป)

---

## จุดที่ 3 — AI Provider Abstraction

**ตัวเลือก**
- **A. เรียก OpenAI SDK ตรงในโค้ด** — เร็วแต่ผูกแน่น
- **B. Interface กลาง `AIProvider` + adapter (OpenAI default)** — `analyze(input): Promise<Result>` มี implementation OpenAI, เผื่อ Claude/อื่นภายหลัง
- **C. Framework abstraction (LangChain/Vercel AI SDK)** — ได้ tooling เยอะแต่ dependency หนัก

| เกณฑ์ | A ตรง | B Interface+adapter | C Framework |
|---|---|---|---|
| ความเร็วในการทำ | เร็วสุด | เร็ว | ปานกลาง |
| ดูแลรักษาง่าย | สลับเจ้าลำบาก | ดี (จุดเดียว) | ขึ้นกับ framework |
| ขยายต่อได้ | ต่ำ | สูง | สูงแต่ overhead |
| ความเสี่ยง | lock-in | ต้องคุม schema เอง | breaking changes ของ lib |

**structured JSON output**: บังคับด้วย OpenAI Structured Outputs / `response_format: json_schema` + validate ด้วย **Zod** ฝั่งเรา (parse ไม่ผ่าน → retry 1 ครั้งแล้ว fallback flag ให้มนุษย์ตรวจ). ต้อง redact เบอร์/อีเมล/เลขภาษีก่อนส่งเข้า AI (ตาม standards) และผลลัพธ์ต้องมี field แยก `customer_facts` vs `ai_assumptions` + `evidence` + `confidence` ตามข้อบังคับ "ห้ามสรุปพนักงานผิดโดยไม่มีหลักฐาน"

**✅ แนะนำ: B** — interface `AIProvider` บางๆ, default OpenAI (`gpt` รุ่น mini สำหรับสรุป/จัดหมวด ตาม lessons ที่ว่างาน AI หนักใช้ OpenAI คุ้มกว่า), บังคับ json_schema + Zod validation, มี guardrail กันคำสัญญาชดเชย/คืนเงิน (system prompt + post-filter). ไม่ใช้ framework ใหญ่ใน MVP

---

## จุดที่ 4 — LINE Integration

**ตัวเลือก**
- **A. Webhook + LIFF อยู่ใน Next.js app เดียวกัน** — `/api/line/webhook` (route handler) + หน้า LIFF เป็น route `/liff/*` ใน app เดียว deploy บน Vercel
- **B. แยก service webhook (เช่น Edge Function/serverless แยก) + LIFF ใน Next.js**
- **C. แยกทั้ง webhook และ LIFF เป็นคนละ deployment**

| เกณฑ์ | A รวมใน Next.js | B แยก webhook | C แยกหมด |
|---|---|---|---|
| ความเร็วในการทำ | เร็วสุด | ปานกลาง | ช้า |
| ดูแลรักษาง่าย | ดี (repo/deploy เดียว) | ปานกลาง | ยาก (หลาย env) |
| ขยายต่อได้ | พอเพียง | ดีถ้า webhook โหลดสูง | สูง |
| ความเสี่ยง | webhook 200 ต้องไว → ต้อง ack เร็วแล้วโยนเข้าคิว | ซับซ้อนขึ้น | overkill สำหรับ MVP |

หัวใจ: LINE webhook ต้องตอบ 2xx ภายในเวลาสั้น → handler ต้อง **verify signature → เขียน event ลง queue → return 200** แล้วประมวลผลจริงใน worker (เชื่อมกับจุดที่ 2). LIFF form ใช้ LIFF SDK + LINE Login, host หน้า `/liff/survey/[invitationToken]` ใน Next.js, ตรวจ token ผูก invitation กันคนอื่นเปิดแบบประเมินที่ไม่ใช่ของตัวเอง

**✅ แนะนำ: A** — รวม webhook + LIFF ใน Next.js app เดียว, pattern "ack เร็ว + async worker", ส่ง Flex/Push ผ่าน Messaging API ใน worker. ง่ายต่อการ deploy/monitor และเข้ากับทีมสุด

---

## จุดที่ 5 — Multi-tenant + RBAC + RLS (7 บทบาท + tenant isolation)

**ตัวเลือก**
- **A. RLS ล้วน** — เขียน policy ครอบทุกตารางตาม `tenant_id` + role + ownership
- **B. Application-layer authz ล้วน** — เช็คสิทธิ์ในโค้ด, ปิด RLS
- **C. Hybrid** — RLS เป็นชั้นบังคับ tenant isolation + ownership ขั้นต่ำ (fail-safe), application layer จัดการ RBAC เชิงฟีเจอร์/UI + query filter ละเอียด

| เกณฑ์ | A RLS ล้วน | B App layer ล้วน | C Hybrid |
|---|---|---|---|
| ความเร็วในการทำ | ช้า (policy ซับซ้อน 7 role) | เร็ว | ปานกลาง |
| ดูแลรักษาง่าย | policy บานตาม role | เสี่ยงลืมเช็ค=รั่ว | ดี (RLS กันพลาด, โค้ดอ่านง่าย) |
| ความปลอดภัย | แข็งแรงระดับ DB | เปราะ (bug=leak ข้าม tenant) | แข็งแรง+ยืดหยุ่น |
| ขยายต่อได้ | เพิ่ม role=แก้ policy เยอะ | ดี | ดี |
| ความเสี่ยง | debug policy ยาก | data leak | ต้องมีวินัย 2 ชั้น |

โจทย์เป็น multi-tenant SaaS + PDPA + "นักบัญชีห้ามเห็นข้อมูลลูกค้านอกความรับผิดชอบ" → tenant isolation ต้องบังคับที่ DB ห้ามพึ่งโค้ดอย่างเดียว

**✅ แนะนำ: C (Hybrid)** — RLS บังคับ `tenant_id` + ownership แบบ coarse (fail-safe กันข้าม tenant/เห็นลูกค้าที่ไม่ได้ดูแล) ทุกตาราง; RBAC 7 บทบาทเชิงฟีเจอร์/scope ทำที่ application layer + query filter ผ่าน service role อย่างระวัง. ได้ความปลอดภัยระดับ DB โดยไม่ต้องเขียน policy มหึมาต่อทุก role

---

## จุดที่ 6 — Anonymity / Visibility ของ feedback

**ตัวเลือก**
- **A. เก็บ 2 ชุดข้อมูล (identified copy + anonymized copy)** — ซ้ำซ้อน, sync ยาก
- **B. เก็บชุดเดียว + ควบคุมการมองเห็นด้วย DB views/RLS ตามบทบาท** — ผู้ถูกประเมินเห็นผ่าน view ที่ตัด PII/ชื่อ; Admin เห็น raw ผ่านสิทธิ์เฉพาะ + audit
- **C. คุมที่ application layer ตอน render** — เสี่ยงลืม, PII หลุดผ่าน API

| เกณฑ์ | A 2 ชุด | B View/RLS ชั้นเดียว | C App render |
|---|---|---|---|
| ความถูกต้อง/ปลอดภัย | เสี่ยง sync หลุด | ดีสุด (บังคับที่ DB) | เปราะ |
| ดูแลรักษาง่าย | ยาก | ดี | ปานกลาง |
| ตรวจสอบได้ (audit) | ยาก | ดี (Admin เข้าถึงตัวตน=log) | ยาก |
| ความเสี่ยง | ข้อมูลไม่ตรงกัน | ออกแบบ view ให้ครบ | PII leak |

โจทย์ระบุชัด: "ห้ามอ้าง Anonymous 100% ถ้ายังเชื่อมกลับถึงตัวบุคคลได้" และ Admin เข้าถึงตัวตนได้ในกรณีร้องเรียน → โมเดลคือ **pseudonymous มีชั้นการมองเห็น** ไม่ใช่ anonymous จริง

**✅ แนะนำ: B** — เก็บชุดเดียว(identified) + สร้าง **view ตามบทบาท**: `v_feedback_for_evaluatee` (ตัดชื่อ/PII, เห็นเฉพาะคะแนน+ข้อความ redacted ของตัวเอง), Admin เข้า raw ผ่าน role เฉพาะและ **ทุกครั้งลง audit_log**. บังคับด้วย RLS/view ที่ DB สอดคล้องกับจุดที่ 5. แจ้ง visibility model นี้ใน PDPA consent ให้โปร่งใส

---

## Tech Stack ที่เสนอ
- **Frontend/Backend**: Next.js (App Router) + TypeScript + Tailwind, mobile-first, Thai-first, LIFF SDK
- **DB/Auth**: Supabase Postgres + RLS + Storage; UUID, soft delete, versioned survey schema
- **Deploy**: Vercel (Dev/Preview/Prod แยก env ผ่าน Vercel CLI)
- **Queue/Scheduler**: Vercel Cron + Postgres `job_queue` (แยก notification/ai)
- **AI**: OpenAI ผ่าน `AIProvider` interface + json_schema + Zod validation + PII redaction + guardrail
- **LINE**: Messaging API (webhook+Flex/Push) + LIFF host ใน Next.js
- **Validation**: Zod (survey answers, AI output, API input)

## ผังสถาปัตยกรรมคร่าวๆ
```
[ลูกค้า] → LINE OA (Rich Menu/Flex/QR)
   │ open LIFF
   ▼
Next.js on Vercel ─── /liff/survey (render จาก versioned JSON schema + conditional logic)
   │                      │ submit
   │                      ▼
   ├─ /api/line/webhook → verify sig → enqueue → 200
   ├─ /api/survey/*    → เขียน survey_responses/answers (RLS)
   │                      │ enqueue ai-analysis
   ▼                      ▼
[Vercel Cron] ── ดึง job_queue ── worker endpoints
   ├─ notification worker → Messaging API (ส่งตามรอบ A/B/C/D, กันส่งซ้ำ)
   └─ ai-analysis worker  → AIProvider(OpenAI) → ai_feedback_analysis
                                   │ ถ้า High/Critical → complaint_cases + แจ้งเตือน (มนุษย์ตรวจก่อนตอบ)
   ▼
Supabase Postgres (RLS + views ชั้นการมองเห็น) ← Dashboard (7 บทบาท) อ่านผ่านสิทธิ์
Audit Log ครอบทุก action สำคัญ (แก้คะแนน/Admin เข้าถึงตัวตน/ส่งแบบประเมิน)
```

## ไอเดียเสริม
- **ทำตอนนี้ (MVP)**: cron health-check + last-run alert (มีบทเรียน cron เงียบ), auto-save คำตอบ LIFF (กันเน็ตหลุด/ตาม UX ในโจทย์), idempotency key กันส่งแบบประเมินซ้ำในรอบเดียว, แสดงคะแนนคู่ Response Rate+Sample Size เสมอ (anti-bias)
- **ทำทีหลัง (Phase ถัดไป)**: Form-builder UI (อัปเกรดจากจุดที่ 1), สลับเป็น QStash เมื่อ volume โต, Testimonial consent flow, เทียบ trend ข้ามไตรมาสเชิงลึก

---

## สรุปคำแนะนำสุดท้าย (จุดละ 1 บรรทัด)
1. **Survey Engine**: versioned JSON schema ใน DB + render engine กลาง (ยังไม่ทำ builder UI) — ยืดหยุ่นตามข้อบังคับ versioning โดยไม่ over-engineer
2. **Scheduler/Jobs**: Vercel Cron + Postgres queue table (แยก notification/ai) + health-check — เข้า House Stack, ไม่เพิ่ม vendor, เตรียมสลับ QStash ทีหลัง
3. **AI Provider**: interface `AIProvider` (OpenAI default) + json_schema + Zod validation + redact PII + guardrail ห้ามรับปากชดเชย
4. **LINE**: webhook + LIFF รวมใน Next.js app เดียว, pattern "ack 200 เร็ว → async worker"
5. **Multi-tenant/RBAC/RLS**: Hybrid — RLS บังคับ tenant isolation+ownership ที่ DB, RBAC เชิงฟีเจอร์ทำ application layer
6. **Anonymity/Visibility**: เก็บชุดเดียว + views ตามบทบาท (pseudonymous, Admin เข้าถึงตัวตนได้พร้อม audit) — สอดคล้อง PDPA ในโจทย์
