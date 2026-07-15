# NOVA Customer Experience System (nova-cx) — Requirements

> เรียบเรียงจาก docs/00-brief.md เพื่อให้ทีมออกแบบ/พัฒนาต่อ
> Source of truth ของ "โจทย์" คือ 00-brief.md — ไฟล์นี้จัดระเบียบ + ระบุจุดตัดสินใจ

## 0. สรุปโจทย์
ระบบประเมินความพึงพอใจและติดตามคุณภาพบริการของ Finovas Accounting ผ่าน LINE OA + LIFF
มี AI "น้อง NOVA" ช่วยพูดคุย เก็บแบบประเมิน 4 ประเภท (สำนักงาน/นักบัญชี/เซลล์ Won/เซลล์ Lost)
สรุปความคิดเห็น จับสัญญาณเสี่ยงยกเลิก เปิด Complaint/Retention Case แจ้งเตือนตามระดับเร่งด่วน
พร้อม Dashboard/Report แยกตามสิทธิ์ 7 บทบาท เป็น multi-tenant SaaS, ไทยเป็นหลัก, เร็วบนมือถือ, เคารพ PDPA

## 1. Functional Requirements

### 1.1 Survey Engine
- FR-SV-01 แบบประเมิน 4 ประเภท: A สำนักงาน (ทุก 3 เดือน), B นักบัญชี (รายเดือน แยกหัวหน้า/ลูกทีม/ทั้งทีม), C เซลล์ Won, D เซลล์ Lost (สั้นกว่า)
- FR-SV-02 แบบ A 6 ส่วน: ข้อมูลอ้างอิง(auto-fill), คะแนน 1–5 จำนวน 10 ข้อ, ปัญหาที่พบ(multi-select), บริการเสริม, Loyalty/NPS/แนวโน้มใช้ต่อ, การติดต่อกลับ
- FR-SV-03 แบบ B (นักบัญชี) — **แยกเป็น 2 การประเมิน (decision ผู้ใช้ 2026-07-15):**
  - **(ก) ลูกค้า → ประเมินลูกน้อง (นักบัญชีที่ดูแล):** ผ่านแบบประเมิน LINE, ระบบผูกผู้ดูแลอัตโนมัติจาก customer_assignments (snapshot ตอนส่ง invitation) — ลูกค้าไม่ต้องเลือกเอง; ประเมินเฉพาะ **ลูกทีมที่ดูแลจริงคนละ 10 ข้อ** (ตัดการให้ลูกค้าประเมินหัวหน้าทีมออก)
  - **(ข) หัวหน้าทีม → ประเมินลูกน้อง (ประเมินภายใน):** ทำใน **Dashboard/หลังบ้าน** (role หัวหน้าทีมบัญชี) ไม่อยู่ในแบบประเมินลูกค้า — เป็น performance review ภายใน; ผลเห็นใน dashboard เท่านั้น
  - หมายเหตุ data model (M2): 1 นักบัญชีมีคะแนน 2 แหล่ง (customer + team lead) แยก source ใน employee_evaluations
- FR-SV-04 แบบ C: 10 ข้อคะแนน + ปลายเปิด + เหตุผลตัดสินใจซื้อ (multi-choice)
- FR-SV-05 แบบ D: 5 คำถามหลัก + เหตุผลไม่ตัดสินใจ + สิ่งที่ปรับแล้วจะพิจารณาใหม่ + ระดับอนุญาตติดต่อ
- FR-SV-06 auto-fill ข้อมูลอ้างอิงจากฐานข้อมูล ไม่ให้กรอกซ้ำโดยไม่จำเป็น
- FR-SV-07 ตัวเลือก "ยังไม่พบปัญหา/ไม่มีปัญหา" ต้องเลือกแบบเดี่ยว
- FR-SV-08 Conditional Logic ตามคะแนน (4–5 จุดดี, 3 จุดปรับปรุง, 1–2 หาสาเหตุ+ติดต่อกลับ) + follow-up เฉพาะเรื่อง (งานผิด/ตอบช้า/ค่าใช้จ่ายไม่ชัด)
- FR-SV-09 เก็บ survey_template_version กับทุกคำตอบ
- FR-SV-10 บันทึก CSAT/NPS/CES แยกต่อข้อ + สรุประดับ

