# NOVA Customer Experience System (nova-cx)

ระบบวัด/ติดตามคุณภาพบริการ (CX) ของ **Finovas Accounting** ผ่าน **LINE OA + LIFF + AI**
ลูกค้าตอบแบบประเมินผ่าน LINE → AI "น้อง NOVA" สรุป/จัดระดับความเร่งด่วน → เปิดเคส + แจ้งเตือนทีม → Dashboard/Report แยกสิทธิ์ตามบทบาท

- **Prod:** https://nova-cx.vercel.app
- **Repo:** https://github.com/pawaritkm-bit/nova-cx
- **Stack:** Next.js 15 (App Router) + TypeScript + Tailwind · Supabase (Postgres + RLS + Auth) · Vercel (+ Cron) · OpenAI

> เอกสารนี้เขียนสำหรับ "นักพัฒนา/ผู้ดูแลระบบคนต่อไป" — สะท้อนโค้ดจริงในโปรเจกต์
> เอกสารออกแบบเชิงลึก (Phase 1–3): `docs/00-brief.md` … `docs/03-roadmap.md`
> เอกสารเทคนิค: [`docs/architecture.md`](docs/architecture.md) · [`docs/setup.md`](docs/setup.md) · [`docs/api.md`](docs/api.md)

---

## ระบบทำอะไรได้

- **2 LINE OA**
  - **Care** = แบบประเมิน **A** (สำนักงาน / ราย 3 เดือน — ส่งเข้ากลุ่ม LINE) + **B** (นักบัญชี / รายเดือน — แชตส่วนตัว)
  - **Sale** = แบบประเมิน **C** (เซลขายได้/Won) + **D** (เซลขายไม่ได้/Lost) — แชตส่วนตัว
- **แบบประเมิน 4 แบบ (A/B/C/D)** เป็น **versioned JSON** + conditional question (คะแนน 4–5 ถามจุดเด่น / 3 ถามจุดปรับปรุง / 1–2 หาสาเหตุ + ขอติดต่อกลับ) + validate ทั้ง client และ server (Zod)
- **ส่งอัตโนมัติจากสถานะจริง** ผ่าน Vercel Cron + `job_queue` (idempotent, กันบิดเบือนคะแนน) — พนักงานเลือกส่งเองไม่ได้
- **AI น้อง NOVA**: redact PII → OpenAI (structured JSON) → Zod validate → guardrail → เปิดเคสถ้า High/Critical (human-in-the-loop)
- **Dashboard 7 บทบาท** (executive / acc_lead / accountant / sales_lead / sales / cs / admin) อ่านผ่าน view ชั้นการมองเห็น — นักบัญชี/เซลไม่เห็นชื่อลูกค้า
- **Admin**: จัดการ user / team / employee / customer / assignment (effective-dated)
- **Integration กับ NOVA Sales**: เปิดลูกค้า / ปิดดีล (Won/Lost) → upsert + ยิงแบบประเมินเซลอัตโนมัติ
- **PDPA**: consent ก่อนเริ่ม, pseudonymity (ไม่ใช่ anonymous 100%), audit append-only, PII เข้ารหัส

---

## ความต้องการของระบบ

| อย่าง | เวอร์ชัน / หมายเหตุ |
|---|---|
| Node.js | 18.18+ (แนะนำ 20 LTS — Next.js 15) |
| Next.js / React / TS | 15 (App Router) / 19 / 5.7 |
| Tailwind CSS | 3.4 |
| Supabase | Postgres + RLS + Auth (โปรเจกต์ + `supabase` CLI) |
| OpenAI | API key (ทางเลือก — ไม่มีก็รันได้ AI จะ skip อย่างสุภาพ) |
| Vercel | deploy + Cron (prod) |

Dependencies หลัก (`package.json`): `@supabase/ssr`, `@supabase/supabase-js`, `next`, `react`, `zod`
Dev/test: `vitest`, `pg`, `dotenv`, `eslint`, `tailwindcss`

---

## ติดตั้งและรัน (local)

```bash
# 1) ติดตั้ง dependencies
npm install

# 2) สร้างไฟล์ env จากตัวอย่าง แล้วเติมค่า (รายละเอียดใน docs/setup.md)
cp .env.example .env.local

# 3) เตรียม Supabase (ติดตั้ง supabase CLI + login แล้ว)
supabase link --project-ref <PROJECT_REF>
supabase db push            # apply migrations 0001–0028
# (ทางเลือก) รีเซ็ต + seed demo data:
supabase db reset --linked  # รัน migrations + supabase/seed.sql

# 4) รัน dev server
npm run dev                 # http://localhost:3000
```

คำสั่งอื่น (จาก `package.json`):

```bash
npm run build       # next build
npm run start       # next start (หลัง build)
npm run lint        # eslint (สแกนเฉพาะ app/ + lib/)
npm run typecheck   # tsc --noEmit
npm test            # vitest run  (ดู docs/setup.md เรื่อง DATABASE_URL สำหรับ DB test)
```

> ระบบออกแบบให้ **degrade อย่างสุภาพ**: ถ้ายังไม่ตั้ง env (Supabase/OpenAI/LINE) แอปจะไม่ crash —
> `GET /api/health` ตอบ `degraded`, worker/cron จะ skip, หน้า LIFF เข้าโหมด dev

---

## โครงสร้างโปรเจกต์ (ย่อ)

```
app/                       # Next.js App Router
├─ page.tsx  layout.tsx    # หน้าแรก + layout
├─ login/  auth/logout/    # เข้า/ออกระบบ (Supabase Auth — พนักงาน)
├─ dashboard/              # Dashboard ตามบทบาท (server-rendered)
├─ admin/                  # จัดการ master data (admin/executive)
├─ liff/survey/[token]/    # LIFF แบบประเมินลูกค้า (มือถือ)
└─ api/                    # Route Handlers (ดู docs/api.md)
   ├─ health/  survey/{template,submit}/  liff/survey/[token]/
   ├─ line/webhook/[oa]/   dashboard/[role]/   reports/export/
   ├─ integrations/nova-sales/{customer,deal-status}/
   └─ cron/{scan-invitations,process-ai,process-notifications,health-ping}/

lib/                       # โดเมนลอจิก (pure/testable + inject deps)
├─ env.ts  http.ts  pdpa.ts  health.ts
├─ supabase/               # client(browser) + server + service-role
├─ auth/                   # guard เส้นทาง + login/session
├─ survey/                 # schema/conditional/scoring/submit/token/service/steps
├─ ai/                     # redact→prompt→provider(OpenAI)→schema→guardrail→worker→case
├─ scheduling/             # engine + eligibility (cron scan)
├─ line/                   # signature/webhook/events/routing/notify/messages/client
├─ dashboard/              # queries/aggregate/redact/sample-size/session/sla
├─ admin/                  # guard + service (write path) + schema
├─ integrations/           # nova-sales (contract + service)
└─ reports/                # csv + build report

supabase/
├─ migrations/0001…0028_*.sql   # schema + RLS + views + RPC (ดู docs/setup.md)
└─ seed.sql                     # demo: 1 tenant, 7 roles, template A/B/C/D

tests/                     # vitest (unit + DB-integration; ดู docs/setup.md)
middleware.ts              # refresh session + guard /dashboard,/admin
vercel.json                # Vercel Cron (4 ตัว) + function maxDuration
next.config.mjs            # security headers (LIFF ยกเว้น X-Frame-Options)
docs/  prototype/          # เอกสารออกแบบ + ต้นแบบ HTML (Gate 2)
```
