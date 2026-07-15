# 01-analysis.md — บทวิเคราะห์เชิงลึก NOVA Customer Experience System

## 0. บริบท
โปรเจกต์ใหม่ (greenfield) มีแค่ `docs/00-brief.md`, `README.md`, `.env.example` — ยังไม่มีโค้ด จึงเป็น **โหมดสร้างใหม่** ไม่ต้องทำ Impact Analysis กับระบบเดิม แต่ต้อง reuse ความรู้/แพทเทิร์นจากตระกูล NOVA (nova-sales, nova-video, CIS) และ House Stack เดิม

Stack ที่ยืนยันจาก `.env.example`: Supabase + LINE OA/LIFF + OpenAI + `CREDENTIAL_ENC_KEY` (immutable ตาม memory)

---

## 1. Feasibility — ทำได้บน House Stack หรือไม่

**สรุป: ทำได้ทั้งหมด แต่มี 4 จุดที่ต้องออกแบบรอบคอบ (ไม่ใช่ blocker แต่เป็น design constraint)**

| ด้าน | ทำได้? | ข้อควรระวัง |
|---|---|---|
| Next.js + Supabase + Vercel + OpenAI | ได้ | เป็นแพทเทิร์นที่ทีมทำมาแล้ว 3 โปรเจกต์ |
| LINE OA / Messaging API / LIFF | ได้ | LIFF ต้อง HTTPS, endpoint = หน้าเว็บบน Vercel; webhook ต้อง verify signature |
| แบบประเมิน 4 ประเภท + conditional | ได้ | เป็น dynamic form engine ธรรมดา |
| AI สรุป/จัดระดับ | ได้ | ต้อง structured output + guardrails (ดูข้อ 2.5) |
| RBAC 7 บทบาท + RLS | ได้ | policy ซับซ้อนสุดของงาน (ดูข้อ 2.7) |

### จุดที่ต้องระวังเป็นพิเศษบน Serverless

**1.1 Vercel Cron granularity**
- Cron ของ Vercel รับประกัน "ยิงใกล้เวลาที่ตั้ง" แต่ **ไม่รับประกันความแม่นยำระดับนาที** และบน **Hobby จำกัดวันละครั้ง / จำนวน job น้อย** → prod ต้องใช้ **Pro plan**
- งานนี้ไม่ต้องการความถี่สูง (รอบ 3 เดือน/รายเดือน) → **cron รายวันครั้งเดียวพอ** ("นาฬิกาปลุกรายวัน") ให้ cron แค่ทำหน้าที่ scan หา invitation ที่ถึงกำหนด แล้ว enqueue — ไม่ผูก business logic ไว้กับตัว cron
- ห้ามพึ่ง cron ยิงตรงเป๊ะ: ต้องคิด logic แบบ **idempotent** (ยิงซ้ำ/พลาดรอบแล้วไล่เก็บทีหลังได้) — บทเรียน CIS เตือนแล้วว่า cron อาจไม่ยิง

**1.2 Background queue บน serverless**
- Serverless ไม่มี worker ที่รันตลอด → ห้ามทำ in-memory queue
- แนะนำ **queue table ใน Postgres** (survey_invitations/notification_jobs สถานะ `pending`→`processing`→`sent`/`failed`) + cron/route ดึงมาประมวลผลเป็น batch + **retry with backoff** + `max_attempts`
- งาน AI ที่นานเกิน timeout function (Pro default 60s, ขยายได้ถึง ~300s) → แตกเป็น job async ห้ามทำ inline ตอน webhook ตอบ (webhook LINE ต้องตอบ 200 ภายในไม่กี่วินาที)

**1.3 LINE Webhook + timeout**
- Webhook ต้องตอบเร็ว → รับ event แล้ว enqueue ทันที ไม่ประมวลผลหนักใน request เดียว
- ต้อง verify `x-line-signature` ทุก request (กัน spoof)