### 1.2 Scheduling
- FR-SC-00 **Trigger เริ่มต้น:** หลังลูกค้าแอด LINE OA เป็นเพื่อน → ระบบส่งแบบประเมินเข้าแชทอัตโนมัติ (เริ่มที่สำนักงาน) แล้วเข้าสู่รอบส่งอัตโนมัติต่อไป
- FR-SC-01 **สำนักงาน (A): ส่งอัตโนมัติทุก 3 เดือน (วนซ้ำ)** นับจากรอบบริการ/วันเริ่ม → **ส่งเข้า "กลุ่ม LINE" ที่มีนักบัญชี+ลูกค้าอยู่ด้วยกัน** (ประเมินภาพรวมสำนักงาน) — ต้องระบุผู้ตอบว่าเป็นลูกค้า (ไม่ใช่พนักงานในกลุ่ม) + กันพนักงานตอบแทน
- FR-SC-01b **นักบัญชี (B): ส่งอัตโนมัติทุกเดือน — ต้นเดือน (วนซ้ำ)** ประเมินลูกน้องที่ดูแลจริง → **ส่งเข้าแชตส่วนตัวลูกค้า (1:1 push) โดยตรง** (เป็นการประเมินตัวบุคคล ต้องเป็นส่วนตัว นักบัญชีไม่เห็น)
- FR-SC-02 **เซล (C/D): ส่งครั้งเดียวจบต่อ 1 ดีล (ไม่วนซ้ำ)** — C เมื่อปิดการขายได้ (Won, เว้น 1–3 วัน), D เมื่อปิด Lost/ไม่ตอบครบเกณฑ์; ห้ามส่งซ้ำในดีลเดียวกัน
- FR-SC-03 trigger จากสถานะจริงเท่านั้น ไม่ให้พนักงานเลือกส่งเอง
- FR-SC-04 เตือนซ้ำ ≤2 ครั้งมีระยะห่าง; หยุดเมื่อประเมินแล้ว/ยกเลิก/ขอไม่รับ/Do Not Contact
- FR-SC-05 กันซ้ำ 1 คำตอบต่อลูกค้า/รอบ/ประเภท และ 1 ครั้งต่อดีล
- FR-SC-06 เปลี่ยนผู้ดูแลกลางรอบ → ส่งประเมินตรงคนที่ดูแลจริงช่วงนั้น
- FR-SC-07 Queue + Scheduler + Failed Job Retry + บันทึก delivery status

### 1.3 LINE OA / LIFF
- FR-LN-00 **2 LINE OA (decision ผู้ใช้ 2026-07-15):** OA "Care" = ประเมินสำนักงาน(A)+พนักงานทีมบัญชี(B); OA "Sale" = ประเมินเซล ขายได้(C)+ขายไม่ได้(D) → ต้องมี channel credential 2 ชุด (Care/Sale ใน .env), webhook/LIFF แยกต่อ OA, และ routing ว่าฟอร์มไหนส่งผ่าน OA ไหน
- FR-LN-01 LINE Login ลูกค้า + เปิดแบบประเมินผ่าน LIFF ทันที
- FR-LN-02 ช่องทางเข้า: Rich Menu, Flex Message, LIFF, QR, แจ้งเตือนอัตโนมัติ, พนักงานส่งให้
- FR-LN-03 Rich Menu 6 เมนู (ประเมิน/แจ้งปัญหาด่วน/ติดต่อทีม/ตรวจสถานะเรื่องร้องเรียน/FAQ/PDPA)
- FR-LN-04 รับ LINE Webhook + บันทึกสถานะ block/unblock
- FR-LN-05 กันเข้าถึงแบบประเมินของคนอื่น (invitation token ผูก line_user + หมดอายุ)
- FR-LN-06 Loading Animation (นกอินทรีวิ่ง) Lottie/SVG/WebP, ข้อความสลับ, >5 วิ แสดง "ลองใหม่"+"แจ้งปัญหา"

