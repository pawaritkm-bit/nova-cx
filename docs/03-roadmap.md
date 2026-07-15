# 03-roadmap.md — NOVA-CX แผนพัฒนา (Phase 3)

> อ้างอิง `docs/02-design.md` + `docs/01-arch-options.md` · ยึด House Stack + ข้อห้าม C-01..C-16
> ลำดับความสำคัญ: **MVP** = ต้องมีในเฟส 4 · **Later** = เลื่อนไป Phase ถัดไป

---

## 1. Epics + User Stories + Acceptance Criteria

### E1 — Foundation: Auth + RBAC + RLS + Multi-tenant `[MVP]`
- **US:** ในฐานะ Admin ต้อง login (Supabase Auth) และเห็นเฉพาะข้อมูล tenant ตน; แต่ละ role เห็น scope ตามสิทธิ์
- **AC:** RLS บังคับ `tenant_id` ทุกตาราง (deny-by-default) · 7 role มี permission ตาม Permission Matrix · ลูกค้า (LINE) แยก auth domain จากพนักงาน · test ข้าม-tenant/ข้าม-scope ไม่รั่ว
- **DoD:** migration RLS ครบ + permission test ทุก role ผ่าน + type/lint/build ผ่าน

### E2 — Data Model: Migration + Seed (temporal binding) `[MVP]`
- **US:** ในฐานะทีม ต้องมีสคีมา ~40 ตารางพร้อม assignment history + snapshot
- **AC:** UUID/soft delete/tenant_id ทุกตาราง · `customer_assignments` effective-dated · `UNIQUE(customer_id,survey_type,cycle_period)` · seed demo (1 คน/role, ลูกค้า/ดีลตัวอย่าง)
- **DoD:** `supabase db reset` รันผ่าน + seed ครบ + ERD ตรงกับ migration

### E3 — Survey Engine (versioned JSON + render + conditional) `[MVP]`
- **US:** ในฐานะลูกค้า เปิดแบบประเมินที่ auto-fill, ให้คะแนน, เจอ follow-up ตามคะแนน; ในฐานะทีม แก้ฟอร์มผ่าน seed/migration
- **AC:** 4 ฟอร์ม A/B/C/D เป็น versioned JSON · conditional (4-5/3/1-2 + topic follow-up) · "ยังไม่พบปัญหา" เลือกเดี่ยว · validate client + server (Zod) · เก็บ survey_template_version ทุกคำตอบ
- **DoD:** conditional test + duplicate submit test ผ่าน · Form-builder UI = `[Later]`

### E4 — LINE OA / LIFF Integration `[MVP]`
- **US:** ในฐานะลูกค้า กดจาก Rich Menu/Flex เปิด LIFF ตอบได้ทันที เฉพาะของตน
- **AC:** webhook verify signature → enqueue → 200 · Rich Menu 6 เมนู · Flex/Push invitation · LIFF host + LINE Login · invitation token ผูก line_user + หมดอายุ + single-use · Loading animation (>5s fallback)
- **DoD:** webhook signature test + token access test (คนอื่นเปิดไม่ได้) ผ่าน + ทดสอบบนมือถือจริง iOS/Android

### E5 — Scheduling + Queue (cron idempotent) `[MVP]`
- **US:** ในฐานะระบบ ส่งแบบประเมินอัตโนมัติจากสถานะจริง ถูกประเภท/คน/ไม่ซ้ำ
- **AC:** Vercel Cron รายวัน scan → eligibility → สร้าง invitation idempotent (idempotency_key) · A ทุก 3 เดือน, B รายเดือน, C หลัง Won 1–3 วัน, D หลัง Lost · frequency cap รวมทุกประเภท · reminder ≤2 · หยุดเมื่อประเมินแล้ว/ยกเลิก/DNC/block · job_queue retry+backoff+dead_letter · cron_health + alert
- **DoD:** scheduling test (รวมเปลี่ยนทีม, Won→Cancelled) + duplicate/idempotency test ผ่าน · QStash = `[Later]`