**1.4 LIFF constraints**
- LIFF init/`liff.login()` ต้องมีเน็ต — offline เต็มรูปแบบทำไม่ได้ตอนเปิดครั้งแรก
- แต่ "เน็ตหลุดไม่หายคำตอบ" ทำได้ด้วย **auto-save ลง localStorage/IndexedDB** ระหว่างกรอก แล้ว sync เมื่อเน็ตกลับ (ดูข้อ 2.6)
- In-app browser ของ LINE มีข้อจำกัดบางอย่าง → ทดสอบบนอุปกรณ์จริงทั้ง iOS/Android

---

## 2. Hard Problems — จุดออกแบบที่ยากและสำคัญ

### 2.1 Temporal Binding (ผูก feedback กับผู้ดูแล ณ เวลาที่เกิดบริการจริง) ★อันตราย
**ปัญหา:** ถ้าเก็บแค่ "ลูกค้า X ดูแลโดยนักบัญชี Y" แบบ current-state พอ Y ย้ายทีม/เปลี่ยนคนดูแล คะแนนเก่าจะถูกโยงผิดคน → ประเมินผลงานผิด, ไม่เป็นธรรม

**แนวทาง:**
- ตาราง **`customer_assignments`** เก็บเป็น **history แบบ effective-dated**: `customer_id, employee_id, role (lead/member/coordinator), team_id, valid_from, valid_to (null=ปัจจุบัน)`
- ทุก `survey_invitation` ต้อง **snapshot** ผู้ดูแล ณ วันที่ trigger — ไม่ resolve ตอน query
- `employee_evaluations` อ้าง employee_id จาก snapshot นั้น ไม่ใช่ current assignment
- Form B ให้ลูกค้าเลือกจาก **รายชื่อผู้ดูแลช่วงเวลานั้น** (พร้อมรูป/ชื่อเล่น) + ตัวเลือก "จำไม่ได้ว่าใครดูแล"
- Query dashboard คิดคะแนนตาม employee_id ที่ snapshot ไว้เสมอ

### 2.2 Anti-gaming / กันบิดเบือนคะแนน ★อันตราย
**ปัญหา:** พนักงานเลือกส่งเฉพาะลูกค้าที่พอใจ / แก้-ลบคำตอบ / ยิงซ้ำเพื่อดันคะแนน

**แนวทาง:**
- **ส่งอัตโนมัติจากสถานะจริง** — ไม่ให้พนักงานตัดสินว่าจะส่งใคร; ปุ่ม "ส่งด้วยตนเอง" ต้อง log + คุม eligibility เดียวกัน
- **Unique constraint** ระดับ DB: `unique(customer_id, survey_type, campaign_cycle)`
- คำตอบลูกค้า **แก้ไม่ได้/ลบไม่ได้** โดยพนักงาน; ลูกค้าแก้เองได้เฉพาะในหน้าต่างเวลาที่กำหนด + เก็บ version history (append-only)
- **audit_logs** ทุก action (immutable, append-only), soft-delete เท่านั้น
- ตรวจ anomaly: อัตราส่ง/ตอบผิดปกติ, คะแนนกระจุกตัว, ดีลเดียวส่งซ้ำ → flag
- Dashboard **แสดงคะแนนคู่กับ Response Rate + Sample Size เสมอ**; sample น้อยห้ามสรุป "ดีสุด/แย่สุด"

### 2.3 Anonymity model (ชั้นการมองเห็น) ★อันตราย (legal + trust)
**ปัญหา:** ระบบเชื่อมกลับถึงตัวลูกค้าได้เสมอ → **ห้ามโฆษณา Anonymous 100%** (brief สั่งชัด)

**แนวทาง — visibility layers 3 ชั้น:**
1. **ผู้ถูกประเมิน (นักบัญชี/เซล):** เห็นเฉพาะคะแนน+ข้อความ **ไม่เห็นชื่อลูกค้า** (แม้ลูกค้าเลือก "ระบุตัวตน" — ระบุตัวตน = ให้ระบบ/Admin ติดตามแก้ไขได้ ไม่ใช่ให้พนักงานเห็น)
2. **หัวหน้าทีม/ผู้บริหาร:** เห็น aggregate + เคส, ตัวตนลูกค้าเปิดเฉพาะเมื่อจำเป็นต่อการแก้เคส
3. **Admin (authorized):** เข้าถึงตัวตนได้ในเคสร้องเรียน/ความปลอดภัย — **ทุกการเปิดตัวตนต้อง log** (who/when/why)
- ลูกค้าเลือกโหมด: ระบุตัวตน (ติดตามแก้ไขได้) / จำกัดการแสดงชื่อแก่ผู้ถูกประเมิน
- ทางเทคนิค: แยก field ระบุตัวตนออกจากคำตอบ + บังคับผ่าน RLS + view เฉพาะบทบาท