### 1.4 AI Analysis (น้อง NOVA)
- FR-AI-01 สรุปใจความ, แยกคำชม/ปัญหา/ความต้องการ/ความเสี่ยง, จัดหมวด, Sentiment, ระดับเร่งด่วน
- FR-AI-02 ระบุพนักงาน/ทีม/บริการ/ช่วงเวลา + ตรวจปัญหาซ้ำ + เทียบคะแนนรอบก่อน
- FR-AI-03 เสนอ Next Best Action + สรุปให้หัวหน้าทีม + ร่างข้อความตอบลูกค้า
- FR-AI-04 ร่างตอบเคส High/Critical ต้องมนุษย์ตรวจก่อนส่งเสมอ
- FR-AI-05 แสดงเหตุผล+ข้อมูลที่ใช้จัดระดับ; แยก "ข้อเท็จจริงจากลูกค้า" ออกจาก "ข้อสันนิษฐาน AI"
- FR-AI-06 keyword สำคัญยกเป็นเรื่องสำคัญ แต่ห้ามตัดสินจาก keyword เดี่ยว ต้องดูบริบท
- FR-AI-07 บุคลิก: เป็นมิตร สั้นกระชับ ไม่ถามซ้ำ ไม่กดดันให้คะแนนดี ไม่เข้าข้างพนักงาน
- FR-AI-08 output = structured JSON + schema validation
- FR-AI-09 provider สลับได้ (default OpenAI); redact PII ก่อนส่งเข้า AI

### 1.5 Complaint / Case
- FR-CS-01 สร้างเคสอัตโนมัติ (คะแนนต่ำ / ขอยกเลิก→Retention Case / ขอเปลี่ยนผู้ดูแล→ตรวจโดยหัวหน้า / keyword สำคัญ)
- FR-CS-02 ทุกเคสมี Case ID, เจ้าของ, ระดับเร่งด่วน, SLA, สถานะ, บันทึกติดต่อ, วิธีแก้, วันปิด, ความพึงพอใจหลังแก้
- FR-CS-03 สถานะ: New/Acknowledged/Investigating/Waiting for Customer/In Progress/Resolved/Closed/Reopened
- FR-CS-04 ระดับ Critical/High/Medium/Positive + routing ตาม 1.6
- FR-CS-05 Positive → เก็บ + ขออนุญาต Testimonial ภายหลัง (ห้ามใช้โดยไม่ยินยอม)
- FR-CS-06 ลูกค้าตรวจสอบสถานะเรื่องร้องเรียนของตนผ่าน Rich Menu

### 1.6 Notification / Escalation
- FR-NT-01 Critical → แจ้งผู้บริหาร+หัวหน้าฝ่ายทันที
- FR-NT-02 High → แจ้งหัวหน้าทีมภายในวันทำการเดียวกัน
- FR-NT-03 Medium → สร้าง Task ติดตาม
- FR-NT-04 Positive → เก็บ Positive Feedback
- FR-NT-05 บันทึก notification_logs + retry เมื่อส่งไม่สำเร็จ
- FR-NT-06 Do Not Contact → หยุด Automation การขายทันที