### E6 — AI Analysis (น้อง NOVA) `[MVP]`
- **US:** ในฐานะหัวหน้าทีม เห็นสรุป AI ที่แยกข้อเท็จจริง/สันนิษฐาน + จัดระดับเร่งด่วน + ร่างตอบ
- **AC:** pipeline redact→prompt→json_schema→Zod→retry/fallback · output มี customer_facts/ai_assumptions/evidence/sentiment/urgency/next_best_action/draft_reply/confidence · guardrail C-01..C-04 · High/Critical → needs_human_review · provider สลับได้ (OpenAI default)
- **DoD:** AI-safety test (ไม่รับปากชดเชย, ไม่ตัดสินพนักงาน, keyword+บริบท, PII redacted) + schema validation test ผ่าน

### E7 — Case Management `[MVP]`
- **US:** ในฐานะ CS จัดการเคสตั้งแต่เปิด→ปิด พร้อม SLA/activity/CSAT หลังแก้
- **AC:** เปิดเคสอัตโนมัติ (คะแนนต่ำ/ขอยกเลิก→Retention/ขอเปลี่ยนผู้ดูแล→ตรวจหัวหน้า/keyword) · Case ID/เจ้าของ/level/SLA/status 8 สถานะ/activity/resolution/closed/post-CSAT · ลูกค้าตรวจสถานะผ่าน Rich Menu
- **DoD:** case lifecycle test + reopen test ผ่าน

### E8 — Notification / Escalation `[MVP]`
- **US:** ในฐานะผู้บริหาร/หัวหน้า ได้รับแจ้งเตือนตามระดับภายใน SLA
- **AC:** Critical→ผู้บริหาร+หัวหน้าฝ่ายทันที · High→หัวหน้าทีมวันเดียวกัน · Medium→Task · Positive→เก็บ · notification_logs + retry · notifier pluggable (LINE push + Email + Dashboard) · DNC หยุด automation
- **DoD:** notification routing test + DNC test + retry test ผ่าน

### E9 — Dashboard (7 บทบาท) `[MVP บางส่วน]`
- **US:** แต่ละบทบาทเห็น dashboard ตามสิทธิ์ พร้อม Response Rate + Sample Size
- **AC:** exec/lead/accountant/sales-lead/sales/cs views · นักบัญชี/เซลล์ไม่เห็นชื่อลูกค้า · แสดง Sample Size, sample น้อยไม่สรุป "ดี/แย่สุด" · อ่านผ่าน view ชั้นการมองเห็น
- **DoD:** permission/visibility test ทุก role ผ่าน · dashboard เชิงลึก/เทียบ trend ข้ามไตรมาส = `[Later]`

### E10 — Reports + Export `[MVP บางส่วน]`
- **US:** ในฐานะผู้บริหาร export รายงานตามตัวกรอง/สิทธิ์
- **AC:** รายงานรายเดือน/ไตรมาส/ทีม/พนักงาน/บริการ/Lost/เสี่ยงยกเลิก · filter ครบ · Export CSV/XLSX/PDF ตามสิทธิ์
- **DoD:** export test + permission test ผ่าน · PDF สวยงาม/Testimonial report = `[Later]`

### E11 — PDPA / Consent / Audit `[MVP]`
- **US:** ในฐานะลูกค้า เห็น consent ก่อนเริ่ม + ใช้สิทธิ; ในฐานะ Admin เปิดตัวตนได้พร้อม log
- **AC:** consent ก่อนเริ่ม (FR-PD-01) · consent_records + policy_version · visibility layers (pseudonymous ไม่ใช่ anonymous 100%) · redact PII ก่อน AI · audit append-only · Admin เปิดตัวตน→audit · retention policy (3/5 ปี anonymize)
- **DoD:** PDPA test (consent gate, redact, visibility) + audit immutability test ผ่าน

### E12 — DevOps / Monitoring `[MVP]`
- **US:** ในฐานะทีม deploy แยก env + monitor cron/error/delivery
- **AC:** Vercel Dev/Preview/Prod แยก env (Vercel CLI) · secret ผ่าน .env/.env.example · health check + cron last-run alert · error log + delivery status + failed job retry + rate limit
- **DoD:** health endpoint + cron alert ทำงาน · CI type/lint/test/build ผ่าน

### E13 — QA / Testing `[MVP]`
- **US:** ในฐานะ Tester มีชุดเทสต์ครอบเส้นทางหลัก + เคสพิเศษ
- **AC:** ครอบ unit/integration/e2e/permission/webhook/duplicate/scheduling/conditional/pdpa/mobile/thai/slow-net/offline/ai-safety + 4 เคสพิเศษ
- **DoD:** ทุกชุดผ่าน, ไม่มี mock ใน critical flow ตอนรายงานเสร็จ

