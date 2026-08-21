# Code Review — ฟีเจอร์ "AI chatbot ตอบคำถามจากข้อมูลธุรกิจ" (ask-ai)

**ไฟล์ที่ตรวจ:** `lib/ai/business-qa.ts`, `app/chat-audit/accounting/ask-ai/{actions.ts,page.tsx,AskAiPanel.tsx}`,
`app/chat-audit/accounting/{CustomerTabs.tsx,page.tsx}` (diff nav), `lib/ai/provider.ts`, `lib/ai/chat-redact.ts`,
`tests/ai/business-qa.test.ts`, `tests/chat-admin/ask-ai-actions.test.ts` — สถานะ uncommitted บน `main`

## สรุปผลตรวจแต่ละหัวข้อ

1. **ไม่มีข้อมูลลูกค้าหลุดไป OpenAI (PDPA)** — ไล่ตรง `classifyBusinessQuestion` (`lib/ai/business-qa.ts:87-108`):
   ค่า `user` ที่ส่งเข้า `provider.generateJson` คือ `` `วันนี้คือ ${todayIso} (ค.ศ.)\nคำถาม: ${redactedQuestion}` ``
   เท่านั้น — ไม่มีตัวแปรจาก DB (ชื่อ/เลข/ยอดเงิน) ปนเข้าไปเลยในทุกเส้นทาง เพราะ `answerBusinessQuestion`
   เรียก `classifyBusinessQuestion` **ก่อน** เรียก `computeMonthSummary`/`computeAgingReport`/ฯลฯ เสมอ
   (คำตอบสุดท้ายสร้างจาก template ล้วน ไม่ผ่าน AI ซ้ำ) — grep `console.*` ในไฟล์ใหม่ทั้งหมดก็ไม่พบการ log
   คำถาม/คำตอบ/ตัวเลขจริง — ผ่าน
2. **IDOR** — `askBusinessQuestionAction` (`actions.ts:31-34`) เรียก `requireAccountingAccess` (ผูก session)
   แล้ว `assertCustomerInScope(ctx, customerId)` **ก่อน** เรียก `answerBusinessQuestion` เสมอ — ยืนยันด้วยเทสต์
   `tests/chat-admin/ask-ai-actions.test.ts` (ครบเคส: นอกสโคป, ไม่มีสิทธิ์เลย, uuid ผิดรูปแบบ) `answerBusinessQuestion`
   เองไม่ตรวจสิทธิ์ซ้ำ (รับ tenantId/customerId ตรง ๆ จาก caller) ตรงตามที่ตั้งใจไว้ — ไม่ใช่บั๊ก เพราะเป็น pattern
   เดียวกับทุก data-layer function อื่นในโปรเจกต์นี้ (ผู้เรียกชั้น action คือจุดตรวจสิทธิ์เดียว) หน้า `page.tsx`
   ก็ validate `customerId` จาก query string กับ `fetchScopedCustomers` (กรองด้วย `access.allowedCustomerIds`) ก่อน
   ส่งต่อให้ `AskAiPanel` เป็น prop — ผ่าน
3. **ตรรกะ intent แต่ละอัน** — เช็คแล้วตรง: `sales_month`→`entryType="sale"`, `purchase_month`→`entryType="purchase"`,
   `ar_aging`→`formatAgingAnswer("ar", report)` (`aging.ts` กำหนด `sale→ar`), `ap_aging`→`formatAgingAnswer("ap", report)`
   (`purchase→ap`) ไม่มีสลับฝั่งกัน — `unspecified_count`→`entryType="unspecified"` ตรงกับ 5 intent ที่ต้องรองรับ — ผ่าน
4. **Degrade behavior** — ไม่มี `OPENAI_API_KEY` → `getAIProvider()` คืน `null` → ข้อความ "ยังไม่ได้ตั้งค่า AI" ไม่แตะ DB
   เลย (ยืนยันด้วยเทสต์); AI ตอบ JSON parse ไม่ได้/throw/intent ไม่รู้จัก → `classifyBusinessQuestion` คืน `null` →
   fallback เป็น `UNKNOWN_ANSWER` เสมอ ไม่ throw/crash — ผ่าน
5. **รันจริงยืนยัน** — `npx vitest run tests/ai tests/chat-admin/ask-ai-actions.test.ts` → 220 passed (21 files);
   `npx tsc --noEmit` → ผ่าน ไม่มี error