### 1.7 Dashboard (แยกสิทธิ์)
- FR-DB-01 ผู้บริหาร: CSAT/NPS/CES/Response Rate/Sentiment/Critical-High Cases/ลูกค้าเสี่ยงยกเลิก/อัตรายกเลิก/คะแนนรายทีม-บริการ-รอบ/ปัญหาพบบ่อย/เวลาตอบ-ปิดเคส/เทียบทีม/trend/เคสค้าง
- FR-DB-02 นักบัญชี: คะแนนตัวเอง/แนวโน้ม/คำชม/จุดปรับปรุง/งานติดตาม — ห้ามเห็นลูกค้านอกความรับผิดชอบ
- FR-DB-03 ฝ่ายขาย: คะแนนเซลล์/Won vs Lost/เหตุผลซื้อ-ไม่ซื้อ/ความชัดเจนเสนอราคา/การรับปากเกิน — ห้ามใช้คะแนนตัวเดียวตัดสิน
- FR-DB-04 แสดงคะแนนพร้อม Response Rate + Sample Size; คำตอบน้อยห้ามสรุป "ดีสุด/แย่สุด"

### 1.8 Reports
- FR-RP-01 รายงานรายเดือน/ไตรมาส/ทีม/พนักงาน/บริการ/Lost/เสี่ยงยกเลิก/ปัญหาซ้ำ/เวลาตอบ-ปิดเคส/Testimonial
- FR-RP-02 Export CSV/XLSX/PDF ตามสิทธิ์
- FR-RP-03 ตัวกรอง: วันที่/ทีม/พนักงาน/สาขา/บริการ/ประเภทแบบ/คะแนน/Sentiment/เร่งด่วน/สถานะเคส/ใหม่-เดิม/Won-Lost

### 1.9 RBAC
- FR-RB-01 7 บทบาท: ผู้บริหาร/หัวหน้าทีมบัญชี/นักบัญชี/หัวหน้าฝ่ายขาย/เซลล์/CS/Admin
- FR-RB-02 LINE Login (ลูกค้า) แยกจาก RBAC (พนักงาน); session/token security
- FR-RB-03 บังคับสิทธิ์ระดับข้อมูล (RLS) ไม่ใช่แค่ซ่อน UI

### 1.10 PDPA
- FR-PD-01 consent ก่อนเริ่ม: วัตถุประสงค์/ประเภทข้อมูล/ผู้เข้าถึง/ระยะเวลาเก็บ/ช่องทางใช้สิทธิ/การใช้ AI/ขออนุญาตติดต่อกลับ
- FR-PD-02 consent_records + สิทธิ์ถอน/ลบ/เข้าถึง
- FR-PD-03 โหมดแสดงตัวตน: ระบุตัวตน / จำกัดการแสดงชื่อต่อผู้ถูกประเมิน
- FR-PD-04 Admin เข้าถึงตัวตนได้เฉพาะกรณีร้องเรียน/ความปลอดภัย + แจ้งลูกค้าโปร่งใส

### 1.11 Anti-gaming
- FR-AG-01 ส่งอัตโนมัติจากสถานะจริง; พนักงานห้ามเลือกส่งเฉพาะลูกค้าพอใจ
- FR-AG-02 ห้ามลบ/แก้คำตอบลูกค้า; Audit Log ทุกการกระทำ
- FR-AG-03 จำกัด 1 คำตอบ/ลูกค้า/รอบ/ประเภท; แก้ได้เฉพาะกรอบเวลา + เก็บประวัติ
- FR-AG-04 ตรวจจับการส่งซ้ำ/รูปแบบตอบผิดปกติ
- FR-AG-05 คำชม/ร้องเรียนมีน้ำหนักตรวจสอบเป็นธรรม