### 2.4 Scheduling — กันส่งซ้ำ/ไม่ถี่เกิน บน serverless cron
**แนวทาง:**
- **แยก eligibility engine ออกจาก cron:** cron รายวันแค่ scan → คำนวณ "ใครถึงกำหนด" → สร้าง `survey_invitation` (pending) ผ่าน **idempotency key** = `hash(customer_id, survey_type, cycle_period)` + unique constraint
- **Cooldown / frequency cap ต่อลูกค้า:** คุมรวมทุกประเภท กัน A+B+C มากองวันเดียว — "global send policy" ต่อ line_user
- **Reminder ≤ 2 ครั้ง** มีระยะห่าง; หยุดเมื่อ: ประเมินแล้ว / ยกเลิกบริการ / Do-Not-Contact / block
- นักบัญชี: ไม่มี interaction เดือนนั้น → เลื่อน/ข้ามได้
- ทุกอย่าง idempotent + สถานะชัด → cron พลาดรอบแล้วรอบถัดไปเก็บตกได้

### 2.5 AI Safety
**แนวทาง (ตาม lessons.md + brief):**
- **Redact PII ก่อนส่งเข้า AI** เสมอ (เบอร์/อีเมล/เลขภาษี/ชื่อ) — hard requirement
- **Structured JSON output + schema validation** — reject ถ้าไม่ตรง schema
- Prompt บังคับ **แยก "ข้อเท็จจริงจากลูกค้า" ออกจาก "ข้อสันนิษฐาน AI"**; ทุกข้อสรุปอ้าง evidence
- **ห้าม AI สรุปว่าพนักงานผิด** — output เป็น "ประเด็นที่ควรตรวจสอบ" ไม่ใช่ "คำตัดสิน"
- keyword เสี่ยง → escalate **แต่ห้ามตัดสินจาก keyword เดี่ยว** ต้องดูบริบท
- **Human-in-the-loop บังคับ** สำหรับ High/Critical: AI ร่างได้ มนุษย์ approve ก่อนส่ง
- guardrail กันคำว่า "รับรองไม่เกิดอีก"/รับปากเงิน (system prompt + post-filter)
- ใช้ OpenAI (default)

### 2.6 Conditional logic + auto-save + offline (LIFF/mobile)
- Form engine ขับด้วย schema (question → condition → next) + เก็บ `survey_template_version` ทุกคำตอบ
- **Auto-save**: debounce เขียน localStorage/IndexedDB ทุกการเปลี่ยน + key ผูก invitation_id
- **Offline**: ตรวจ `navigator.onLine` + queue submit; Offline State; sync เมื่อ online; submit idempotent
- Logic (เช่น "ยังไม่พบปัญหา" เลือกเดี่ยว; คะแนน 1–2 เปิดคำถาม) ทำ client-side + **validate ซ้ำ server-side**
- Loading animation >5 วิ → ปุ่ม "ลองใหม่/แจ้งปัญหา"

### 2.7 RBAC + RLS (7 บทบาท + tenant isolation + scope นักบัญชี)
**แนวทาง:**
- ทุกตาราง multi-tenant มี `tenant_id` + RLS `tenant_id = auth tenant` เป็นชั้นแรก
- ชั้นสอง: **scope ตาม assignment** — นักบัญชีเห็น row ที่ `employee_id ∈ assignment ของตน ณ ช่วงเวลานั้น` (อ้าง history ไม่ใช่ current)
- แยก **พนักงาน (Supabase Auth/RBAC) กับ ลูกค้า (LINE Login)** เป็นคนละ auth domain — ลูกค้าเข้าได้เฉพาะ invitation ของตน (token ผูก invitation)
- "ซ่อนชื่อลูกค้าจากผู้ถูกประเมิน" ทำที่ view/column-level ไม่ใช่แค่ frontend
- ใช้ **security definer functions + views ต่อ role** ลดความซับซ้อน policy; เขียน permission matrix ครบก่อน + test RLS ทุก role