---

## 2. Development Roadmap (Milestones)

| Milestone | เนื้อหา | Epics | พึ่งพา |
|---|---|---|---|
| **M1 — โครงหลักรันได้** | Next.js+Supabase+Vercel setup, Auth+RBAC+RLS, migration+seed, health check | E1, E2, E12 | — |
| **M2 — Survey เดินได้ end-to-end** | Survey engine (versioned JSON+conditional), LIFF+LINE Login+webhook+Rich Menu, submit+consent | E3, E4, E11(consent) | M1 |
| **M3 — ส่งอัตโนมัติ + คิว** | Cron+queue idempotent, scheduling 4 ประเภท, notification worker, delivery log | E5, E8(pipeline) | M2 |
| **M4 — AI + Case + Escalation** | AI analysis (guardrail+schema), เปิดเคสอัตโนมัติ, routing+SLA, human-in-the-loop | E6, E7, E8 | M3 |
| **M5 — Dashboard + Report + PDPA เต็ม** | Dashboard 7 บทบาท (view+Sample Size), reports+export, audit, visibility layers, retention | E9, E10, E11 | M4 |
| **M6 — QA + ขัดเกลา** | เทสต์ครบทุกชุด + 4 เคสพิเศษ, mobile จริง, ขัดเกลา UX/mascot/loading | E13 (+ทุก epic) | M5 |

> **MVP = M1–M6** (ครอบ PHASE 4 ในโจทย์) · Later items กระจายใน epic ข้างต้น

---

## 3. Testing Plan Mapping

| ชนิดเทสต์ | ครอบคลุม | Epic |
|---|---|---|
| Unit | survey engine, scoring, redact, Zod schema, guardrail filter | E3,E6 |
| Integration | submit→AI→case→notify, cron→invitation | E5,E6,E7,E8 |
| E2E | ลูกค้ารับ invitation→ตอบ→confirm บน LIFF | E3,E4 |
| Permission (RLS) | 7 role × ทรัพยากร, ข้าม-tenant/scope ไม่รั่ว | E1,E9 |
| Webhook | verify signature, ack 200 เร็ว, spoof ปฏิเสธ | E4 |
| Duplicate survey | unique constraint, idempotent submit | E3,E5 |
| Scheduling | รอบ A/B/C/D, cron พลาดแล้วเก็บตก, frequency cap | E5 |
| Conditional | 4-5/3/1-2, topic follow-up, "ยังไม่พบปัญหา" เลือกเดี่ยว | E3 |
| PDPA | consent gate, redact PII, visibility layers, audit เปิดตัวตน | E11 |
| Mobile / Thai text | อุปกรณ์จริง iOS/Android, ตัดคำ/ฟอนต์ไทย | E4 |
| Slow network / Offline | auto-save, offline state, sync, >5s fallback | E3,E4 |
| AI safety | ไม่รับปากชดเชย(C-01/02), ไม่ตัดสินพนักงาน(C-03), keyword+บริบท(C-04), PII redacted(C-15) | E6 |
| **เคสพิเศษ 1** | พนักงานเปลี่ยนทีม → คะแนนเก่าโยงถูกคน (temporal binding) | E2,E5 |
| **เคสพิเศษ 2** | ลูกค้าหลายผู้ดูแล → Form B เลือกถูกคน (snapshot) | E3,E5 |
| **เคสพิเศษ 3** | Won → Cancelled → ไม่ส่ง/ปรับ flow ถูกต้อง | E5 |
| **เคสพิเศษ 4** | Do Not Contact → หยุด automation ทันที | E5,E8 |

---

## 4. Definition of Done (ต่อ Epic — สรุปรวม)

ทุก epic ต้องผ่านครบ:
1. โค้ดทำงานตาม Acceptance Criteria (ไม่มี mock ใน critical flow)
2. type check + lint + test + build ผ่านทั้งหมด
3. เทสต์ที่ map กับ epic (ตารางข้อ 3) ผ่าน
4. ไม่ละเมิดข้อห้าม C-01..C-16 ที่เกี่ยวข้อง
5. เอกสาร/README ส่วนที่เกี่ยวข้องอัปเดต
6. ผ่าน Reviewer + Tester (+ Security ในโหมดเต็ม) ก่อนเข้า QC gate
7. ไม่มี secret ในโค้ด, `.env.example` อัปเดต