## 2. Non-Functional Requirements
- NFR-01 Performance บนมือถือ: LIFF+animation โหลดเร็ว, mobile-first, ใช้มือเดียว, Progress Bar, บอกเวลาประมาณ
- NFR-02 Resilience: Auto-save + กลับมากรอกต่อ, offline ไม่เสียคำตอบ, Empty/Loading/Error/Offline State
- NFR-03 Accessibility: Screen Reader + Contrast, ไม่มีคำถามชี้นำ, สเกลเรียงต่ำ→สูง
- NFR-04 ภาษาไทยเป็นหลัก (ข้อความ/รายงาน/AI output + ตัดคำ/ฟอนต์ไทย)
- NFR-05 Security: ไม่ฝัง secret ในโค้ด, เข้ารหัสข้อมูลอ่อนไหว, ห้ามเก็บ Access Token plain text, CREDENTIAL_ENC_KEY ตั้งครั้งเดียวห้ามเปลี่ยน
- NFR-06 PDPA: เก็บเท่าที่จำเป็น + consent log + redact ก่อน AI + Retention Policy
- NFR-07 Multi-tenant: RLS ทุกตาราง, UUID PK, created/updated/deleted_at (soft delete)
- NFR-08 Monitoring: Error Log/Audit Log/Delivery Status/Retry/Rate Limit/Health Check/Analytics Event
- NFR-09 Data integrity: Feedback ผูกผู้ดูแล ณ ช่วงเวลาบริการจริง (เก็บประวัติย้ายทีม/เปลี่ยนผู้ดูแล)

House Stack: Next.js(App Router)+TS+Tailwind · Supabase(Postgres+Auth+RLS+Storage) · Vercel(Dev/Preview/Prod) · OpenAI ผ่าน provider abstraction · LINE Messaging API + LIFF SDK

## 3. Explicit Constraints (ห้ามทำ)
- C-01 AI ห้ามรับปากค่าชดเชย/คืนเงิน/ลดราคา/ผลลัพธ์ แทนบริษัทอัตโนมัติ
- C-02 AI ห้ามพูด "รับรองว่าจะไม่เกิดขึ้นอีก", ห้ามวินิจฉัยข้อพิพาท, ห้ามยอมรับผิดแทนบริษัท
- C-03 AI ห้ามสรุปว่าพนักงานผิดโดยไม่มีหลักฐาน; แยกข้อเท็จจริงจากข้อสันนิษฐาน
- C-04 AI ห้ามจัดระดับเร่งด่วนจาก keyword เดี่ยว ต้องดูบริบท
- C-05 ห้ามลอกแบรนด์อื่น — Branding/UI/Mascot ออกแบบใหม่ทั้งหมด
- C-06 ห้าม Dark Pattern บังคับ/ชี้นำคะแนนดี; ห้ามคำถามชี้นำ; สเกลเรียงต่ำ→สูงชัด
- C-07 ห้ามอ้าง Anonymous 100% ถ้ายังเชื่อมกลับถึงตัวบุคคลได้
- C-08 พนักงานห้ามเลือกส่งเฉพาะลูกค้าที่พอใจ
- C-09 ห้ามลบ/แก้คำตอบลูกค้า; แก้ได้เฉพาะกรอบเวลา + เก็บประวัติ
- C-10 นักบัญชี/เซลล์ห้ามเห็นข้อมูลลูกค้านอกความรับผิดชอบ
- C-11 ห้ามใช้คะแนนพึงพอใจตัวเดียวตัดสินผลงาน
- C-12 ห้ามใช้ Positive Feedback ทำ Testimonial โดยไม่ยินยอม
- C-13 ห้ามส่งซ้ำในรอบ/ดีลเดียว; ห้ามส่งเมื่อ Do Not Contact
- C-14 ห้ามฝัง secret/key ในโค้ด; ห้ามเก็บ Access Token plain text; ห้ามเปลี่ยน CREDENTIAL_ENC_KEY
- C-15 ห้ามส่ง PII (เบอร์/อีเมล/เลขภาษี) เข้า AI โดยไม่ redact
- C-16 (Process) ห้ามเริ่ม coding ทันที — ผ่าน Phase 1–2 + รออนุมัติ Architecture ก่อน