---

## 3. Top Risks

| # | ความเสี่ยง | ผลกระทบ | โอกาสเกิด | Mitigation |
|---|---|---|---|---|
| R1 | RLS/scope ผิด → เห็นข้อมูลลูกค้าคนอื่น/ชื่อที่ควรซ่อน | สูง (PDPA+trust) | กลาง | permission matrix ก่อนโค้ด, view ต่อ role, test RLS ทุกบทบาท, deny-by-default |
| R2 | Temporal binding ผิด → คะแนนโยงผิดคนหลังย้ายทีม | สูง (ไม่เป็นธรรม) | กลาง-สูง | assignment history + snapshot ตอน invitation |
| R3 | อ้าง "Anonymous 100%" แต่ trace กลับได้ | สูง (legal) | กลาง | ห้ามใช้คำ anonymous 100%, PDPA notice โปร่งใส, visibility layers + log |
| R4 | PII รั่วเข้า AI / AI ตัดสินผิด/รับปากเงิน | สูง | กลาง | redact, structured output, แยกข้อเท็จจริง/สันนิษฐาน, human-in-the-loop, guardrail |
| R5 | ส่งซ้ำ/ถี่เกิน → ลูกค้า **Block LINE OA** | สูง | สูง | idempotency key + frequency cap รวมทุกประเภท, reminder ≤2, หยุดเมื่อ block/DNC, track block rate |
| R6 | Vercel cron ไม่ยิง/ช้า → invitation ไม่ออกตามรอบ | กลาง | กลาง | logic idempotent+เก็บตก, Pro plan, health check + alert (บทเรียน CIS) |
| R7 | Response rate ต่ำ/sample น้อย → สรุปไม่น่าเชื่อถือ | กลาง | สูง | แสดง sample size+response rate, ห้ามสรุปที่ sample น้อย, threshold ขั้นต่ำ |
| R8 | Duplicate submit ตอนเน็ตหลุดบน LIFF | กลาง | กลาง | idempotent submit (invitation_id+client token), auto-save local |
| R9 | Do-Not-Contact ไม่หยุด automation ทันเวลา | สูง (legal) | ต่ำ-กลาง | flag DNC ตรวจใน send policy ทุกครั้งก่อนยิง |
| R10 | CREDENTIAL_ENC_KEY ตั้งผิด/หาย → ถอด credential ไม่ได้ | สูง | ต่ำ | ตั้งครั้งเดียว เก็บปลอดภัย ห้ามเปลี่ยน (memory), เก็บนอก repo |
| R11 | Webhook signature ไม่ verify → spoof | กลาง | ต่ำ | verify x-line-signature ทุก request, rate limit |
| R12 | Scope creep (4 ฟอร์ม, dashboard 7 role, AI, mascot) | สูง (delivery) | สูง | คุม MVP scope เข้ม, เฟสชัด, gate อนุมัติก่อนโค้ด |

---

## 4. โหมดทีมที่แนะนำ

**แนะนำ: โหมดเต็มรูปแบบ (Full)** — เพิ่ม Security reviewer + QC gate เข้ม

เหตุผล:
1. ความเสี่ยง PDPA/legal สูง (ข้อมูลลูกค้าจริง, ตัวตน, การประเมินที่กระทบการจ้างงาน)
2. RLS/RBAC 7 บทบาท + tenant isolation + temporal scope ผิดพลาดง่าย ผลกระทบรุนแรง
3. AI safety ต้อง human-in-the-loop + guardrail ที่ตรวจสอบได้
4. ผู้ว่าจ้างกำหนด process 5 เฟส + deliverable 20 รายการ + gate อนุมัติก่อนโค้ด
5. ระบบใหญ่ ~40 ตาราง, 4 ฟอร์ม, dashboard หลายบทบาท → ไม่เหมาะโหมดเร็ว