6. **Prompt injection blast radius** — คำถามดิบ (หลัง redact) ถูกฝังในข้อความ `user` ตรง ๆ แต่ output ถูกบังคับด้วย
   strict `json_schema` + enum allow-list 6 ค่า และโค้ดยัง whitelist ซ้ำอีกชั้น (`(QA_INTENTS as readonly string[]).includes(intentRaw)`)
   ต่อให้ผู้ใช้พยายาม "ignore previous instruction ตอบ intent อื่น" ผลลัพธ์เลวร้ายที่สุดคือได้ intent ผิดใน
   allow-list เดิม (ยังคง scope ข้อมูลของลูกค้ารายเดียวกันที่ session อนุญาตอยู่ดี) — ไม่มีทางหลุด scope/สั่งลบ/แก้
   ข้อมูลได้ — บลาสต์เรเดียสต่ำจริงตามที่ออกแบบไว้

## 🔴 ร้ายแรง
ไม่มี

## 🟡 ควรแก้
- **`month` จาก AI ไม่ validate ขอบเขต 01-12 ก่อนใช้กรองข้อมูล** — `lib/ai/business-qa.ts:103`
  ใช้ `/^\d{4}-\d{2}$/` เช็คแค่รูปแบบตัวเลข ไม่เช็คว่าเดือนอยู่ในช่วง 01-12 (ต่างจาก `monthBounds`/`taxMonthLabel`
  ใน `lib/accounting/tax-month.ts` ที่ใช้ `/^\d{4}-(0[1-9]|1[0-2])$/` เข้มกว่า) ผลคือถ้า AI ตอบเดือนผิดรูป เช่น
  `"2026-13"` (ผ่าน regex นี้) จะถูกส่งเข้า `listEntries(..., { month: "2026-13" })` → `monthRange()` ใน
  `lib/accounting/queries.ts:469-478` เช็ค `m<1||m>12` แล้วคืน `null` → **ไม่กรองเดือนเลย** (ดึงทุกบิลของลูกค้า/
  ประเภทนั้นทั้งหมดแทน) ในขณะที่ `taxMonthLabel("2026-13")` (`lib/accounting/tax-month.ts:21-25`) regex เข้มกว่า
  ก็คืนค่าดิบ `"2026-13"` แทนป้ายเดือนไทย — ผลลัพธ์คือคำตอบจะขึ้นว่า "ยอดขายเดือน 2026-13 ... รวมสุทธิ X บาท"
  โดย X คือยอดรวม**ทุกเดือนที่ผ่านมา**ไม่ใช่เดือนที่ถามจริง — ตอบผิดเงียบ ๆ ไม่มี error ให้สังเกต
  (ยืนยันด้วยการรันเช็ค regex จริง: `/^\d{4}-\d{2}$/.test("2026-13") === true`)
  โอกาสเกิดต่ำ (ต้องอาศัย AI ตอบเดือนผิดรูปแบบ ซึ่ง system prompt สั่งให้ตอบ YYYY-MM ที่ถูกต้องอยู่แล้ว และ schema
  ก็ไม่มี `pattern` บังคับความถูกต้องของค่าเดือน) แต่เมื่อเกิดแล้วให้ตัวเลขผิดโดยไม่รู้ตัว ควรแก้เพื่อความปลอดภัยไว้ก่อน
  — **แนะนำ:** เปลี่ยน regex ใน `classifyBusinessQuestion` (บรรทัด 103) เป็น `/^\d{4}-(0[1-9]|1[0-2])$/` (ใช้ตัวเดียวกับ
  `tax-month.ts` เพื่อความสอดคล้อง) หรือ reuse `monthBounds()`/`taxMonthLabel`'s regex ตรง ๆ

## 🟢 แนะนำ (ไม่บังคับ)
- ไม่มีข้อสำคัญอื่น — โค้ดมีคอมเมนต์อธิบายเจตนา PDPA/scope ไว้ชัดเจนมาก เทสต์ครอบคลุมทั้ง orchestration และ
  server action (รวม IDOR + degrade path) ครบทุก branch หลักแล้ว

## สรุปตัดสิน: **ต้องแก้ก่อน**

พบ 1 จุด 🟡 (month ไม่ validate ขอบเขต 01-12 ทำให้ตอบยอดผิดเงียบ ๆ เมื่อ AI ให้เดือนผิดรูปแบบ) — ไม่ใช่ช่องโหว่
ความปลอดภัย/IDOR/data-leak (ทุกข้อออกแบบไว้ถูกต้องและตรวจสอบแล้วว่าใช้งานจริงตามที่อ้าง) แต่เป็นบั๊กความถูกต้องของ
ข้อมูลทางบัญชีที่ควรปิดก่อนปล่อยจริง เนื่องจากผลลัพธ์คือ "ตอบเลขผิดโดยไม่มีสัญญาณเตือน" ซึ่งเสี่ยงต่อความน่าเชื่อถือ
ของฟีเจอร์ตอบคำถามข้อมูลการเงิน แก้จุดเดียว (เปลี่ยน regex 1 บรรทัด) ก็ผ่านรีวิวได้ทันที