## 4. Open Questions / จุดขาดข้อมูล (+ default)
1. Q1 มี CRM/ฐานลูกค้าเดิมให้เชื่อมไหม (เชื่อม API/import/สร้างใหม่)? → default: เฟสแรกยังไม่เชื่อม nova-cx เก็บ master data เอง + import CSV, ทำ integration layer เผื่อ
2. Q2 multi-tenant กี่ tenant/แบรนด์จริงตอนเริ่ม? → default: เริ่ม 1 tenant แต่ออกแบบ schema/RLS multi-tenant เต็มรูป
3. Q3 ปริมาณลูกค้า/invitation ต่อรอบ (sizing queue/quota)? → default: ร้อย–ต่ำพันราย, push batch+queue, เผื่อ LINE quota
4. Q4 ช่องทางแจ้งเตือนทีมภายใน (LINE Notify กำลังปิด)? → default: LINE Messaging API push + Email fallback + Dashboard notification center, ทำ notifier แบบ pluggable
5. Q5 มี LINE OA/LIFF channel จริงแล้วหรือยัง, OA เดียวหรือแยก? → default: เฟสพัฒนาใช้ dev channel; OA ลูกค้า 1 + ช่องแจ้งเตือนภายในแยก; ผู้ใช้เติม env ผ่าน CLI
6. Q6 map คน→role จริง + โครงสร้างทีมหัวหน้า-ลูกทีม? → default: RBAC 7 role ตาม brief + หน้า Admin จัดการ user/role/team + seed 1 คน/role
7. Q7 Data Retention กี่ปี + นโยบายลบ/anonymize? → default: survey/case 3 ปี, audit/consent 5 ปี, ครบกำหนด anonymize แทน hard delete (รอยืนยันตามกฎหมายบัญชี)
8. Q8 AI model/งบ/privacy — ส่งข้อมูลออก OpenAI ได้ไหม/ต้องการ region? → default: OpenAI ผ่าน abstraction + redact PII, สลับ provider ได้
9. Q9 ตัวเลข SLA จริงแต่ละระดับ + เวลาทำการ? → default: Critical ทันที+ตอบใน 4 ชม.ทำการ, High ในวันเดียวกัน, Medium 3 วันทำการ, เวลาทำการ จ-ศ 9:00–18:00
10. Q10 flow ขอความยินยอม Testimonial + ใครอนุมัติ? → default: consent แยกภายหลัง + Admin/ผู้บริหารอนุมัติก่อนใช้

## 5. Success Criteria (วัดได้)
- ลูกค้ากรอกแบบประเมินจบบนมือถือมือเดียว, auto-save ไม่เสียคำตอบเมื่อเน็ตหลุด
- ส่งแบบอัตโนมัติจากสถานะจริง ถูกประเภท/ถูกคน/ไม่ซ้ำ
- AI สรุปเป็น JSON, จัด sentiment/เร่งด่วน, แยกข้อเท็จจริง-ข้อสันนิษฐาน, ไม่ละเมิด C-01–C-04
- เคส Critical/High แจ้งภายใน SLA + ติดตามจนปิด + วัดความพึงพอใจหลังแก้
- Dashboard/Report ตามสิทธิ์ (ผ่าน permission test) + Response Rate + Sample Size
- Metrics: Response/Completion Rate, CSAT, NPS, CES, เสี่ยงยกเลิกที่พบ, Retention Recovery, First Response Time, Resolution Time, Reopen Rate, คะแนนหลังแก้, อัตราส่งสำเร็จ, Block OA, Do Not Contact
- ผ่าน type check+lint+test+build ทุกเฟส; ไม่มี mock ใน critical flow ตอนรายงานเสร็จ

## 6. Out of Scope (เฟสนี้)
- เชื่อม CRM/ระบบบัญชีภายนอกแบบ real-time sync (รอ Q1)
- ระบบชำระเงิน/ค่าชดเชย/คืนเงิน
- Sales automation เต็มรูป (nova-cx แค่ trigger survey + Do Not Contact flag)
- แอป Native iOS/Android (ใช้ LIFF)
- ภาษาอื่นนอกจากไทย (Thai-first)
