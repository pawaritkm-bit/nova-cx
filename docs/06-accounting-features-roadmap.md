# 06-accounting-features-roadmap.md — โรดแมปฟีเจอร์บัญชี NOVA-CX (8 เฟส)

> ไฟล์กลาง บันทึกแผนละเอียดของฟีเจอร์บัญชีที่ทำต่อจาก FlowAccount sync (`docs/05-flowaccount-integration.md`)
> ทุกเฟสในไฟล์นี้ต่อเนื่องจาก backlog ท้าย `docs/05-flowaccount-integration.md` หมวด 7
> รูปแบบเอกสารตาม pattern เดิม (มติ M1/M2 ของ FlowAccount) — เฟสใหม่ **ต่อท้ายไฟล์นี้** ไม่แยกไฟล์

**หมายเหตุการทำงาน (ยืนยันจากผู้ใช้ 2026-08-07):** ทำต่อเนื่องหลายเฟสโดยไม่หยุดขออนุมัติทีละจุด
แล้ว deploy ทีเดียวตอนจบทั้งหมด — ทุก task ในเอกสารนี้ติดป้ายกำกับไว้ 2 แบบ:
- **[โค้ดได้เลย]** — ทำต่อได้ทันทีตามสเปกที่ล็อกไว้ ไม่ต้องหยุดถาม
- **[⚠️ FLAG]** — เป็นจุดที่ตัดสินใจเชิงสถาปัตยกรรม/มีผลกระทบกว้าง หรือเป็นการเพิ่มขอบเขตนอกเหนือคำขอเดิม
  **ให้ทำต่อไปได้เลยเช่นกัน (ไม่ต้องรอ approve)** แต่ต้อง**แจ้งผู้ใช้ให้รับทราบ**ระหว่างทาง/ในสรุปจบงาน

---

## ภาพรวม 6 เฟส (ร่างเบื้องต้นของ planner — ยังไม่ยืนยันกับผู้ใช้ทีละเฟส ปรับลำดับได้)

**หมายเหตุการจัดลำดับ (2026-08-08):** ผู้ใช้ยืนยันให้ "รับ/จ่ายเงินแยกจากบิล + ลูกหนี้/เจ้าหนี้ค้างชำระ"
เป็นเฟส 2 (แซงหน้า WHT Certificate ที่ร่างไว้เดิม) — เฟส WHT/เอกสารก่อนขาย-ซื้อ/งบเต็มรูป/FlowAccount ขยาย/
ขัดเกลา ที่เคยเป็นเฟส 2-6 เลื่อนลงเป็นเฟส 3-7 ตามลำดับ (ยังไม่มีแผนละเอียด เนื้อหาเดิมทุกตัว ไม่เปลี่ยน)

**หมายเหตุการรวมเฟส (2026-08-08):** ตอนวางแผนละเอียดเฟส 3 พบว่าใบลดหนี้/ใบเพิ่มหนี้ (Credit Note/Debit
Note) เป็นเอกสารที่ขาดไปจาก backlog เดิม (ไม่มีอยู่ในภาพรวม 7 เฟสแต่แรก) แต่มีความเสี่ยง/ความซับซ้อนใกล้เคียง
กับ WHT Certificate และเอกสารก่อน/ระหว่างขาย-ซื้อ (ทั้งหมดเป็น "เอกสารใหม่" ที่ต่อยอดจากบิล/สินค้าที่มีอยู่แล้ว)
จึงรวม 3 เรื่องนี้เป็น **เฟส 3 เดียว** (ส่วน I=WHT, J=Credit/Debit Note, K=Quotation/PO/Billing Note เรียง
ตามความเสี่ยงจากน้อยไปมาก) ทำให้ภาพรวมเดิม 7 เฟส เหลือ **6 เฟส** — เฟสงบการเงินเต็มรูป/FlowAccount ขยาย/ขัดเกลา
ที่เคยเป็นเฟส 5-7 เลื่อนขึ้นเป็นเฟส 4-6 ตามลำดับ (เนื้อหาเดิมทุกตัว ไม่เปลี่ยน)

| เฟส | ชื่อ | เนื้อหาหลัก | สถานะ |
|---|---|---|---|
| **1** | โครงพื้นฐานบัญชี | (A) ผังบัญชีย้ายจาก hardcode → DB table แก้ไขได้จริง · (B) สินค้า/บริการ (Product Master) · (C) ลงบันทึกบัญชีเอง (Manual Journal Entry: JV/PV/RV) | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **2** | รับ/จ่ายเงินแยกจากบิล + ลูกหนี้/เจ้าหนี้ค้างชำระ | บันทึกรับเงิน/จ่ายเงินจริงแยกจากบิล (บิลเชื่อที่ค่อยผ่อน/ทยอยชำระทีหลัง) ผ่านตารางใหม่ `bill_payments` + เพิ่ม `due_date` ต่อบิล + รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุ (AR/AP Aging) — ต่อยอด `payment_method='credit'`/AR(1140)/AP(2010) ที่มีอยู่แล้ว | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **3** | เอกสารบัญชีเพิ่มเติม (WHT + ใบลดหนี้/เพิ่มหนี้ + เอกสารก่อน/ระหว่างขาย-ซื้อ) | (I) ใบหัก ณ ที่จ่าย — print-only จาก `wht_rate`/`wht_amount` ที่มีอยู่แล้ว (mirror `receipt-cert/`) · (J) ใบลดหนี้/ใบเพิ่มหนี้ (Credit/Debit Note) — ตารางใหม่ + กระทบ `billOutstanding`/journal · (K) ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล — ตารางร่วม `sales_documents` + doc-number generation, ไม่กระทบ engine บัญชี | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **4** | งบการเงินเต็มรูป + รายงานเชิงลึก | งบกำไรขาดทุน/งบแสดงฐานะที่พิมพ์/export เป็นทางการ, เทียบช่วงเวลา/ไตรมาส, งบกระแสเงินสด (ต่อยอด `financial-statements.ts` ที่มีพื้นฐานอยู่แล้ว) | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **5** | ขยาย FlowAccount sync | บิลซื้อ/ค่าใช้จ่าย (`entry_type='purchase'`) + sync สินค้า/ผังบัญชีไป FlowAccount ผ่าน mapping table (ตามที่ร่างไว้ใน `docs/05-flowaccount-integration.md` หมวด 6) — **ต้องรอเฟส 1 (ผังบัญชี DB + สินค้า) เสร็จก่อน** เพราะเป็นฐานที่ mapping table ต้องใช้ | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **6** | ขัดเกลา + อัตโนมัติเพิ่มเติม | รายการบันทึกซ้ำ (recurring JE), กระทบยอดธนาคาร (bank reconciliation), งบประมาณ, ทดสอบเต็มระบบรอบสุดท้ายก่อน deploy รวม | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **7** | ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติ | เพิ่มจาก gap analysis เทียบ FlowAccount (2026-08-09) — บันทึกทรัพย์สิน, คำนวณ/บันทึกค่าเสื่อมราคาแบบเส้นตรงอัตโนมัติทุกเดือน, จำหน่ายทรัพย์สิน (คำนวณกำไร/ขาดทุน), รายงานทะเบียนทรัพย์สิน | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |
| **8** | สต็อกสินค้าคงเหลือ + ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ | ยืนยันจากผู้ใช้ (2026-08-09) ว่าลูกค้าหลายรายมีสต็อกสินค้าจริง — ยอดยกมาสต็อก, เชื่อมรับ/จ่ายสต็อกจากบิลที่ยืนยันแล้ว (manual-trigger), บัตรสต็อก+รายงานสินค้าคงเหลือแยกหมวด (mirror ตัวอย่างหน้าจอที่ผู้ใช้แนบ) — **เป็นชั้นติดตามคู่ขนาน ไม่ auto-post ต้นทุนขายเข้าบัญชีแยกประเภทเลย** (สอดคล้องกับผังบัญชีเดิมที่ออกแบบตามระบบสต็อกสิ้นงวด) | **แผนละเอียดในไฟล์นี้ (ด้านล่าง)** |

**หมายเหตุการเพิ่มเฟส (2026-08-09):** หลัง merge+deploy เฟส 1-6 แล้ว ผู้ใช้ขอให้ทำ gap analysis เทียบ
FlowAccount อีกรอบเพื่อยืนยันว่า "copy มาครบทุกฟีเจอร์" — พบว่า **ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติ**
เป็นฟีเจอร์ที่ผู้ใช้เคยขอไว้ตั้งแต่ต้น ("ค่าเสื่อมราคาทรัพย์สินด้วย") แต่ตกหล่นจากแผน 6 เฟสเดิม จึงเพิ่มเป็น
**เฟส 7** ท้ายไฟล์นี้ ส่วนฟีเจอร์อื่นที่พบว่าขาด (payroll, ระบบคลังสินค้า/สต็อกจริง, multi-currency,
e-Tax Invoice by Time Stamp) เป็นโมดูลใหญ่ที่ขึ้นกับ business context ของลูกค้าสำนักงานบัญชี — ผู้ใช้ยังไม่ได้
สั่งให้ทำ ไม่รวมในรอบนี้ (payment gateway/POS/e-commerce integration/mobile app ตัดออกจากสโคปเพราะไม่ตรงกับ
business model ของ NOVA-CX ที่เป็นเครื่องมือให้สำนักงานบัญชีใช้ ไม่ใช่ให้เจ้าของธุรกิจใช้เอง) — ต่อมาผู้ใช้
ยืนยันว่าลูกค้าหลายรายมีสต็อกสินค้าจริง (ควรใส่) จึงเพิ่ม **เฟส 8** สต็อกสินค้าคงเหลือ พร้อมส่งตัวอย่างหน้าจอ
โปรแกรมบัญชีเดสก์ท็อปไทย (product master + FIFO/AVERAGE + บัตรสต็อก + รายงานคงเหลือแยกหมวด) เป็นข้อมูลอ้างอิง
รูปแบบรายงานที่ต้องการ

# เฟส 1 — แผนละเอียด: โครงพื้นฐานบัญชี

ประกอบด้วย 3 ส่วนที่ต้องทำ **ตามลำดับ A → B → C** (B และ C ทั้งคู่พึ่งผังบัญชีจาก A):
**(A)** ผังบัญชี hardcode → DB table แก้ไขได้จริง · **(B)** สินค้า/บริการ (Product Master) ·
**(C)** ลงบันทึกบัญชีเอง (Manual Journal Entry)

อ้างอิง input จาก analyst (สรุปซ้ำเป็น decision ที่ล็อกไว้ในหมวด 0 — ไม่วิเคราะห์ซ้ำ) + การตรวจโค้ดจริงเพิ่มเติม
ของ planner (พบไฟล์ที่ต้องแก้เพิ่มจากที่ analyst ระบุไว้ และพบว่าบางไฟล์ที่ analyst ระบุไว้ **ไม่ต้องแก้จริง** —
ดูหมวด 0.4)

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ลำดับ A → B → C และขอบเขตต่อส่วน
- **A (ผังบัญชี)** เป็นฐานที่ B และ C ต้องใช้ (validate account_code, combobox เลือกบัญชี) — ทำก่อนเสมอ
- **B (สินค้า)** ไม่แตะ engine บัญชีเลย (`journal.ts`/`ledger.ts`/`trial-balance.ts`/`statements.ts`) — เป็นแค่
  ตัวช่วย prefill (`description`+`account_code`) ในบรรทัดบิล/JE ผ่าน `product_id` ที่เพิ่มใน `bill_entry_lines`
  เท่านั้น (nullable, non-destructive) — ของจริงที่ engine ใช้ยังเป็น `account_code`/`account_name`/`amount`
  ต่อบรรทัดเหมือนเดิมทุกอย่าง — **ความเสี่ยงต่ำมาก**
- **C (Manual JE)** แยกตารางใหม่ทั้งหมด (`manual_journal_entries`/`manual_journal_entry_lines`) ไม่ขยาย
  `bill_entries` (เหตุผลตาม analyst — bill_entries ผูก seller/buyer/VAT/WHT ต่อบรรทัด ไม่มีแนวคิด debit/credit
  ตรง ๆ แบบ JV มือ และจะพัง filter รายงานภาษีที่กรองตาม entry_type) — ต่อเข้า engine ด้วย mapper แปลง
  manual entry → `JournalLine[]` แล้ว concat ก่อนเข้า `buildLedger` (ไม่แก้ตรรกะ ledger/trial-balance เลย)

### 0.2 ผังบัญชีเป็น **tenant-scoped** (ไม่ใช่ global ข้าม tenant)
NOVA-CX เป็น multi-tenant (1 tenant = 1 สำนักงานบัญชี ดูแลลูกค้าหลายบริษัท) — ผังบัญชี "ใช้ร่วมทุกลูกค้า"
หมายถึงร่วมกันทุกลูกค้า **ภายใน tenant เดียว** เท่านั้น ตรงกับที่ระบบมีอยู่แล้ว (ไม่มี concept ผังข้าม tenant)
→ ตาราง `chart_of_accounts` มีคอลัมน์ `tenant_id` เหมือนตารางอื่นทั้งหมดในระบบ

### 0.3 กลไก migrate จาก hardcode → DB: seed ตรงใน SQL migration (ไม่พึ่งโค้ด TS ตอน apply)
แปลง 75 รายการเดิมใน `CHART_OF_ACCOUNTS` เป็น `INSERT ... SELECT tenants.id × VALUES(...)` ในไฟล์ migration
เดียว — ให้ทุก tenant ที่มีอยู่แล้วได้ผังเริ่มต้นครบ 75 รายการทันทีที่ apply (ไม่ต้องรันสคริปต์แยก)
**[⚠️ FLAG]** ก่อน apply บน production ให้เช็คจำนวน tenant จริงก่อน (`select count(*) from tenants`) — ถ้ามี
มากกว่า 1 tenant ต้องมั่นใจว่าทุก tenant ควรได้ผังเริ่มต้นชุดเดียวกันนี้จริง (ไม่มี tenant ไหนที่ควรว่างเปล่า/ต่างชุด)

### 0.4 ตรวจซ้ำรายไฟล์จากที่ analyst ระบุ — พบ 2 จุดต้องแก้ไขรายการ
ตรวจโค้ดจริงแล้วพบว่ารายการไฟล์ที่ analyst ให้มา **ไม่ตรงเป๊ะ** กับที่ต้องแก้จริง — ปรับดังนี้:
- **`lib/accounting/trial-balance.ts` ไม่ต้องแก้เลย** — import `CATEGORY_BY_DIGIT` จาก chart-of-accounts.ts
  ตรง ๆ (ไม่ผ่าน `statement-config.ts` ตามที่ analyst ระบุ) แต่ `CATEGORY_BY_DIGIT` เป็นค่าคงที่โครงสร้าง
  (หมวด 1-6 ตามเลขหลักแรก) ที่ **ไม่ย้ายเข้า DB** (ไม่ใช่สิ่งที่ admin แก้ได้ เป็น convention ทางบัญชีตรึงตัว)
  → ไฟล์นี้ปลอดภัย ไม่ต้องแตะ
- **พบไฟล์เพิ่มที่ analyst ไม่ได้ระบุ แต่ import chart-of-accounts.ts จริง และต้องแก้:**
  `lib/accounting/payment.ts` (ใช้ `CHART_BY_CODE` ทำชื่อ fallback บัญชีคู่),
  `lib/ai/bill-extract.ts` (ใช้ `CHART_BY_CODE`+`searchChartNonBank` สร้าง AI prompt + validate ผลลัพธ์ —
  ดู 0.5), `lib/line/bill-extract-worker.ts` (ใช้ `CHART_BY_CODE` เติมชื่อบัญชีให้ AI draft),
  `app/chat-audit/accounting/actions.ts` (ใช้ `CHART_BY_CODE`+`searchChartNonBank` ตอน worker เติม draft)

### 0.5 ⚠️ จุดเสี่ยงสถาปัตยกรรมที่สุดของ Part A: AI prompt เดิมคำนวณครั้งเดียวตอน module load (sync)
`lib/ai/bill-extract.ts` มี `const CHART_PROMPT_LIST = searchChartNonBank("").filter(...).map(...).join(", ")`
เป็น **module-level constant คำนวณครั้งเดียวตอนโหลดไฟล์** (sync, ไม่มี tenant context) — ผังบัญชีย้ายเป็น
per-tenant ใน DB แล้ว จุดนี้ทำแบบเดิมไม่ได้ (ต้องรู้ tenant ก่อนถึงจะรู้ผัง) **[⚠️ FLAG]**
- แก้โดยเปลี่ยน `CHART_PROMPT_LIST` จาก module constant → ฟังก์ชัน `buildChartPromptList(chart: ChartAccount[])`
  คำนวณต่อ call (ต้นทุนต่ำมาก — string join ของ ~75-300 รายการ ไม่ใช่ network call)
- `extractBillData`/`extractBillsData` (async อยู่แล้ว) เพิ่มพารามิเตอร์ `chart: ChartAccount[]` — caller
  (`bill-extract-worker.ts`) โหลดผังของ tenant นั้นครั้งเดียวต่อรอบ worker แล้วส่งเข้าไปทุกครั้งที่เรียก
  (ไม่ query ซ้ำต่อบิล)
- `gateAccountCodeGuess()` (validate account_code ที่ AI คืนมา ต้องอยู่ในผัง + ไม่ใช่หมวดธนาคาร) ต้องรับ
  `chartByCode` เป็นพารามิเตอร์แทน `CHART_BY_CODE` module-level เช่นกัน
- ผลกระทบเชิงพฤติกรรม: **พรอมต์ AI จะเปลี่ยนตามผังของแต่ละ tenant จริง** (ก่อนหน้านี้ทุก tenant ใช้พรอมต์
  เดียวกันเพราะผังกลาง hardcode) — ถ้า tenant ไหนแก้ผังจนต่างจาก 75 รายการเดิมมาก AI จะแนะนำบัญชีต่างไปตาม
  ผังที่แก้จริง (นี่คือพฤติกรรมที่ถูกต้องตามเจตนาของฟีเจอร์ แต่เป็นการเปลี่ยนพฤติกรรม AI ที่ควรรับทราบ)

### 0.6 บัญชีเงินฝากธนาคาร (bank:true) — validate ต้องรับผังเป็นพารามิเตอร์เหมือนกัน
`isBankAccountCode`/`BANK_ACCOUNT_CODES` (ใช้ใน `bank-accounts.ts::validateBankAccountInput`) ต้องรับ
`chart: ChartAccount[]` เป็นพารามิเตอร์ (caller = server action ที่ผูกบัญชีเงินฝากลูกค้า ต้องโหลดผังของ
tenant ก่อนเรียก validate)

### 0.7 ป้องกันรหัสบัญชี "โครงสร้าง" ที่ engine ผูกไว้แบบ hardcode ไม่ให้ลบ/ปลดสถานะได้จาก UI จัดการผัง
**[⚠️ FLAG]** — เป็นเงื่อนไขที่ planner เพิ่มเองจากการอ่านโค้ด ไม่ได้อยู่ในบทวิเคราะห์ของ analyst โดยตรง:
`lib/accounting/statement-config.ts` ผูกรหัสไว้ตรง ๆ 8 ตัว (`INPUT_VAT=1154, OUTPUT_VAT=2900,
WHT_PAYABLE=2910, WHT_RECEIVABLE=1216, CASH=1010, AP=2010, AR=1140, RETAINED_EARNINGS=3020`) และรหัสเงินฝาก
ธนาคาร 3 ตัว (`1020/1025/1030`, ผูกกับ `customer_bank_accounts`) — ถ้า admin ลบ/ปลดหมวดรหัสเหล่านี้ผ่านหน้า
จัดการผังใหม่ engine จะพังเงียบ (VAT/WHT ไม่ลงบัญชี, บัญชีคู่หาไม่เจอ) **ต้อง**:
- ปฏิเสธการ "ลบ" (soft-delete) รหัสใน `PROTECTED_CODES` เซตข้างต้นเสมอ (แก้ชื่อได้ ลบไม่ได้)
- ปฏิเสธการปลดค่า `is_bank` ของ 1020/1025/1030 **ถ้ามี `customer_bank_accounts` ที่ยัง active ผูกอยู่**
  (เช็คก่อนบันทึกทุกครั้งที่แก้ฟิลด์ `is_bank` จาก true → false)

### 0.8 Manual JE เข้า "สมุดรายวัน" ที่ถูกเล่ม ตาม `doc_type` — แก้ TODO เดิมในโค้ดไปพร้อมกัน
**[⚠️ FLAG — เพิ่มขอบเขตนอกคำขอเดิมเล็กน้อย แต่คุ้มค่าเพราะแก้ gap ที่มีอยู่แล้วในโค้ด]**
`lib/accounting/journal-books.ts` มีคอมเมนต์ระบุไว้ตรง ๆ ว่าเล่ม "รับเงิน/จ่ายเงิน" ยังว่างเปล่าเพราะ
"จะมาจากสเตทเมนต์ภายหลัง — ยังไม่ post จากบิล" — Manual JE (`doc_type`: `JV`=ทั่วไป, `PV`=จ่ายเงิน,
`RV`=รับเงิน) คือ data source ที่ TODO นี้รออยู่พอดี → เฟส 1 นี้จะ route manual entry เข้าเล่มตาม `doc_type`
ตรง ๆ (`JV`→สมุดรายวันทั่วไป, `PV`→สมุดรายวันจ่ายเงิน, `RV`→สมุดรายวันรับเงิน) แก้ gap นี้ไปในตัว

### 0.9 สิทธิ์ (ยึดตามที่ analyst แนะนำ — ยืนยันแล้ว)
- จัดการผังบัญชี + สินค้า/บริการ (tenant-level ไม่ผูกลูกค้า) → **admin/executive เท่านั้น**
  (`resolveAdminContext`, pattern `app/chat-audit/admin/members/page.tsx`)
- ลงบันทึกบัญชีเอง (ผูกลูกค้ารายเดียว) → `requireAccountingAccess` + `assertCustomerInScope`
  (pattern `app/chat-audit/accounting/opening/page.tsx` + `OpeningBalancePanel.tsx` — นักบัญชีทำได้เฉพาะ
  ลูกค้าที่ตัวเองดูแล เหมือนยอดยกมา)

### 0.10 Manual JE ไม่เชื่อม FlowAccount ในเฟสนี้
Manual JE ไม่ใช่ `bill_entries` — ปุ่ม "ส่งไป FlowAccount" (M1/M2 ของ `docs/05`) จะไม่เห็น/ใช้กับ manual JE
เลย (ตั้งใจ — manual JE เป็นรายการปรับปรุงภายในระบบ NOVA-CX เท่านั้นในเฟสนี้ ไม่ sync ออกไปข้างนอก)

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 1

```
supabase/migrations/
  0063_chart_of_accounts_table.sql        [ใหม่] ตาราง chart_of_accounts + seed 75 รายการทุก tenant + RLS
  0064_products_table.sql                 [ใหม่] ตาราง products (tenant-scoped) + RLS
  0065_bill_entry_lines_product_id.sql    [ใหม่] เพิ่มคอลัมน์ product_id (FK nullable) บน bill_entry_lines
  0066_manual_journal_entries.sql         [ใหม่] manual_journal_entries + manual_journal_entry_lines + RLS
  ⚠️ เลขไฟล์ 0063-0066 อิง "0062 เป็นไฟล์ล่าสุด ณ วันที่วางแผน" — ก่อนสร้างไฟล์จริงให้ `ls supabase/migrations`
     เช็คเลขล่าสุดอีกครั้ง เผื่อมีงานอื่นแซงเข้ามาก่อน

lib/accounting/
  chart-of-accounts.ts        [แก้ครั้งใหญ่] ลบ CHART_OF_ACCOUNTS/CHART_BY_CODE/BANK_ACCOUNT_CODES/
                                              NONBANK_ACCOUNT_CODES/BANK_ACCOUNTS (module constants) →
                                              เปลี่ยนทุกฟังก์ชันเป็น pure รับ chart:ChartAccount[] เป็นพารามิเตอร์
                                              คงไว้: ChartAccount type, CATEGORY_BY_DIGIT, categoryDigitOf (ไม่เปลี่ยน)
  chart-accounts-data.ts      [ใหม่] data layer: listChartOfAccounts(db,tenantId) + validate/create/
                                              update/soft-delete helpers + PROTECTED_CODES guard (0.7)
  products.ts                 [ใหม่] data layer สินค้า: listProducts/validate/create/update/soft-delete
                                              + searchProducts (pure, สำหรับ combobox)
  manual-journal.ts           [ใหม่] data layer + pure: listManualEntries/validate/upsert/softDelete,
                                              isBalanced(), toJournalLines(), toJournalPosting() (routing ตาม doc_type)
  journal.ts                  [แก้] buildJournalEntries(entries, chartByCode={}) — accountName() ใช้ param
  ledger.ts                   [แก้] buildLedger(lines, opening, chartByCode={}) — ensure()/categoryOf() ใช้ param
  trial-balance.ts             [ไม่แก้] — ยืนยันแล้วไม่ต้องแตะ (0.4)
  payment.ts                  [แก้] contraAccountFor(chartByCode, paymentMethod, entryType, bankCode) — chartName() ใช้ param
  opening-balance.ts          [แก้] parseOpeningBalanceRows(chart, rows) — fallback ชื่อบัญชีใช้ param
  bank-accounts.ts            [แก้] validateBankAccountInput(chart, input) — isBankAccountCode รับ chart
  statements.ts                [แก้ 2 รอบ] รอบ A: buildStatements(entries, opening, chartByCode={})
                                              รอบ C: เพิ่ม manualJournalLines: JournalLine[] = [] concat ก่อน buildLedger
  journal-books.ts            [แก้ในรอบ C] เพิ่มเส้นทาง merge manual posting เข้าเล่มตาม doc_type (0.8)
  report-filter.ts            [แก้ในรอบ C] เพิ่ม filterManualEntriesForReport() (คู่กับ filterEntriesForReport เดิม)

lib/ai/
  bill-extract.ts             [แก้] extractBillData/extractBillsData รับ chart:ChartAccount[] เพิ่ม;
                                              CHART_PROMPT_LIST → buildChartPromptList(chart); gateAccountCodeGuess รับ chartByCode

lib/line/
  bill-extract-worker.ts      [แก้] โหลด chart ต่อ tenant ครั้งเดียวต่อรอบ worker → ส่งต่อทุก call

app/chat-audit/admin/
  chart-of-accounts/page.tsx           [ใหม่] list+CRUD ผังบัญชี (admin only)
  chart-of-accounts/ChartOfAccountsPanel.tsx [ใหม่] client component ตาราง
  chart-of-accounts/actions.ts         [ใหม่] server actions (create/update/soft-delete, guard PROTECTED_CODES)
  products/page.tsx                    [ใหม่] list+CRUD สินค้า/บริการ (admin only)
  products/ProductsPanel.tsx           [ใหม่] client component ตาราง
  products/actions.ts                  [ใหม่] server actions (create/update/soft-delete)

app/chat-audit/accounting/
  actions.ts                  [แก้] แทนที่ CHART_BY_CODE/searchChartNonBank ด้วยผังที่โหลดจาก DB ต่อ tenant
  EntryEditor.tsx              [แก้] รับ chart:ChartAccount[] เป็น prop (ไม่ import chart-of-accounts ตรง) +
                                              เพิ่ม product picker ในบรรทัด (เลือกสินค้า → prefill description+account_code)
  OpeningBalancePanel.tsx      [แก้] รับ chart:ChartAccount[] เป็น prop (auto-fill ชื่อบัญชี onCodeChange)
  page.tsx                     [แก้] โหลด chart ของ tenant ครั้งเดียว → ส่งเป็น prop ให้ EntryEditor
  opening/page.tsx             [แก้] โหลด chart → ส่งเป็น prop ให้ OpeningBalancePanel
  reports/page.tsx             [แก้ในรอบ C] โหลด manual entries (confirmed, ตามงวด) → map → ส่งเข้า buildStatements
  reports/export/route.ts      [แก้ในรอบ C] เหมือนกัน (export ต้องตรงกับที่หน้าจอเห็น)
  journal-books/page.tsx       [แก้ในรอบ C] โหลด manual entries → merge เข้าเล่มตาม doc_type
  journal-entry/page.tsx       [ใหม่] เลือกลูกค้า (สโคป) → เปิด JournalEntryPanel (pattern เดียวกับ opening/page.tsx)
  journal-entry/JournalEntryPanel.tsx [ใหม่] ฟอร์ม header (doc_type/date/doc_no/memo) + ตาราง lines
                                              (combobox เลือกบัญชีจากผัง) + เช็คสมดุล + list entries เดิมของลูกค้า
  journal-entry/actions.ts     [ใหม่] server actions: upsert/confirm/delete manual entry (guard เหมือน opening-balance)

tests/accounting/
  chart-of-accounts.test.ts       [แก้ทั้งไฟล์] signature ใหม่ทุกฟังก์ชัน + fixture ผังทดสอบ
  chart-accounts-data.test.ts     [ใหม่]
  products.test.ts                [ใหม่]
  manual-journal.test.ts          [ใหม่]
  journal.test.ts / statements.test.ts / ledger-statement.test.ts / bank-accounts.test.ts /
    opening-balance.test.ts / payment.test.ts / report-filter.test.ts / journal-books.test.ts
                                    [แก้] เพิ่ม fixture chart เข้าทุก call site ที่ signature เปลี่ยน
  fixtures/chart.ts                [ใหม่] TEST_CHART: ChartAccount[] ใช้ร่วมทุกเทสต์ (mirror ของ 75 รายการเดิม)

tests/ai/bill-extract.test.ts       [แก้] extractBillData/extractBillsData เรียกพร้อม chart param
tests/line/bill-extract-worker.test.ts [แก้] mock chart fetch
tests/admin/ (หรือ tests/chat-admin/)
  chart-of-accounts-actions.test.ts [ใหม่]
  products-actions.test.ts          [ใหม่]

.env.example — ไม่แก้ (เฟสนี้ไม่มี env ใหม่)
```

### 1.1 Schema — migration 0063 (ผังบัญชี)

```sql
create table if not exists public.chart_of_accounts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null,
  name        text not null,
  category    text not null,           -- ป้ายหมวดไทย (สินทรัพย์/หนี้สิน/ทุน/รายได้/ค่าใช้จ่าย/อื่นๆ)
  is_bank     boolean not null default false,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create unique index if not exists uq_chart_of_accounts_tenant_code
  on public.chart_of_accounts (tenant_id, code) where deleted_at is null;
create index if not exists idx_chart_of_accounts_tenant_sort
  on public.chart_of_accounts (tenant_id, sort_order) where deleted_at is null;

drop trigger if exists trg_chart_of_accounts_updated on public.chart_of_accounts;
create trigger trg_chart_of_accounts_updated before update on public.chart_of_accounts
  for each row execute function public.set_updated_at();

-- seed 75 รายการเดิมให้ทุก tenant ที่มีอยู่แล้ว (แปลงตรงจาก lib/accounting/chart-of-accounts.ts)
insert into public.chart_of_accounts (tenant_id, code, name, category, is_bank, sort_order)
select t.id, v.code, v.name, v.category, v.is_bank, v.sort_order
from public.tenants t
cross join (values
  ('1010','เงินสด','สินทรัพย์',false,1),
  ('1015','เงินสดย่อย','สินทรัพย์',false,2),
  ('1020','เงินฝากธนาคาร #1','สินทรัพย์',true,3),
  ('1025','เงินฝากธนาคาร #2','สินทรัพย์',true,4),
  ('1030','เงินฝากธนาคาร #3','สินทรัพย์',true,5),
  -- ... (ครบ 75 แถวตาม CHART_OF_ACCOUNTS ปัจจุบันทุกตัว เรียง sort_order ตามลำดับเดิมในไฟล์) ...
  ('6000','ค่าใช้จ่ายต้องห้าม','อื่น ๆ',false,75)
) as v(code,name,category,is_bank,sort_order)
on conflict (tenant_id, code) where deleted_at is null do nothing;

alter table public.chart_of_accounts enable row level security;
drop policy if exists tenant_read on public.chart_of_accounts;
create policy tenant_read on public.chart_of_accounts for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.chart_of_accounts from anon;
grant select on public.chart_of_accounts to authenticated;
grant all on public.chart_of_accounts to service_role;

notify pgrst, 'reload schema';
```
**หมายเหตุ**: ค่า `...` ในตัวอย่างข้างบนคือ "ครบ 75 แถว" จริง — developer ต้อง copy ค่าตรงจาก
`lib/accounting/chart-of-accounts.ts` (ปัจจุบัน) มาเขียนเป็น VALUES ให้ครบทุกแถว ห้ามพิมพ์มือใหม่ (กันพลาด/ตกหล่น)

### 1.2 Schema — migration 0064 (สินค้า/บริการ)

```sql
create table if not exists public.products (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  sku                   text,
  name                  text not null,
  unit                  text,
  default_price         numeric(14,2),
  default_account_code  text,     -- ตรงตัวอักษรกับ chart_of_accounts.code (ไม่ใช้ FK จริง — pattern เดียวกับ bill_entry_lines.account_code เดิม)
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create unique index if not exists uq_products_tenant_sku
  on public.products (tenant_id, sku) where deleted_at is null and sku is not null;
create index if not exists idx_products_tenant_active
  on public.products (tenant_id) where deleted_at is null;

drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;
drop policy if exists tenant_read on public.products;
create policy tenant_read on public.products for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.products from anon;
grant select on public.products to authenticated;
grant all on public.products to service_role;

notify pgrst, 'reload schema';
```

### 1.3 Schema — migration 0065 (product_id บน bill_entry_lines)

```sql
alter table public.bill_entry_lines
  add column if not exists product_id uuid references public.products(id) on delete set null;

notify pgrst, 'reload schema';
```

### 1.4 Schema — migration 0066 (Manual Journal Entry)

```sql
create table if not exists public.manual_journal_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  doc_type      text not null check (doc_type in ('JV','PV','RV')),  -- JV=ทั่วไป PV=จ่ายเงิน RV=รับเงิน
  doc_date      date not null,
  doc_no        text,
  memo          text,
  status        text not null default 'draft' check (status in ('draft','confirmed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  deleted_at    timestamptz
);
create index if not exists idx_manual_je_tenant_customer_date
  on public.manual_journal_entries (tenant_id, customer_id, doc_date)
  where deleted_at is null;

create table if not exists public.manual_journal_entry_lines (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references public.manual_journal_entries(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  account_code  text not null,
  account_name  text,
  description   text,
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_manual_je_lines_entry
  on public.manual_journal_entry_lines (tenant_id, entry_id);

drop trigger if exists trg_manual_je_updated on public.manual_journal_entries;
create trigger trg_manual_je_updated before update on public.manual_journal_entries
  for each row execute function public.set_updated_at();
drop trigger if exists trg_manual_je_lines_updated on public.manual_journal_entry_lines;
create trigger trg_manual_je_lines_updated before update on public.manual_journal_entry_lines
  for each row execute function public.set_updated_at();

alter table public.manual_journal_entries      enable row level security;
alter table public.manual_journal_entry_lines  enable row level security;
drop policy if exists tenant_read on public.manual_journal_entries;
create policy tenant_read on public.manual_journal_entries for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.manual_journal_entry_lines;
create policy tenant_read on public.manual_journal_entry_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.manual_journal_entries      from anon;
revoke all on public.manual_journal_entry_lines  from anon;
grant select on public.manual_journal_entries      to authenticated;
grant select on public.manual_journal_entry_lines  to authenticated;
grant all on public.manual_journal_entries      to service_role;
grant all on public.manual_journal_entry_lines  to service_role;

notify pgrst, 'reload schema';
```
**หมายเหตุความสมดุล**: debit=credit ต่อ entry บังคับที่ **application layer** (server action ก่อน insert/update
เหมือน pattern เดิมของ `journal.ts` ที่ตรวจสมดุลด้วย `EPSILON` ไม่ใช้ DB constraint) — ไม่เพิ่ม DB trigger ตรวจ
สมดุล (สอดคล้องกับที่ระบบไม่มี double-entry constraint ระดับ DB ที่อื่นเลยในระบบปัจจุบัน)

---

## 2) งานย่อยเรียงลำดับ

**Legend**: [โค้ดได้เลย] = ทำตามสเปกได้ทันที · [⚠️ FLAG] = ทำต่อได้เลยแต่ต้องแจ้งผู้ใช้ (ดูรายละเอียดในหมวด 0)

### ส่วน A — ผังบัญชี DB (ทำก่อน B, C ทั้งคู่)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **A1** [โค้ดได้เลย] | Migration 0063 — ตาราง `chart_of_accounts` + seed 75 รายการทุก tenant + RLS | `0063_chart_of_accounts_table.sql` | - | apply สำเร็จไม่ error · ทุก tenant มีครบ 75 รายการหลัง apply (query นับแถวเทียบ) · RLS/grant ตาม pattern 0057 · เทสต์เดิมทั้งหมดผ่าน (migration นี้ไม่แตะตาราง/flow เดิม) |
| **A2** [โค้ดได้เลย] | Refactor `chart-of-accounts.ts` — ลบ module constants → ฟังก์ชัน pure รับ `chart` เป็นพารามิเตอร์ทั้งหมด (`chartByCode`, `searchChart`, `searchChartNonBankGrouped`, `isBankAccountCode`, `isValidNonBankCode` ฯลฯ) คง `CATEGORY_BY_DIGIT`/`categoryDigitOf`/type `ChartAccount` เดิม | `lib/accounting/chart-of-accounts.ts` | - | unit test ครอบทุกฟังก์ชันด้วย fixture chart (ไม่พึ่ง array เดิม) · TS compile ผ่าน (บอกจุดที่ยังพัง = importer ที่ยังไม่แก้) |
| **A3** [โค้ดได้เลย] | `chart-accounts-data.ts` — `listChartOfAccounts(db,tenantId)` + validate/create/update/soft-delete + `PROTECTED_CODES` guard (0.7: ห้ามลบ 8 รหัสโครงสร้าง + ห้ามปลด `is_bank` ของ 1020/1025/1030 ถ้ามี `customer_bank_accounts` ผูกอยู่) | `lib/accounting/chart-accounts-data.ts` | A1 | unit test: CRUD ปกติผ่าน, ลบรหัสป้องกัน → ปฏิเสธ, ปลด is_bank ที่มีลูกค้าผูกอยู่ → ปฏิเสธ, รหัสซ้ำในผังเดียวกัน → ปฏิเสธ |
| **A4** [โค้ดได้เลย] | Thread `chartByCode`/`chart` param เข้า `journal.ts`, `ledger.ts`, `payment.ts`, `opening-balance.ts`, `bank-accounts.ts`, `statements.ts` (default `{}`/`[]` เพื่อให้ signature เดิม backward-compat ระดับ compile แต่ผู้เรียกจริงต้องส่งของจริงมาเสมอ) | 6 ไฟล์ข้างต้น | A2 | เทสต์เดิมทุกไฟล์ (`journal`/`ledger-statement`/`payment`/`opening-balance`/`bank-accounts`/`statements`.test.ts) ผ่านหลังอัปเดต fixture · ไม่มี behavior เปลี่ยนเมื่อ chartByCode ตรงกับ 75 รายการเดิม (regression-safe) |
| **A5** [⚠️ FLAG — ดู 0.5] | `lib/ai/bill-extract.ts` — ย้าย `CHART_PROMPT_LIST`/`gateAccountCodeGuess` จาก module constant → รับ `chart`/`chartByCode` ต่อ call; `extractBillData`/`extractBillsData` เพิ่มพารามิเตอร์ `chart: ChartAccount[]` | `lib/ai/bill-extract.ts` | A2 | unit test เดิม (`tests/ai/bill-extract.test.ts`) ผ่านหลังส่ง chart param ทุก call · เทสต์ใหม่: prompt เปลี่ยนตาม chart ที่ส่งเข้าจริง (2 ชุด chart ต่างกัน → prompt ต่างกัน) · `gateAccountCodeGuess` ปฏิเสธรหัสนอกผังที่ส่งเข้าถูกต้อง |
| **A6** [โค้ดได้เลย] | `lib/line/bill-extract-worker.ts` — โหลด chart ของ tenant ครั้งเดียวต่อรอบ (ไม่ query ซ้ำต่อบิล) → ส่งต่อทุกจุดที่เรียก `extractBillData`/`extractBillsData` + แทน `CHART_BY_CODE` module import ด้วย `chartByCode(chart)` ที่โหลดมา | `lib/line/bill-extract-worker.ts` | A3, A5 | `tests/line/bill-extract-worker.test.ts` ผ่านหลัง mock chart fetch · ยืนยันด้วยเทสต์ว่า chart ถูก fetch "ครั้งเดียว" ต่อ batch (ไม่ query ต่อบิล — mock นับจำนวนครั้งที่ query ถูกเรียก) |
| **A7** [โค้ดได้เลย] | `app/chat-audit/accounting/actions.ts` — แทน `CHART_BY_CODE`/`searchChartNonBank` module import ด้วยผังที่โหลดจาก DB (โหลดต้นฟังก์ชันที่ต้องใช้ ผ่าน `access.tenantId`) | `actions.ts` | A3 | เทสต์เดิม (`actions-lib.test.ts` ที่เกี่ยวข้อง) ผ่าน; ตรวจด้วยตาว่าไม่มี `import { CHART_BY_CODE }` เหลืออยู่ |
| **A8** [โค้ดได้เลย] | `EntryEditor.tsx`/`OpeningBalancePanel.tsx` รับ `chart: ChartAccount[]` เป็น prop แทนการ import ตรง; `page.tsx`/`opening/page.tsx` โหลด chart ของ tenant ครั้งเดียวแล้วส่งลง prop | 4 ไฟล์ข้างต้น | A3 | เปิดหน้า `/chat-audit/accounting` และ `/chat-audit/accounting/opening` จริง → combobox เลือกบัญชียังทำงานเหมือนเดิมทุกอย่าง (regression ด้วยตา) |
| **A9** [โค้ดได้เลย] | หน้า Admin จัดการผังบัญชี `/chat-audit/admin/chart-of-accounts` (list + เพิ่ม/แก้ชื่อ/หมวด/สลับ is_bank/soft-delete) — guard `resolveAdminContext` (admin/executive) | `chart-of-accounts/page.tsx`, `ChartOfAccountsPanel.tsx`, `actions.ts` | A3 | เปิดหน้าจริงด้วย role admin → แก้ชื่อบัญชีได้ + เห็นผลทันที (revalidatePath) · role อื่น/ไม่ login → ปฏิเสธ (redirect/ข้อความ) · ลองลบรหัสป้องกัน (เช่น 1010) → ระบบปฏิเสธพร้อมข้อความชัดเจน |

**Milestone M1 (ส่วน A)**: ผังบัญชีย้ายเข้า DB ครบ ทุก consumer อ่านจาก DB จริง ไม่มี hardcode array เหลือ
ในระบบ (ยกเว้นในไฟล์ migration seed) — ทดสอบผ่านหมด รันได้จริงบน dev

### ส่วน B — สินค้า/บริการ (Product Master)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **B1** [โค้ดได้เลย] | Migration 0064 — ตาราง `products` + RLS | `0064_products_table.sql` | A1 (เผื่อ FK/pattern ต่อกัน แต่จริง ๆ ไม่พึ่ง A โดยตรง) | apply ผ่าน · เทสต์เดิมทั้งหมดผ่าน |
| **B2** [โค้ดได้เลย] | `products.ts` — data layer (list/validate/create/update/soft-delete) + `searchProducts(list,q)` (pure) | `lib/accounting/products.ts` | B1 | unit test ครอบ CRUD + search + validate (ชื่อว่าง/ราคาลบ/sku ซ้ำ → ปฏิเสธ) |
| **B3** [โค้ดได้เลย] | Migration 0065 — เพิ่ม `product_id` บน `bill_entry_lines` | `0065_bill_entry_lines_product_id.sql` | B1 | apply ผ่าน (non-destructive) · query เดิม (`queries.test.ts`) ยังผ่านครบ (ฟิลด์ใหม่ optional ไม่พังของเดิม) |
| **B4** [โค้ดได้เลย] | หน้า Admin จัดการสินค้า `/chat-audit/admin/products` (list+CRUD) — guard admin เหมือน A9 | `products/page.tsx`, `ProductsPanel.tsx`, `actions.ts` | B2 | เปิดหน้าจริงด้วย role admin → เพิ่ม/แก้/ลบสินค้าได้ · role อื่นปฏิเสธ |
| **B5** [โค้ดได้เลย] | `EntryEditor.tsx` — เพิ่ม product picker ต่อบรรทัด (combobox ค้นสินค้า คู่กับ combobox เลือกบัญชีเดิม) เลือกแล้ว prefill `description` + `account_code`(ถ้า product มี `default_account_code`) — ไม่ auto-fill `amount` (คนยังต้องกรอกยอดจริงเอง กันเผลอใช้ default_price ผิด) | `EntryEditor.tsx`, `actions.ts` (บันทึก `product_id`) | B4, A8 | เปิดหน้าจริง เลือกสินค้า → เห็น description/account_code เติมอัตโนมัติ · บันทึกแล้ว `product_id` ติดกับบรรทัดจริง (ตรวจผ่าน query) · เลือกบัญชีเองทับ prefill ได้เหมือนเดิม (ไม่ล็อก) |
| **B6** [โค้ดได้เลย] | เทสต์ครบ: `products.test.ts`, admin actions test, อัปเดต `queries.test.ts`/`actions-lib.test.ts` ให้ครอบ `product_id` | `tests/accounting/*` | B2-B5 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M2 (ส่วน B)**: มีสินค้า/บริการให้เลือกในหน้าลงบันทึกบัญชีจริง ไม่กระทบ engine บัญชีเลย

### ส่วน C — ลงบันทึกบัญชีเอง (Manual Journal Entry)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **C1** [โค้ดได้เลย] | Migration 0066 — `manual_journal_entries` + `manual_journal_entry_lines` + RLS | `0066_manual_journal_entries.sql` | A1 | apply ผ่าน · เทสต์เดิมทั้งหมดผ่าน |
| **C2** [โค้ดได้เลย] | `manual-journal.ts` — data layer (list/validate/upsert/confirm/soft-delete ต่อ entry) + pure: `isBalanced(lines)`, `toJournalLines(entry)`, `toJournalPosting(entry)` (routing เล่มตาม `doc_type` — 0.8) | `lib/accounting/manual-journal.ts` | A3, C1 | unit test: validate (account_code ต้องอยู่ในผัง, debit/credit ห้ามลบ, ต้องมีอย่างน้อย 2 บรรทัด, สมดุลก่อน confirm ได้เท่านั้น) · `toJournalLines` คืนบรรทัด debit/credit แยกฝั่งถูกต้อง (คงเครื่องหมาย/ผังตรง `JournalLine` type เดิม) · `toJournalPosting` route JV/PV/RV เข้าเล่มถูกต้อง |
| **C3** [โค้ดได้เลย] | `statements.ts` — เพิ่มพารามิเตอร์ `manualJournalLines: JournalLine[] = []` ใน `buildStatements()` → concat ก่อนเข้า `buildLedger` | `lib/accounting/statements.ts` | C2 | เทสต์เดิม (`statements.test.ts`) ผ่านด้วย default `[]` (ไม่กระทบ behavior เดิม) + เทสต์ใหม่: ส่ง manual lines เข้าไป → ปรากฏใน ledger/trial-balance/งบ ถูกต้อง สมดุลรวมยังผ่าน |
| **C4** [⚠️ FLAG — ดู 0.8] | `journal-books.ts` — เพิ่มเส้นทาง merge manual posting (จาก `toJournalPosting`) เข้าเล่มตาม `doc_type` (แก้ TODO เดิมเรื่องเล่มรับ/จ่ายเงินว่างเปล่า) | `lib/accounting/journal-books.ts` | C2 | unit test: entry `doc_type='PV'` → โผล่ในเล่ม "สมุดรายวันจ่ายเงิน", `RV`→"รับเงิน", `JV`→"ทั่วไป" · ยอดรวมเล่มยังสมดุล (debit=credit) รวมทั้งบิลกับ manual entry ในเล่มเดียวกัน |
| **C5** [โค้ดได้เลย] | `report-filter.ts` — เพิ่ม `filterManualEntriesForReport(entries, period)` (semantics เดียวกับ `filterEntriesForReport` เดิม: กรองงวด + `includeDraft`) | `lib/accounting/report-filter.ts` | C1 | unit test คู่กับของเดิม (ครอบ from/to/includeDraft ทุก branch) |
| **C6** [โค้ดได้เลย] | หน้าลงบันทึกบัญชีเอง `/chat-audit/accounting/journal-entry` — เลือกลูกค้า (สโคป) → `JournalEntryPanel` (header: doc_type/date/doc_no/memo + ตาราง lines แก้ได้ทีละบรรทัด ใช้ combobox เดียวกับ `EntryEditor.tsx::searchChartNonBankGrouped` + เช็คสมดุล debit=credit ก่อนกด "ยืนยัน" + list entries เดิมของลูกค้ารายนี้ แก้/ลบ/ยืนยันได้) | `journal-entry/page.tsx`, `JournalEntryPanel.tsx`, `actions.ts` | C2, A8 | `requireAccountingAccess`+`assertCustomerInScope` ทุก write · สมดุลไม่ผ่าน → ปฏิเสธบันทึกพร้อมข้อความ (ทั้ง client hint + server validate จริง) · confirm แล้วแก้ไม่ได้ (ต้อง unlock/ยกเลิกก่อน เหมือน pattern bill_entries confirmed) |
| **C7** [โค้ดได้เลย] | เสียบ manual JE เข้ารายงานจริง: `reports/page.tsx`, `reports/export/route.ts`, `journal-books/page.tsx` — โหลด manual entries (confirmed ตามงวดที่เลือก) → map ผ่าน C2/C5 → ส่งเข้า `buildStatements`/`buildJournalBooks` | 3 ไฟล์ข้างต้น | C3, C4, C5, C6 | เปิดหน้า reports จริง → สร้าง manual JE 1 รายการ (เช่น ปรับปรุงค่าเสื่อม) → confirm → เห็นผลกระทบในงบทดลอง/งบการเงินทันที (ตรวจด้วยตา + เทียบเลขมือ) |
| **C8** [โค้ดได้เลย] | เทสต์ครบ: `manual-journal.test.ts`, `journal-entry-actions.test.ts`, อัปเดต `statements.test.ts`/`journal-books.test.ts`/`report-filter.test.ts` | `tests/accounting/*` | C1-C7 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M3 (ส่วน C)**: ลงบันทึกบัญชีเองได้จริง ยืนยันแล้วไหลเข้าสมุดรายวัน/บัญชีแยกประเภท/งบทดลอง/
งบการเงินถูกต้อง ครบ 3 ส่วนของเฟส 1

### D — ปิดงานเฟส 1

| รหัส | สิ่งที่ต้องทำ | ขึ้นกับ | เกณฑ์เสร็จ |
|---|---|---|---|
| **D1** [โค้ดได้เลย] | รันชุดตรวจสอบเต็ม + ทดสอบมือทั้ง 3 ส่วนต่อเนื่องกัน (สร้างผังใหม่ → สร้างสินค้า → ใช้สินค้าในบิล → ลง manual JE → เห็นผลในงบ) | A1-A9, B1-B6, C1-C8 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม + เทสต์ใหม่ทุกตัว) · ไม่มี `console.*` ที่มี PII/เลขเงิน/ชื่อลูกค้า · ไม่มี mock/stub ในโค้ด production |

---

## 3) Definition of Done (เฟส 1 รวม)

- [ ] **A**: ผังบัญชีแก้ไขได้จริงผ่านหน้า admin — เพิ่ม/แก้ชื่อ/สลับหมวดเงินฝาก/soft-delete ได้ (ยกเว้นรหัส
      โครงสร้าง 0.7) — ทุกหน้าที่เคยใช้ผัง hardcode (ลงบัญชี/ยอดยกมา/AI สกัดบิล/worker) อ่านจาก DB จริง
      ไม่มี `CHART_OF_ACCOUNTS` hardcode array เหลือใช้งานจริงที่ไหนอีก (คงไว้แค่ในคอมเมนต์ migration seed)
- [ ] **B**: สร้าง/แก้/ลบสินค้าได้ผ่านหน้า admin · เลือกสินค้าในบรรทัดบิลได้จริง prefill ถูกต้อง ·
      ไม่กระทบ engine บัญชีเดิมแม้แต่จุดเดียว (regression = 0)
- [ ] **C**: ลงบันทึกบัญชีเอง (JV/PV/RV) ได้จริง ยืนยันความสมดุล debit=credit ทั้ง client-hint และ
      server-validate (ปฏิเสธถ้าไม่สมดุล) · entry ที่ confirm แล้วไหลเข้าสมุดรายวัน(เล่มถูกต้องตาม doc_type)/
      บัญชีแยกประเภท/งบทดลอง/งบกำไรขาดทุน/งบแสดงฐานะถูกต้องจริง (ตรวจเทียบเลขมือ)
- [ ] ทุก write path ผ่าน guard ที่ถูกต้อง (admin สำหรับผัง/สินค้า, `requireAccountingAccess`+
      `assertCustomerInScope` สำหรับ manual JE)
- [ ] รหัสบัญชีโครงสร้าง (VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้/กำไรสะสม/เงินฝาก 3 บัญชี) ลบไม่ได้จากหน้าจัดการผัง
- [ ] ไม่มี `console.log`/log ที่มี PII/ตัวเลข/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี secret ฝังในโค้ด (เฟสนี้ไม่มี secret ใหม่)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่
- [ ] ไม่มี regression ในฟีเจอร์เดิมที่พึ่งผังบัญชี (ลงบัญชีซื้อ/ขาย, AI สกัดบิล, ยอดยกมา, บัญชีเงินฝาก,
      รายงานภาษี, FlowAccount sync M1/M2) — ทดสอบด้วยตาจริงทุกจุดที่แก้ (ดูหมวด 4)

---

## 4) แนวทางการทดสอบ

**Unit test (ตามตารางงาน A/B/C ข้างบน) — เน้นจุดที่เปลี่ยน signature เป็นพารามิเตอร์:**
- `chart-of-accounts.ts`: ทุกฟังก์ชัน pure รับ chart อะไรมา ต้องได้ผลลัพธ์ตามนั้น (ไม่ hardcode ในตัวมันเองอีก)
- `chart-accounts-data.ts`: CRUD + PROTECTED_CODES guard (ลบรหัสป้องกัน/ปลด is_bank ที่มีลูกค้าผูก → ปฏิเสธ)
- `journal.ts`/`ledger.ts`/`payment.ts`/`opening-balance.ts`/`bank-accounts.ts`/`statements.ts`: ผลลัพธ์
  เดิมทุกตัวต้องเหมือนเดิมเป๊ะเมื่อส่ง fixture chart ที่ตรงกับ 75 รายการเดิม (regression test เป็นหลัก)
- `bill-extract.ts`: prompt เปลี่ยนตาม chart ที่ส่งเข้าจริง + validate account_code ตามผังที่ส่งเข้า (ไม่ใช่
  hardcode) + AI เดายังไม่มั่นใจ → null เหมือนเดิม
- `products.ts`: CRUD + search + validate
- `manual-journal.ts`: validate (สมดุล/บัญชีอยู่ในผัง/จำนวนบรรทัดขั้นต่ำ) + mapper `toJournalLines`/
  `toJournalPosting` ให้ผลตรงตามกติกา double-entry เดิม (debit=credit ต่อ entry)

**Integration/manual (บน dev จริง — ทำต่อเนื่องกันเป็น flow เดียว):**
1. เปิด `/chat-audit/admin/chart-of-accounts` (role admin) → แก้ชื่อบัญชี 1 ตัว → เปิดหน้าลงบัญชีดู
   combobox ว่าชื่อเปลี่ยนตามจริง
2. ลองลบรหัส `1010` (เงินสด) → ต้องถูกปฏิเสธพร้อมข้อความ
3. เพิ่มรหัสบัญชีใหม่ (เช่น `5390` ทดสอบ) → ไปเลือกใช้ในบรรทัดบิลจริง → ยืนยันบิล → เปิดงบทดลองเห็นรหัสใหม่จริง
4. เปิด `/chat-audit/admin/products` (role admin) → เพิ่มสินค้า 1 ตัว (มี default_account_code) → ไปหน้า
   ลงบัญชี เลือกสินค้านั้นในบรรทัด → ตรวจว่า description/account_code เติมถูก → บันทึก → ตรวจ `product_id`
   ติดจริงใน DB
5. อัปโหลดบิลใหม่ผ่านไลน์ (หรือ trigger worker) → ตรวจว่า AI ยังแนะนำ account_code ได้ตามผังปัจจุบัน (รวม
   รหัสที่เพิ่งเพิ่มใหม่ในข้อ 3 ถ้าตรงบริบท)
6. เปิด `/chat-audit/accounting/journal-entry` (role นักบัญชี) → เลือกลูกค้าที่ตัวเองดูแล → สร้าง JV ปรับปรุง
   1 รายการ (เดบิต=เครดิต) → กด "ยืนยัน" → เปิดงบทดลอง/งบกำไรขาดทุน/งบแสดงฐานะของลูกค้ารายนั้น → ตัวเลขต้อง
   เปลี่ยนตามที่คำนวณมือ
7. สร้าง manual JE ที่ debit≠credit ตั้งใจ → กด "ยืนยัน" → ต้องถูกปฏิเสธ (server-side จริง ไม่ใช่แค่ client)
8. สร้าง manual JE `doc_type='PV'`/`'RV'` → เปิดหน้าสมุดรายวัน → ต้องโผล่ในเล่ม "จ่ายเงิน"/"รับเงิน" ตามลำดับ
   (เล่มที่เคยว่างเปล่ามาตลอด)
9. นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → เปิด `/chat-audit/accounting/journal-entry?customerId=...` ของลูกค้า
   คนอื่น → ต้องไม่เห็น/ทำรายการไม่ได้ (ทดสอบผ่าน session นักบัญชีจริง)
10. ทดสอบฟีเจอร์เดิมที่พึ่งผังบัญชีทุกตัวว่ายังทำงานถูก (regression เต็ม): ลงบัญชีซื้อ/ขายปกติ, ยอดยกมา,
    ผูกบัญชีเงินฝากลูกค้า, ส่งบิลไป FlowAccount (M1/M2 เดิม)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| Seed migration 0063 พิมพ์ผิด/ตกหล่นแถวตอนแปลง 75 รายการเป็น SQL VALUES | เขียนสคริปต์ช่วย (Node ชั่วคราว ไม่ commit) generate SQL VALUES จาก `CHART_OF_ACCOUNTS` เดิมก่อนลบไฟล์ ลด human error; หลัง apply เทียบจำนวนแถว+เทียบ code รายตัวกับไฟล์เดิมด้วยเทสต์ 1 ตัว |
| Thread `chart`/`chartByCode` param เข้าทุกจุด (A2-A9) กระทบไฟล์เยอะ + เทสต์เยอะ ตกหล่นจุดใดจุดหนึ่งจะ compile error ชัดเจน (ไม่ใช่ runtime silent) | ใช้ TypeScript เป็นตัวช่วยหลัก — เปลี่ยน signature ก่อน (ไม่ default เป็น optional จริง ให้ TS ฟ้อง caller ที่ยังไม่ส่ง) แล้วไล่แก้ทีละ compile error จนหมด รับประกันไม่ตกหล่น |
| AI prompt behavior เปลี่ยนหลัง A5 (พรอมต์ผูกกับผังจริงของ tenant ไม่ใช่ผังกลาง static อีกต่อไป) | เทียบผลลัพธ์ AI ก่อน/หลังด้วย chart ที่ตรงกับ 75 รายการเดิมเป๊ะ (ต้องได้ผลเหมือนเดิมทุกกรณีทดสอบ) ก่อน merge — ถือเป็น regression gate ของ A5 |
| Admin แก้/ลบผังบัญชีจนกระทบรายงานเก่าที่อ้างชื่อ/หมวดบัญชีตอนนั้น (บัญชีแยกประเภท/งบเก่าที่พิมพ์ไปแล้วอาจ ไม่ตรงกับผังปัจจุบันถ้าย้อนดูอนาคต) | ไม่ใช่ปัญหาจริงในเฟสนี้ — `bill_entry_lines`/`manual_journal_entry_lines` เก็บ `account_name` ต่อบรรทัด ณ เวลาที่บันทึกอยู่แล้ว (ไม่ join สดกับผังปัจจุบันเสมอ) engine ใช้ชื่อที่เก็บไว้เป็นหลัก ผังปัจจุบันใช้แค่ตอน "เลือกใหม่"/prefill เท่านั้น — ข้อมูลย้อนหลังไม่กระทบ |
| `product_id` อ้างอิงสินค้าที่ถูก soft-delete ไปแล้ว (บรรทัดเก่ายังมี FK ชี้อยู่) | ใช้ `on delete set null` ไม่ได้ (soft-delete ไม่ใช่ DB delete จริง) — ยอมให้ `product_id` ชี้สินค้าที่ `is_active=false`/`deleted_at` ได้ (เหมือน `bill_entry_lines.account_code` ที่ไม่ FK จริงอยู่แล้ว) UI แค่ไม่โชว์สินค้านั้นในตัวเลือกใหม่ ไม่ลบข้อมูลเก่า |
| Manual JE ทำให้ debit/credit ไม่สมดุล "รวมทั้งระบบ" ถ้า validate พลาดจุดใดจุดหนึ่ง (เช่น แก้ entry ที่ confirm แล้วโดยไม่เช็คสมดุลใหม่) | ล็อกกฎ "แก้ได้เฉพาะตอน draft" (เหมือน `bill_entries.status='confirmed'` ที่ล็อกการแก้เดิม) — entry ที่ confirm แล้วต้อง "ยกเลิกการยืนยัน" ก่อนแก้ (กลับเป็น draft) แล้วเช็คสมดุลใหม่ทุกครั้งก่อน confirm ซ้ำ |
| งาน C4 (route manual JE เข้าเล่มรับ/จ่ายเงิน) อาจไม่ตรงกับที่นักบัญชีทีมจริงคาดหวัง (สมมติฐานเรื่องการจัดเล่มยังไม่มีคนยืนยัน 100% เหมือนที่ `journal-books.ts` คอมเมนต์ไว้ว่า "ต้องยืนยัน") | ทำตาม mapping ที่ตรงไปตรงมาที่สุด (JV→ทั่วไป, PV→จ่ายเงิน, RV→รับเงิน) ตามชื่อเอกสารมาตรฐานบัญชีไทย — ถ้านักบัญชีทีมใช้จริงแล้วไม่ตรง แก้ที่ `toJournalPosting()` จุดเดียว (ไม่กระทบโครงสร้างตาราง/engine อื่น) |
| ปริมาณงานเทสต์ที่ต้องแก้ (analyst ประเมินว่า "กระทบเทสต์เยอะ") อาจทำให้ตกหล่นเทสต์บางไฟล์ | ใช้ `npm run test` แบบรันทั้งชุดหลังแก้ทุกจุด (ไม่ใช่ไล่ทีละไฟล์) ให้ vitest ฟ้องไฟล์ที่พังจริงครบ ก่อนถือว่า D1 เสร็จ |

---
---

# เฟส 2 — แผนละเอียด: รับ/จ่ายเงินแยกจากบิล + ลูกหนี้/เจ้าหนี้ค้างชำระตามอายุ

**สโคป (ยืนยันจากผู้ใช้):** (E) บันทึกรับเงิน/จ่ายเงินจริง แยกออกจากตัวบิล — สำหรับบิลเชื่อ (`payment_method
='credit'`) ที่ทยอยรับ/จ่ายเงินทีหลัง ไม่ใช่ครั้งเดียวตอนลงบิล · (F) `due_date` ต่อบิล (กำหนดชำระ) · (G)
รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ (AR/AP Aging Report)

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน — ไม่ต้องสร้างใหม่ตั้งแต่ต้น):
- `bill_entries.payment_method='credit'` + `contraAccountFor()` (`lib/accounting/payment.ts`) ที่ตั้งบัญชีคู่
  เป็น **1140 ลูกหนี้การค้า** (ขาย) / **2010 เจ้าหนี้การค้า** (ซื้อ) อยู่แล้วตอนยืนยันบิล — แต่ปัจจุบัน "ตั้งค้าง
  ไว้ตลอด" ไม่มีกลไกลดยอดเมื่อรับ/จ่ายเงินจริงทีหลัง (ช่องว่างที่เฟสนี้ปิด)
- `manual-journal.ts`/`journal-books.ts::buildJournalBooks(entries, chartByCode, manualPostings)` — พารามิเตอร์
  `manualPostings: JournalPosting[]` เป็น **generic อยู่แล้ว** (ไม่ผูกกับ manual JE โดยเฉพาะ) → เฟสนี้ผสม
  posting ของการรับ/จ่ายเงินเข้าพารามิเตอร์เดิมนี้ตรง ๆ ไม่ต้องแก้ signature ของ `buildJournalBooks`
- `statements.ts::buildStatements(entries, opening, chartByCode, manualJournalLines)` — พารามิเตอร์
  `manualJournalLines: JournalLine[]` เดิมก็รับ `JournalLine[]` ทั่วไป → concat เข้าที่ **call site** (ไม่แก้
  signature ของ `buildStatements` เลย)
- `statement-config.ts` มี `AR="1140"`, `AP="2010"` เป็นค่าคงที่พร้อมใช้แล้ว (ผูกใน `PROTECTED_CODES` ของเฟส 1
  ห้ามลบอยู่แล้ว — เข้ากันได้ดี)

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ขอบเขต "การชำระ" ที่ต้องแยกบันทึก — เฉพาะบิลเชื่อเท่านั้น
บิลที่ `payment_method` เป็น `cash`/`cheque`/`transfer` ถือว่า **จ่ายเงินเสร็จสิ้นตอนยืนยันบิล** อยู่แล้ว
(ลงบัญชีคู่ตรงกับเงินสด/เช็ค/ธนาคารทันที) — ไม่มีสถานะ "ค้างชำระ" ให้ต้องติดตาม
มีแค่ `payment_method='credit'` เท่านั้นที่ตั้ง AR/AP ค้างไว้ → เป็นบิลกลุ่มเดียวที่ต้องมี "การบันทึกรับ/จ่ายเงิน"
แยกทีหลัง และเป็นกลุ่มเดียวที่เข้ารายงานลูกหนี้/เจ้าหนี้ค้างชำระ (ส่วน G)
**[⚠️ FLAG]** ผู้ใช้ยังไม่ได้ยืนยันชัดเจนว่ามีเคส "รับเงินบางส่วนแล้วยกเลิกวิธีจ่ายจาก cash เป็น credit ย้อนหลัง"
หรือไม่ — เฟสนี้ไม่รองรับการแปลงย้อนหลังข้ามวิธีจ่าย ถ้าพบเคสจริงให้แจ้งผู้ใช้และดีลเป็นกรณีเฉพาะ

### 0.2 โมเดลข้อมูล: 1 บิล มีได้หลาย "การรับ/จ่ายเงิน" (ตารางใหม่ `bill_payments`)
ไม่ขยาย `bill_entries` (จะพังแนวคิด 1 แถว = 1 บิล) และไม่ใช้ `manual_journal_entries` (นั่นคือรายการปรับปรุง
อิสระ ไม่ผูกบิลต้นทาง) — สร้างตารางใหม่ `bill_payments` ผูก `entry_id` (FK `bill_entries.id`) แบบ 1-ต่อ-กลาย
(1 บิลเชื่อ ผ่อน/ทยอยรับได้หลายงวด) ตามแนวทางเดียวกับที่เฟส 1 ใช้แยกตาราง manual JE (เหตุผลเดียวกัน: โครงสร้าง
ข้อมูลคนละแบบกับหัวบิล)
- `bill_payments` **ไม่มีสถานะ draft/confirmed** (ต่างจาก manual JE) — การบันทึกรับ/จ่ายเงินถือว่า "เงินเข้า/
  ออกจริงแล้ว" ตั้งแต่กดบันทึก (เหมือนใบสำคัญรับ/จ่ายที่ออกย้อนหลังตามเงินที่เข้าบัญชีจริง) แก้ไขไม่ได้หลังบันทึก
  — ผิดพลาดต้อง **ยกเลิก (soft-delete)** แล้วบันทึกรายการใหม่ที่ถูกต้อง (เหมือน `bill_entries`/`manual JE`
  ที่ soft-delete แทนแก้ตัวเลขย้อนหลังเงียบ ๆ)
- `method` รับได้เฉพาะ `cash`/`cheque`/`transfer` (ตัดตัวเลือก `credit` ออก — การชำระจริงไม่มีทาง "เชื่อ" ต่อ
  การเชื่อได้อีก)

### 0.3 ยอดค้างชำระต่อบิล (outstanding) — คำนวณจากของที่มีอยู่แล้ว ไม่สร้างสูตรใหม่
ยอดเต็มของบิล (มูลค่าที่ตั้ง AR/AP ไว้ตอนยืนยัน) = `summarizeEntry(entry.lines).net` ที่มีอยู่แล้วใน
`lib/accounting/queries.ts` (= `amount + vat − wht` ต่อบิล ตรงกับสูตร `contraAmount` ใน `journal.ts` เป๊ะ — ไม่
มีสูตรคู่ขนานให้ค่าเพี้ยนกันได้) → `ยอดค้างชำระ = ยอดเต็ม − Σ(bill_payments.amount ที่ยังไม่ยกเลิกของบิลนั้น)`
บิลถือว่า "จ่ายครบแล้ว" เมื่อยอดค้างชำระ ≤ `EPSILON` (ค่าเดียวกับที่ `journal.ts`/`manual-journal.ts` ใช้)

### 0.4 double-entry ของการรับ/จ่ายเงิน — ใช้ `contraAccountFor()` เดิมซ้ำ ไม่เขียนสูตรใหม่
`contraAccountFor(chartByCode, method, entryType, bankAccountCode)` (`lib/accounting/payment.ts`, เฟส 1 คง
ไว้เดิม) รองรับ `cash`/`cheque`/`transfer` อยู่แล้ว → ใช้คำนวณ "บัญชีคู่" (เงินสด/เช็ค/ธนาคาร) ของการรับ/จ่ายเงิน
ได้ตรง ๆ ไม่ต้องเขียน mapping ใหม่:
- บิลขาย (ลด AR): **Dr** บัญชีที่ได้จาก `contraAccountFor(...,'sale',...)` = จำนวนที่รับ · **Cr** 1140 (AR)
- บิลซื้อ (ลด AP): **Dr** 2010 (AP) = จำนวนที่จ่าย · **Cr** บัญชีที่ได้จาก `contraAccountFor(...,'purchase',...)`
ทั้งคู่สมดุลเสมอ (2 บรรทัด ยอดเท่ากัน) — ไม่มีทางไม่สมดุล (ต่างจาก manual JE ที่คนกรอกได้หลายบรรทัด)

### 0.5 เข้าสมุดรายวัน/งบการเงิน — ผสมเข้าพารามิเตอร์ generic ที่มีอยู่แล้ว ไม่แก้ signature engine
- `toJournalLines(payment, entry, chartByCode)` → `JournalLine[]` (รูปเดียวกับที่ `journal.ts`/
  `manual-journal.ts` สร้าง) — concat เข้าที่ **call site** ของ `buildStatements()` พร้อมกับ manual JE lines
  เดิม (ไม่แก้ `statements.ts` เลย — `manualJournalLines` param เดิมรับ `JournalLine[]` ทั่วไปอยู่แล้ว)
- `toJournalPosting(payment, entry, chartByCode)` → `JournalPosting` พร้อม `book`: บิลขาย → `"receipt"`
  (สมุดรายวันรับเงิน) · บิลซื้อ → `"payment"` (สมุดรายวันจ่ายเงิน) — ผสมเข้าพารามิเตอร์ `manualPostings` เดิม
  ของ `buildJournalBooks()` ร่วมกับ posting ของ manual JE (ไม่แก้ `journal-books.ts` เลย เพราะออกแบบมา
  generic ตั้งแต่เฟส 1 แล้ว)

### 0.6 ⚠️ พบบั๊ก/gap ที่ค้างจากเฟส 1 ระหว่างตรวจโค้ด — แก้ไปพร้อมกันในเฟสนี้
**[⚠️ FLAG]** `app/chat-audit/accounting/journal-books/page.tsx` (หน้าจอที่คนดู) เรียก
`buildJournalBooks(entries, buildChartByCode(chart))` **โดยไม่ส่ง `manualPostings` เลย** ในขณะที่
`journal-books/export/route.ts` (ไฟล์ export) ส่ง `manualPostings` ถูกต้อง — แปลว่าปัจจุบันหน้าจอกับไฟล์ที่
export ไม่ตรงกัน (บนจอไม่เห็น manual JE ในเล่มรับ/จ่ายเงิน แต่ export เห็น) เนื่องจากต้องแก้ไฟล์นี้อยู่แล้วเพื่อ
ผสม `paymentPostings` เข้าไปด้วย (0.5) จะแก้ gap นี้ไปพร้อมกันในงานเดียว (เพิ่ม `manualPostings` ที่ขาดไป +
`paymentPostings` ใหม่ ในการเรียกเดียวกัน)

### 0.7 `due_date` — เก็บต่อบิล (ไม่ auto-คำนวณเทอมเครดิต ไม่ backfill ข้อมูลเก่า)
เพิ่มคอลัมน์ `due_date` (date, nullable) บน `bill_entries` แก้ได้จากหน้าลงบัญชี (`EntryEditor.tsx`) เหมือนฟิลด์
อื่น ๆ — **ไม่มี default อัตโนมัติ** (เช่น doc_date+30 วัน) ในเฟสนี้ เพื่อกันเดาเทอมเครดิตผิดของลูกค้าแต่ละราย
(ต่างกันได้ 0-90 วัน+) นักบัญชีกรอกเองตามเงื่อนไขจริงของบิลนั้น — บิลเก่าที่ confirmed ไปแล้วก่อนเฟสนี้จะมี
`due_date=null` เสมอ (ไม่ backfill) → รายงานอายุหนี้ (ส่วน G) ต้องรองรับเคส `due_date=null` แยกกลุ่มต่างหาก
(ดู 0.9) ไม่ปัดเป็น "ยังไม่ครบกำหนด" ทันที (จะทำให้เข้าใจผิดว่าไม่ค้างนาน)
`due_date` มีผลเฉพาะกับบิล `payment_method='credit'` เชิงความหมาย (ฟิลด์ยังกรอกได้ทุก payment_method ในระดับ
DB — ไม่บังคับด้วย constraint — แต่ UI/รายงานอายุหนี้ใช้จริงเฉพาะกลุ่ม credit เท่านั้นตาม 0.1)

### 0.8 ยอดชำระเกิน (overpayment) — ปฏิเสธเสมอ ไม่รับยอดเกินค้างชำระ
Server ต้อง re-fetch ยอดค้างชำระล่าสุดจาก DB (ไม่เชื่อค่าจากฝั่ง client) ก่อน insert ทุกครั้ง แล้วปฏิเสธถ้า
`amount > outstanding + EPSILON` — ไม่รองรับเครดิตค้างย้อนกลับ (เช่น ลูกค้าโอนเกิน) ในเฟสนี้ (ถ้าพบเคสจริงให้
แจ้งผู้ใช้แยกดีล ไม่ auto-สร้างเครดิตหนี้ย้อนกลับเงียบ ๆ)

### 0.9 Aging bucket — แยก "ไม่ระบุวันครบกำหนด" ออกจาก "ยังไม่ครบกำหนด" เสมอ
5 กลุ่ม (ไม่ใช่ 4): `no_due_date` (ไม่มี due_date) · `current` (มี due_date และ ≥ วันที่รายงาน) · `1-30` ·
`31-60` · `61-90` · `over_90` (เกิน 90 วัน) — คำนวณจาก `asOfDate − due_date` เป็นวัน เทียบกับวันที่ตั้งของ
รายงาน (`asOfDate`, ค่าเริ่มต้น = วันนี้ตามเวลาไทย แต่เลือกวันอื่นได้ เผื่อดูรายงาน ณ สิ้นเดือนที่ผ่านมา)
บิลที่ "จ่ายครบแล้ว" (outstanding ≤ EPSILON) **ไม่แสดง** ในรายงาน (ตรงตามเจตนา "ค้างชำระ" เท่านั้น — ไม่ใช่
ประวัติทั้งหมด)

### 0.10 กลุ่มก้อนของรายงาน (grouping) — กลุ่มตาม `counterparty_name` เดิมของบิล (ไม่ต้องมีตารางคู่ค้าใหม่)
`bill_entries.counterparty_name`/`counterparty_tax_id` (มีอยู่แล้ว, resolve แล้วตอนยืนยันบิล) คือชื่อ "อีกฝั่ง"
ที่ไม่ใช่ลูกค้าของสำนักงานบัญชี (ผู้ซื้อของบิลขาย = ลูกหนี้ตัวจริง, ผู้ขายของบิลซื้อ = เจ้าหนี้ตัวจริง) — ใช้ฟิลด์
นี้กลุ่มแถวในรายงานอายุหนี้ตรง ๆ ไม่ต้องสร้างตารางคู่ค้า/vendor master ใหม่ในเฟสนี้ (ขอบเขตนอกคำขอ)

### 0.11 สิทธิ์ — ยึด pattern เดียวกับ manual JE ของเฟส 1
- บันทึกรับ/จ่ายเงิน + ยกเลิกรายการ (ผูกบิล/ลูกค้ารายเดียว) → `requireAccountingAccess` +
  `assertCustomerInScope(customerId ของ entry ที่ผูก)` (นักบัญชีทำได้เฉพาะบิลของลูกค้าที่ตัวเองดูแล)
- รายงานลูกหนี้/เจ้าหนี้ค้างชำระ (ต่อลูกค้า) → guard เดียวกับหน้า reports/journal-books เดิม
  (`resolveAccountingAccess` + กรองลูกค้าตามสโคป — ไม่มีมุมมองข้าม tenant/ข้ามลูกค้าที่ไม่อยู่ในสโคป)

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 2

```
supabase/migrations/
  0067_bill_entries_due_date.sql   [ใหม่] เพิ่มคอลัมน์ due_date (date, nullable) บน bill_entries
  0068_bill_payments.sql           [ใหม่] ตาราง bill_payments (รับ/จ่ายเงินแยกจากบิล) + RLS
  ⚠️ เลขไฟล์ 0067-0068 อิง "0066 เป็นไฟล์ล่าสุด ณ วันที่วางแผน" (จากเฟส 1) — ก่อนสร้างไฟล์จริงให้
     `ls supabase/migrations` เช็คเลขล่าสุดอีกครั้งเผื่อมีงานอื่นแซงเข้ามาก่อน

lib/accounting/
  queries.ts            [แก้] BillEntry.dueDate: string | null · RawEntry.due_date · เพิ่มคอลัมน์ due_date
                                  ใน select ของ listEntries() + mapping
  actions-lib.ts        [แก้] UpsertEntryInput.dueDate?: string | null · payload.due_date (ใส่เฉพาะเมื่อส่งมา
                                  — undefined = ไม่แตะ ตาม pattern paymentMethod เดิม)
  bill-payments.ts      [ใหม่] data layer + validate + pure mapper (mirror ของ manual-journal.ts):
                                  - billNetTotal(entry) → reuse summarizeEntry(entry.lines).net (0.3)
                                  - billOutstanding(entry, payments) → ยอดค้างชำระ (0.3)
                                  - isCreditEligibleForPayment(entry) → entryType∈{sale,purchase} &&
                                    paymentMethod==='credit' && status==='confirmed'
                                  - validatePaymentInput(input, entry, existingPayments) → ปฏิเสธ overpay (0.8),
                                    method ผิด, entry ไม่ eligible (0.1)
                                  - toJournalLines(payment, entry, chartByCode) → JournalLine[] (0.5)
                                  - toJournalPosting(payment, entry, chartByCode) → JournalPosting (0.5)
                                  - getBillPaymentScope(db, tenantId, entryId) → {customerId, entryType,
                                    paymentMethod, status} (mirror getManualEntryScope)
                                  - listBillPayments(db, tenantId, entryId)
                                  - listBillPaymentsForEntries(db, tenantId, entryIds) → Map<entryId, Payment[]>
                                    (ใช้กับหน้ารายการ/รายงานที่ต้องดูหลายบิลพร้อมกัน)
                                  - recordBillPayment(db, tenantId, entryId, input) → insert (re-fetch ยอดค้าง
                                    ก่อนเสมอ ตาม 0.8)
                                  - voidBillPayment(db, tenantId, id) → soft-delete (0.2)
  aging.ts              [ใหม่] pure ทั้งไฟล์ (ไม่แตะ DB):
                                  - AgingBucketKey = 'no_due_date'|'current'|'1_30'|'31_60'|'61_90'|'over_90'
                                  - AGING_BUCKET_LABELS, AGING_BUCKET_ORDER (0.9)
                                  - ageBucket(dueDate, asOfDate) → AgingBucketKey
                                  - buildAgingReport(entries, paymentsByEntry, asOfDate) → { ar: AgingRow[],
                                    ap: AgingRow[], totalsByBucket } — กรอง eligible (0.1) + outstanding>EPSILON
                                    เท่านั้น + กลุ่มตาม counterpartyName (0.10)
  report-filter.ts      [แก้] เพิ่ม filterBillPaymentsForReport(payments, period) — กรองตาม pay_date เท่านั้น
                                  (ไม่มี includeDraft เพราะ bill_payments ไม่มีสถานะ draft ตาม 0.2)
  journal-books.ts      [ไม่ต้องแก้] — ยืนยันแล้วว่า manualPostings param เดิม generic พอสำหรับ paymentPostings
                                  ด้วย (0.5) — ใช้ซ้ำตรง ๆ

app/chat-audit/accounting/
  EntryEditor.tsx        [แก้] เพิ่ม state dueDate + input[type=date] (แสดงเมื่อ paymentMethod==='credit',
                                  label "วันครบกำหนดชำระ") ต่อจากช่อง "วิธีจ่าย/รับเงิน" ที่มีอยู่แล้ว (บรรทัด
                                  ~547-560) — รวมใน buildInput()
  actions.ts             [แก้] SaveEntryInput.dueDate?: string | null · validate รูปแบบวันที่ (YYYY-MM-DD) ·
                                  ส่งต่อ actions-lib.ts::upsertEntry
  payments/page.tsx      [ใหม่] เลือกลูกค้า (สโคป, pattern เดียวกับ journal-entry/page.tsx) → PaymentsPanel
                                  (list บิลเชื่อค้างชำระของลูกค้ารายนั้น)
  payments/PaymentsPanel.tsx [ใหม่] client — ต่อบิล: docNo/docDate/dueDate/aging bucket/ยอดเต็ม/ยอดค้างชำระ +
                                  ฟอร์มบันทึกรับ/จ่ายเงิน (pay_date/amount≤outstanding/method/บัญชีธนาคารถ้า
                                  transfer) + list ประวัติการรับ/จ่ายเงินเดิมของบิลนั้น (ปุ่ม "ยกเลิก" ต่อรายการ)
  payments/actions.ts     [ใหม่] recordBillPaymentAction(input) / voidBillPaymentAction(id) — guard
                                  requireAccountingAccess + assertCustomerInScope (0.11), เรียก bill-payments.ts
  ar-ap-aging/page.tsx    [ใหม่] เลือกลูกค้า + ณ วันที่ (asOfDate, default วันนี้) → โหลด entries+payments →
                                  buildAgingReport() → ตารางลูกหนี้ + ตารางเจ้าหนี้ (แยก 2 ตาราง) พร้อมยอดรวม
                                  ต่อ bucket (pattern หน้าเดียวกับ vat-report/page.tsx)
  ar-ap-aging/AgingReportDoc.tsx [ใหม่] ตารางแสดงผล/พิมพ์ (mirror VatReportDoc.tsx)
  ar-ap-aging/export/route.ts   [ใหม่] export Excel (2 ชีท: ลูกหนี้/เจ้าหนี้ ตาม bucket) — ใช้ exceljs ตรง ๆ
                                  แบบเดียวกับ lib/accounting/excel.ts (ไม่แชร์ helper กลาง — ระบบเดิมก็เขียน
                                  ต่อไฟล์แบบนี้อยู่แล้วทุกรายงาน)
  ar-ap-aging/aging-report.css  [ใหม่] สไตล์ตาราง/พิมพ์ (mirror vat-report.css)
  journal-books/page.tsx        [แก้] เพิ่ม manualPostings ที่ขาดไปเดิม (0.6, บั๊กเฟส 1) + paymentPostings ใหม่
                                  → รวมเข้า buildJournalBooks(entries, chartByCode, [...manualPostings,
                                  ...paymentPostings])
  journal-books/export/route.ts [แก้] เพิ่ม paymentPostings เข้าคู่กับ manualPostings เดิมที่มีอยู่แล้ว
  reports/page.tsx               [แก้] โหลด bill_payments ของช่วงงวด/ลูกค้าที่เลือก → toJournalLines ทุกตัว →
                                  concat เข้ากับ manualJournalLines เดิมก่อนส่ง buildStatements()
  reports/export/route.ts        [แก้] เหมือนกัน (export ต้องตรงกับที่หน้าจอเห็น)

tests/accounting/
  bill-payments.test.ts       [ใหม่] validate (overpay/method ผิด/entry ไม่ eligible) + billOutstanding +
                                  toJournalLines/toJournalPosting (สมดุล 2 บรรทัดเสมอ, book ถูกฝั่ง)
  aging.test.ts                [ใหม่] ageBucket ทุก branch (no_due_date/current/1-30/31-60/61-90/over_90,
                                  ค่าเผื่อขอบเขตวันพอดี 30/31/60/61/90/91) + buildAgingReport (กรอง eligible +
                                  outstanding>0 + กลุ่มตาม counterparty ถูกต้อง)
  report-filter.test.ts        [แก้] เพิ่มเทสต์ filterBillPaymentsForReport (from/to ทุก branch)
  queries.test.ts               [แก้] เพิ่ม dueDate ใน mapping fixture
  actions-lib.test.ts           [แก้] เพิ่มเทสต์ upsertEntry ส่ง/ไม่ส่ง dueDate (undefined = ไม่แตะค่าเดิม)
  journal-books.test.ts         [แก้] เทสต์ paymentPostings ผสมเข้าเล่มถูกฝั่ง (ขาย→receipt, ซื้อ→payment) +
                                  รวมกับ manualPostings ในเล่มเดียวกันยังสมดุล
  payments-actions.test.ts      [ใหม่] recordBillPaymentAction/voidBillPaymentAction — guard สโคป, ปฏิเสธ
                                  overpay ฝั่ง server (ไม่เชื่อ client), ปฏิเสธถ้า entry ไม่ eligible
```

### 1.1 Schema — migration 0067 (due_date)

```sql
alter table public.bill_entries
  add column if not exists due_date date;

-- index ช่วยสแกนรายงานอายุหนี้ (กรองบิลเชื่อที่ยังไม่ปิด ตามลูกค้า/วันครบกำหนด)
create index if not exists idx_bill_entries_due_date
  on public.bill_entries (tenant_id, due_date)
  where deleted_at is null and payment_method = 'credit';

notify pgrst, 'reload schema';
```

### 1.2 Schema — migration 0068 (bill_payments)

```sql
create table if not exists public.bill_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  entry_id        uuid not null references public.bill_entries(id) on delete cascade,
  -- customer_id สำเนาจาก bill_entries ตอนบันทึก (กันต้อง join ทุกครั้งตอนกรองสโคป/รายงาน — บิลเชื่อไม่ย้าย
  -- ลูกค้าหลังยืนยันแล้วในทางปฏิบัติ ระบบไม่มี UI ให้ย้ายลูกค้าของบิล confirmed อยู่แล้ว)
  customer_id     uuid references public.customers(id) on delete set null,
  pay_date        date not null,
  amount          numeric(14,2) not null check (amount > 0),
  method          text not null check (method in ('cash','cheque','transfer')),
  bank_account_id uuid references public.customer_bank_accounts(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists idx_bill_payments_tenant_entry
  on public.bill_payments (tenant_id, entry_id)
  where deleted_at is null;
create index if not exists idx_bill_payments_tenant_customer_date
  on public.bill_payments (tenant_id, customer_id, pay_date)
  where deleted_at is null;

drop trigger if exists trg_bill_payments_updated on public.bill_payments;
create trigger trg_bill_payments_updated before update on public.bill_payments
  for each row execute function public.set_updated_at();

alter table public.bill_payments enable row level security;
drop policy if exists tenant_read on public.bill_payments;
create policy tenant_read on public.bill_payments for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.bill_payments from anon;
grant select on public.bill_payments to authenticated;
grant all on public.bill_payments to service_role;

notify pgrst, 'reload schema';
```
**หมายเหตุ**: ไม่มี DB constraint ตรวจ "amount ≤ ยอดค้างชำระ" (ต้องรู้ยอดเต็มของบิล + ผลรวม payment อื่นก่อน
— คำนวณข้าม 2 ตาราง) → บังคับที่ **application layer** เท่านั้น (`validatePaymentInput`/`recordBillPayment`
ใน `bill-payments.ts`, ตาม 0.8) สอดคล้องกับ pattern เดิมทั้งระบบที่ไม่มี business-rule constraint ระดับ DB

---

## 2) งานย่อยเรียงลำดับ

**Legend**: [โค้ดได้เลย] = ทำตามสเปกได้ทันที · [⚠️ FLAG] = ทำต่อได้เลยแต่ต้องแจ้งผู้ใช้ (ดูรายละเอียดในหมวด 0)

### ส่วน E — due_date + engine รับ/จ่ายเงิน (bill_payments) — ทำก่อน F, G ทั้งคู่

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **E1** [โค้ดได้เลย] | Migration 0067 — เพิ่ม `due_date` บน `bill_entries` + index | `0067_bill_entries_due_date.sql` | - | apply ผ่านไม่ error (non-destructive) · เทสต์เดิมทั้งหมดผ่าน · คอลัมน์ใหม่ nullable ไม่กระทบแถวเก่า |
| **E2** [โค้ดได้เลย] | Migration 0068 — ตาราง `bill_payments` + RLS | `0068_bill_payments.sql` | - | apply ผ่าน · เทสต์เดิมทั้งหมดผ่าน |
| **E3** [โค้ดได้เลย] | `queries.ts` — เพิ่ม `dueDate` เข้า `BillEntry` type + select columns + mapping ของ `listEntries()` | `lib/accounting/queries.ts` | E1 | `queries.test.ts` ผ่าน (เพิ่ม fixture dueDate) · หน้าเดิมที่ใช้ `BillEntry` ยัง compile ผ่าน (optional-safe ตาม pattern `inputTaxMonth`/`flowaccountSync` เดิม) |
| **E4** [โค้ดได้เลย] | `actions-lib.ts` — `UpsertEntryInput.dueDate` + payload `due_date` (ใส่เฉพาะเมื่อส่งมา — undefined ไม่แตะค่าเดิม ตาม pattern `paymentMethod`) | `lib/accounting/actions-lib.ts` | E1 | `actions-lib.test.ts`: update ที่ไม่ส่ง dueDate → ค่าเดิมไม่เปลี่ยน · ส่ง dueDate ใหม่ → อัปเดตจริง · ส่ง `null` → ล้างค่า |
| **E5** [โค้ดได้เลย] | `bill-payments.ts` — pure: `billNetTotal`, `billOutstanding`, `isCreditEligibleForPayment`, `validatePaymentInput` (0.1/0.3/0.8) | `lib/accounting/bill-payments.ts` | E2 | unit test: ยอดเต็ม/ยอดค้างชำระตรงสูตร (0.3) · ปฏิเสธ overpay (0.8) · ปฏิเสธถ้า entry ไม่ใช่ credit/ไม่ confirmed (0.1) · ปฏิเสธ `method='credit'` |
| **E6** [โค้ดได้เลย] | `bill-payments.ts` — pure mapper `toJournalLines`/`toJournalPosting` (0.4/0.5, reuse `contraAccountFor`) | `lib/accounting/bill-payments.ts` | E5 | unit test: บิลขาย → Dr เงินสด/เช็ค/ธนาคาร, Cr 1140 (book=`receipt`) · บิลซื้อ → Dr 2010, Cr เงินสด/เช็ค/ธนาคาร (book=`payment`) · สมดุลเสมอ (debit=credit) ทุกเคส |
| **E7** [โค้ดได้เลย] | `bill-payments.ts` — data layer: `getBillPaymentScope`, `listBillPayments`, `listBillPaymentsForEntries`, `recordBillPayment` (re-fetch ยอดค้างก่อน insert เสมอ), `voidBillPayment` (soft-delete) | `lib/accounting/bill-payments.ts` | E5, E6 | unit test (mock DB หรือ integration เบา): insert สำเร็จเมื่อ amount≤outstanding · insert ถูกปฏิเสธเมื่อ overpay (คำนวณจาก DB จริง ไม่เชื่อ client) · void แล้ว outstanding กลับมาเดิม (payment ที่ deleted_at ไม่ถูกนับ) |
| **E8** [โค้ดได้เลย] | `aging.ts` — pure ทั้งไฟล์: `ageBucket` (0.9, ครอบขอบเขตวันพอดี 30/31/60/61/90/91) + `buildAgingReport` (0.9/0.10) | `lib/accounting/aging.ts` | E5 | unit test ครอบทุก bucket + edge case วันพอดีเขต + กรอง eligible/outstanding>0 ถูกต้อง + กลุ่มตาม counterpartyName ถูกต้อง (ยอดรวมต่อ bucket ตรง) |
| **E9** [โค้ดได้เลย] | `report-filter.ts` — เพิ่ม `filterBillPaymentsForReport(payments, period)` (กรองตาม `pay_date`, ไม่มี includeDraft) | `lib/accounting/report-filter.ts` | E2 | unit test ครอบ from/to ทุก branch (เหมือนของเดิม ตัด includeDraft) |

**Milestone M4 (ส่วน E)**: engine คำนวณยอดค้างชำระ/double-entry ของการรับ-จ่ายเงินถูกต้อง ครบทุก edge case
(overpay/ไม่ eligible/void) — ยังไม่มี UI ให้คนใช้จริง (ส่วน F, G ทำถัดไป)

### ส่วน F — บันทึกรับ/จ่ายเงิน (UI) + due_date ในหน้าลงบัญชี + เสียบเข้ารายงาน/สมุดรายวัน

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **F1** [โค้ดได้เลย] | `EntryEditor.tsx` — เพิ่มช่อง "วันครบกำหนดชำระ" (`input[type=date]`, แสดงเมื่อ `paymentMethod==='credit'`) ต่อจากช่องวิธีจ่าย/รับเงินเดิม + `actions.ts::SaveEntryInput.dueDate` + validate รูปแบบวันที่ | `EntryEditor.tsx`, `actions.ts` | E3, E4 | เปิดหน้าลงบัญชีจริง → เลือกวิธีจ่าย "ลูกหนี้/เจ้าหนี้" → เห็นช่องวันครบกำหนด → บันทึก → ค่าติดจริงใน DB (ตรวจผ่าน query) · เปลี่ยนวิธีจ่ายเป็นอื่นแล้วกลับมา credit → ค่าที่กรอกไว้ยังอยู่ (ไม่ถูกล้างทิ้งกลางทาง) |
| **F2** [โค้ดได้เลย] | `payments/page.tsx` + `PaymentsPanel.tsx` + `actions.ts` — หน้าใหม่ `/chat-audit/accounting/payments`: เลือกลูกค้า (สโคป) → list บิลเชื่อค้างชำระ (docNo/dueDate/ยอดเต็ม/ยอดค้าง) → ฟอร์มบันทึกรับ/จ่ายเงินต่อบิล + ประวัติ/ปุ่มยกเลิก | 3 ไฟล์ข้างต้น | E7, F1 | `requireAccountingAccess`+`assertCustomerInScope` ทุก write · บันทึกรับ/จ่ายเงินสำเร็จ → ยอดค้างชำระของบิลลดลงถูกต้องทันที (refresh เห็นจริง) · ลองบันทึกเกินยอดค้าง → ถูกปฏิเสธพร้อมข้อความ (server-side จริง) · กด "ยกเลิก" รายการ → ยอดค้างกลับมาเดิม |
| **F3** [⚠️ FLAG — ดู 0.6] | `journal-books/page.tsx` — เพิ่ม `manualPostings` ที่ขาดไปเดิม (บั๊กเฟส 1) + `paymentPostings` ใหม่ (จาก E6) → ผสมเข้า `buildJournalBooks()` เดียวกัน; `journal-books/export/route.ts` — เพิ่ม `paymentPostings` ให้ตรงกับหน้าจอ | `journal-books/page.tsx`, `journal-books/export/route.ts` | E6, E7 | บันทึกรับเงิน 1 รายการ (บิลขาย) → เปิดหน้าสมุดรายวัน → โผล่ในเล่ม "รับเงิน" ถูกต้อง ยอดสมดุล · บันทึกจ่ายเงิน 1 รายการ (บิลซื้อ) → โผล่เล่ม "จ่ายเงิน" · export Excel ตรงกับที่จอเห็นเป๊ะ (ตัวเลข/จำนวนแถวเท่ากัน) |
| **F4** [โค้ดได้เลย] | `reports/page.tsx`/`reports/export/route.ts` — โหลด `bill_payments` ของงวด/ลูกค้าที่เลือก (ผ่าน E9) → `toJournalLines` ทุกตัว → concat เข้ากับ `manualJournalLines` เดิมก่อนส่ง `buildStatements()` | 2 ไฟล์ข้างต้น | E6, E9 | บันทึกรับเงิน 1 รายการ → เปิดงบทดลอง → AR (1140) ลดลงตามยอดที่รับจริง, บัญชีเงินสด/ธนาคารเพิ่มขึ้นตรงกัน (สมดุลรวมยังผ่าน) — ตรวจเทียบเลขมือ |

**Milestone M5 (ส่วน F)**: บันทึกรับ/จ่ายเงินแยกจากบิลได้จริงผ่าน UI ยอดค้างชำระลดถูกต้อง ไหลเข้าสมุดรายวัน/
งบการเงินถูกฝั่งถูกเล่ม

### ส่วน G — รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุ (AR/AP Aging)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **G1** [โค้ดได้เลย] | หน้า `/chat-audit/accounting/ar-ap-aging` — เลือกลูกค้า (สโคป) + วันที่ตั้งรายงาน (`asOfDate`, default วันนี้เวลาไทย) → โหลด entries (credit, confirmed) + payments → `buildAgingReport()` → แสดง 2 ตาราง (ลูกหนี้/เจ้าหนี้) พร้อมยอดรวมต่อ bucket | `ar-ap-aging/page.tsx`, `AgingReportDoc.tsx`, `.css` | E8 | เปิดหน้าจริง → เลือกลูกค้าที่มีบิลเชื่อค้างชำระ → เห็นแถวถูก bucket ตรงกับวันครบกำหนดจริง (ตรวจด้วยตา/คำนวณมือ) · เปลี่ยน `asOfDate` → bucket ขยับตามจริง · บิลที่จ่ายครบแล้วไม่โผล่ในรายงาน |
| **G2** [โค้ดได้เลย] | `ar-ap-aging/export/route.ts` — export Excel (2 ชีท ลูกหนี้/เจ้าหนี้ ตาม bucket, ใช้ exceljs ตรง ๆ) | `export/route.ts` | G1 | export ตรงกับที่หน้าจอเห็นเป๊ะ (จำนวนแถว/ยอดรวมต่อ bucket เท่ากัน) |
| **G3** [โค้ดได้เลย] | เทสต์ครบส่วน G: `aging.test.ts` (ถ้ายังไม่ครบจาก E8), ตรวจ integration ของหน้า/export ด้วยมือ | `tests/accounting/aging.test.ts` | E8, G1, G2 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M6 (ส่วน G)**: นักบัญชี/หัวหน้าทีมดูยอดลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ของลูกค้าแต่ละรายได้จริง
ครบ 3 ส่วนของเฟส 2

### H — ปิดงานเฟส 2

| รหัส | สิ่งที่ต้องทำ | ขึ้นกับ | เกณฑ์เสร็จ |
|---|---|---|---|
| **H1** [โค้ดได้เลย] | รันชุดตรวจสอบเต็ม + ทดสอบมือทั้ง 3 ส่วนต่อเนื่องกัน (ลงบิลเชื่อใหม่ + ตั้ง due_date → บันทึกรับ/จ่ายเงินบางส่วน → เปิดรายงานอายุหนี้เห็นยอดค้างถูกต้อง → บันทึกจนครบ → บิลหลุดจากรายงาน) | E1-E9, F1-F4, G1-G3 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม + ใหม่ทุกตัว) · ไม่มี `console.*` ที่มี PII/เลขเงิน/ชื่อลูกค้า · ไม่มี mock/stub ในโค้ด production |

---

## 3) Definition of Done (เฟส 2 รวม)

- [ ] **E**: `due_date` แก้ได้จริงจากหน้าลงบัญชีสำหรับบิลเชื่อ · `bill_payments` คำนวณยอดค้างชำระถูกต้อง
      (ตรงกับ `ยอดเต็ม − Σรับ/จ่ายจริงที่ยังไม่ยกเลิก`) · ปฏิเสธยอดชำระเกินค้างเสมอ (server-side) · double-entry
      ของการรับ/จ่ายเงินสมดุลทุกเคส (สอดคล้องบัญชีคู่เดิมของระบบ — ใช้ `contraAccountFor` ตัวเดียวกับบิล)
- [ ] **F**: บันทึก/ยกเลิกการรับ-จ่ายเงินได้จริงผ่านหน้า `/chat-audit/accounting/payments` เฉพาะบิลเชื่อที่
      ยืนยันแล้วเท่านั้น (บิล draft/ไม่ใช่ credit ทำไม่ได้) · ไหลเข้าสมุดรายวัน (เล่มรับ/จ่ายเงินถูกฝั่ง) และ
      งบทดลอง/งบการเงินถูกต้องจริง (AR/AP ลดลงตามยอดที่รับ/จ่ายจริง) — ตรวจเทียบเลขมือ
- [ ] **G**: รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ใช้งานได้จริง แบ่ง 6 กลุ่ม (ไม่ระบุกำหนด/ยังไม่ครบกำหนด/
      1-30/31-60/61-90/เกิน 90 วัน) ถูกต้องตามวันที่ตั้งรายงาน · บิลที่จ่ายครบแล้วไม่ปนอยู่ในรายงาน · export
      Excel ตรงกับที่จอเห็น
- [ ] ทุก write path ผ่าน guard ที่ถูกต้อง (`requireAccountingAccess`+`assertCustomerInScope` ตามบิลที่ผูก)
- [ ] แก้บั๊ก/gap ที่พบระหว่างตรวจโค้ด (0.6): `journal-books/page.tsx` กับ `export/route.ts` แสดงผลตรงกัน
      (ทั้งคู่รวม manual JE + bill payments ครบ ไม่ใช่แค่ไฟล์ export)
- [ ] ไม่มี `console.log`/log ที่มี PII/ตัวเลข/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี secret ฝังในโค้ด (เฟสนี้ไม่มี secret ใหม่)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่
- [ ] ไม่มี regression ในฟีเจอร์เดิมที่พึ่งบิล/รายงาน (ลงบัญชีซื้อ/ขายปกติ, สมุดรายวัน/งบการเงินเดิมที่ไม่มี
      บิลเชื่อ/manual JE เกี่ยวข้อง, manual JE ของเฟส 1)

---

## 4) แนวทางการทดสอบ

**Unit test (ตามตารางงาน E/F/G ข้างบน) — เน้น pure logic ที่คำนวณเงิน/สมดุล/bucket:**
- `bill-payments.ts`: `billOutstanding` ตรงสูตรทุกเคส (ยังไม่จ่าย/จ่ายบางส่วน/จ่ายครบ/เกิน EPSILON เล็กน้อย) ·
  `validatePaymentInput` ปฏิเสธ overpay/method ผิด/entry ไม่ eligible ทุก branch · `toJournalLines`/
  `toJournalPosting` สมดุลเสมอ + book ถูกฝั่ง (ขาย→receipt, ซื้อ→payment) + ใช้บัญชีคู่ตรงกับ `contraAccountFor`
- `aging.ts`: `ageBucket` ครอบทุก bucket รวมขอบเขตวันพอดี (เช่น due_date = asOfDate−30 วันเป๊ะ ต้องอยู่ bucket
  ไหน) · `buildAgingReport` กรอง eligible + outstanding>0 ถูกต้อง + กลุ่ม/ยอดรวมต่อ counterparty/bucket ตรง
- `report-filter.ts`: `filterBillPaymentsForReport` ครอบ from/to ทุก branch
- `journal-books.ts` (integration ระดับไฟล์ที่แก้): posting ของ bill payment ผสมกับของบิล/manual JE ในเล่ม
  เดียวกันแล้วยังสมดุลรวม (debit=credit ทั้งเล่ม)

**Integration/manual (บน dev จริง — ทำต่อเนื่องกันเป็น flow เดียว):**
1. เปิดบิลขายที่ยืนยันแล้ว (หรือสร้างใหม่) → ตั้งวิธีจ่ายเป็น "ลูกหนี้" → กรอกวันครบกำหนดชำระ → บันทึก →
   ตรวจว่า `due_date` ติดจริงใน DB
2. เปิด `/chat-audit/accounting/payments` เลือกลูกค้ารายเดียวกัน → เห็นบิลนั้นค้างชำระเต็มยอด
3. บันทึกรับเงินบางส่วน (เช่น ครึ่งยอด) → ยอดค้างชำระลดลงถูกต้องทันที
4. เปิด `/chat-audit/accounting/ar-ap-aging` → เห็นบิลนั้นอยู่ bucket ตามวันครบกำหนดจริง ยอดค้างตรงกับข้อ 3
5. เปิด `/chat-audit/accounting/journal-books` → เห็นรายการรับเงินโผล่ในเล่ม "รับเงิน" ยอดตรงกับที่บันทึก ·
   export Excel → ตัวเลขตรงกับที่จอเห็น
6. เปิด `/chat-audit/accounting/reports` → งบทดลอง → AR (1140) ลดลงตามยอดที่รับจริง, บัญชีเงินสด/ธนาคารที่ใช้
   รับเพิ่มขึ้นตรงกัน (สมดุลรวมยังผ่าน)
7. บันทึกรับเงินอีกครั้งจนครบยอดเต็ม → บิลหลุดจากทั้งหน้า `/payments` (ไม่มียอดค้างให้บันทึกต่อ) และหน้า
   `/ar-ap-aging` (ไม่ค้างชำระแล้ว)
8. ลองบันทึกรับเงินเกินยอดค้าง (ตั้งใจ) → ต้องถูกปฏิเสธพร้อมข้อความ (server-side จริง ไม่ใช่แค่ client)
9. กด "ยกเลิก" รายการรับเงินที่บันทึกไว้ → ยอดค้างชำระของบิลกลับมาเดิม → บิลกลับมาโผล่ในหน้า `/payments`/
   `/ar-ap-aging` อีกครั้ง
10. ทำบิลซื้อเชื่อคู่กัน (ตั้งเจ้าหนี้ 2010) + บันทึกจ่ายเงินบางส่วน → ตรวจฝั่งเจ้าหนี้ในทุกจุดข้างบนเหมือนกัน
    (`/payments`, `/ar-ap-aging`, สมุดรายวันเล่ม "จ่ายเงิน", งบทดลอง AP ลดลงถูกต้อง)
11. นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → เปิด `/chat-audit/accounting/payments`/`/ar-ap-aging` ของลูกค้าคนอื่น
    → ต้องไม่เห็น/ทำรายการไม่ได้ (ทดสอบผ่าน session นักบัญชีจริง)
12. regression: เปิดสมุดรายวัน/รายงานของลูกค้าที่ไม่มีบิลเชื่อ/ไม่มี manual JE เลย → ตัวเลขต้องเหมือนก่อนแก้เฟสนี้
    เป๊ะ (ไม่มี array/บรรทัดว่างที่ผสมเข้าไปโดยไม่ตั้งใจ)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| Race condition: 2 คนบันทึกรับเงินพร้อมกันสำหรับบิลเดียวกัน (re-fetch ยอดค้างที่ server อาจไม่ทันเห็นของอีกฝั่ง) | ยอมรับความเสี่ยงนี้ในเฟสนี้ (สอดคล้องกับ posture เดิมทั้งระบบ — ไม่มี DB-level lock/constraint ที่อื่นเลย) · re-fetch ยอดค้างจาก DB ทุกครั้งก่อน insert (ลดโอกาสชนได้มากแล้ว) · ถ้าพบชนจริงในทางปฏิบัติ ให้เพิ่ม unique/serializable transaction เฉพาะจุดนี้เป็นรอบถัดไป |
| `due_date` ไม่มี default/บิลเก่าเป็น `null` จำนวนมาก → รายงานอายุหนี้อาจดู "ไม่ระบุกำหนด" เกะกะช่วงแรก | ตั้งใจ (0.7) ไม่ auto-เดาวันครบกำหนดของบิลเก่า (เดาผิดอันตรายกว่าไม่รู้) — แยก bucket ต่างหากให้เห็นชัดว่า "ต้องไปกรอกเพิ่ม" ไม่ปนกับ bucket ที่มีข้อมูลจริง |
| นักบัญชีเข้าใจผิดว่าบิล `cash`/`transfer`/`cheque` ก็ต้อง "บันทึกรับเงิน" แยกอีกที (ทำงานซ้ำซ้อน/สับสนกับ 0.1) | หน้า `/chat-audit/accounting/payments` list เฉพาะบิล `payment_method='credit'` ที่ยังค้างชำระเท่านั้น (บิล cash/transfer/cheque ไม่โผล่ในหน้านี้เลย — กันสับสนตั้งแต่ UI ไม่ต้องอธิบายด้วยข้อความ) |
| Overpayment ที่เกิดจากตัวเลขบิลเดิมผิด (เช่น แก้ยอดบิลย้อนหลังหลังรับเงินไปแล้วบางส่วน ทำให้ยอดเต็มใหม่ต่ำกว่าที่รับไปแล้ว) | บิลที่ confirmed แล้วแก้ไม่ได้ปกติอยู่แล้ว (ต้อง `allowConfirmed` เท่านั้นซึ่งเป็น flow แก้ของ AI อ่านผิดเฉพาะ) — ถ้าเคสนี้เกิดจริง ให้นักบัญชีตรวจด้วยตาที่หน้า `/payments` (จะเห็น outstanding เป็นค่าติดลบ/ผิดปกติทันที) และ escalate เป็น manual JE ปรับปรุงแทน (ไม่ auto-แก้เงียบ ๆ) |
| `bill_payments.customer_id` เป็นสำเนา (denormalized) — ถ้า `bill_entries.customer_id` ถูกแก้หลังมี payment ผูกอยู่แล้ว (ปัจจุบันระบบไม่มี UI ให้ทำแบบนี้กับบิล confirmed แต่ในทางทฤษฎีเป็นไปได้ผ่าน `allowConfirmed`) จะทำให้สโคปเพี้ยน | `recordBillPayment`/`voidBillPayment` ทุกครั้ง re-check สโคปผ่าน `getBillPaymentScope` (อ่าน `customer_id` สดจาก `bill_entries` ผ่าน `entry_id` ไม่ใช่จากสำเนาใน `bill_payments`) — สำเนาใน `bill_payments.customer_id` ใช้แค่ "กรองเร็ว" ตอน list/รายงานเท่านั้น ไม่ใช่แหล่งความจริงของสิทธิ์ |
| ปริมาณ call site ที่ต้องแก้ให้ตรงกัน (`reports`, `journal-books` ทั้งหน้าจอ+export) เสี่ยงแก้ไม่ครบบางไฟล์ (ซ้ำแบบ 0.6 ที่พบจากเฟส 1) | ไล่ทุก caller ของ `buildStatements`/`buildJournalBooks` ด้วย grep ก่อนปิดงาน (`grep -rn "buildStatements\|buildJournalBooks" app/`) แล้ว diff กับรายการไฟล์ในหมวด 1 ให้ตรงกันเป๊ะ ก่อนถือว่า H1 เสร็จ |

---
---

# เฟส 3 — แผนละเอียด: หนังสือรับรองหัก ณ ที่จ่าย + ใบลดหนี้/เพิ่มหนี้ + เอกสารก่อน/ระหว่างขาย-ซื้อ

**สโคป (ยืนยันจากผู้ใช้):** 3 ส่วน เรียงตามความเสี่ยง/ความซับซ้อนจากน้อยไปมาก **I → J → K**:
- **(I) หนังสือรับรองหัก ณ ที่จ่าย (WHT Certificate)** — print-only จากข้อมูลที่มีอยู่แล้ว ไม่กระทบ engine
- **(J) ใบลดหนี้/ใบเพิ่มหนี้ (Credit Note / Debit Note)** — schema ใหม่ + กระทบ `billOutstanding()` + กระทบ pipeline บัญชี
- **(K) ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล (Quotation/PO/Billing Note)** — เอกสารช่วยขาย ไม่กระทบ engine บัญชีเลย ใช้ตารางร่วม `sales_documents`

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `receipt-cert/page.tsx` (เฟสก่อนเฟส 1) — pattern "print-only, ไม่บันทึก DB, เลขที่เอกสารเป็นช่องกรอก" ที่ส่วน I จะ mirror เกือบเป๊ะ
- `bill_entry_lines.wht_rate`/`wht_amount` + `bill_entries.wht_form` (migration 0046) — ข้อมูล WHT ที่มีอยู่แล้ว ส่วน I ใช้อ่านอย่างเดียว
- `lib/accounting/bill-payments.ts::billOutstanding/isCreditEligibleForPayment/contraAccountFor` (เฟส 2) — ส่วน J reuse ตรง ๆ ไม่เขียนสูตรคู่ขนาน
- `lib/accounting/statements.ts::buildStatements(entries, opening, chartByCode, manualJournalLines=[])` และ `journal-books.ts::buildJournalBooks(entries, chartByCode, manualPostings=[])` — พารามิเตอร์ generic เดิม (เฟส 1/2 ออกแบบไว้แล้ว) → ส่วน J ผสม `JournalLine[]`/`JournalPosting[]` ของ CN/DN เข้าพารามิเตอร์เดิมที่ **call site** เหมือนที่เฟส 2 ทำกับ `bill_payments` ไม่ต้องแก้ signature ของ engine อีกเลย
- `lib/accounting/products.ts` (เฟส 1 ส่วน B) — ส่วน K ใช้ `product_id` ต่อบรรทัด prefill ราคา/รายละเอียด
- `supabase/migrations/0026_scheduled_invitation_rpc.sql` — pattern RPC `SECURITY DEFINER` + `set search_path` + grant เฉพาะ `service_role` ที่ส่วน K จะใช้ทำเลขที่เอกสารแบบ atomic

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ลำดับ I → J → K ตามที่ผู้ใช้ยืนยัน (ความเสี่ยง/ผลกระทบจากน้อยไปมาก)
ทั้ง 3 ส่วนไม่พึ่งพากันทางเทคนิค (I ไม่พึ่ง J, K ไม่พึ่งใครเลย — ทำขนานได้จริง) แต่จัดคิวตามความเสี่ยงเพื่อ derisk ก่อน:
I (print-only, ไม่มี migration, ไม่กระทบ engine) → J (schema ใหม่ + กระทบ `billOutstanding`/journal/ledger — เสี่ยง regression ของเฟส 2 ทั้งชุด) → K (schema ใหม่แต่ไม่กระทบ engine เลย, ความเสี่ยงคือแค่ความซับซ้อนของ UI/doc-numbering)

### 0.2 ขอบเขต WHT Certificate (ส่วน I) — mirror `receipt-cert` เป๊ะ, print-only, ไม่มี migration
- **ออกได้เฉพาะบิลซื้อ (`entryType==='purchase'`) ที่มีอย่างน้อย 1 บรรทัด `whtAmount > 0` เท่านั้น** — เหตุผล: หนังสือรับรองหัก ณ ที่จ่ายออกโดย **"ผู้จ่ายเงิน/ผู้มีหน้าที่หักภาษี"** ให้ **"ผู้รับเงิน/ผู้ถูกหักภาษี"** ในระบบนี้ ลูกค้าของสำนักงานบัญชี (NOVA-CX customer) เป็นผู้จ่ายเงินเฉพาะตอนเป็นฝั่งซื้อเท่านั้น (`entryType='purchase'` → ตั้ง `WHT_PAYABLE 2910`) ส่วนบิลขายที่ `whtAmount>0` (`WHT_RECEIVABLE 1216`) คือกรณีที่ **ลูกค้าเราถูกอีกฝั่งหัก** — ลูกค้าเราเป็นผู้ *รับ* ใบรับรองจากคู่ค้า ไม่ใช่ผู้ *ออก* → ไม่ต้องมีฟีเจอร์นี้ฝั่งขาย
- **Phase 1 เหมือน `receipt-cert` ทุกประการ**: ไม่บันทึกลง DB, ไม่มี migration, ไม่ auto-number — เลขที่หนังสือรับรองเป็นช่องกรอกอิสระในฟอร์มพิมพ์ (นักบัญชีดูแลเลขที่เองตามระบบเดิมของสำนักงาน/ลูกค้าแต่ละราย)
- หัวกระดาษ = ข้อมูล **ลูกค้า** (ผู้จ่ายเงิน/ผู้มีหน้าที่หัก) — `business_name`/`tax_id`/`address` (มีครบตั้งแต่ migration 0058) ไม่ใช่ Finovas (เหมือน receipt-cert)
- ผู้ถูกหักภาษี (ผู้รับเงิน) = `bill_entries.counterparty_name`/`counterparty_tax_id` ของบิลนั้น (resolve แล้วตอนยืนยันบิล)
- **"ประเภทเงินได้พึงประเมิน" (ตามมาตรา 40) ไม่มีอยู่ในข้อมูลปัจจุบันของระบบ** — ไม่เพิ่มคอลัมน์ใหม่ในเฟสนี้ (นอกสโคป, ไม่กระทบ engine ตามที่ยืนยัน) → เป็น **dropdown เลือกในฟอร์มพิมพ์** (ไม่บันทึก ไม่ persist, เหมือนช่อง "เลขที่เอกสาร") ตัวเลือกมาตรฐานแบบย่อ (ค่าจ้างทำของ/ค่าบริการ, ค่าเช่า, ค่าขนส่ง, ค่าโฆษณา, รางวัล/ส่วนลด/ของแถม, อื่น ๆ)
- แสดง checkbox "บุคคลธรรมดา (ภ.ง.ด.3)" / "นิติบุคคล (ภ.ง.ด.53)" — prefill จาก `bill_entries.wht_form` (แก้ในฟอร์มพิมพ์ได้ ไม่ persist กลับ)
- แต่ละบรรทัดของหนังสือรับรอง = 1 `bill_entry_line` ที่ `whtAmount > 0` ของบิลนั้น (วันที่จ่าย=`doc_date`, เงินได้ที่จ่าย=`line.amount`, อัตรา=`line.whtRate`, ภาษีที่หัก=`line.whtAmount`) — บิลเดียวมีได้หลายบรรทัด WHT พร้อมกันในเอกสารเดียว (ไม่แยกเอกสารต่อบรรทัด ในเฟสนี้เพื่อความง่าย)
- **[⚠️ FLAG]** รูปแบบเอกสารเป็นการจำลองแบบง่าย ไม่ใช่ฟอร์มราชการ (ภ.ง.ด.1ก/50 ทวิ) เป๊ะ 100% — เหมือนที่ receipt-cert เคยยืนยันไว้ ถ้าต้องใช้ยื่นจริงต่อสรรพากรให้แจ้งผู้ใช้ปรับ CSS/เค้าโครงในรอบถัดไป

### 0.3 ขอบเขต Credit Note/Debit Note (ส่วน J) — จำกัดเฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น
**[⚠️ FLAG — เพิ่มเงื่อนไขจำกัดสโคปจากคำขอเดิมเพื่อลดความซับซ้อน]** CN/DN ในเฟสนี้ออกได้เฉพาะบิลที่ `isCreditEligibleForPayment(entry)` เป็นจริงเท่านั้น (**reuse ฟังก์ชันเดิมจาก `bill-payments.ts` ตรง ๆ — ไม่เขียน eligibility ใหม่คู่ขนาน**) คือ: `entryType∈{sale,purchase}` && `paymentMethod==='credit'` && `status==='confirmed'`
- เหตุผล: บิลเชื่อเท่านั้นที่มีแนวคิด "ยอดค้างชำระ" (AR/AP) ให้ปรับ — บิล cash/transfer/cheque จ่ายเงินเสร็จสิ้นตอนยืนยันบิลแล้ว (เหมือนเหตุผลเดียวกับ 0.1 ของเฟส 2) การออก CN/DN กับบิลเงินสดต้องคิดเรื่อง refund เงินสดจริง ซึ่งเป็นเคสธุรกิจคนละแบบ ไม่รวมในเฟสนี้
- ถ้าพบความต้องการจริงกับบิลเงินสด ให้แจ้งผู้ใช้แยกดีลเป็นรอบถัดไป (ไม่ auto-ขยายสโคปเงียบ ๆ)

### 0.4 โมเดลข้อมูล CN/DN: ตารางใหม่ `credit_debit_notes` + `credit_debit_note_lines` (ไม่ขยาย `bill_entries`)
เหตุผลเดียวกับที่เฟส 1 (manual JE) และเฟส 2 (`bill_payments`) แยกตารางใหม่: CN/DN มีโครงสร้างข้อมูลคนละแบบกับหัวบิล (มีเหตุผล/ประเภทลด-เพิ่ม/บรรทัดปรับปรุงของตัวเอง ไม่ใช่ VAT/WHT ต่อบรรทัดแบบบิล) และต้อง **อ้างอิงใบกำกับภาษีต้นฉบับ** (`entry_id`, บังคับตามกฎหมาย มาตรา 82/9-82/10) — 1 บิลออก CN/DN ซ้ำได้หลายใบ (1-ต่อ-กลาย เหมือน `bill_payments`)
- `credit_debit_notes`: `doc_type` (`credit_note`|`debit_note`), `doc_date`, `doc_no` (**free text — ดู 0.13 เหตุผลที่ไม่ auto-number**), `reason` (บังคับกรอก — ฟอร์ม RD บังคับระบุเหตุผล), `status` (`draft`|`confirmed`, mirror manual JE — ต้องตรวจทานก่อน confirm เพราะกระทบ VAT ที่ยื่นแล้ว)
- `credit_debit_note_lines`: `account_code`/`account_name`/`amount`/`vat_amount` ต่อบรรทัด (ไม่มี WHT — ดู 0.8)
- **สถานะ + void policy**: `draft` แก้ไข/ลบได้อิสระ (งานร่าง) · `confirmed` ล็อกแก้ไข ยกเลิกได้ด้วย soft-delete (`deleted_at`) เท่านั้น (ผิดพลาดต้องยกเลิกแล้วออกใบใหม่ที่ถูกต้อง — เหมือน `bill_payments` 0.2 ไม่ใช่แก้ตัวเลขย้อนหลังเงียบ ๆ)

### 0.5 double-entry ของ CN/DN — reuse `contraAccountFor('credit', entryType)` ตรง ๆ (contra คงที่ = AR/AP เสมอ)
เพราะ eligibility จำกัดเฉพาะ `paymentMethod==='credit'` (0.3) → บัญชีคู่คงที่เสมอเป็น **AR (1140)** ฝั่งขาย หรือ **AP (2010)** ฝั่งซื้อ ไม่ต้องคำนวณ cash/cheque/transfer เหมือนบิล — เรียก `contraAccountFor(chartByCode, 'credit', entry.entryType)` ตรง ๆ (ไม่เขียน mapping ใหม่)

สูตร (ยอดรวมต่อ note = Σ`line.amount` + Σ`line.vat_amount`, ใช้ `INPUT_VAT`/`OUTPUT_VAT`/`AR`/`AP` จาก `statement-config.ts` เดิม):

| ประเภท | ฝั่งขาย (sale) | ฝั่งซื้อ (purchase) |
|---|---|---|
| **ใบลดหนี้ (credit_note)** — ลดยอด | Dr แต่ละ`line.account_code`=`amount` · Dr `OUTPUT_VAT`=Σvat · **Cr AR**=Σ(amount+vat) | **Dr AP**=Σ(amount+vat) · Cr แต่ละ`line.account_code`=`amount` · Cr `INPUT_VAT`=Σvat |
| **ใบเพิ่มหนี้ (debit_note)** — เพิ่มยอด | **Dr AR**=Σ(amount+vat) · Cr แต่ละ`line.account_code`=`amount` · Cr `OUTPUT_VAT`=Σvat | Dr แต่ละ`line.account_code`=`amount` · Dr `INPUT_VAT`=Σvat · **Cr AP**=Σ(amount+vat) |

สังเกต: `debit_note` มีทิศทางเดียวกับบิลปกติชนิดเดียวกัน (เหมือนบิลเพิ่มอีกใบ) ส่วน `credit_note` คือ **กลับทิศทั้งหมด** ของบิลปกติ — เขียนเป็นฟังก์ชันเฉพาะใน `credit-debit-notes.ts` (ไม่ import จาก `journal.ts` ตรง ๆ — เขียนบรรทัด Dr/Cr เองแบบเดียวกับที่ `bill-payments.ts::toJournalLines` ทำ ไม่ใช้ `buildJournalEntries` ทั้งฟังก์ชันเพราะ pipeline นั้นออกแบบมาสำหรับบิลเต็มใบ ไม่ใช่รายการปรับปรุง 2-3 บรรทัด)

### 0.6 `billOutstanding()` ต้องรับ `netAdjustment` — grep แล้ว พบ caller ที่ต้องแก้ครบ
signature ใหม่: `billOutstanding(entry, payments, netAdjustment = 0)` → สูตรใหม่ = `ยอดเต็ม + netAdjustment − Σการรับ/จ่ายเงินจริง`
`netAdjustment` = ผลรวมสัญญาณของ CN/DN ที่ **confirmed** แล้วของบิลนั้น (`credit_note` = ลบ, `debit_note` = บวก)
**Caller ทุกจุดที่ต้องแก้ (grep `billOutstanding(` ยืนยันแล้ว ครบตามนี้ ไม่มีตกหล่น):**
- `lib/accounting/bill-payments.ts` — เรียกตัวเองใน `validatePaymentInput` (ต้องรับ `netAdjustment` เพิ่มเป็นพารามิเตอร์ต่อ แล้ว forward)
- `lib/accounting/aging.ts::buildAgingReport` — ต้องรับ `netAdjustmentByEntry: Map<string, number>` เพิ่ม
- `app/chat-audit/accounting/payments/page.tsx` (บรรทัด ~134) — ต้อง join CN/DN ก่อนคำนวณ `outstanding` ที่โชว์ในตาราง
- `tests/accounting/bill-payments.test.ts` — เทสต์เดิม 6 จุดที่เรียก `billOutstanding(...)` ต้อง compile ผ่านต่อ (default `0` = backward-compat ระดับ compile เท่านั้น เหมือน pattern `chartByCode={}` ของเฟส 1) + เพิ่มเทสต์ใหม่กรณีมี `netAdjustment`
- **`recordBillPayment()` ต้องคำนวณ `netAdjustment` จาก DB สดก่อน insert ทุกครั้ง** (re-fetch เหมือน 0.8 ของเฟส 2 — ไม่เชื่อค่าจาก client) → ต้องโหลด CN/DN confirmed ของ `entryId` นั้นก่อนเรียก `validatePaymentInput`

### 0.7 CN/DN เข้าสมุดรายวันเล่มไหน — ตามฝั่งบิลเดิม (sale/purchase) ไม่ใช่ receipt/payment
CN/DN ไม่ใช่เงินเข้า-ออกจริง (ต่างจาก `bill_payments`) แต่เป็น "รายการปรับปรุงยอดขาย/ซื้อ" → `toJournalPosting()` คืน `book: entry.entryType === 'sale' ? 'sale' : 'purchase'` (ผสมเข้าเล่มเดียวกับบิลปกติของฝั่งนั้น ผ่านพารามิเตอร์ `manualPostings` เดิมของ `buildJournalBooks()` — generic พออยู่แล้วตั้งแต่เฟส 1 ไม่ต้องแก้ signature)

### 0.8 CN/DN ไม่กระทบยอดหัก ณ ที่จ่าย (WHT) เดิมของบิลต้นฉบับ
**[⚠️ FLAG — descope ชัดเจน]** WHT คำนวณจากยอดใบกำกับภาษีต้นฉบับ ณ วันที่จ่ายเงินจริงเท่านั้นตามกฎหมาย — ถ้าธุรกิจจริงต้องปรับ WHT ตาม CN/DN ด้วย (กรณีพิเศษ) ให้ทำผ่าน **manual JE** แยกต่างหาก ไม่ auto-คำนวณใน CN/DN ของเฟสนี้ (`credit_debit_note_lines` ไม่มีคอลัมน์ wht เลย)

### 0.9 สิทธิ์ CN/DN — reuse `getBillPaymentScope` ตรง ๆ (ไม่เขียน scope query คู่ขนาน)
`credit-debit-notes.ts` import `getBillPaymentScope` จาก `bill-payments.ts` มาใช้ตรวจสโคป/สิทธิ์ก่อนสร้าง/แก้/ยืนยัน/ยกเลิก CN/DN ทุกครั้ง (คืนรูปแบบ `{customerId, entryType, paymentMethod, status}` ตรงกับที่ต้องใช้เป๊ะ — บิลเดียวกัน ตรวจสโคปแบบเดียวกัน) — write path ทั้งหมดผ่าน `requireAccountingAccess` + `assertCustomerInScope(scope.customerId)`

### 0.10 ขอบเขต Sales Documents (ส่วน K) — ตารางร่วม `sales_documents` เดียว ไม่แยก 3 ตาราง
เหตุผล: โครงสร้าง header ของทั้ง 3 ประเภทเหมือนกันเกือบทั้งหมด (ลูกค้า/คู่ค้า/วันที่/สถานะ/เลขที่เอกสาร/บรรทัดรายการ) ต่างกันแค่ (ก) ความหมายของ `counterparty` (ใบเสนอราคา/ใบวางบิล = ลูกค้าปลายทาง, ใบสั่งซื้อ = ผู้ขาย/ซัพพลายเออร์) และ (ข) `billing_note` เท่านั้นที่ใช้ `source_bill_entry_id` ต่อบรรทัด — ไม่คุ้มที่จะแยก 3 ตาราง (จะต้องเขียน CRUD/RLS/numbering ซ้ำ 3 ชุด) เทียบกับเพิ่ม `document_type` column แยกด้วย `check` constraint (pattern เดียวกับที่ `bill_entries.entry_type` ใช้แยก purchase/sale/unspecified อยู่แล้ว)
- `sales_document_lines` มี `product_id` (nullable FK `products`, reuse เฟส 1 ส่วน B — prefill ราคา/รายละเอียด) และ `source_bill_entry_id` (nullable FK `bill_entries` — ใช้เฉพาะ `billing_note`, บังคับที่ **application layer** เท่านั้น ไม่ผูก DB constraint ข้าม document_type)

### 0.11 K ไม่กระทบ accounting engine เลย (ยืนยันตามสโคปผู้ใช้)
`sales-documents.ts` **ไม่ import** จาก `journal.ts`/`ledger.ts`/`statements.ts`/`journal-books.ts`/`payment.ts` เลยแม้แต่บรรทัดเดียว — ไม่มี `toJournalLines`/`toJournalPosting` ในไฟล์นี้ (ต่างจาก J โดยตั้งใจ) เอกสารกลุ่มนี้เป็นแค่ "งานเอกสารก่อน/ระหว่างขาย-ซื้อ" ไม่ใช่รายการทางบัญชี

### 0.12 ระบบ doc-number generation ของ K — atomic RPC (pattern เดียวกับ `0026_scheduled_invitation_rpc.sql`)
- รูปแบบ: `{PREFIX}-{ปีพ.ศ.}-{running:04d}` เช่น `QT-2569-0001`, `PO-2569-0001`, `BN-2569-0001` — prefix: `quotation`→`QT`, `purchase_order`→`PO`, `billing_note`→`BN` (คงที่ใน `doc-format.ts`)
- **เลขรันแยกต่อ (`tenant_id`, `document_type`, `ปีพ.ศ.`)** เก็บใน `sales_document_counters` — reset ทุกปีใหม่ (ปีพ.ศ. ของ**เวลาที่กด "ออกเอกสาร" จริง** ไม่ใช่ `doc_date` ที่แก้ backdate ได้ — กันเลขสับสนถ้ามีคนตั้งใจ backdate)
- **เลขที่ assign ตอน "ออกเอกสาร" (issue) เท่านั้น ไม่ใช่ตอนสร้าง draft** — เหตุผล: กันเลขกระโดด/มีช่องว่างจาก draft ที่พิมพ์ทดลองแล้วทิ้ง (สอดคล้องธรรมเนียมบัญชี — เอกสารที่ไม่เคยส่งออกจริงไม่ควรกิน running number) draft ที่ไม่ต้องการ ลบทิ้งได้อิสระโดยไม่เสียเลข
- **RPC `public.issue_sales_document(...)` เดียวทำ 2 อย่างแบบ atomic ในทรานแซกชันเดียว**: (1) increment counter (`insert...on conflict...do update...returning`) (2) update แถว `sales_documents` เป็น `doc_no`+`status='issued'`+`issued_at` **เฉพาะแถวที่ยังเป็น `draft`** — ถ้า update ไม่ติด (ถูก issue/void ไปแล้ว หรือถูกลบ) ให้ `raise exception` ทำให้ **ทั้งฟังก์ชัน rollback รวมถึง counter ที่เพิ่งเพิ่มไปด้วย** (กันเลขถูก "เผา" ทิ้งเงียบ ๆ) — `SECURITY DEFINER` + `set search_path = public, pg_temp` + grant execute เฉพาะ `service_role` (mirror 0026 เป๊ะ)
- ออกเอกสารแล้ว **ล็อกแก้ไม่ได้** (เหมือน `bill_entries confirmed`/`manual_journal_entries confirmed`) — แก้ไขได้เฉพาะสถานะ `draft` เท่านั้น

### 0.13 asymmetry: J (CN/DN) ไม่มี auto doc-number แต่ K มี — เหตุผลของความไม่สมมาตรนี้
**[⚠️ FLAG]** CN/DN (`doc_no`) เป็น **free text** เหมือน `bill_entries.doc_no`/`manual_journal_entries.doc_no` เดิมทุกอย่าง ส่วน K (`sales_documents.doc_no`) เป็น **auto-generate** — เหตุผล: CN/DN เป็นเอกสารที่หลายสำนักงานบัญชี**มีเลขชุดเดิมของตัวเองอยู่แล้ว**ก่อนใช้ NOVA-CX (เหมือนใบกำกับภาษี/บิลที่คีย์เข้าระบบภายหลัง มีเลขที่จากเอกสารจริงต้นทาง) ให้กรอกเองต่อเนื่องจากที่ใช้อยู่เดิม (ตรง pattern ของระบบทั้งหมดสำหรับ "เอกสารบัญชี" ที่มีอยู่ก่อน) ส่วน K เป็นเอกสารที่ **NOVA-CX เป็นผู้ออกเลขที่ใหม่เองครั้งแรก** (ไม่มีเลขเดิมจากที่อื่นมาก่อน) — ผู้ใช้ระบุชัดเจนแล้วว่าต้องมีระบบ doc-number generation เฉพาะส่วนนี้

### 0.14 `billing_note` ผูก `bill_entries` แบบ read-only reference เท่านั้น — ไม่ sync ยอดย้อนหลัง
`sales_document_lines.source_bill_entry_id` ใช้แค่ **prefill ตอนสร้าง** (ดึง `docNo`/`docDate`/`billNetTotal`/`billOutstanding` ของบิลเชื่อที่ยังค้างชำระของลูกค้ารายนั้นมาแสดงเป็นตัวเลือก) — ค่า `amount`/`description` ที่บันทึกใน `sales_document_lines` เป็น **สำเนา ณ เวลาที่สร้าง** ถ้าบิลต้นทางถูกแก้ไขทีหลัง (เช่นแก้ยอด, บันทึกรับเงินเพิ่ม) ใบวางบิลที่ออกไปแล้ว**ไม่ auto-update ตาม** — ตรงกับพฤติกรรมเอกสารจริง (ใบวางบิลที่พิมพ์/ส่งไปแล้วไม่ควรเปลี่ยนตัวเลขเงียบ ๆ)

### 0.15 สิทธิ์ K — เหมือน J/`bill_payments` (`requireAccountingAccess`+`assertCustomerInScope`)
Quotation/PO/Billing Note ผูกลูกค้ารายเดียวเสมอ (`sales_documents.customer_id not null`) — ไม่ใช่ทรัพยากร tenant-level แบบผังบัญชี/สินค้า (เฟส 1 ส่วน A/B ที่เป็น admin-only) จึงใช้ guard แบบเดียวกับ `payments`/`ar-ap-aging`/CN-DN: นักบัญชีทำได้เฉพาะลูกค้าที่ตัวเองดูแล

### 0.16 สถานะ/lock ของ `sales_documents` — 3 สถานะ (`draft`/`issued`/`void`)
`draft` แก้ไขได้เต็มที่ (header+lines) รวมลบทิ้งได้ (soft-delete, ไม่เสียเลขเพราะยังไม่มีเลข) · `issued` ล็อกแก้ไข (มีเลขที่แล้ว) แก้ไขไม่ได้อีก แก้ผิดต้อง `void` แล้วสร้างใหม่ (เลขเดิมค้างไว้เป็นหลักฐานว่าเคยออกแล้วยกเลิก — ไม่ reuse เลข) · `void` = ยกเลิกจาก `issued` เท่านั้น (ไม่มีทางย้อนกลับเป็น `draft`/`issued`)

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 3

```
supabase/migrations/
  0069_credit_debit_notes.sql   [ใหม่] ตาราง credit_debit_notes + credit_debit_note_lines + RLS
  0070_sales_documents.sql      [ใหม่] ตาราง sales_documents + sales_document_lines + sales_document_counters
                                        + ฟังก์ชัน issue_sales_document() (RPC atomic) + RLS
  ⚠️ เลขไฟล์ 0069-0070 อิง "0068 เป็นไฟล์ล่าสุด ณ วันที่วางแผน" — ก่อนสร้างไฟล์จริงให้ `ls supabase/migrations`
     เช็คเลขล่าสุดอีกครั้ง เผื่อมีงานอื่นแซงเข้ามาก่อน

lib/accounting/
  wht-cert.ts             [ใหม่] pure ทั้งไฟล์ (ไม่แตะ DB, ไม่ import journal/ledger):
                                  - isWhtCertEligible(entry) → entryType==='purchase' && lines.some(whtAmount>0) (0.2)
                                  - type WhtCertLine = { date, description, amount, whtRate, whtAmount }
                                  - buildWhtCertLines(lines) → WhtCertLine[] (กรองเฉพาะ whtAmount>0, pure mapping)
                                  - WHT_INCOME_TYPE_OPTIONS: ตัวเลือก "ประเภทเงินได้" มาตรฐานย่อ (ไม่ persist)
  credit-debit-notes.ts   [ใหม่] pure + data layer (mirror bill-payments.ts):
                                  - type NoteDocType/NoteStatus/CreditDebitNoteLine/CreditDebitNote
                                  - isEligibleForNote = re-export ตรงจาก isCreditEligibleForPayment (0.3, ไม่เขียนใหม่)
                                  - noteLineTotal(lines) → reuse summarizeEntry (map whtAmount:0 เข้าไป — ไม่มีสูตรคู่ขนาน)
                                  - noteNetTotal(note) / noteSignedAdjustment(note) (0.5)
                                  - validateNoteInput(input, entry) → ปฏิเสธถ้า entry ไม่ eligible (0.3), reason ว่าง,
                                    lines ว่าง/account_code ขาด/amount≤0
                                  - toJournalLines(note, entry, chartByCode) / toJournalPosting(...) (0.5/0.7,
                                    reuse contraAccountFor('credit', entryType) ตรง ๆ)
                                  - getNoteEntryScope = re-export ตรงจาก getBillPaymentScope (0.9, ไม่เขียนใหม่)
                                  - listNotes(db,tenantId,entryId) / listNotesForEntries(db,tenantId,entryIds)
                                    → Map<entryId, CreditDebitNote[]>
                                  - netAdjustmentByEntry(notesByEntry) → Map<entryId, number> (pure, กรอง confirmed
                                    เท่านั้นก่อนรวม — ใช้ป้อน billOutstanding()/buildAgingReport() ตาม 0.6)
                                  - createDraftNote / updateDraftNote (เฉพาะ status='draft') / confirmNote /
                                    softDeleteNote (0.4) — ทุกตัว re-fetch scope ผ่าน getNoteEntryScope ก่อนเขียนเสมอ
  bill-payments.ts        [แก้] billOutstanding(entry, payments, netAdjustment=0) (0.6) ·
                                  validatePaymentInput(input, entry, existingPayments, netAdjustment=0) ·
                                  recordBillPayment() โหลด confirmed CN/DN ของ entryId ก่อน insert เสมอ (0.6, re-fetch)
  aging.ts                 [แก้] buildAgingReport(entries, paymentsByEntry, asOfDate, netAdjustmentByEntry=new Map())
                                  (0.6) — outstanding = billOutstanding(e, payments, netAdjustmentByEntry.get(e.id)??0)
  report-filter.ts         [แก้] เพิ่ม filterCreditDebitNotesForReport(notes, period) — กรองตาม doc_date, เฉพาะ
                                  confirmed (mirror filterBillPaymentsForReport แต่กรอง status ด้วย เพราะ note มี draft)
  doc-format.ts             [ใหม่] pure ทั้งไฟล์ (0.10/0.12): SalesDocType, DOC_TYPE_LABELS, DOC_TYPE_PREFIX
                                  (quotation→QT, purchase_order→PO, billing_note→BN), beYearNowThai(),
                                  formatSalesDocNo(prefix, beYear, seq) → "{prefix}-{beYear}-{seq:04d}"
  sales-documents.ts        [ใหม่] pure + data layer (0.10/0.11/0.14/0.16) — ★ ไม่ import journal/ledger/statements
                                  /journal-books/payment.ts เลย:
                                  - type SalesDocument/SalesDocumentLine/SalesDocStatus
                                  - lineTotal(lines) → reuse summarizeEntry (map whtAmount:0 เหมือน credit-debit-notes)
                                  - validateDocumentInput / validateLineInput
                                  - getDocumentScope(db,tenantId,id) → {customerId, status, documentType}
                                  - listSalesDocuments(db,tenantId,customerId,documentType?)
                                  - getSalesDocument(db,tenantId,id) → SalesDocument (+lines) | null
                                  - listBillingCandidates(db,tenantId,customerId) → บิลเชื่อ confirmed ที่ยังค้างชำระ
                                    ของลูกค้ารายนั้น (reuse isCreditEligibleForPayment+billOutstanding — สำหรับ
                                    prefill บรรทัด billing_note, 0.14)
                                  - createDraftDocument / updateDraftDocument (เฉพาะ draft) / softDeleteDraft
                                  - issueDocument(db,tenantId,id,documentType) → เรียก RPC issue_sales_document
                                    (คำนวณ prefix+beYear จาก doc-format.ts ก่อนส่งเข้า RPC)
                                  - voidDocument(db,tenantId,id) → เฉพาะจาก status='issued'

app/chat-audit/accounting/
  wht-cert/page.tsx              [ใหม่] mirror receipt-cert/page.tsx เป๊ะ — searchParams {customer, bill}, guard
                                  resolveAccountingAccess+customerInScope, prefill จาก isWhtCertEligible/buildWhtCertLines
  wht-cert/WhtCertDoc.tsx        [ใหม่] client presentational (mirror ReceiptCertDoc.tsx) — ฟอร์มพิมพ์ + dropdown
                                  ประเภทเงินได้ + checkbox pnd3/pnd53 + ช่องเลขที่เอกสาร (ไม่ persist)
  wht-cert/wht-cert.css          [ใหม่] mirror receipt-cert.css
  credit-debit-notes/page.tsx    [ใหม่] เลือกลูกค้า (สโคป) + เลือกบิลเชื่อ (eligible) → CreditDebitNotesPanel
  credit-debit-notes/CreditDebitNotesPanel.tsx [ใหม่] client — ฟอร์ม header(doc_type/date/doc_no/reason) + ตาราง
                                  lines (AccountCombobox reuse) + list note เดิมของบิลนั้น + ปุ่มยืนยัน/ยกเลิก
  credit-debit-notes/actions.ts  [ใหม่] server actions: upsertNoteAction/confirmNoteAction/voidNoteAction
                                  (guard requireAccountingAccess+assertCustomerInScope ผ่าน getNoteEntryScope)
  sales-documents/page.tsx       [ใหม่] เลือกลูกค้า (สโคป) + แท็บ 3 ประเภท → list เอกสาร (สถานะ/เลขที่/วันที่/ยอดรวม)
  sales-documents/SalesDocumentsPanel.tsx [ใหม่] client — ฟอร์มสร้าง/แก้ draft (header+lines, product picker reuse
                                  จาก products.ts, billing_note มีปุ่ม "ดึงจากบิลค้างชำระ" ใช้ listBillingCandidates)
                                  + ปุ่ม "ออกเอกสาร" (issue) + "ยกเลิก" (void)
  sales-documents/actions.ts     [ใหม่] server actions: createDraftAction/updateDraftAction/deleteDraftAction/
                                  issueDocumentAction/voidDocumentAction
  sales-documents/[id]/print/page.tsx     [ใหม่] หน้าพิมพ์เอกสารเดี่ยว (server component, guard สโคป, โหลด document+lines)
  sales-documents/SalesDocumentPrintDoc.tsx [ใหม่] client presentational — หัวเรื่องเปลี่ยนตาม document_type
                                  ("ใบเสนอราคา"/"ใบสั่งซื้อ"/"ใบวางบิล")
  sales-documents/sales-documents.css     [ใหม่]
  RowActions.tsx           [แก้] เพิ่มปุ่ม "ใบหัก ณ ที่จ่าย" (target=_blank, href=/wht-cert?customer=&bill=)
                                  เฉพาะ entryType==='purchase' && hasWht (prop ใหม่ที่ page.tsx ส่งมา)
  page.tsx                 [แก้] ส่ง hasWht={e.lines.some(l=>l.whtAmount>0)} ให้ RowActions ต่อแถว · เพิ่มปุ่มระดับ
                                  ลูกค้า "＋ หนังสือรับรองหัก ณ ที่จ่าย" (ฟอร์มเปล่า, mirror ปุ่มใบรับรองแทนใบเสร็จเดิม)
                                  · ส่ง creditDebitNotesHref/salesDocumentsHref เข้า CustomerTabs
  CustomerTabs.tsx          [แก้] เพิ่ม prop+ปุ่ม creditDebitNotesHref ("ใบลดหนี้/เพิ่มหนี้"), salesDocumentsHref
                                  ("ใบเสนอราคา/PO/วางบิล") เข้าแถวปุ่มเดิม (mirror paymentsHref/agingHref)
  payments/page.tsx         [แก้] (0.6) โหลด confirmed CN/DN ของบิลที่แสดง → netAdjustmentByEntry(...) → thread
                                  เข้า billOutstanding(e, payments, netAdjustmentByEntry.get(e.id) ?? 0)
  ar-ap-aging/page.tsx      [แก้] (0.6) โหลด confirmed CN/DN ของบิลในสโคป → thread netAdjustmentByEntry เข้า
                                  buildAgingReport(entries, paymentsByEntry, asOfDate, netAdjustmentByEntry)
  journal-books/page.tsx        [แก้] (0.7) โหลด confirmed CN/DN ของช่วงวันที่/ลูกค้า → toJournalPosting ทุกตัว →
                                  รวมเข้า [...manualPostings, ...paymentPostings, ...notePostings] ก่อนส่ง
                                  buildJournalBooks() — ไม่แก้ signature engine
  journal-books/export/route.ts [แก้] เหมือนกัน (export ต้องตรงกับที่จอเห็น)
  reports/page.tsx               [แก้] (0.7) โหลด confirmed CN/DN → toJournalLines ทุกตัว → concat เข้า
                                  [...manualJournalLines, ...paymentJournalLines, ...noteJournalLines] ก่อนส่ง
                                  buildStatements()
  reports/export/route.ts        [แก้] เหมือนกัน

tests/accounting/
  wht-cert.test.ts                [ใหม่] isWhtCertEligible ทุก branch (purchase มี/ไม่มี wht, sale มี wht) +
                                   buildWhtCertLines กรองเฉพาะ whtAmount>0 ถูกต้อง
  doc-format.test.ts               [ใหม่] formatSalesDocNo ทุก prefix + zero-pad ถูกต้อง (seq=1→"0001", seq=10000
                                   เกิน 4 หลัก → ไม่ครอบตัด แสดงตามจริง) · beYearNowThai ปีถูกต้อง (mock เวลา)
  credit-debit-notes.test.ts       [ใหม่] noteLineTotal/noteNetTotal/noteSignedAdjustment (credit=ลบ, debit=บวก,
                                   draft=0) · validateNoteInput ปฏิเสธทุก branch (entry ไม่ eligible/reason ว่าง/
                                   lines ว่าง/account_code ขาด) · toJournalLines สมดุลเสมอทั้ง 4 กรณี (ตาราง 0.5)
  sales-documents.test.ts          [ใหม่] lineTotal reuse ถูกต้อง · validateDocumentInput/validateLineInput ทุก
                                   branch · listBillingCandidates กรอง eligible+outstanding>0 ถูกต้อง
  bill-payments.test.ts            [แก้] เพิ่มเทสต์ billOutstanding กับ netAdjustment (credit_note ลด/debit_note
                                   เพิ่ม/ผสมกันหลายใบ) · validatePaymentInput ปฏิเสธ overpay ที่คำนวณรวม
                                   netAdjustment แล้วถูกต้อง
  aging.test.ts                    [แก้] buildAgingReport กับ netAdjustmentByEntry เปลี่ยน bucket/ยอดรวมถูกต้อง
  report-filter.test.ts            [แก้] เพิ่มเทสต์ filterCreditDebitNotesForReport (from/to + กรอง draft ออก)
  journal-books.test.ts            [แก้] notePostings ผสมเข้าเล่ม sale/purchase ถูกฝั่ง ยังสมดุลรวม
  statements.test.ts               [แก้] noteJournalLines concat เข้า buildStatements แล้วงบทดลองยังสมดุล
  credit-debit-notes-actions.test.ts [ใหม่] guard สโคป, ปฏิเสธ entry ไม่ eligible, confirm ล็อกแก้ไม่ได้, void ทำงาน
  sales-documents-actions.test.ts    [ใหม่] guard สโคป, draft แก้ได้/issued แก้ไม่ได้, issue ได้เลขจริงไม่ซ้ำ
                                     (จำลองเรียกซ้อน), void เฉพาะจาก issued
```

### 1.1 Schema — migration 0069 (Credit Note / Debit Note)

```sql
create table if not exists public.credit_debit_notes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  entry_id      uuid not null references public.bill_entries(id) on delete cascade,
  -- customer_id สำเนาจาก bill_entries ตอนสร้าง (กรองเร็ว/สโคป — pattern เดียวกับ bill_payments.customer_id
  -- ความจริงของสิทธิ์ยังอ่านสดผ่าน getNoteEntryScope เสมอ ไม่ใช้สำเนานี้ตัดสิน)
  customer_id   uuid references public.customers(id) on delete set null,
  doc_type      text not null check (doc_type in ('credit_note','debit_note')),
  doc_date      date not null,
  doc_no        text,
  reason        text not null,
  status        text not null default 'draft' check (status in ('draft','confirmed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  deleted_at    timestamptz
);
create index if not exists idx_credit_debit_notes_tenant_entry
  on public.credit_debit_notes (tenant_id, entry_id) where deleted_at is null;
create index if not exists idx_credit_debit_notes_tenant_customer_date
  on public.credit_debit_notes (tenant_id, customer_id, doc_date) where deleted_at is null;

create table if not exists public.credit_debit_note_lines (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references public.credit_debit_notes(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  description   text,
  account_code  text not null,
  account_name  text,
  amount        numeric(14,2) not null default 0,
  vat_amount    numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_credit_debit_note_lines_note
  on public.credit_debit_note_lines (tenant_id, note_id);

drop trigger if exists trg_credit_debit_notes_updated on public.credit_debit_notes;
create trigger trg_credit_debit_notes_updated before update on public.credit_debit_notes
  for each row execute function public.set_updated_at();
drop trigger if exists trg_credit_debit_note_lines_updated on public.credit_debit_note_lines;
create trigger trg_credit_debit_note_lines_updated before update on public.credit_debit_note_lines
  for each row execute function public.set_updated_at();

alter table public.credit_debit_notes       enable row level security;
alter table public.credit_debit_note_lines  enable row level security;
drop policy if exists tenant_read on public.credit_debit_notes;
create policy tenant_read on public.credit_debit_notes for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.credit_debit_note_lines;
create policy tenant_read on public.credit_debit_note_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.credit_debit_notes       from anon;
revoke all on public.credit_debit_note_lines  from anon;
grant select on public.credit_debit_notes       to authenticated;
grant select on public.credit_debit_note_lines  to authenticated;
grant all on public.credit_debit_notes       to service_role;
grant all on public.credit_debit_note_lines  to service_role;

notify pgrst, 'reload schema';
```
**หมายเหตุความสมดุล**: เหมือน manual JE เดิม (0.4 ของเฟส 1) — ไม่มี DB constraint บังคับ debit=credit บังคับที่ application layer (`toJournalLines`/validate ก่อน confirm)

### 1.2 Schema — migration 0070 (Sales Documents: Quotation/PO/Billing Note)

```sql
create table if not exists public.sales_documents (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  document_type         text not null check (document_type in ('quotation','purchase_order','billing_note')),
  -- doc_no = null จนกว่าจะ "ออกเอกสาร" (issue) — assign แบบ atomic ผ่าน issue_sales_document() ด้านล่าง (0.12)
  doc_no                text,
  doc_date              date not null,
  valid_until           date,  -- เฉพาะ quotation ใช้จริง (อื่น ๆ = null เสมอ ไม่บังคับด้วย DB)
  counterparty_name     text,
  counterparty_tax_id   text,
  counterparty_address  text,
  notes                 text,
  status                text not null default 'draft' check (status in ('draft','issued','void')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  issued_at             timestamptz,
  deleted_at            timestamptz
);
create unique index if not exists uq_sales_documents_tenant_doc_no
  on public.sales_documents (tenant_id, doc_no) where doc_no is not null and deleted_at is null;
create index if not exists idx_sales_documents_tenant_customer_type
  on public.sales_documents (tenant_id, customer_id, document_type) where deleted_at is null;

create table if not exists public.sales_document_lines (
  id                    uuid primary key default gen_random_uuid(),
  document_id           uuid not null references public.sales_documents(id) on delete cascade,
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  line_no               int not null default 1,
  description           text,
  product_id            uuid references public.products(id) on delete set null,
  -- อ้างอิงบิลต้นทาง (เฉพาะ billing_note, 0.14) — read-only reference, validate ที่ app layer เท่านั้น
  source_bill_entry_id  uuid references public.bill_entries(id) on delete set null,
  quantity              numeric(14,3) not null default 1,
  unit                  text,
  unit_price            numeric(14,2) not null default 0,
  amount                numeric(14,2) not null default 0,
  vat_amount            numeric(14,2) not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_sales_document_lines_document
  on public.sales_document_lines (tenant_id, document_id);

-- ตัวนับเลขที่เอกสารต่อ (tenant, ประเภทเอกสาร, ปีพ.ศ.) — ใช้เฉพาะภายใน RPC ด้านล่าง (0.12)
create table if not exists public.sales_document_counters (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  document_type   text not null check (document_type in ('quotation','purchase_order','billing_note')),
  be_year         int not null,
  last_seq        int not null default 0,
  primary key (tenant_id, document_type, be_year)
);

drop trigger if exists trg_sales_documents_updated on public.sales_documents;
create trigger trg_sales_documents_updated before update on public.sales_documents
  for each row execute function public.set_updated_at();
drop trigger if exists trg_sales_document_lines_updated on public.sales_document_lines;
create trigger trg_sales_document_lines_updated before update on public.sales_document_lines
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RPC: ออกเอกสาร (assign doc_no แบบ atomic) — increment counter + ล็อกแถวเป็น issued
--   ใน "ทรานแซกชันเดียว" (ฟังก์ชันเดียว) → ถ้าแถวไม่ใช่ draft แล้ว raise exception → rollback ทั้งหมด
--   รวม counter ที่เพิ่งเพิ่มไปด้วย (กันเลขถูกเผาทิ้งเงียบ ๆ เมื่อ race กับการ issue/void ซ้อน)
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (pattern 0026)
-- =====================================================================
create or replace function public.issue_sales_document(
  p_tenant_id      uuid,
  p_document_id    uuid,
  p_document_type  text,
  p_be_year        int,
  p_prefix         text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq int;
  v_doc_no text;
  v_updated_id uuid;
begin
  insert into public.sales_document_counters (tenant_id, document_type, be_year, last_seq)
  values (p_tenant_id, p_document_type, p_be_year, 1)
  on conflict (tenant_id, document_type, be_year)
  do update set last_seq = sales_document_counters.last_seq + 1
  returning last_seq into v_seq;

  v_doc_no := p_prefix || '-' || p_be_year::text || '-' || lpad(v_seq::text, 4, '0');

  update public.sales_documents
  set doc_no = v_doc_no, status = 'issued', issued_at = now()
  where id = p_document_id
    and tenant_id = p_tenant_id
    and document_type = p_document_type
    and status = 'draft'
    and deleted_at is null
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'sales_document not found or not draft (id=%)', p_document_id;
  end if;

  return jsonb_build_object('id', v_updated_id, 'doc_no', v_doc_no);
end;
$$;

revoke all on function public.issue_sales_document(uuid, uuid, text, int, text) from public;
grant execute on function public.issue_sales_document(uuid, uuid, text, int, text) to service_role;

comment on function public.issue_sales_document(uuid, uuid, text, int, text) is
  'ออกเลขที่เอกสารขาย/จัดซื้อ (quotation/PO/billing_note) แบบ atomic — increment counter + ล็อกเป็น issued (เฟส 3 ส่วน K, 0.12)';

alter table public.sales_documents          enable row level security;
alter table public.sales_document_lines     enable row level security;
alter table public.sales_document_counters  enable row level security;
drop policy if exists tenant_read on public.sales_documents;
create policy tenant_read on public.sales_documents for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.sales_document_lines;
create policy tenant_read on public.sales_document_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
-- sales_document_counters ไม่มี policy ให้ authenticated เลย (ไม่มีเหตุผลต้องอ่านผ่าน PostgREST)
revoke all on public.sales_documents          from anon;
revoke all on public.sales_document_lines     from anon;
revoke all on public.sales_document_counters  from anon, authenticated;
grant select on public.sales_documents          to authenticated;
grant select on public.sales_document_lines     to authenticated;
grant all on public.sales_documents          to service_role;
grant all on public.sales_document_lines     to service_role;
grant all on public.sales_document_counters  to service_role;

notify pgrst, 'reload schema';
```

---

## 2) งานย่อยเรียงลำดับ

**Legend**: [โค้ดได้เลย] = ทำตามสเปกได้ทันที · [⚠️ FLAG] = ทำต่อได้เลยแต่ต้องแจ้งผู้ใช้ (ดูรายละเอียดในหมวด 0)

### ส่วน I — หนังสือรับรองหัก ณ ที่จ่าย (WHT Certificate)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **I1** [โค้ดได้เลย] | `wht-cert.ts` — pure: `isWhtCertEligible`, `buildWhtCertLines`, `WHT_INCOME_TYPE_OPTIONS` (0.2) | `lib/accounting/wht-cert.ts` | - | unit test: eligible เฉพาะ purchase+wht>0 · `buildWhtCertLines` กรอง/แปลงถูกต้อง รวมกรณีหลายบรรทัด wht ในบิลเดียว |
| **I2** [โค้ดได้เลย] | `wht-cert/page.tsx` — mirror `receipt-cert/page.tsx`: guard `resolveAccountingAccess`+`customerInScope`, โหลดหัวกระดาษลูกค้า + prefill จากบิล (ถ้ามี `?bill=`) | `wht-cert/page.tsx` | I1 | เปิด `?customer=<uuid>` (ฟอร์มเปล่า) และ `?customer=&bill=` (prefill) ได้จริง · ลูกค้านอกสโคป → ปฏิเสธ |
| **I3** [โค้ดได้เลย] | `WhtCertDoc.tsx` + `wht-cert.css` — ฟอร์มพิมพ์: หัวกระดาษลูกค้า, checkbox pnd3/pnd53, dropdown ประเภทเงินได้, ตารางบรรทัด wht, ช่องเลขที่เอกสาร (ไม่ persist) | `WhtCertDoc.tsx`, `.css` | I2 | พิมพ์ (`window.print()`หรือปุ่มพิมพ์) ได้จริง เลขเงิน/อัตราตรงกับข้อมูลบิล ตรวจด้วยตา |
| **I4** [โค้ดได้เลย] | `RowActions.tsx` + `page.tsx` — เพิ่มปุ่ม "ใบหัก ณ ที่จ่าย" ต่อแถว (เฉพาะ purchase+มี wht) + ปุ่มระดับลูกค้า "＋ หนังสือรับรองหัก ณ ที่จ่าย" (ฟอร์มเปล่า) | `RowActions.tsx`, `page.tsx` | I2 | เปิดหน้า `/chat-audit/accounting` จริง → เห็นปุ่มเฉพาะแถวที่เข้าเงื่อนไข → คลิกแล้วเปิดแท็บใหม่ตรงบิลที่ถูกต้อง |
| **I5** [โค้ดได้เลย] | เทสต์ครบส่วน I (`wht-cert.test.ts`) | `tests/accounting/wht-cert.test.ts` | I1 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M7 (ส่วน I)**: ออกหนังสือรับรองหัก ณ ที่จ่าย (print-only) จากบิลซื้อที่มี WHT ได้จริง ไม่กระทบข้อมูล/engine ใด ๆ

### ส่วน J — ใบลดหนี้/ใบเพิ่มหนี้ (Credit Note / Debit Note)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **J1** [โค้ดได้เลย] | Migration 0069 — `credit_debit_notes`+`credit_debit_note_lines` + RLS | `0069_credit_debit_notes.sql` | - | apply ผ่านไม่ error · เทสต์เดิมทั้งหมดผ่าน (non-destructive) |
| **J2** [โค้ดได้เลย] | `credit-debit-notes.ts` — pure: types, `noteLineTotal`/`noteNetTotal`/`noteSignedAdjustment`, `validateNoteInput` (0.3/0.4) | `lib/accounting/credit-debit-notes.ts` | J1 | unit test: `noteSignedAdjustment` ถูกสัญญาณทุกกรณี (credit=ลบ/debit=บวก/draft=0) · `validateNoteInput` ปฏิเสธครบทุก branch |
| **J3** [โค้ดได้เลย] | `credit-debit-notes.ts` — `toJournalLines`/`toJournalPosting` (0.5/0.7, reuse `contraAccountFor('credit',...)`) | `lib/accounting/credit-debit-notes.ts` | J2 | unit test ครบ 4 กรณีตามตาราง 0.5: สมดุลเสมอ (debit=credit), บัญชี AR/AP/VAT ถูกฝั่ง, `book` ถูกฝั่ง sale/purchase |
| **J4** [โค้ดได้เลย] | `credit-debit-notes.ts` — data layer: `listNotes`/`listNotesForEntries`/`netAdjustmentByEntry`/`createDraftNote`/`updateDraftNote`/`confirmNote`/`softDeleteNote` (reuse `getBillPaymentScope`, 0.9) | `lib/accounting/credit-debit-notes.ts` | J2, J3 | unit/integration เบา: draft แก้ได้/confirmed แก้ไม่ได้ · confirm แล้วเข้า `netAdjustmentByEntry` ถูกต้อง · void แล้วหลุดออกจากผลรวม |
| **J5** [⚠️ FLAG — ดู 0.6] | `bill-payments.ts` — `billOutstanding(entry, payments, netAdjustment=0)`, `validatePaymentInput(...,netAdjustment=0)`, `recordBillPayment()` โหลด confirmed CN/DN ก่อน insert เสมอ | `lib/accounting/bill-payments.ts` | J4 | `bill-payments.test.ts` เดิมทุกจุด compile+ผ่าน (default `0`) · เทสต์ใหม่: มี CN ลด/DN เพิ่ม/ผสมกันหลายใบ → outstanding ถูกต้อง · overpay ที่คำนวณรวม CN/DN แล้วถูกปฏิเสธถูกต้อง |
| **J6** [โค้ดได้เลย] | `aging.ts` — `buildAgingReport(...,netAdjustmentByEntry=new Map())` (0.6) | `lib/accounting/aging.ts` | J5 | `aging.test.ts` เดิมผ่าน (default ว่าง = พฤติกรรมเดิมเป๊ะ) · เทสต์ใหม่: netAdjustment ทำให้ bucket/ยอดรวมเปลี่ยนถูกต้อง |
| **J7** [โค้ดได้เลย] | `report-filter.ts` — `filterCreditDebitNotesForReport(notes, period)` | `lib/accounting/report-filter.ts` | J1 | unit test ครอบ from/to ทุก branch + กรอง draft ออก |
| **J8** [โค้ดได้เลย] | `payments/page.tsx` — thread `netAdjustmentByEntry` เข้า `billOutstanding()` ที่แสดงในตาราง | `payments/page.tsx` | J4, J5 | เปิดหน้าจริง → บิลที่มี CN confirmed แล้ว → ยอดค้างชำระที่แสดงลดลงถูกต้องทันที (ไม่ต้องรอบันทึกรับเงิน) |
| **J9** [โค้ดได้เลย] | `ar-ap-aging/page.tsx` — thread `netAdjustmentByEntry` เข้า `buildAgingReport()` | `ar-ap-aging/page.tsx` | J4, J6 | เปิดหน้าจริง → บิลที่มี DN confirmed แล้ว → ยอดค้าง/bucket ขยับถูกต้องตามยอดใหม่ |
| **J10** [⚠️ FLAG — คล้าย 0.6 ของเฟส 2] | `journal-books/page.tsx`+`export/route.ts` — เพิ่ม `notePostings` ผสมเข้า `[...manualPostings, ...paymentPostings, ...notePostings]`; `reports/page.tsx`+`export/route.ts` — เพิ่ม `noteJournalLines` ผสมเข้า `buildStatements()` | 4 ไฟล์ข้างต้น | J3, J7 | บันทึก CN ยืนยันแล้ว 1 ใบ (บิลขาย) → เปิดสมุดรายวัน → โผล่ในเล่ม "ขาย" ยอดสมดุล · เปิดงบทดลอง → AR ลดลงถูกต้องตามยอด CN, บัญชีรายได้/VAT ขายลดลงตรงกัน (สมดุลรวมยังผ่าน) · export Excel ตรงกับที่จอเห็นทุกจุด |
| **J11** [โค้ดได้เลย] | `credit-debit-notes/page.tsx`+`Panel.tsx`+`actions.ts` — หน้าใหม่สร้าง/แก้/ยืนยัน/ยกเลิก CN/DN ต่อบิล + ลิงก์จาก `RowActions.tsx`/`page.tsx`/`CustomerTabs.tsx` | 6 ไฟล์ข้างต้น | J4, J8, J9, J10 | `requireAccountingAccess`+`assertCustomerInScope` ทุก write · สร้าง draft → แก้ไขได้ → ยืนยันแล้วแก้ไม่ได้ (UI ล็อก+server ปฏิเสธ) · ยกเลิกแล้วยอดค้างชำระ/รายงานกลับมาเดิมทันที |
| **J12** [โค้ดได้เลย] | เทสต์ครบส่วน J (unit ที่เหลือ + `*-actions.test.ts`) | `tests/accounting/*` | J1-J11 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M8 (engine, J1-J7)**: `billOutstanding`/`buildAgingReport`/journal mapper ของ CN/DN ถูกต้องครบทุก edge case — ยังไม่มี UI
**Milestone M9 (UI+wiring, J8-J12)**: ออก/ยกเลิก CN/DN ได้จริงผ่าน UI ไหลเข้ายอดค้างชำระ/รายงานอายุหนี้/สมุดรายวัน/งบการเงินถูกต้องครบวงจร

### ส่วน K — ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล (Quotation/PO/Billing Note)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **K1** [โค้ดได้เลย] | Migration 0070 — `sales_documents`+`sales_document_lines`+`sales_document_counters`+RPC `issue_sales_document` + RLS | `0070_sales_documents.sql` | - | apply ผ่านไม่ error · เทสต์เดิมทั้งหมดผ่าน · เรียก RPC ตรง ๆ ด้วย service client ทดสอบว่าได้เลขจริงไม่ซ้ำ |
| **K2** [โค้ดได้เลย] | `doc-format.ts` — pure: labels/prefix/`beYearNowThai`/`formatSalesDocNo` (0.10/0.12) | `lib/accounting/doc-format.ts` | - | unit test ครบ (0.13 asymmetry อธิบายในคอมเมนต์ไฟล์) |
| **K3** [โค้ดได้เลย] | `sales-documents.ts` — pure: types, `lineTotal` (reuse `summarizeEntry`), `validateDocumentInput`/`validateLineInput` (0.10) | `lib/accounting/sales-documents.ts` | K2 | unit test ครบทุก branch validate · ยืนยันด้วยโค้ด review ว่าไฟล์นี้ไม่ import จาก journal/ledger/statements/journal-books/payment.ts เลย (0.11) |
| **K4** [โค้ดได้เลย] | `sales-documents.ts` — data layer: `getDocumentScope`/`listSalesDocuments`/`getSalesDocument`/`createDraftDocument`/`updateDraftDocument`/`softDeleteDraft` | `lib/accounting/sales-documents.ts` | K1, K3 | integration เบา: draft แก้ได้เต็มที่ · ลบ draft ไม่เสียเลข (เพราะยังไม่มีเลข) |
| **K5** [โค้ดได้เลย] | `sales-documents.ts` — `listBillingCandidates` (reuse `isCreditEligibleForPayment`+`billOutstanding`, 0.14), `issueDocument` (เรียก RPC), `voidDocument` | `lib/accounting/sales-documents.ts` | K4, J5 (ใช้ `billOutstanding` เวอร์ชันใหม่ที่มี netAdjustment) | unit/integration: `listBillingCandidates` กรอง eligible+outstanding>0 ถูกต้อง · `issueDocument` เรียกซ้อนพร้อมกัน (จำลอง) → ได้เลขไม่ซ้ำกันเสมอ · `voidDocument` ทำได้เฉพาะจาก `issued` |
| **K6** [โค้ดได้เลย] | `sales-documents/page.tsx`+`SalesDocumentsPanel.tsx`+`actions.ts` — list ต่อลูกค้า/ประเภท + ฟอร์มสร้าง/แก้ draft (product picker reuse) + ปุ่มออกเอกสาร/ยกเลิก | 3 ไฟล์ข้างต้น | K5 | `requireAccountingAccess`+`assertCustomerInScope` ทุก write · สร้าง draft → แก้ไขได้ → กด "ออกเอกสาร" → ได้เลขที่จริงตามรูปแบบ `{PREFIX}-{ปีพ.ศ.}-{seq}` → แก้ไขไม่ได้อีก (UI ล็อก+server ปฏิเสธ) |
| **K7** [โค้ดได้เลย] | `sales-documents/[id]/print/page.tsx`+`SalesDocumentPrintDoc.tsx`+`.css` — หน้าพิมพ์ต่อประเภท (หัวเรื่องเปลี่ยนตาม document_type) | 3 ไฟล์ข้างต้น | K6 | เปิดพิมพ์ทั้ง 3 ประเภทได้จริง เนื้อหา/เลขที่/ยอดรวมตรงกับที่บันทึกไว้ |
| **K8** [โค้ดได้เลย] | ปุ่ม "ใบเสนอราคา/PO/วางบิล" เชื่อมจาก `page.tsx`/`CustomerTabs.tsx` เข้า `/sales-documents?customerId=` | `page.tsx`, `CustomerTabs.tsx` | K6 | เปิดจากการ์ดลูกค้าจริงแล้วไปหน้า sales-documents ของลูกค้ารายนั้นถูกต้อง |
| **K9** [โค้ดได้เลย] | `billing_note` พิเศษ: ปุ่ม "ดึงจากบิลค้างชำระ" ใน `SalesDocumentsPanel.tsx` — เลือกบิล eligible จาก `listBillingCandidates` → prefill บรรทัด (`source_bill_entry_id`+`description`+`amount`) | `SalesDocumentsPanel.tsx` | K5, K6 | เลือกลูกค้าที่มีบิลเชื่อค้างชำระ → เปิดสร้าง billing_note → เห็นรายการบิลค้างให้เลือก → เลือกแล้ว prefill ยอด/เลขที่บิลถูกต้อง → แก้ไขบิลต้นทางทีหลัง (0.14) → เอกสารที่ออกไปแล้วไม่เปลี่ยนตาม (ตรวจด้วยตา) |
| **K10** [โค้ดได้เลย] | เทสต์ครบส่วน K (`sales-documents.test.ts`, `doc-format.test.ts`, `sales-documents-actions.test.ts`) | `tests/accounting/*` | K1-K9 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M10 (schema+lib, K1-K5)**: ระบบออกเลขที่เอกสารแบบ atomic ทำงานถูกต้อง — ยังไม่มี UI
**Milestone M11 (UI, K6-K10)**: สร้าง/ออก/พิมพ์ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิลได้จริงครบ 3 ประเภท ไม่กระทบ accounting engine

### L — ปิดงานเฟส 3

| รหัส | สิ่งที่ต้องทำ | ขึ้นกับ | เกณฑ์เสร็จ |
|---|---|---|---|
| **L1** [โค้ดได้เลย] | รันชุดตรวจสอบเต็ม + ทดสอบมือทั้ง 3 ส่วนต่อเนื่องกัน (I: ออกใบหัก ณ ที่จ่าย → J: บิลเชื่อ+CN/DN+รับเงินบางส่วน+เปิดรายงาน/สมุดรายวัน/งบการเงินตรวจเลข → K: สร้าง/ออก/พิมพ์ครบ 3 ประเภท) — ดูรายละเอียดขั้นตอนในหมวด 4 | I1-I5, J1-J12, K1-K10 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม+ใหม่ทุกตัว) · ไม่มี `console.*` ที่มี PII/เลขเงิน/ชื่อลูกค้า · ไม่มี mock/stub ในโค้ด production · grep `billOutstanding(\|buildStatements(\|buildJournalBooks(` ทั่ว `app/` แล้ว diff กับรายการไฟล์ในหมวด 1 ให้ตรงกันเป๊ะก่อนปิดงาน (กัน caller ตกหล่นแบบที่เคยเกิดในเฟส 1→2) |

---

## 3) Definition of Done (เฟส 3 รวม)

- [ ] **I**: ออกหนังสือรับรองหัก ณ ที่จ่าย (print-only) ได้จริงจากบิลซื้อที่มี `whtAmount>0` เท่านั้น · ไม่มีการเขียนลง DB ใหม่ใด ๆ (ตรวจ diff migration = ไม่มีของ I เลย) · บิลขาย/บิลไม่มี WHT ไม่เห็นปุ่มนี้
- [ ] **J**: สร้าง/แก้ไข (เฉพาะ draft)/ยืนยัน/ยกเลิก CN/DN ได้จริงเฉพาะบิลเชื่อที่ยืนยันแล้ว (`isCreditEligibleForPayment`) · `billOutstanding()` คำนวณรวม `netAdjustment` ถูกต้องทุกจุดที่เรียก (payments/aging/validate overpay) · double-entry ของ CN/DN สมดุลทุกเคสตามตาราง 0.5 · ไหลเข้าสมุดรายวัน (เล่ม sale/purchase ตามฝั่งบิล) และงบทดลอง/งบการเงินถูกต้องจริง — ตรวจเทียบเลขมือ
- [ ] **K**: สร้าง/แก้ไข (เฉพาะ draft)/ออกเอกสาร/ยกเลิกได้จริงครบ 3 ประเภท · เลขที่เอกสารออกโดยระบบ ไม่ซ้ำ ไม่กระโดดผิดปกติ รูปแบบ `{PREFIX}-{ปีพ.ศ.}-{seq:04d}` ถูกต้อง · เอกสารที่ออกแล้ว (`issued`) แก้ไขไม่ได้จริงทั้ง UI และ server · `billing_note` prefill จากบิลค้างชำระได้ถูกต้อง และไม่ sync ย้อนหลังถ้าบิลต้นทางถูกแก้ไขทีหลัง (0.14) · **ยืนยันด้วยโค้ด review ว่า `sales-documents.ts` ไม่แตะ engine บัญชีเลย**
- [ ] ทุก write path ผ่าน guard ที่ถูกต้อง (`requireAccountingAccess`+`assertCustomerInScope` ตามลูกค้า/บิลที่ผูก — I ไม่มี write path)
- [ ] ไม่มี regression ในฟีเจอร์เดิมทุกเฟสก่อนหน้า (ลงบัญชีซื้อ/ขายปกติ, manual JE เฟส 1, `bill_payments`/AR-AP aging เฟส 2 ที่ไม่มี CN/DN เกี่ยวข้อง — ตัวเลขต้องเหมือนเดิมเป๊ะเมื่อ `netAdjustment=0`)
- [ ] ไม่มี `console.log`/log ที่มี PII/ตัวเลข/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี secret ฝังในโค้ด (เฟสนี้ไม่มี secret ใหม่)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่

---

## 4) แนวทางการทดสอบ

**Unit test (ตามตารางงาน I/J/K ข้างบน) — เน้น pure logic ที่คำนวณเงิน/สมดุล/เลขที่เอกสาร:**
- `wht-cert.ts`: eligibility + การกรอง/แปลงบรรทัด WHT ถูกต้องทุกกรณี (0/1/หลายบรรทัด wht ในบิลเดียว)
- `credit-debit-notes.ts`: `noteSignedAdjustment` ถูกสัญญาณ (credit=ลบ/debit=บวก/draft=0) · `toJournalLines`/`toJournalPosting` สมดุลเสมอครบ 4 กรณี (sale×credit, sale×debit, purchase×credit, purchase×debit) ตามตาราง 0.5 · `validateNoteInput` ปฏิเสธครบทุก branch
- `bill-payments.ts`: `billOutstanding` กับ `netAdjustment` ทุกเคส (ไม่มี CN/DN / มี CN อย่างเดียว / มี DN อย่างเดียว / ผสมกันหลายใบ / draft ไม่นับ) · `validatePaymentInput` ปฏิเสธ overpay ที่คำนวณรวม `netAdjustment` แล้วถูกต้อง
- `aging.ts`: `buildAgingReport` กับ `netAdjustmentByEntry` เปลี่ยน bucket/ยอดรวมถูกต้อง (ไม่กระทบพฤติกรรมเดิมเมื่อ map ว่าง)
- `doc-format.ts`: `formatSalesDocNo` ทุก prefix + zero-pad + `beYearNowThai` (mock เวลา, เทียบผลกับปี พ.ศ. ที่คำนวณมือ)
- `sales-documents.ts`: `lineTotal` reuse ถูกต้อง (ไม่ใช่สูตรคู่ขนาน) · `listBillingCandidates` กรอง eligible+outstanding>0 ถูกต้อง
- `journal-books.ts`/`statements.ts` (integration ระดับไฟล์ที่แก้): `notePostings`/`noteJournalLines` ผสมกับของบิล/manual JE/`bill_payments` ในเล่ม/งบเดียวกันแล้วยังสมดุลรวม

**Integration/manual (บน dev จริง — ทำต่อเนื่องกันเป็น flow เดียว):**

*ส่วน I:*
1. เปิดบิลซื้อที่มี `whtAmount>0` → กด "ใบหัก ณ ที่จ่าย" จากแถวบิล → ตรวจเลขเงิน/อัตรา/ชื่อคู่ค้าตรงกับบิลจริง → เลือกประเภทเงินได้ + วันที่ → พิมพ์ได้จริง
2. เปิดบิลขายที่มี `whtAmount>0` (ลูกค้าเราถูกหัก) → ต้อง **ไม่เห็น** ปุ่มนี้เลย (0.2)

*ส่วน J:*
3. เปิดบิลขายเชื่อ (`credit`, confirmed) → เปิด `/chat-audit/accounting/credit-debit-notes` → สร้างใบลดหนี้ (draft) → กรอกบรรทัด+เหตุผล → ยืนยัน (confirm) → ตรวจว่าแก้ไขไม่ได้อีก
4. เปิด `/chat-audit/accounting/payments` ของบิลเดียวกัน → ยอดค้างชำระต้องลดลงตามยอด CN ทันที (ก่อนบันทึกรับเงินใด ๆ)
5. เปิด `/chat-audit/accounting/ar-ap-aging` → ยอดค้าง/bucket ของบิลนั้นตรงกับข้อ 4
6. เปิด `/chat-audit/accounting/journal-books` → เห็น CN โผล่ในเล่ม "ขาย" ยอดสมดุล · เปิด `/chat-audit/accounting/reports` → งบทดลอง → AR/รายได้/ภาษีขายลดลงถูกต้องตรงกับยอด CN (ตรวจเทียบเลขมือ)
7. บันทึกรับเงินส่วนที่เหลือ (หลังหัก CN แล้ว) จนครบ → บิลหลุดจาก `/payments`/`/ar-ap-aging` — ลองบันทึกเกินยอดที่เหลือจริง (รวม CN แล้ว) → ต้องถูกปฏิเสธ
8. สร้างใบเพิ่มหนี้ (debit_note) กับบิลซื้อเชื่อ → ตรวจฝั่งเจ้าหนี้ (AP เพิ่มขึ้น) ในทุกจุดข้างบนแบบเดียวกัน
9. ยกเลิก (void) CN/DN ที่ยืนยันแล้ว → ยอดค้างชำระ/รายงานทุกจุดกลับมาเหมือนก่อนมี CN/DN นั้น
10. regression: ลูกค้าที่ไม่มี CN/DN เลย → ตัวเลขในทุกรายงานต้องเหมือนก่อนแก้เฟสนี้เป๊ะ

*ส่วน K:*
11. เปิด `/chat-audit/accounting/sales-documents` เลือกลูกค้า → สร้างใบเสนอราคา (draft) → เพิ่มบรรทัด (เลือกสินค้าจาก product picker) → บันทึก draft → แก้ไขซ้ำได้
12. กด "ออกเอกสาร" → ได้เลขที่รูปแบบ `QT-2569-0001` → แก้ไขบรรทัด/หัวเอกสารไม่ได้อีก (ปุ่มแก้หายไป/server ปฏิเสธถ้ายิงตรง) → พิมพ์เอกสารได้ถูกต้อง
13. สร้างใบสั่งซื้อ (PO) อีกใบ → ออกเอกสาร → เลขที่เริ่มที่ `PO-2569-0001` (แยกชุดจาก QT อย่างถูกต้อง)
14. สร้างใบวางบิล (billing_note) กับลูกค้าที่มีบิลเชื่อค้างชำระ → กด "ดึงจากบิลค้างชำระ" → เลือกบิล → ยอด/เลขที่บิลต้นทาง prefill ถูกต้อง → ออกเอกสาร → เลขที่เริ่มที่ `BN-2569-0001`
15. หลังออกใบวางบิลแล้ว กลับไปแก้ยอดบิลต้นทาง (ถ้าทำได้) → เปิดใบวางบิลเดิมซ้ำ → ตัวเลขต้อง **ไม่เปลี่ยน** (0.14)
16. กด "ยกเลิก" (void) เอกสารที่ออกแล้ว 1 ใบ → สร้างเอกสารประเภทเดียวกันใหม่ → เลขที่ใหม่ต้อง **ไม่ชนกับเลขที่ยกเลิกไป** (เลขเดิมไม่ถูก reuse)
17. นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → เปิด `/credit-debit-notes`/`/sales-documents` ของลูกค้าคนอื่น → ต้องไม่เห็น/ทำรายการไม่ได้ (ทดสอบผ่าน session นักบัญชีจริง)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| Race condition ตอนเรียก `issue_sales_document()` พร้อมกัน 2 คำขอ (เอกสารเดียวกันหรือคนละเอกสารแต่ prefix/ปีเดียวกัน) | ออกแบบให้ atomic แล้วในระดับ SQL (upsert-increment + update-where-status='draft' ในฟังก์ชันเดียว, 0.12) — Postgres lock แถว `sales_document_counters` ระหว่าง upsert กันชนกันเองอยู่แล้ว ถ้าคำขอที่ 2 มาถึงแถว `sales_documents` ที่ไม่ใช่ `draft` แล้ว → `raise exception` ทั้งฟังก์ชัน rollback (ไม่เผาเลข) ผู้ใช้เห็น error "ออกเอกสารไม่สำเร็จ" ให้กดใหม่ |
| Race condition เดิมของเฟส 2 (2 คนบันทึกรับเงินพร้อมกัน) ตอนนี้ซับซ้อนขึ้นเพราะมี `netAdjustment` จาก CN/DN เข้ามาด้วย | ยังคง posture เดิม (ยอมรับความเสี่ยงนี้ เหมือนเฟส 2 0.x) — `recordBillPayment()` re-fetch ทั้งยอดชำระเดิมและ CN/DN confirmed ล่าสุดจาก DB ทุกครั้งก่อน insert (ลดโอกาสชนได้มาก) ถ้าพบชนจริงในทางปฏิบัติค่อยเพิ่ม lock เฉพาะจุดเป็นรอบถัดไป |
| CN/DN ที่ confirmed แล้วแต่คนกรอกผิด (เช่น เลือกบัญชี/ยอดผิด) — แก้ไม่ได้ต้อง void+สร้างใหม่ อาจสร้างความสับสนช่วงแรก | เหมือน `bill_payments`/manual JE เดิม — เป็นพฤติกรรมที่ตั้งใจ (ป้องกันแก้ตัวเลขบัญชีที่ยื่นภาษีไปแล้วเงียบ ๆ) ข้อความ error/ปุ่ม UI ต้องสื่อสารชัดเจนว่า "ยืนยันแล้วแก้ไม่ได้ — ยกเลิกแล้วสร้างใหม่" ก่อนกดยืนยันทุกครั้ง (confirm dialog) |
| `netAdjustment` เพิ่มความซับซ้อนของ caller หลายจุด (`bill-payments.ts`, `aging.ts`, `payments/page.tsx`, `ar-ap-aging/page.tsx`) เสี่ยงแก้ไม่ครบบางไฟล์ (ซ้ำแบบ 0.6 ที่เคยพบในเฟส 1→2) | ไล่ grep `billOutstanding(` ทั่วทั้ง repo ก่อนปิดงาน (L1) แล้ว diff กับรายการไฟล์ในหมวด 1 ให้ตรงกันเป๊ะ — เหมือน L1/H1 เดิมทำสำเร็จมาแล้วในเฟส 2 |
| `billing_note` ที่ prefill จากบิลต้นทางแล้วบิลนั้นถูกลบ (soft-delete) ทีหลัง — `source_bill_entry_id` จะชี้ไปยังบิลที่ถูกลบ | ไม่ auto-ป้องกันด้วย DB constraint (ตั้งใจ, 0.14 ระบุว่าเป็น read-only snapshot อยู่แล้ว) — หน้าแสดงเอกสารต้อง handle เคส `source_bill_entry_id` หา `bill_entries` ไม่เจอ/ถูกลบ อย่างสวยงาม (แสดง "-" ไม่ throw) เพราะข้อมูลที่ใช้จริงคือสำเนาใน `sales_document_lines` อยู่แล้วไม่ใช่ join สด |
| ผู้ใช้เข้าใจผิดว่า CN/DN กระทบยอดหัก ณ ที่จ่าย (WHT) ของบิลต้นฉบับด้วย (0.8 ระบุว่าไม่กระทบ) | ข้อความในฟอร์มสร้าง CN/DN ต้องระบุชัดเจนว่า "ไม่กระทบยอดหัก ณ ที่จ่ายเดิม — หากต้องปรับ WHT ให้ใช้ลงบันทึกบัญชีเอง (Manual JE)" (คล้ายที่เฟส 2 ทำกับหน้า `/payments` ที่กรองเฉพาะบิลเชื่อไม่ให้บิลสดมาสร้างความสับสน) |
| ปริมาณ call site ที่ต้องแก้ให้ตรงกันของ J (`reports`, `journal-books` ทั้งหน้าจอ+export) เสี่ยง gap แบบเดียวกับ 0.6 ที่เจอในเฟส 1 และ 0.6 ของเฟส 2 | เขียน task J10 ให้ครอบทั้ง 4 ไฟล์พร้อมกันในงานเดียว (ไม่แยกทำคนละรอบ) + ตรวจ manual step 6 ในหมวด 4 เทียบเลขมือก่อนถือว่า J10 เสร็จ |

---

# เฟส 4 — แผนละเอียด: งบการเงินเต็มรูป + รายงานเชิงลึก

**สโคป (ตามภาพรวม):** 3 เรื่อง ทำเป็น 3 ส่วน **M → N → O** (M เป็นโครงพื้นฐานที่ N และ O ต้องใช้ร่วมกัน):
- **(M) โครงสร้างพื้นฐาน** — "งวดเปรียบเทียบ" (comparative period) + แก้บั๊ก correctness ของ "งบสะสม ณ วันที่"
  (as-of) ที่พบระหว่างตรวจโค้ด — ไม่มี UI เป็นของตัวเอง แต่ N/O ทั้งคู่พึ่งพา
- **(N) งบการเงินฉบับทางการ** — งบกำไรขาดทุน + งบแสดงฐานะการเงิน รูปแบบพิมพ์/export เป็นทางการ
  (หัวกระดาษบริษัท/รอบบัญชี/ผู้จัดทำ-ผู้สอบทาน) พร้อมคอลัมน์เทียบงวด/ไตรมาส/ปีก่อน
- **(O) งบกระแสเงินสด** — คำนวณจากข้อมูลจริงที่มี (bill_payments/journal ที่มีอยู่แล้ว) ด้วย **direct method**
  (เหตุผลในหมวด 0.5 — มาจากการตรวจโครงสร้างข้อมูลจริง ไม่ใช่การเดา)

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `lib/accounting/statements.ts::buildStatements(entries, opening, chartByCode, manualJournalLines=[])` —
  facade เดิม (เฟส 1-3 ออกแบบ generic ไว้แล้ว) **ไม่แก้ signature เลยในเฟสนี้** — เรียกซ้ำ 2 รอบแทน (0.3)
- `lib/accounting/financial-statements.ts::buildIncomeStatement/buildBalanceSheet` — งบพื้นฐานที่มีอยู่แล้ว
  (นี่คือไฟล์ที่โจทย์เดิมเรียก "financial-statements.ts ที่มีพื้นฐานอยู่แล้ว" — ยืนยันแล้วว่ามีอยู่จริง ไม่ต้องสร้างใหม่)
- `lib/accounting/report-filter.ts::filterEntriesForReport/filterManualEntriesForReport/
  filterBillPaymentsForReport/filterCreditDebitNotesForReport` — ตัวกรองงวดเดิม (`from=""` = ไม่จำกัดต้นช่วง
  รองรับอยู่แล้ว) — ใช้ตรง ๆ เป็นกลไกหลักของ "งบสะสม ณ วันที่" (0.3) ไม่ต้องเขียนตัวกรองใหม่
- `lib/accounting/aging.ts` — มี concept "`asOfDate`" (วันที่ตั้งรายงาน) อยู่แล้วตั้งแต่เฟส 2 — ยืนยันว่า
  "งบสะสม ณ จุดเวลาหนึ่ง" เป็นแนวคิดที่ระบบเคยใช้มาก่อน ไม่ใช่เรื่องใหม่
- `lib/accounting/bill-payments.ts::toJournalLines/listBillPaymentsForEntries`,
  `lib/accounting/manual-journal.ts::toJournalLines/listManualEntries`,
  `lib/accounting/credit-debit-notes.ts::toJournalLines/listNotesForEntries` — 3 แหล่งข้อมูล `JournalLine[]`
  ที่ `reports/page.tsx`/`reports/export/route.ts` โหลด+concat กันอยู่แล้ว (โค้ดซ้ำ 4 จุด — เฟสนี้จะสกัดเป็น
  ฟังก์ชันเดียว, 0.13)
- `supabase/migrations/` ล่าสุด (ยืนยันด้วย `ls`) = `0070_sales_documents.sql` — **เฟสนี้ไม่มี migration ใหม่เลย
  แม้แต่ไฟล์เดียว** (0.2) — ถ้ามีเฟสถัดไปต้องใช้ schema เลขถัดไปคือ `0071`
- `app/chat-audit/accounting/wht-cert/page.tsx` — pattern "หัวกระดาษจาก `customers.business_name ||
  customers.name` + `tax_id` + `address` (best-effort, migration 0058)" ที่ส่วน N จะ mirror สำหรับ letterhead
- `lib/accounting/chart-of-accounts.ts` + seed 75 รายการใน migration 0063 — ใช้เป็นฐานออกแบบ
  `cash-flow-config.ts` (0.7) โดยดูรหัสจริงที่มี (สินทรัพย์ถาวร 1610/1615/1640/1645, หุ้นกู้ 2110,
  ทุนเรือนหุ้น 3010, เงินปันผลค้างจ่าย 2035 ฯลฯ)

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ขอบเขต M → N → O และทำเป็นหน้าใหม่แยกจาก `/reports` เดิม
`/chat-audit/accounting/reports` เดิมเป็นหน้า "ใช้งานภายใน" (สมุดรายวัน/แยกประเภท/งบทดลอง/กำไรขาดทุน/ฐานะ
รวม 5 แท็บ, เห็นรายการตกหล่น, ปุ่ม RD Prep) — เฟส 4 **ไม่แก้ 5 แท็บเดิมของหน้านั้น** (ลดความเสี่ยง regression
กับหน้าที่ใช้งานทุกวัน) แต่สร้างหน้าใหม่ `/chat-audit/accounting/financial-statements` เฉพาะ "งบการเงินฉบับ
ทางการ" (กำไรขาดทุน + ฐานะ + กระแสเงินสด, เทียบงวดได้, พิมพ์/export สวย) — 2 หน้าอยู่คู่กันได้ ไม่ทับซ้อน
กัน (เหมือนที่ `/journal-books` กับ `/reports` แท็บ "สมุดรายวัน" อยู่คู่กันมาตั้งแต่ต้น)
ลำดับทำ: **M (โครงพื้นฐาน) → N (กำไรขาดทุน+ฐานะ ฉบับทางการ) → O (กระแสเงินสด)** เพราะ O ต้องพึ่งทั้ง
M (opening cash แบบสะสมถูกต้อง) และโครง UI/print/export ที่ N สร้างไว้ก่อนแล้ว (เพิ่มแค่แท็บที่ 3)

### 0.2 ขอบเขต "เป็นทางการ" = presentation + composition layer เท่านั้น — **ไม่มี migration ใหม่เลย**
- ไม่แตะโครงสร้างข้อมูลใด ๆ (`bill_entries`/`manual_journal_entries`/`bill_payments`/`credit_debit_notes` ฯลฯ
  เดิมทั้งหมด) — letterhead ใช้ `customers.business_name/name/tax_id/address` ที่มีอยู่แล้ว (mirror wht-cert)
- **ผู้จัดทำ/ผู้สอบทาน** (preparer/reviewer) = ช่องกรอกอิสระในฟอร์มพิมพ์เท่านั้น **ไม่ persist ลง DB**
  (mirror เลขที่หนังสือรับรอง WHT ที่เฟส 3 ตัดสินใจไว้แล้ว ข้อ 0.2 ของเฟส 3) **[⚠️ FLAG]** ถ้าต้องการเก็บ
  เป็นบันทึกตรวจสอบย้อนหลังจริงจัง (audit trail ว่าใครจัดทำ/สอบทานงบไหนเมื่อไหร่) ต้องเพิ่ม schema ใหม่
  แยกต่างหาก — เสนอเป็นรอบถัดไปถ้าพบว่าจำเป็นจริงในทางปฏิบัติ
- รูปแบบพิมพ์เป็น "รูปแบบที่พบบ่อยตามงบการเงินไทยทั่วไป" ไม่ใช่แบบฟอร์มยื่นกรมพัฒนาธุรกิจการค้า/สภาวิชาชีพ
  บัญชีเป๊ะ 100% (เหมือนที่ wht-cert/receipt-cert เคยประกาศไว้ในเฟสก่อน) — ถ้าต้องใช้ยื่นทางการจริง
  ให้แจ้งปรับเค้าโครง/ถ้อยคำในรอบถัดไป

### 0.3 ⚠️ พบบั๊ก correctness ที่มีอยู่ก่อนเฟสนี้: "งบแสดงฐานะการเงิน" ต้องเป็นงบสะสม ณ วันที่ ไม่ใช่ flow
**[⚠️ FLAG — พบระหว่างตรวจโครงสร้างข้อมูลจริง ไม่ได้อยู่ในคำขอเดิม]**
`buildStatements()` ปัจจุบัน (เฟส 1-3) รับ entries ชุดเดียว (`filterEntriesForReport(entries, {from, to})`)
แล้วสร้าง `ledger`/`trialBalance`/`incomeStatement`/`balanceSheet` **จากชุดเดียวกันหมด** — งบกำไรขาดทุน
เป็น *flow statement* (ถูกต้องแล้วที่ใช้ `from-to`) แต่งบแสดงฐานะการเงินเป็น *stock/point-in-time statement*
ต้องเท่ากับ "ยอดยกมา + ความเคลื่อนไหว**ทั้งหมด**ตั้งแต่ต้นจนถึงวันที่ตั้งงบ (`to`)" เท่านั้น — ถ้าผู้ใช้ตั้งทั้ง
`from` และ `to` (เช่นดูเฉพาะเดือนมีนาคม) แท็บ "งบแสดงฐานะการเงิน" ของ `/reports` ปัจจุบัน **จะขาดผลกระทบของ
เดือนก่อนหน้า `from` ไปเงียบ ๆ** (ตัวเลขผิด) — ที่ผ่านมาไม่เคยมีใครสังเกตเพราะ default UI คือ "— ต้น —"
(from ว่างเสมอ) ผู้ใช้จริงมักไม่ตั้ง `from` ตอนดูงบฐานะ
- **ตัดสินใจ: ไม่แก้ `/reports` เดิม** (ลดความเสี่ยง regression กับหน้าที่ใช้งานทุกวัน — ไม่มีใครร้องเรียนบั๊ก
  นี้มาก่อนเพราะพฤติกรรมผู้ใช้จริงหลีกเลี่ยงมันโดยบังเอิญ) — แก้ให้ถูกต้อง **เฉพาะ pipeline ใหม่ของเฟสนี้**
  (`formal-statements.ts`, 0.4) เท่านั้น
- **วิธีแก้ (ไม่แตะ `buildStatements`/`buildLedger`/`buildTrialBalance`/`buildBalanceSheet` แม้แต่บรรทัดเดียว):**
  เรียก `buildStatements()` (ฟังก์ชันเดิม เหมือนเดิมทุกอย่าง) **2 รอบต่องวด**:
  1. รอบ **"flow"** — entries กรองด้วย `{from, to}` ตามที่ผู้ใช้เลือกจริง → ใช้ผลลัพธ์ `.journal`/`.ledger`/
     `.trialBalance`/`.incomeStatement` (ทั้งหมดนี้เป็น flow ที่ถูกต้องอยู่แล้ว)
  2. รอบ **"cumulative"** — entries กรองด้วย `{from: "", to}` (ตัด `from` ทิ้ง ใช้แค่ `to` เดิม) → ใช้เฉพาะ
     `.balanceSheet` ของรอบนี้ (สะสมถูกต้องตั้งแต่ยอดยกมาแรกสุดถึง `to`)
  - ประกอบเป็นก้อนใหม่ `FormalStatements = { flow: Pick<Statements,'journal'|'ledger'|
    'trialBalance'|'incomeStatement'>, balanceSheet: BalanceSheet }` ใน `formal-statements.ts` (M4)

### 0.4 รูปแบบ "เทียบช่วงเวลา/ไตรมาส" — shift งวดแบบทั่วไป (ครอบคลุมเดือน/ไตรมาส/กำหนดเอง) + เทียบสองจุดเวลาสำหรับงบฐานะ
- ผู้ใช้เลือกงวดปัจจุบันแบบเดิม (`from`/`to` เป็น YYYY-MM, ยาวกี่เดือนก็ได้) + ปุ่มลัด "ไตรมาส" (`quarterRangeOf`
  ช่วยตั้ง `from-to` ให้เป็น 3 เดือนของไตรมาสปฏิทินที่เลือกอย่างเดียว ไม่ใช่ "โหมดเทียบ" แยกต่างหาก)
- โหมดเทียบ (`ComparePeriodMode`): `none` (ค่าเริ่มต้น) / `prev_period` (งวดก่อนหน้าที่ "ยาวเท่ากัน" —
  ใช้ได้ทั้งกรณีเทียบเดือนก่อนหน้าและไตรมาสก่อนหน้าด้วยสูตรเดียวกัน: shift ถอยหลังเท่าจำนวนเดือนของงวดที่เลือก
  เอง) / `prev_year` (งวดเดียวกัน ปีก่อนหน้า — shift ถอยหลัง 12 เดือนเสมอ ไม่ว่างวดจะยาวเท่าไร) / `custom`
  (ผู้ใช้กรอก `compareFrom`/`compareTo` เอง — validate ด้วย `validMonth` เดิม)
- **งบกำไรขาดทุนเทียบ 2 ช่วง** (flow vs flow) ตาม `from-to` ของแต่ละงวดตรง ๆ — ถูกต้องตามหลักบัญชี (income
  statement เปรียบเทียบ "สองรอบระยะเวลา")
- **งบแสดงฐานะการเงินเทียบ 2 จุดเวลา** (ไม่ใช่ 2 ช่วง) — ใช้ `to` ของแต่ละงวดเป็น "วันที่ตั้งงบ" แล้วคำนวณ
  สะสมแบบ 0.3 ทั้งคู่ (เช่น "31 มี.ค. 2569" เทียบ "31 มี.ค. 2568" ไม่ใช่ "ม.ค.-มี.ค. 2569" เทียบ "ม.ค.-มี.ค.
  2568" แบบ flow) — ตรงกับที่งบดุลเปรียบเทียบจริงทำกันเสมอ (ณ วันสิ้นงวด 2 ปีติดกัน)

### 0.5 วิธีคำนวณงบกระแสเงินสด: **Direct Method แบบไล่เส้นเงินจาก double-entry จริง** (ไม่ใช่ Indirect)
**[สำคัญที่สุดของเฟสนี้ — เหตุผลจากการตรวจโครงสร้างข้อมูลจริง ไม่ใช่การเดา]**
พิจารณา **Indirect method** (เริ่มจากกำไรสุทธิ + บวกกลับรายการไม่ใช่เงินสด เช่น ค่าเสื่อม + ปรับผลต่างสินทรัพย์/
หนี้สินหมุนเวียนจากงบทดลอง 2 จุดเวลา) ก่อน — พบว่า **ผังบัญชีของระบบนี้ไม่มี flag แยกว่าบัญชีไหนเป็น
"รายการไม่ใช่เงินสด" (non-cash item)** เลย (นับตั้งแต่เฟส 1 ผังบัญชีแก้ไขได้เองโดย tenant แล้ว — ยิ่งเดา
รหัสค่าเสื่อม `537x`/`538x` แบบ hardcode ไม่ได้ เพราะ tenant อาจเปลี่ยน/เพิ่ม/ลบรหัสเหล่านี้เองได้จริง) →
indirect method ในระบบนี้ต้อง "เดา" กติกาเพิ่มจำนวนมาก เสี่ยงผิดเงียบ ๆ สูง
ในทางกลับกัน ตรวจพบว่า **ระบบมี `JournalLine[]`/`JournalPosting` ที่จับกลุ่มตาม `entryId` อยู่แล้วในทุกแหล่ง
ข้อมูล** (`journal.ts::buildJournalEntries`, `bill-payments.ts::toJournalLines`, `manual-journal.ts::
toJournalLines`) — แต่ละบรรทัดรู้ `accountCode` ชัดเจนว่ากระทบบัญชีเงินสด/ธนาคารหรือไม่ (เทียบกับกลุ่ม
"เงินสดและรายการเทียบเท่าเงินสด" ที่คำนวณจากผังจริงของ tenant นั้น ผ่าน `bankAccountCodesOf(chart)` ที่มี
อยู่แล้วตั้งแต่เฟส 1) → **ไล่ทุกบรรทัดที่กระทบกลุ่มนี้ แล้วดูว่า "อีกขา" (contra) ของธุรกรรมเดียวกันคือบัญชี
อะไร** เพื่อจัดกิจกรรม (ดำเนินงาน/ลงทุน/จัดหาเงิน) — ทำได้ตรง ๆ จากข้อมูลจริงที่มี ไม่ต้องเดา ไม่ต้องแก้
engine เดิม ไม่ต้อง migration ใหม่
- CN/DN (เฟส 3, 0.5 เดิม) ไม่มีบรรทัดแตะบัญชีเงินสดเลยแม้แต่กรณีเดียว (contra คงที่ = AR/AP เสมอ) →
  ไม่ต้องมีโค้ดพิเศษกันออก จะไม่ถูกนับเข้า CF โดยธรรมชาติของข้อมูล (ยืนยันด้วยเทสต์)
- ผลลัพธ์ที่ได้ตรงกับ direct method มาตรฐาน (แสดง "เงินสดรับจากลูกค้า"/"เงินสดจ่ายผู้ขาย/ค่าใช้จ่าย"/
  "เงินสดจ่ายซื้อสินทรัพย์ถาวร" ฯลฯ) และ **อ้างอิงกลับไปยังรายการต้นทางได้ทุกบรรทัด** (audit-friendly —
  ตรงกับแนวทางโปรดักส์ "chat-audit")

### 0.6 กลุ่ม "เงินสดและรายการเทียบเท่าเงินสด" (cash pool) + ตัดรายการโอนภายในกลุ่มออก
- cash pool ของ tenant = `{1010 (เงินสด), 1015 (เงินสดย่อย)}` ∪ ทุกรหัสที่ `is_bank=true` ในผังของ tenant
  นั้น (`bankAccountCodesOf(chart)` เดิม — คำนวณจากผังจริง ไม่ hardcode 1020/1025/1030 ตรง ๆ เผื่อ tenant
  เพิ่มบัญชีธนาคารเองมากกว่า 3 บัญชี)
- `1160 (บัตรเครดิต)` **ไม่รวม** ในกลุ่มนี้ — เป็นยอดรอเคลียร์ ไม่ใช่เงินสดพร้อมใช้จริง จัดเป็นรายการปกติ
  (fallback → operating ตาม 0.7) **[⚠️ FLAG]** ถ้าธุรกิจจริงต้องการนับรวม แจ้งปรับ 1 จุดใน
  `cash-flow-config.ts::CASH_POOL_STATIC_CODES`
- 1 posting/entry ที่**ทั้งสองขา**อยู่ในกลุ่มเดียวกันหมด (เช่น ฝากเงินสดเข้าธนาคาร, โอนระหว่างบัญชีธนาคาร)
  → **ตัดออกจาก CF ทั้งหมด** (ไม่มีผลต่อยอดรวมเงินสด+เทียบเท่า ไม่ใช่กิจกรรมทางธุรกิจจริง) — ตรวจจากการ
  group `JournalLine[]` ตาม `entryId` ก่อนเสมอ

### 0.7 การจัดกลุ่มกิจกรรม (operating/investing/financing) — ตารางกลางแก้ที่เดียว (mirror `statement-config.ts`)
ไฟล์ใหม่ `lib/accounting/cash-flow-config.ts`:
- `INVESTING_CODES` — รหัสสินทรัพย์ถาวร: `1610` (ที่ดิน), `1615` (อาคาร), `1640` (อุปกรณ์สำนักงาน), `1645`
  (รถยนต์) — **ไม่รวม** รหัสค่าเสื่อมสะสม `.1` (`1615.1`/`1640.1`/`1645.1`) เพราะไม่มีทางจับคู่กับเงินสด
  โดยตรงอยู่แล้วจากลักษณะ double-entry ของรายการค่าเสื่อม (Dr ค่าเสื่อม / Cr ค่าเสื่อมสะสม ไม่มีขาไหนแตะเงินสด)
- `FINANCING_CODES` — `3010` (ทุนเรือนหุ้น), `2110` (หุ้นกู้), `2035` (เงินปันผลค้างจ่าย — มีผลเฉพาะตอน
  "จ่ายจริง" ที่มีบรรทัดแตะเงินสดเท่านั้น การตั้งพักหนี้ปันผลเองไม่แตะเงินสด จึงไม่เข้า CF อยู่แล้ว)
- ทุกรหัสอื่นที่ไม่อยู่ 2 ชุดนี้ (รวม AR/AP/VAT/WHT/รายได้/ค่าใช้จ่ายทั้งหมด) → **operating** (ค่าเริ่มต้น
  fallback — ถูกต้องสำหรับธุรกรรมส่วนใหญ่ของธุรกิจ SME ทั่วไป)
- ฟังก์ชัน `classifyCashFlowActivity(code): 'operating' | 'investing' | 'financing'`
- **[⚠️ FLAG]** ถ้า tenant เพิ่มรหัสบัญชีสินทรัพย์ถาวร/เงินกู้ใหม่เองนอกชุดที่กำหนดไว้ (เช่น "เงินกู้ยืม
  ระยะยาวจากกรรมการ") รายการนั้นจะถูกจัดเป็น operating โดย default (ไม่ผิดกฎบัญชีร้ายแรงแต่ไม่ตรง 100%)
  — ทางแก้ระยะสั้น: เพิ่มรหัสในไฟล์นี้เอง (จุดเดียว ไม่กระทบที่อื่น) ถ้าต้องรองรับทั่วไปแบบไม่ hardcode ต้อง
  เพิ่มคอลัมน์ "หมวดกระแสเงินสด" ในผังบัญชี — **นอกสโคปเฟสนี้** เสนอเป็นแผนสำรอง/รอบถัดไปถ้าพบว่าจำเป็นจริง

### 0.8 การจัดสรร (allocation) เมื่อ 1 รายการมีหลายขาที่ไม่ใช่เงินสด
สำหรับ posting ที่มีขาเงินสด 1 ขา + ขาไม่ใช่เงินสดหลายขา (เช่น manual JE จ่ายเงินสดก้อนเดียวแต่บันทึกลง
หลายบัญชีค่าใช้จ่าย/ทั้งค่าใช้จ่ายและสินทรัพย์ถาวรพร้อมกัน) — จัดสรรตามยอดจริงของแต่ละขาที่ไม่ใช่เงินสด
(ไม่หารเฉลี่ย) เพราะผลรวมของขาไม่ใช่เงินสดสมดุลกับขาเงินสดเป๊ะอยู่แล้วโดยธรรมชาติของ double-entry — แต่ละขา
ไม่ใช่เงินสดจัดกิจกรรมของตัวเอง (1 entry อาจถูกแบ่งเข้าทั้ง operating และ investing พร้อมกันได้ — ถูกต้อง
ตามหลักบัญชีจริง)
กรณีมี**หลายขาเงินสดพร้อมกันในรายการเดียว** (เช่น manual JE ที่นักบัญชีคีย์เอง จ่ายจากทั้งเงินสด+ธนาคาร
พร้อมกัน) — ไม่เกิดจาก `journal.ts`/`bill-payments.ts` (สร้างขาเงินสดสูงสุด 1 ขาต่อ 1 บิล/1 การจ่ายเงินเสมอ)
อาจเกิดได้เฉพาะ manual JE เท่านั้น → จัดสรรตามสัดส่วนของแต่ละขาเงินสดต่อผลรวมขาเงินสดทั้งหมดของ posting นั้น
(proportional) — ระบุ edge case นี้ชัดในเทสต์

### 0.9 opening cash balance + reconciliation (พิสูจน์ความถูกต้อง มิเรอร์ `BalanceSheet.balanced`)
`openingCash(period)` = ผลรวม `balance` ของบัญชีในกลุ่มเงินสด (0.6) จาก **TrialBalance สะสม ณ วันสิ้นเดือน
ก่อนหน้า `from`** (ใช้ pipeline เดียวกับ 0.3: `filterEntriesForReport(entries, {from:"", to: เดือนก่อน from})`)
— ไม่ใช่แค่ `account_opening_balances` ตรง ๆ (นั่นคือยอดยกมา ณ วันเริ่มระบบเท่านั้น ถ้ามีรายการระหว่างวันเริ่ม
ระบบกับ `from` ต้องรวมเข้าด้วยเสมอ)
`closingCash(period)` = `openingCash + Σ(operating + investing + financing)` ของ CF — ต้อง**ตรงกับ**ยอด
เงินสดในงบแสดงฐานะการเงิน ณ `to` เป๊ะ (โดยธรรมชาติของการคำนวณ ถ้า classify ครบทุกบรรทัดเงินสดจริง จะตรงกัน
เสมอโดยไม่ต้อง reconcile แยก — เก็บ field `reconciled: boolean` ไว้เป็น**การตรวจสอบภายใน**ว่าไม่มีบรรทัด
เงินสดตกหล่นจาก allocation logic เอง เหมือนที่ `bs.balanced` ทำหน้าที่เตือนความผิดปกติ) — ถ้า `reconciled
=false` ให้ UI เตือนแบบเดียวกับ `bs.balanced=false`

### 0.10 หน้าใหม่ default "เฉพาะที่ยืนยันแล้ว" (`includeDraft=false`) — ต่างจาก `/reports` เดิม
`/reports` เดิม default รวม draft ด้วย (ใช้ตรวจงานระหว่างทำ) — งบการเงิน "ฉบับทางการ" ควรนิ่งกว่านั้น
default = เฉพาะที่ยืนยันแล้วเท่านั้น (ผู้ใช้สลับดูรวมร่างได้เหมือนเดิมถ้าต้องการ แค่ default ต่างกัน)

### 0.11 สิทธิ์ N/O — เหมือนหน้า `/reports` เดิมทุกประการ (ไม่ใช่ admin-only)
`resolveAccountingAccess` + `customerInScope` — งบการเงิน/กระแสเงินสดผูกลูกค้ารายเดียว (เหมือนงบทดลอง/
AR-AP aging เดิม) ไม่ใช่ทรัพยากร tenant-level (ผังบัญชี/สินค้าที่เป็น admin-only) — นักบัญชีเห็นเฉพาะลูกค้า
ที่ตัวเองดูแลเหมือนเดิมทุกจุด **ไม่มี write path ใหม่ในเฟสนี้เลย** (M/N/O ทั้งหมดเป็นอ่าน+คำนวณ+แสดงผล/export)

### 0.12 Export/พิมพ์: ต่อยอด Excel workbook เดิม + หน้าพิมพ์ CSS ใหม่ — ไม่เพิ่ม dependency ใหม่
ระบบยังไม่มี PDF generator ฝั่งเซิร์ฟเวอร์ (export ปัจจุบันทั้งหมดเป็น `.xlsx` ผ่าน `exceljs`) — เฟสนี้ (ก)
เพิ่มฟังก์ชันชีทใหม่ใน `statements-excel.ts` (ไม่แก้ของเดิม) สำหรับงบเทียบงวด+กระแสเงินสด (ข) เพิ่มหน้าพิมพ์
HTML/CSS (`window.print()`) แยกต่างหาก mirror `wht-cert`/`receipt-cert`/`sales-documents print` ที่มีอยู่แล้ว
**[⚠️ FLAG]** ถ้าต้องการไฟล์ `.pdf` จริงจากเซิร์ฟเวอร์ (ไม่ใช่ print จาก browser) เป็นงานเพิ่มเติมนอกสโคปนี้
(ต้องเพิ่ม dependency เช่น puppeteer) — แจ้งผู้ใช้แยกทำรอบถัดไปถ้าจำเป็นจริง

### 0.13 ⚠️ Refactor สกัด logic โหลด+รวม JournalLine ที่ซ้ำกัน 4 จุด เป็นฟังก์ชันเดียว
**[⚠️ FLAG — เพิ่มขอบเขตนอกคำขอเดิมเล็กน้อย แต่คุ้มค่า — ลดความเสี่ยงที่เกิดซ้ำมาแล้วทุกเฟส (ดูตาราง 5)]**
`reports/page.tsx`, `reports/export/route.ts`, `journal-books/page.tsx`, `journal-books/export/route.ts`
ทั้ง 4 ไฟล์มีโค้ด "โหลด manual JE + bill_payments + CN/DN ของงวด แล้วแปลงเป็น `JournalLine[]`" ซ้ำกันเป๊ะ
(คัดลอกกันมาทีละเฟส 1→2→3) — เสี่ยง gap แบบที่ตารางความเสี่ยงเฟส 1-3 เคยเตือนไว้ซ้ำ ๆ ("ปริมาณ call site
ที่ต้องแก้ให้ตรงกัน") เฟสนี้สกัดเป็น `lib/accounting/statement-inputs.ts::loadCombinedJournalLines()`
ฟังก์ชันเดียว แล้ว **รีแฟกเตอร์ 4 จุดเดิมให้เรียกฟังก์ชันนี้แทน** (behavior-preserving 100% ไม่เปลี่ยนพฤติกรรม
แม้แต่จุดเดียว) — หน้าใหม่ (N/O) ก็เรียกฟังก์ชันเดียวกันนี้ กันโค้ดคู่ขนานเพิ่มอีกชุด
- ถ้าประเมินแล้วเสี่ยงเกินไป (แตะไฟล์ที่ใช้งานทุกวัน) **แผนสำรอง**: ข้ามการรีแฟกเตอร์ 4 จุดเดิม ให้หน้าใหม่
  เรียก `loadCombinedJournalLines()` เองอย่างเดียว (ยอมให้โค้ดเดิม 4 จุดยังคงซ้ำต่อไปตามเดิม) — ระบุไว้ใน
  ตารางงาน M3 ว่าเป็นงานที่ทำแยกได้ ไม่ผูกกับ N/O

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 4

```
supabase/migrations/
  (ไม่มี migration ใหม่ในเฟสนี้ — M/N/O เป็น presentation + composition layer ล้วน ไม่มี schema เปลี่ยนแปลง
   ยืนยันจาก `ls supabase/migrations` แล้วว่า 0070_sales_documents.sql เป็นไฟล์ล่าสุด ณ วันที่วางแผน —
   ถ้าเฟสถัดไปต้องใช้ schema ใหม่ เลขไฟล์ถัดไปคือ 0071 ให้เช็คซ้ำอีกครั้งก่อนสร้างจริง)

lib/accounting/
  comparative-period.ts    [ใหม่] pure: ComparePeriodMode ('none'|'prev_period'|'prev_year'|'custom'),
                                          periodLengthInMonths(from,to), shiftPeriodBackward(from,to,months)
                                          (0.4 — ใช้ทั้ง prev_period(shift=length) และ prev_year(shift=12)),
                                          resolveComparePeriod(current,mode,custom?) → {from,to}|null,
                                          quarterRangeOf(ceYear,quarter) → {from,to} (ปุ่มลัดตั้งงวดปัจจุบัน
                                          เป็นไตรมาสปฏิทิน — ไม่ใช่ "โหมดเทียบ")
  statement-inputs.ts      [ใหม่] data layer (0.13): loadCombinedJournalLines(service, tenantId, entries,
                                          period) → { manualJournalLines, paymentJournalLines,
                                          noteJournalLines } — สกัด logic เดิมที่ซ้ำ 4 จุดใน reports/*,
                                          journal-books/* (โหลด manual JE + bill_payments + CN/DN ของ
                                          entries ชุดนั้น กรองงวด/สถานะ แล้ว map เป็น JournalLine[] ผ่าน
                                          mapper เดิมทุกตัว — ไม่เขียนสูตรคำนวณใหม่แม้แต่บรรทัดเดียว)
  formal-statements.ts     [ใหม่] compose (pure, ไม่แตะ DB, 0.3): buildFormalStatements(entries,
                                          combinedLines, opening, chartByCode, period) → เรียก
                                          buildStatements() 2 รอบ (flow + cumulative) ประกอบเป็น
                                          FormalStatements = { flow: Pick<Statements,'journal'|'ledger'|
                                          'trialBalance'|'incomeStatement'>, balanceSheet: BalanceSheet }
                                          — งาน O3 จะเพิ่ม cashFlow เข้าก้อนนี้ทีหลัง
  cash-flow-config.ts      [ใหม่] pure (0.6/0.7): CASH_POOL_STATIC_CODES=['1010','1015'],
                                          cashPoolCodesOf(chart) (รวม is_bank), INVESTING_CODES,
                                          FINANCING_CODES, classifyCashFlowActivity(code)
  cash-flow.ts             [ใหม่] pure หลักของ O (0.5/0.6/0.7/0.8/0.9): buildCashFlowStatement(
                                          journalLines: JournalLine[], openingCash: number, chartByCode,
                                          chart: ChartAccount[]) → CashFlowStatement { operating[],
                                          investing[], financing[], totalOperating, totalInvesting,
                                          totalFinancing, netChange, openingCash, closingCash,
                                          reconciled: boolean } — แต่ละบรรทัดใน operating/investing/
                                          financing เก็บ {entryId, date, docNo, description, accountCode,
                                          accountName, amount} (อ้างอิงกลับต้นทางได้)
  statements-excel.ts      [แก้] เพิ่มฟังก์ชันใหม่ (ไม่แก้ของเดิมแม้แต่บรรทัดเดียว): sheetIncomeComparative,
                                          sheetBalanceComparative, sheetCashFlow + export ใหม่
                                          buildFormalStatementsWorkbook(formal, comparison?, cashFlow?,
                                          header) — ไฟล์แยกจาก buildStatementsWorkbook() เดิม (คนละ route)

app/chat-audit/accounting/
  reports/page.tsx                [แก้ในงาน M3 เท่านั้น] เรียก loadCombinedJournalLines() แทนโค้ด inline
                                          เดิม (ไม่เปลี่ยน UI/ตัวเลข/พฤติกรรมแม้แต่จุดเดียว)
  reports/export/route.ts         [แก้ในงาน M3] เหมือนกัน
  journal-books/page.tsx          [แก้ในงาน M3] เหมือนกัน
  journal-books/export/route.ts   [แก้ในงาน M3] เหมือนกัน
  financial-statements/page.tsx              [ใหม่] เลือกลูกค้า(สโคป)+งวด(from/to + ปุ่มลัดไตรมาสจาก
                                          quarterRangeOf)+โหมดเทียบ(none/prev_period/prev_year/custom)+
                                          เฉพาะยืนยันแล้ว(0.10, default true) → แท็บ "กำไรขาดทุน"/"ฐานะ
                                          การเงิน"/"กระแสเงินสด" (แท็บที่ 3 มาจากงาน O) พร้อมคอลัมน์เทียบงวด
                                          ถ้าเลือกโหมดเทียบ (mirror สไตล์ inline function component ของ
                                          reports/page.tsx เดิม)
  financial-statements/print/page.tsx        [ใหม่] server component (guard สโคป, mirror wht-cert/
                                          page.tsx) โหลดข้อมูลเดียวกับหน้าจอ + letterhead ลูกค้า
  financial-statements/FinancialStatementPrintDoc.tsx [ใหม่] client presentational (mirror
                                          WhtCertDoc.tsx/SalesDocumentPrintDoc.tsx) — หัวกระดาษ
                                          (business_name/tax_id/address) + ชื่องบ+งวด+ช่องผู้จัดทำ/
                                          ผู้สอบทาน (กรอกอิสระ ไม่ persist, 0.2) + ตาราง (เทียบงวดถ้ามี) +
                                          ปุ่มพิมพ์
  financial-statements/financial-statements.css [ใหม่] mirror css pattern เดิม (wht-cert.css)
  financial-statements/export/route.ts       [ใหม่] เหมือน reports/export/route.ts เดิมแต่เรียก
                                          buildFormalStatementsWorkbook() แทน
  CustomerTabs.tsx        [แก้] เพิ่ม prop+ปุ่ม financialStatementsHref ("งบการเงินฉบับทางการ") เข้าแถวปุ่ม
                                          เดิม (mirror reportsHref/agingHref) — ป้ายต่างจาก reportsHref เดิม
                                          ("งบการเงิน") ชัดเจน กันสับสน 2 หน้า
  page.tsx (accounting hub) [แก้] ส่ง financialStatementsHref เข้า CustomerTabs

tests/accounting/
  comparative-period.test.ts   [ใหม่]
  statement-inputs.test.ts     [ใหม่]
  formal-statements.test.ts    [ใหม่] — สำคัญ: พิสูจน์ 0.3 ว่าบั๊กถูกแก้จริง
  cash-flow-config.test.ts     [ใหม่]
  cash-flow.test.ts            [ใหม่] — เทสต์หนักสุดของเฟส (ครอบ allocation/exclude intra-pool/
                                          classification/reconciliation ทุก edge case)
  statements-excel.test.ts     [แก้] เพิ่มเทสต์ sheet ใหม่ (ไม่แก้เทสต์เดิม)
  reports.test.ts / journal-books.test.ts (ถ้ามี integration test อยู่แล้ว) [แก้ในงาน M3] เพิ่มยืนยันว่า
                                          ผลลัพธ์เหมือนก่อน refactor เป๊ะ (regression gate)
```

---

## 2) งานย่อยเรียงลำดับ

**Legend**: [โค้ดได้เลย] = ทำตามสเปกได้ทันที · [⚠️ FLAG] = ทำต่อได้เลยแต่ต้องแจ้งผู้ใช้ (ดูรายละเอียดในหมวด 0)

### ส่วน M — โครงสร้างพื้นฐาน: งวดเปรียบเทียบ + งบสะสม ณ วันที่ (as-of) ถูกต้อง

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **M1** [โค้ดได้เลย] | `comparative-period.ts` — pure: `periodLengthInMonths`, `shiftPeriodBackward`, `resolveComparePeriod` (0.4), `quarterRangeOf` | `lib/accounting/comparative-period.ts` | - | unit test ครบทุกโหมด (`prev_period`/`prev_year`/`custom`/`none`) + `quarterRangeOf` ครบ 4 ไตรมาส + edge case ข้ามปี (เช่น shift ถอยหลังจากเดือน ม.ค. ต้องข้ามปีถูกต้อง, งวดยาวหลายเดือนไม่เท่าไตรมาส) |
| **M2** [โค้ดได้เลย] | `statement-inputs.ts` — `loadCombinedJournalLines(service, tenantId, entries, period)` (0.13, สกัด logic เดิมออกมา ไม่เปลี่ยนพฤติกรรม) | `lib/accounting/statement-inputs.ts` | - | unit test (mock DB): ผลลัพธ์ตรงกับที่ `reports/page.tsx` คำนวณ inline เดิม 100% เทียบ fixture ชุดเดียวกัน (manual JE + bill_payments + CN/DN ผสมกัน) |
| **M3** [⚠️ FLAG — ดู 0.13] | Refactor 4 จุดเดิม (`reports/page.tsx`, `reports/export/route.ts`, `journal-books/page.tsx`, `journal-books/export/route.ts`) ให้เรียก `loadCombinedJournalLines()` แทนโค้ด inline ที่ซ้ำกัน | 4 ไฟล์ข้างต้น | M2 | เทสต์เดิมทั้งหมดผ่าน 100% (ไม่มี diff พฤติกรรม) · manual regression: เปิดหน้า `/reports` และ `/journal-books` ก่อน-หลัง refactor เทียบตัวเลขทุกแท็บของลูกค้าตัวอย่าง 2-3 รายที่มีทั้งบิลปกติ/manual JE/bill_payments/CN-DN ต้องเหมือนเดิมเป๊ะ |
| **M4** [โค้ดได้เลย] | `formal-statements.ts` — `buildFormalStatements()` composition (0.3: 2 รอบ flow+cumulative) | `lib/accounting/formal-statements.ts` | M2 | unit test: ตั้ง `from≠""` → `balanceSheet` เท่ากับตอน `from=""` เป๊ะ (พิสูจน์ 0.3 แก้บั๊กจริง) · ไม่ตั้งงวดเลย (`from=to=""`) → ผลลัพธ์เหมือนเรียก `buildStatements()` ตรง ๆ ครั้งเดียว (regression-safe) · `flow.incomeStatement` ไม่เปลี่ยนไม่ว่าจะเรียกกี่รอบ (ยืนยันว่ารอบ cumulative ไม่ปนเข้ารอบ flow) |
| **M5** [โค้ดได้เลย] | เทสต์ครบส่วน M | `tests/accounting/*` | M1-M4 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M12 (ส่วน M)**: โครงสร้างพื้นฐาน "งวดเปรียบเทียบ" + "งบสะสม ณ วันที่ถูกต้อง" พร้อมใช้งาน —
ยังไม่มี UI เป็นของตัวเอง, `/reports` เดิมไม่มีการเปลี่ยนพฤติกรรมแม้แต่จุดเดียว (ถ้าทำ M3 ด้วย)

### ส่วน N — งบการเงินฉบับทางการ (งบกำไรขาดทุน + งบแสดงฐานะการเงิน, เทียบงวด, พิมพ์/export)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **N1** [โค้ดได้เลย] | หน้าใหม่ `/chat-audit/accounting/financial-statements` (จอ) — เลือกลูกค้า+งวด+ปุ่มลัดไตรมาส+โหมดเทียบ+เฉพาะยืนยันแล้ว(0.10) → แท็บกำไรขาดทุน/ฐานะ พร้อมคอลัมน์เทียบงวด | `financial-statements/page.tsx` | M4, M1 | เปิดหน้าจริง เลือกลูกค้า+งวด (ไม่ตั้ง from) → ตัวเลขตรงกับ `/reports` เดิม (regression check) · ตั้ง `from` → งบแสดงฐานะการเงินยังถูกต้อง (ต่างจาก `/reports` เดิมที่ยังมีบั๊ก 0.3 อยู่) · เลือกโหมดเทียบ (prev_period/prev_year/custom) → เห็นคอลัมน์งวดก่อนหน้า/ปีก่อนถูกต้อง (ตรวจเทียบเลขมือ) |
| **N2** [โค้ดได้เลย] | หน้าพิมพ์ `financial-statements/print/page.tsx` + `FinancialStatementPrintDoc.tsx` + `.css` — mirror wht-cert/receipt-cert: letterhead + ชื่องบ+งวด + ช่องผู้จัดทำ/ผู้สอบทาน (0.2) + ตารางเทียบงวด | 3 ไฟล์ข้างต้น | N1 | เปิดพิมพ์จริง (`window.print()`) ได้ทั้ง 2 งบ เนื้อหา/ตัวเลขตรงกับที่จอเห็น จัดหน้า A4 อ่านง่าย |
| **N3** [โค้ดได้เลย] | Export Excel — `statements-excel.ts` เพิ่ม `sheetIncomeComparative`/`sheetBalanceComparative` + route ใหม่ `financial-statements/export/route.ts` | `statements-excel.ts` (แก้เพิ่ม), `financial-statements/export/route.ts` (ใหม่) | N1 | export ได้ไฟล์ `.xlsx` จริง ตัวเลขตรงกับที่จอเห็นทั้งกรณีเทียบงวดและไม่เทียบ |
| **N4** [โค้ดได้เลย] | ลิงก์เข้าเมนู — `financialStatementsHref` ใน `CustomerTabs.tsx` + ส่งจาก `page.tsx` (accounting hub) | `CustomerTabs.tsx`, `page.tsx` | N1 | เปิดจากการ์ดลูกค้าจริงแล้วไปหน้าใหม่ของลูกค้ารายนั้นถูกต้อง |
| **N5** [โค้ดได้เลย] | เทสต์ครบส่วน N | `tests/accounting/*` | N1-N4 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M13 (ส่วน N)**: งบการเงินฉบับทางการ (กำไรขาดทุน + ฐานะ) ดู/พิมพ์/export เทียบงวดได้จริง
ครบวงจร, งบแสดงฐานะการเงินถูกต้องแม้ตั้ง `from`

### ส่วน O — งบกระแสเงินสด (Cash Flow Statement, Direct Method)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **O1** [โค้ดได้เลย] | `cash-flow-config.ts` — pure: cash pool, investing/financing codes, `classifyCashFlowActivity` (0.6/0.7) | `lib/accounting/cash-flow-config.ts` | - | unit test ครบ: cash pool รวมรหัสธนาคารที่ tenant เพิ่มเอง (`is_bank=true`) ถูกต้อง · classify ทุกโซนรหัส (1010/1015, 1020-1030, AR/AP, VAT/WHT, 16xx, 3010/2110/2035, รหัสอื่นนอกชุด→operating) |
| **O2** [โค้ดได้เลย] | `cash-flow.ts` — `buildCashFlowStatement()` (0.5/0.6/0.7/0.8/0.9: group by entryId, ตัด intra-pool transfer, allocate, จัดกิจกรรม, totals, reconciled) | `lib/accounting/cash-flow.ts` | O1 | unit test หนักสุดของเฟส ครอบทุกกรณี: บิลขายเงินสด→operating inflow · บิลซื้อเชื่อ+รับชำระทีหลัง(bill_payments)→operating · manual JE ซื้อสินทรัพย์ถาวรด้วยเงินสด→investing · manual JE เพิ่มทุน/ออกหุ้นกู้→financing · ฝากเงินสดเข้าธนาคาร(intra-pool)→ไม่ปรากฏใน CF เลย · manual JE เงินสดจ่ายก้อนเดียวแบ่งหลายบัญชี(operating+investing ผสม)→allocate ถูกสัดส่วน (0.8) · CN/DN ไม่ปรากฏใน CF เลย (ยืนยัน 0.5) · `reconciled=true` เทียบ `closingCash` กับผลรวม cash-pool balance จาก ledger จริง |
| **O3** [โค้ดได้เลย] | ต่อเข้า `formal-statements.ts` — เพิ่ม `cashFlow` เข้าผลลัพธ์ composition (openingCash จากรอบ cumulative "เดือนก่อน `from`", 0.9) | `formal-statements.ts` (แก้) | O2, M4 | unit test: `closingCash` ที่คำนวณจาก CF ตรงกับยอดเงินสด-เทียบเท่าใน `balanceSheet` ของ `formal-statements` เป๊ะ (reconciliation end-to-end) |
| **O4** [โค้ดได้เลย] | UI แท็บ "กระแสเงินสด" ในหน้า N1 + พิมพ์ (N2) + export sheet ใหม่ (`sheetCashFlow`) — เทียบงวดเหมือน N | `financial-statements/page.tsx`, `FinancialStatementPrintDoc.tsx`, `statements-excel.ts` (แก้เพิ่ม) | O3, N1, N2, N3 | เปิดหน้าจริง แท็บกระแสเงินสด เห็น operating/investing/financing + `reconciled ✓` · พิมพ์/export ตรงกับจอ · เลือกโหมดเทียบงวด → เห็น 2 คอลัมน์ถูกต้อง |
| **O5** [โค้ดได้เลย] | เทสต์ครบส่วน O | `tests/accounting/*` | O1-O4 | ชุดเทสต์ผ่านทั้งหมด รวมเทสต์เดิม |

**Milestone M14 (ส่วน O, engine O1-O3)**: งบกระแสเงินสด (direct method) คำนวณถูกต้อง `reconciled` กับ
งบฐานะเสมอ — ยังไม่มี UI
**Milestone M15 (ส่วน O, UI O4-O5)**: ดู/พิมพ์/export งบกระแสเงินสดได้จริงครบวงจร

### P — ปิดงานเฟส 4

| รหัส | สิ่งที่ต้องทำ | ขึ้นกับ | เกณฑ์เสร็จ |
|---|---|---|---|
| **P1** [โค้ดได้เลย] | รันชุดตรวจสอบเต็ม + ทดสอบมือ M→N→O ต่อเนื่องกัน (ดูหมวด 4) | M1-M5, N1-N5, O1-O5 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม+ใหม่ทุกตัว) · grep `buildStatements(\|buildLedger(\|filterEntriesForReport(` ทั่ว `app/`+`lib/` แล้ว diff กับรายการไฟล์ในหมวด 1 ให้ตรงกันเป๊ะก่อนปิดงาน (กัน call site ตกหล่นแบบที่เจอซ้ำทุกเฟส) · regression เต็มของ `/reports`/`/journal-books` เดิม (ถ้าทำ M3) ตัวเลขต้องเหมือนก่อนแก้เป๊ะทุกจุด · ไม่มี `console.*` ที่มี PII/เลขเงิน/ชื่อลูกค้า · ไม่มี mock/stub ในโค้ด production · ยืนยันไม่มี migration ใหม่เกิดขึ้นโดยไม่ตั้งใจ (`git status` เทียบ `supabase/migrations/`) |

---

## 3) Definition of Done (เฟส 4 รวม)

- [ ] **M**: `resolveComparePeriod`/`shiftPeriodBackward` คำนวณงวดเทียบถูกต้องทุกโหมด (เดือนก่อนหน้า/
      ไตรมาสก่อนหน้า/ปีก่อน/กำหนดเอง) · งบแสดงฐานะการเงินที่คำนวณผ่าน `formal-statements.ts` ถูกต้องเสมอไม่
      ว่าจะตั้ง `from` หรือไม่ (พิสูจน์แล้วว่าเท่ากับตอนไม่ตั้ง `from`) · `buildStatements()`/`buildLedger()`/
      `buildTrialBalance()`/`buildIncomeStatement()`/`buildBalanceSheet()` เดิม**ไม่ถูกแก้ signature เลย**
- [ ] **N**: งบกำไรขาดทุน + งบแสดงฐานะการเงิน "ฉบับทางการ" ดู/พิมพ์/export ได้จริง มี letterhead
      (business_name/tax_id/address) + งวดบัญชี + ช่องผู้จัดทำ/ผู้สอบทาน · เทียบงวด/ไตรมาส/ปีก่อนได้ถูกต้อง
      ตรวจเทียบเลขมือ · ไม่กระทบ `/reports` เดิมแม้แต่จุดเดียว (ถ้าไม่ทำ M3) หรือเหมือนเดิมเป๊ะ (ถ้าทำ M3)
- [ ] **O**: งบกระแสเงินสด (direct method) แสดงเงินสดรับ/จ่ายจริงแยก 3 กิจกรรม (ดำเนินงาน/ลงทุน/จัดหาเงิน)
      อ้างอิงกลับต้นทางได้ทุกบรรทัด · `reconciled=true` เสมอ (ปิดยอดตรงกับงบแสดงฐานะการเงิน) · รายการโอน
      ภายในกลุ่มเงินสด (ฝากเงินสดเข้าธนาคาร ฯลฯ) ไม่ปรากฏใน CF · CN/DN ไม่ปรากฏใน CF (ยืนยันตาม 0.5)
- [ ] **ไม่มี migration ใหม่** ในเฟสนี้ (0 ไฟล์ในหมวด `supabase/migrations/`) — ยืนยันด้วย `git status`
- [ ] **ไม่มี write path ใหม่ในเฟสนี้เลย** (M/N/O ทั้งหมดเป็นอ่าน+คำนวณ+แสดงผล/export) — guard
      `resolveAccountingAccess`+`customerInScope` ครบทุกจุดเข้าถึง (N1, N2, N3, O4)
- [ ] ไม่มี regression ในฟีเจอร์เดิมทุกเฟสก่อนหน้า — โดยเฉพาะ `/reports` และ `/journal-books` เดิม (ถ้าทำ
      M3 refactor) ตัวเลขทุกแท็บต้องเหมือนก่อนแก้เป๊ะ
- [ ] ไม่มี `console.log`/log ที่มี PII/ตัวเลข/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี secret ฝังในโค้ด (เฟสนี้ไม่มี secret ใหม่)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/
      warning ใหม่

---

## 4) แนวทางการทดสอบ

**Unit test (ตามตารางงาน M/N/O ข้างบน) — เน้น pure logic ที่คำนวณเงิน/งวด/กิจกรรมกระแสเงินสด:**
- `comparative-period.ts`: `resolveComparePeriod` ทุกโหมด + edge case ข้ามปี/งวดยาวไม่เท่าไตรมาส
- `formal-statements.ts`: การพิสูจน์บั๊ก 0.3 ("`from` ตั้งหรือไม่ตั้ง ผลลัพธ์งบแสดงฐานะการเงินต้องเหมือนกัน")
  เป็นเทสต์ที่**ต้องมี**และห้ามข้าม
- `cash-flow.ts`: ครบทุกประเภทธุรกรรม (บิลเงินสด/บิลเชื่อ+รับชำระ/manual JE ทุกกิจกรรม/โอนภายในกลุ่ม/
  หลายขาไม่ใช่เงินสด/CN-DN ไม่ปรากฏ) + `reconciled` ต้อง `true` ทุกกรณีทดสอบ
- `statement-inputs.ts`: ผลลัพธ์ตรงกับโค้ด inline เดิมทุกกรณี (regression กับพฤติกรรมเดิม)

**Integration/manual (บน dev จริง — ทำต่อเนื่องกันเป็น flow เดียว):**
1. เปิด `/chat-audit/accounting/reports` (ก่อนทำ M3) → จดตัวเลขงบกำไรขาดทุน/ฐานะของลูกค้าตัวอย่าง 1 ราย
   (ไม่ตั้ง `from`) → ทำ M3 refactor แล้วเปิดซ้ำ → ตัวเลขต้องเหมือนเดิมทุกตัว (regression gate ของ M3)
2. เปิด `/chat-audit/accounting/financial-statements` เลือกลูกค้าเดียวกัน + งวดเดียวกัน (ไม่ตั้ง `from`)
   → ตัวเลขต้องตรงกับ `/reports` เดิมทุกจุด (income + balance)
3. ตั้ง `from` เป็นเดือนกลาง ๆ (เช่น เดือนที่ 6 ของปี ทั้งที่มีข้อมูลตั้งแต่เดือนที่ 1) บนหน้าใหม่ → เปิดแท็บ
   "งบแสดงฐานะการเงิน" → ตัวเลขต้องรวมผลกระทบเดือน 1-5 ด้วย (ต่างจาก `/reports` เดิมที่จะขาดไป — ยืนยันว่า
   บั๊ก 0.3 ถูกแก้ในหน้าใหม่จริง)
4. เลือกโหมดเทียบ "งวดก่อนหน้า" (เดือนเดียว) → ตรวจคอลัมน์เทียบตรงกับเดือนก่อนหน้าจริง (เทียบเลขมือ)
5. ใช้ปุ่มลัด "ไตรมาส" ตั้งงวดปัจจุบันเป็นไตรมาส → เลือกโหมดเทียบ "งวดก่อนหน้า" → ต้องได้ไตรมาสก่อนหน้า
   (3 เดือนย้อนไป) ไม่ใช่แค่ 1 เดือน
6. เลือกโหมดเทียบ "ปีก่อน" → ตรวจว่างวดเทียบ = งวดเดียวกันเป๊ะแต่ปีก่อนหน้า (ไม่ใช่ shift ตามความยาวงวด)
7. เลือกโหมดเทียบ "กำหนดเอง" → กรอกงวดเทียบเอง → ตรวจว่าใช้ตามที่กรอกจริง
8. เปิดแท็บ "กระแสเงินสด" ของลูกค้าที่มีทั้งบิลเงินสด/บิลเชื่อ+รับชำระบางส่วน/manual JE (ถ้ามี) → ตรวจว่า
   ตัวเลขรวม 3 กิจกรรม + `reconciled ✓` ปรากฏ (ไม่มีคำเตือนไม่ตรง)
9. สร้าง manual JE ทดสอบ: ซื้อสินทรัพย์ถาวร (เช่น "อุปกรณ์สำนักงาน" 1640) ด้วยเงินสด → ยืนยัน → เปิดแท็บ
   กระแสเงินสด → ต้องเห็นรายการนี้ในกลุ่ม "กิจกรรมลงทุน" ยอดถูกต้อง
10. สร้าง manual JE ทดสอบ: เพิ่มทุนเรือนหุ้น (3010) รับเป็นเงินสด → ยืนยัน → ต้องเห็นในกลุ่ม "กิจกรรม
    จัดหาเงิน"
11. สร้าง manual JE ทดสอบ: ฝากเงินสด (1010) เข้าบัญชีธนาคาร (1020) → ยืนยัน → เปิดแท็บกระแสเงินสด → ต้อง
    **ไม่เห็น**รายการนี้เลยในทั้ง 3 กิจกรรม (ตัดออกตาม 0.6) แต่ยอดรวมเงินสด+เทียบเท่าไม่เปลี่ยน
12. บิลขายเชื่อ + บันทึกรับชำระบางส่วน (เฟส 2) → เปิดแท็บกระแสเงินสด ของงวดที่รับชำระ → ต้องเห็นยอดที่
    "รับชำระจริง" เท่านั้น (ไม่ใช่ยอดเต็มของบิล) ในกลุ่ม "กิจกรรมดำเนินงาน"
13. สร้าง CN/DN (เฟส 3) กับบิลเชื่อ → ยืนยัน → เปิดแท็บกระแสเงินสด → ต้อง**ไม่ปรากฏ**เลย (0.5)
14. เปิดหน้าพิมพ์ (`/financial-statements/print`) ทั้ง 3 งบ (กำไรขาดทุน/ฐานะ/กระแสเงินสด) → กรอกผู้จัดทำ/
    ผู้สอบทาน → พิมพ์จริง (`window.print()`) → เนื้อหา/เลขตรงกับที่จอเห็น จัดหน้า A4 อ่านง่าย
15. Export Excel ทั้งกรณีเทียบงวดและไม่เทียบ → เปิดไฟล์จริง → ตัวเลขตรงกับจอทุกชีท
16. นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → เปิด `/financial-statements?customerId=...` ของลูกค้าคนอื่น →
    ต้องไม่เห็น/ทำรายการไม่ได้ (ทดสอบผ่าน session นักบัญชีจริง)
17. regression เต็ม: ลูกค้าที่ไม่มี manual JE/bill_payments/CN-DN เลย (บิลปกติล้วน) → ตัวเลขทุกงบใน
    หน้าใหม่ต้องเหมือนกับที่คำนวณจากบิลตรง ๆ (sanity check พื้นฐานที่สุด)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| การคำนวณแบบ "2 รอบ" (flow+cumulative, 0.3) ต้องเรียก `buildStatements()`/`buildLedger()` ซ้ำ → ใช้เวลา/ทรัพยากรมากขึ้นต่อการเปิดหน้า/export | ข้อมูลต่อลูกค้า 1 รายมี limit อยู่แล้วทุก query (`ENTRIES_LIMIT`/`LIST_LIMIT`/`BULK_LIST_LIMIT` ในไฟล์ที่เกี่ยวข้อง) ผลกระทบต่อ perf ต่ำในทางปฏิบัติ (SME รายเดียวไม่ถึงหลักหมื่นรายการ) — ถ้าพบช้าจริงในอนาคตค่อย cache ผลลัพธ์ต่อ (customerId, to) รอบถัดไป |
| `cash-flow-config.ts` เป็น static mapping — พังถ้า tenant เพิ่มบัญชีสินทรัพย์ถาวร/เงินกู้ใหม่นอกชุดที่กำหนดไว้ (0.7) | จัดเป็น "operating" โดย default (ไม่ผิดกฎบัญชีร้ายแรง แค่ไม่แม่นยำที่สุด) แก้ได้จุดเดียวในไฟล์ config — backlog เพิ่ม "หมวดกระแสเงินสด" เป็นคอลัมน์ในผังบัญชีถ้าพบว่าจำเป็นจริงในทางปฏิบัติ |
| M3 (refactor `/reports`/`/journal-books` เดิมที่ใช้งานทุกวัน) เสี่ยง regression สูงกว่างานอื่นในเฟสนี้ | เทียบตัวเลขก่อน-หลังจริงทุกจุด (ขั้นตอน 1 ในหมวด 4) ก่อนถือว่าเสร็จ · ถ้าเสี่ยงเกินความคุ้มค่าในทางปฏิบัติ ใช้แผนสำรองตาม 0.13 คือข้าม M3 ไปเลย ให้หน้าใหม่ใช้ `loadCombinedJournalLines()` เองลำพัง (ยอมให้โค้ดเดิม 4 จุดยังซ้ำต่อไป) — ไม่กระทบ N/O เลยถ้าเลือกแผนสำรองนี้ |
| `reconciled=false` เกิดขึ้นจริง (closingCash จาก CF ไม่ตรงกับงบฐานะ) — บ่งชี้ว่ามีบรรทัดเงินสดตกหล่นจาก allocation logic | แสดงคำเตือนแบบเดียวกับ `bs.balanced=false` ให้นักบัญชีเห็นทันที (ไม่ปิดบัง) + log กรณีนี้ไว้ตรวจสอบ (ไม่ log ตัวเลข/ชื่อลูกค้า ตาม PDPA) เพื่อหาสาเหตุ classify/allocation ที่ตกหล่น |
| งวดเทียบข้ามปี/ข้ามทศวรรษที่ผิดปกติ (เช่น current เดือน ม.ค. → shift ถอยหลังข้ามปี พ.ศ./ค.ศ. ผิด) | unit test เฉพาะ edge case ข้ามปีใน `comparative-period.test.ts` ครบทุกกรณี (ต้นปี/ปลายปี/งวดยาวข้ามปี) |
| manual JE ที่มีหลายขาเงินสดพร้อมกันในรายการเดียว (เคส edge หายาก, 0.8) — allocation แบบสัดส่วนอาจไม่ตรงเจตนาจริงของนักบัญชี 100% ในบางเคสซับซ้อนมาก | ระบุ edge case นี้ชัดในเทสต์ + คอมเมนต์โค้ด ถ้าพบปัญหาจริงในทางปฏิบัติ ให้แนะนำนักบัญชีแยกบันทึกเป็นหลายรายการ (1 รายการ = 1 กิจกรรม) แทนการรวมในรายการเดียว — ไม่ใช่บั๊กแต่เป็นข้อจำกัดของการบันทึกต้นทาง |
| ไม่มี PDF generator ฝั่งเซิร์ฟเวอร์จริง (0.12) — ผู้ใช้บางรายอาจคาดหวังไฟล์ `.pdf` ดาวน์โหลดได้โดยตรง | หน้าพิมพ์ใช้ `window.print() → "บันทึกเป็น PDF"` ของเบราว์เซอร์ได้อยู่แล้ว (ผู้ใช้ทำเองได้ในทางปฏิบัติ) — ถ้าต้องการ endpoint สร้าง `.pdf` จริงจากเซิร์ฟเวอร์ เป็นงานเพิ่มเติมนอกสโคป แจ้งแยกทำรอบถัดไป |
| จำนวน call site ที่ต้องอ้างอิง `buildFormalStatements`/`buildCashFlowStatement` ให้ตรงกัน (จอ+พิมพ์+excel = 3 จุดต่องบ × 3 งบ) เสี่ยง gap แบบเดียวกับที่เจอซ้ำทุกเฟส | รวม logic การโหลด+ประกอบข้อมูลไว้ที่ `formal-statements.ts` จุดเดียว (ไม่กระจาย) — จอ/พิมพ์/excel เรียกฟังก์ชันเดียวกันทั้งหมด + P1 ทำ grep เทียบไฟล์ก่อนปิดงานเหมือนที่ L1 เฟส 3 ทำสำเร็จมาแล้ว |

---

# เฟส 5 — แผนละเอียด: ขยาย FlowAccount sync

**สโคป (ตามภาพรวม):** 2 เรื่อง ทำเป็น 2 ส่วน **Q → P** (Q เป็นโครงพื้นฐาน mapping ที่ P ใช้ต่อ และเสี่ยง/ซับซ้อนน้อยกว่า P):
- **(Q) mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้า** — ตารางใหม่ 2 ตัว + หน้าเว็บให้นักบัญชี/หัวหน้าที่ดูแล
  ลูกค้ากรอกเอง (manual, ไม่ live-fetch จาก FlowAccount) แล้วเสียบเข้าไปใช้ตอนสร้างเอกสารขาย (ของเดิม M1/M2) แบบ
  non-breaking — เติม `sellChartOfAccountCode`/`items[].id` ที่ mapper เดิมส่งเป็นค่าว่างมาตลอด (ดู decision 0.1)
- **(P) บิลซื้อ/ค่าใช้จ่าย (`entry_type='purchase'`) sync ไป FlowAccount** — ต่อยอด sync engine เดิม
  (claim atomic/credential ต่อลูกค้า/log) ที่ M1/M2 วางไว้ทั่วไปอยู่แล้ว เพิ่มเอกสารฝั่งซื้อ (endpoint ยังไม่ยืนยัน
  สเปก 100% ต่างจากฝั่งขาย — ต้องมี task ยืนยันก่อนโค้ดจริงเหมือน T0 ของ M1)

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `lib/integrations/flowaccount.ts` — `getAccessToken(credential)`/`createSalesDocument(payload, credential)`,
  token cache `Map<clientId,...>` (M2) — เอาไปต่อยอด `createPurchaseDocument()` ได้ตรง ๆ ไม่ต้องแก้ของเดิม
- `lib/integrations/flowaccount-mapper.ts::buildSalesDocumentPayload` — ปัจจุบันส่ง `sellChartOfAccountCode: ""`,
  `buyChartOfAccountCode: ""`, `items[].id: 0` เสมอ (ยืนยันจาก schema `ProductItem` ว่า field พวกนี้มีจริงแต่ M1
  ตัดสินใจไม่ผูก — decision 0.2 ของ M1 ใน `docs/05`) — เฟสนี้เติมค่าจริงผ่าน mapping table
- `lib/accounting/flowaccount-sync.ts::syncSaleEntryToFlowAccount` — โหลด entry → guard ธุรกิจ → claim atomic →
  โหลด+ถอดรหัส credential ต่อลูกค้า (`customers.flowaccount_client_id/client_secret_enc`, M2) → map → เรียก client →
  เขียนผล+log — **ทุก guard/claim/credential logic reuse ได้ 100% ไม่ต้องออกแบบใหม่**
- `supabase/migrations/0061_flowaccount_sync.sql` — `bill_entries.flowaccount_doc_type` และ
  `flowaccount_sync_log.doc_type` มี `check in ('tax_invoice','cash_sale')` เท่านั้น → ต้อง ALTER เพิ่มค่าใหม่
- `supabase/migrations/0063_chart_of_accounts_table.sql`/`0064_products_table.sql` (เฟส 1) — `chart_of_accounts`/
  `products` เป็น **tenant-scoped** (ใช้ร่วมทุกลูกค้าในเชิงนิยาม) แต่ FlowAccount ของแต่ละลูกค้าเป็นบัญชีแยกกันจริง
  (credential ต่อลูกค้า M2) → รหัสฝั่ง FlowAccount ของแต่ละลูกค้าไม่จำเป็นตรงกัน → mapping table **ต้อง scope ต่อ
  (tenant, customer)** ไม่ใช่ tenant-wide เดียว (0.9)
- `lib/line/bill-extract-worker.ts::billHeadFields/decideEntrySide` — ยืนยันความหมายจริง: `counterparty_name`/
  `counterparty_tax_id` = **ผู้ซื้อ** (ถ้า `entry_type='sale'`) หรือ **ผู้ขาย/vendor** (ถ้า `entry_type='purchase'`)
  — คนละความหมายกับ `customers.name/tax_id` (ตัวลูกค้า NOVA-CX เอง/เจ้าของ FlowAccount instance ที่ใช้ credential)
  → พบว่า mapper บิลขายเดิมใช้ผิดตัว (0.6) — สำคัญมากสำหรับออกแบบ mapper บิลซื้อใหม่ให้ถูกตั้งแต่ต้น
- `app/chat-audit/accounting/FlowAccountSyncButton.tsx`/`page.tsx` — เงื่อนไขโชว์ปุ่ม/คอลัมน์ hardcode
  `entryType !== "sale"` ไว้ 2 จุด ต้องเปิดให้ `"purchase"` ด้วย
- `ls supabase/migrations/` ล่าสุด (ยืนยันแล้ว) = `0070_sales_documents.sql` → migration ใหม่ของเฟสนี้เริ่มที่ `0071`

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ตีความ "sync สินค้า/ผังบัญชีไป FlowAccount" = แนบรหัสอ้างอิงในเอกสาร ไม่ใช่สร้างบัญชี/สินค้าใหม่ฝั่ง FlowAccount
FlowAccount ไม่มี endpoint สร้างผังบัญชี/สินค้าที่ยืนยันแล้วว่าปลอดภัย/มีจริงในสโคปที่ตรวจสอบได้ (ต่างจาก
`/tax-invoices`/`/cash-invoices` ที่ M1 ยืนยันสเปกจริงแล้ว) — เฟสนี้ตีความ "sync" ตามสิ่งที่ schema `ProductItem`
รองรับอยู่แล้วจริง (`sellChartOfAccountCode`/`buyChartOfAccountCode`/`items[].id`) คือ **การอ้างอิงรหัสบัญชี/รหัส
สินค้าที่มีอยู่แล้วในฝั่ง FlowAccount ของลูกค้ารายนั้น** ผ่าน mapping table ที่ nova-cx เก็บเอง ไม่ใช่การ "สร้าง"
บัญชี/สินค้าใหม่ในระบบ FlowAccount ตรง ๆ **[⚠️ FLAG]** ถ้าต้องการ push สร้างจริง (เช่น auto-สร้างสินค้าใหม่ทุกครั้งที่
เพิ่มใน nova-cx) เป็นงานเพิ่มเติมนอกสโคปนี้ ต้องยืนยัน endpoint POST เฉพาะก่อน

### 0.2 ลำดับทำ: **Q (mapping infra) → P (บิลซื้อ)**
Q ไม่แตะ engine/schema ของ `bill_entries`/sync เดิมเลย (แค่ตารางใหม่ 2 ตัว + เสียบเข้า mapper บิลขายแบบ optional)
ความเสี่ยงต่ำ ทดสอบจบในตัวได้ (milestone เห็นผลเร็ว) — P ต้องแก้ constraint ของ `bill_entries`/`flowaccount_sync_log`,
refactor sync engine ให้รองรับ 2 entry_type, และพึ่ง endpoint ที่ยังไม่ยืนยันสเปก จึงเสี่ยง/ซับซ้อนกว่า ทำทีหลัง
และใช้ mapping ที่ Q สร้างไว้ได้เลย (บิลซื้อได้ `buyChartOfAccountCode`/product id ตั้งแต่วันแรกที่ปล่อยใช้งาน)

### 0.3 ⚠️ สเปก endpoint บิลซื้อ/ค่าใช้จ่ายยังไม่ยืนยัน 100% จาก OpenAPI จริง (ต่างจาก M1 ฝั่งขาย)
ในเอกสาร/โค้ดปัจจุบันมีแค่ endpoint ฝั่งขาย (`/tax-invoices`, `/cash-invoices`) ที่ยืนยันจาก schema จริงแล้ว
(คอมเมนต์หัวไฟล์ `flowaccount.ts` "ยืนยันแล้ว 100% ... 2026-08-05") — **ไม่มีสเปกฝั่งซื้อ/ค่าใช้จ่ายที่ยืนยันแล้ว
ในโค้ด/เอกสารของทีมเลยสักที่** (คำว่า `expensesApi`/`purchaseOrderApi` ที่เคยเขียนไว้ในหมวด backlog ของ `docs/05`
เป็นแค่ชื่อ class จาก community SDK ที่ใช้เป็น "เอกสารอ้างอิง" เท่านั้น ตาม decision 0.1 ของ M1 — ไม่ใช่การยืนยันสเปก)
- **T-P0 (งานเตรียม ก่อนเขียนโค้ด client จริง)**: ยืนยัน endpoint จริงจาก FlowAccount OpenAPI ทางการ
  (developers.flowaccount.com) สำหรับ "สร้างเอกสารซื้อ/บันทึกค่าใช้จ่าย" — เอกสารนี้ตั้งสมมติฐานไว้ก่อนว่า
  `POST {apiBaseUrl}/purchases` (บิลซื้อเชื่อ ยังไม่จ่าย) และ `POST {apiBaseUrl}/expenses` (จ่ายเงินสดแล้ว) โดย
  body ทรงคล้าย `SimpleDocument` เดิม (สมมาตรกับ tax-invoices/cash-invoices) — **ถ้ายืนยันไม่ทัน/สเปกต่างจากนี้**
  ให้ทำ T31 (สร้าง client) แบบ TODO ชัดเจนตาม pattern `nova-sales-query.ts` (ยึด M1 T0 contingency) ไม่ block
  งานอื่น (T23–T30 ของ Q ไม่พึ่ง endpoint นี้เลย ทำ/ทดสอบ/ปล่อยใช้ก่อนได้)
- ทุกจุดที่ยิง fetch จริงรวมไว้ที่ฟังก์ชันเดียว (`createPurchaseDocument()` + `purchaseEndpointFor()`) แก้ที่เดียว
  ถ้าสเปกจริงต่างจากที่เดาไว้ (เหมือน M1 risk table เดิม)

### 0.4 ชนิดเอกสารบิลซื้อ — mirror `resolveDocType` เดิม
```ts
export type FlowAccountPurchaseDocType = "purchase_bill" | "cash_expense";
export function resolvePurchaseDocType(paymentMethod: PaymentMethod | null): FlowAccountPurchaseDocType {
  if (paymentMethod === "cash" || paymentMethod === "transfer" || paymentMethod === "cheque") {
    return "cash_expense"; // จ่ายเงินแล้ว
  }
  return "purchase_bill"; // credit หรือ null (ยังไม่ระบุ) — ค้างจ่าย (AP)
}
```
`documentStructureType: "SimpleDocument"` เหมือนเดิม, `creditType`/`creditDays` ใช้ convention เดียวกับฝั่งขาย
(1=เครดิต, 3=เงินสด) — **ไม่ส่งข้อมูล WHT** ในรอบแรกเช่นกัน (0.14)

### 0.5 ขอบเขต sync บิลซื้อ — เหมือน M1/M2 ฝั่งขายทุกประการ
`entry_type='purchase'` + `status='confirmed'` + มี `customer_id` ผูกแล้วเท่านั้น กดทีละใบ ไม่มี background job/
auto-retry เงียบ — **ไม่ขยายไป `entry_type='unspecified'`** (นักบัญชีต้องเลือกซื้อ/ขายให้ชัดก่อนเสมอ เหมือนเดิม)

### 0.6 ⚠️ พบข้อสังเกตจากของเดิม: mapper บิลขาย (M1) ใช้ `customer.name/taxId` (ตัวลูกค้า NOVA-CX เอง) เป็น
`contactName/contactTaxId` ของเอกสาร — **ไม่ใช่ผู้ซื้อจริง** (`entry.counterpartyName/counterpartyTaxId`)
`syncSaleEntryToFlowAccount` โหลด `customers` (แถวที่ `entry.customer_id` ชี้ — คือ "บริษัทลูกค้าของสำนักงานบัญชี"
เจ้าของ credential/FlowAccount instance นั้น) แล้วส่งเป็น contact ของใบกำกับภาษี/ใบเสร็จที่สร้างขึ้น — ถูกต้องแล้ว
เฉพาะกรณีที่ FlowAccount instance เป็นของสำนักงานบัญชีเองและ "ลูกค้า" คือคู่ค้าจริง แต่จาก M2 (credential ต่อลูกค้า
= ต่อบริษัท) แสดงว่า FlowAccount instance เป็นของบริษัทลูกค้าเอง → contact ที่ถูกต้องของใบกำกับภาษีควรเป็น
**ผู้ซื้อจริง** (`entry.buyerName/buyerTaxId` = `counterpartyName/counterpartyTaxId` เมื่อ `entryType='sale'`
ตาม `bill-extract-worker.ts::billHeadFields`) ไม่ใช่ตัวบริษัทลูกค้าเอง — **นี่คือช่องว่างที่มีอยู่ก่อนเฟสนี้ (M1/M2)**
**ตัดสินใจ: ไม่แก้ mapper บิลขายเดิมในเฟสนี้** (นอกสโคปที่ขอ, ความเสี่ยง regression กับ flow ที่ deploy ใช้งานจริง
แล้ว — ต้องตรวจกับผู้ใช้ก่อนว่าพฤติกรรมปัจจุบันเป็นความตั้งใจหรือบั๊กจริง) **[⚠️ FLAG — เสนอเป็นงานถัดไปแยกต่างหาก
ถ้ายืนยันว่าเป็นบั๊ก]** — แต่ **มัปเปอร์บิลซื้อใหม่ (T32) ต้องทำให้ถูกตั้งแต่ต้น**: ใช้ `entry.counterpartyName/
counterpartyTaxId` (ผู้ขาย/vendor) เป็น contact เสมอ ส่วน `customers` (จาก `customer_id`) ใช้แค่ระบุว่าจะยิง
เอกสารเข้า FlowAccount instance/credential ของใครเท่านั้น (ไม่ใช่ contact)

### 0.7 credential — reuse ของเดิม M2 100% ไม่มีคอลัมน์/ตารางใหม่
`customers.flowaccount_client_id`/`flowaccount_client_secret_enc` (migration 0062) ใช้ร่วมกันทั้งบิลขายและ
บิลซื้อของลูกค้ารายเดียวกัน (FlowAccount instance เดียวกันรับได้ทั้งสองทิศทางเอกสารอยู่แล้วโดยธรรมชาติของบัญชี) —
ไม่ต้องมี credential แยกต่อประเภทเอกสาร

### 0.8 sync engine — รวม sale+purchase เป็นฟังก์ชันเดียว (เปลี่ยนชื่อ export)
`claimEntryForSync()` เดิมไม่เช็ค `entry_type` อยู่แล้ว (generic) — reuse ได้ตรง ๆ ไม่ต้องแก้ ส่วน
`syncSaleEntryToFlowAccount()` (ชื่อ+ตรรกะผูกกับ "sale" ตรง ๆ) **เปลี่ยนชื่อเป็น `syncEntryToFlowAccount()`**
แล้ว dispatch ภายในตาม `entry.entry_type` (`sale` → path เดิม + mapping ผังบัญชี/สินค้าจาก Q, `purchase` →
path ใหม่) — call site ที่ต้องแก้มีจุดเดียว (`flowaccount-actions.ts`) + เทสต์ ยอมรับ breaking rename ภายใน
เพราะ blast radius เล็กมาก (ไม่ export ให้ระบบอื่นนอก `lib/accounting`/`app/chat-audit/accounting` ใช้)

### 0.9 mapping table scope ต่อ **(tenant_id, customer_id)** ไม่ใช่ tenant-wide
เหตุผลตาม 0.8 ของบริบทด้านบน — ผังบัญชี/สินค้า nova-cx (`chart_of_accounts`/`products`) เป็น tenant-wide แต่
FlowAccount ของลูกค้าแต่ละรายเป็นบัญชีแยกกันจริง (M2) รหัสฝั่งเขาไม่จำเป็นตรงกัน mapping จึงต้องผูกกับ
`customer_id` เสมอ (1 nova-cx account_code อาจ map ไป FlowAccount code คนละตัวในแต่ละลูกค้า)

### 0.10 mapping table — ไม่ soft-delete (ต่างจาก `chart_of_accounts`/`products`)
เป็น config lookup ธรรมดา (เทียบเท่า `customers.flowaccount_client_id` ที่ overwrite/null ตรง ๆ ไม่ soft-delete)
ไม่ใช่ระเบียนธุรกิจที่ต้องมี audit trail — ลบแถวจริงได้เลยเมื่อผู้ใช้กด "ลบ mapping"

### 0.11 สิทธิ์แก้ mapping — เหมือน credential (0.6 ของ M2) ไม่ใช่ admin-only
`assertCustomerInScope` — นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้นแก้ mapping ของลูกค้านั้นได้เอง (คนละแบบกับหน้า
`/chat-audit/admin/chart-of-accounts`/`/admin/products` ที่เป็น admin-only เพราะเป็นทรัพยากร tenant-level —
mapping ผูก 1 ลูกค้าเฉพาะจึงใช้สโคปแบบ per-customer เหมือนหน้าบัญชี/ยอดยกมา/credential)

### 0.12 กรอก mapping แบบ **manual text-entry** (ไม่ live-fetch list จาก FlowAccount)
รหัสบัญชี/สินค้าฝั่ง FlowAccount ที่แท้จริงต้องอ่านจาก GET endpoint ของ FlowAccount ซึ่ง**ยังไม่ยืนยันสเปก**
เช่นกัน (เหมือน 0.3) — เพิ่ม endpoint ที่ไม่ยืนยันอีก 2 ตัว (`GET /chart-of-accounts`, `GET /products`) จะเพิ่ม
ความเสี่ยงเกินจำเป็นสำหรับ mapping table ที่เป็นแค่ config เขียนไม่บ่อย เฟสนี้ให้นักบัญชีเปิดหน้าจอ FlowAccount
ของลูกค้าเอง คัดลอกรหัสมาพิมพ์ในฟอร์ม nova-cx (validate แค่ความยาว/ไม่ว่าง) **[⚠️ FLAG]** ถ้าอนาคตยืนยันสเปก GET
ได้ ค่อยอัปเกรดเป็น dropdown จริง (backlog แยก ไม่ block เฟสนี้)

### 0.13 ใช้ mapping กับเอกสารขายเดิมด้วย (ไม่ใช่แค่บิลซื้อใหม่) **[⚠️ FLAG — ขยายสโคปเล็กน้อยจากคำขอเดิม]**
คำขอเดิมพูดถึง "sync สินค้า/ผังบัญชี" แยกจาก "บิลซื้อ" — แต่การเติม `sellChartOfAccountCode`/`items[].id` ให้
เอกสารขายที่มีอยู่แล้ว (M1/M2) ใช้ mapping table เดียวกันนี้ได้เลยโดย **ไม่กระทบพฤติกรรมเดิมถ้าไม่ตั้ง mapping**
(ค่า default ยังว่างเหมือนเดิม 100%) คุ้มค่าที่จะทำพร้อมกัน (ไม่ต้องออกแบบ 2 รอบ) — ทำต่อได้เลยตามกติกา FLAG
ของไฟล์นี้ (แจ้งผู้ใช้รับทราบ ไม่ต้องรอ approve)

### 0.14 ไม่ส่งข้อมูล WHT ในเอกสารซื้อรอบแรก — mirror decision 0.2 ของ M1 (ฝั่งขาย)
เหตุผลเดียวกัน: ลดความซับซ้อน/ความเสี่ยง mapping ผิดในรอบแรก — `bill_entry_lines.wht_amount` ที่มีอยู่แล้วยังใช้
ออกใบหัก ณ ที่จ่าย (เฟส 3, `wht-cert/`) ได้ตามปกติ ไม่กระทบกัน

### 0.15 vendor (ผู้ขาย/บิลซื้อ) ไม่มีคอลัมน์ "ที่อยู่" ในสคีมาปัจจุบัน → ส่ง `contactAddress: ""`
`bill_entries` มี `counterparty_name`/`counterparty_tax_id` แต่ไม่มี `counterparty_address` (ต่างจาก `customers`
ที่มี `address` จากเฟส 0058) — ยอมรับข้อจำกัดนี้ในรอบแรก (เหมือนที่ `customer.address` ของฝั่งขายก็เป็น optional
อยู่แล้ว) **[⚠️ FLAG]** ถ้าต้องมีที่อยู่ผู้ขายจริง ต้องเพิ่มคอลัมน์ใหม่ — เกินสโคปนี้

### 0.16 ยืนยันเลข migration จริงจาก `ls supabase/migrations/` (ไฟล์ล่าสุด = `0070_sales_documents.sql`)
เฟสนี้ใช้ `0071`, `0072` — ให้เช็คซ้ำอีกครั้งก่อน apply จริงเผื่อมีเฟสอื่นแทรกระหว่างทาง

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 5

```
supabase/migrations/
  0071_flowaccount_account_product_map.sql   [ใหม่] 2 ตารางใหม่: flowaccount_account_map, flowaccount_product_map
  0072_flowaccount_purchase_doc_types.sql    [ใหม่] ALTER CHECK constraint ของ bill_entries.flowaccount_doc_type
                                                       และ flowaccount_sync_log.doc_type เพิ่ม 'purchase_bill'/'cash_expense'

lib/
  integrations/
    flowaccount.ts              [แก้] เพิ่ม FlowAccountPurchaseDocType, createPurchaseDocument(payload, credential)
                                       + purchaseEndpointFor() (★ endpoint ยังไม่ยืนยันสเปก — ดู 0.3/T-P0)
                                       reuse getAccessToken/token cache/timeout/error-mapping เดิมทั้งหมด
    flowaccount-mapper.ts       [แก้] (ก) buildSalesDocumentPayload รับพารามิเตอร์ใหม่ optional
                                       `maps?: { accountMap?: Record<string,string>; productMap?: Record<string,string> }`
                                       (ข) เพิ่ม resolvePurchaseDocType(), buildPurchaseDocumentPayload()
                                       (ค) สกัด buildLineItems() ใช้ร่วมกัน (sell/buy chart code ต่างกันแค่ field name)
  accounting/
    flowaccount-map.ts          [ใหม่] data layer: list/upsert/delete account map + product map ต่อ (tenant,customer)
                                       + helper accountMapToRecord()/productMapToRecord() (pure)
    flowaccount-sync.ts         [แก้] เปลี่ยนชื่อ syncSaleEntryToFlowAccount → syncEntryToFlowAccount()
                                       dispatch ตาม entry_type (sale/purchase) ภายในฟังก์ชันเดียว, โหลด mapping
                                       ของลูกค้าแล้วส่งต่อให้ mapper ทั้ง 2 เส้นทาง, เพิ่ม reason ใหม่
                                       missing_vendor_tax_id/unsupported_entry_type

app/chat-audit/accounting/
  flowaccount-actions.ts          [แก้] เรียก syncEntryToFlowAccount แทนชื่อเดิม + REASON_MESSAGE ใหม่
                                         (missing_vendor_tax_id, unsupported_entry_type)
  flowaccount-map-actions.ts      [ใหม่] server actions guard requireAccountingAccess+assertCustomerInScope
                                         (list/upsert/delete account map + product map ของลูกค้า)
  flowaccount-map/page.tsx        [ใหม่] เลือกลูกค้า (mirror app/chat-audit/accounting/opening/page.tsx) →
                                         โหลดผัง/สินค้า/mapping ปัจจุบันของลูกค้านั้น
  FlowAccountMapPanel.tsx         [ใหม่] client component 2 ตาราง (ผังบัญชี/สินค้า) ให้กรอกรหัส FlowAccount ต่อแถว
  FlowAccountSyncButton.tsx       [แก้] เงื่อนไขโชว์ปุ่ม entryType==='sale' → entryType==='sale'||'purchase'
  page.tsx                        [แก้] showFlowAccountCol รวม 'purchase' ด้วย + ลิงก์ไปหน้า flowaccount-map ใหม่
                                         (จุดเดียวกับที่มีลิงก์ไปหน้า opening/reports เดิม)

tests/
  integrations/flowaccount.test.ts            [แก้] เพิ่มเทสต์ createPurchaseDocument ครบทุก branch (เหมือน createSalesDocument)
  accounting/flowaccount-mapper.test.ts       [แก้] เพิ่ม resolvePurchaseDocType + buildPurchaseDocumentPayload
                                                      (mapping ปกติ/reject vendor tax id/no value/no date)
                                                      + เคส buildSalesDocumentPayload กับ maps ว่าง/มีค่า (backward-compat)
  accounting/flowaccount-sync.test.ts         [แก้ทั้งไฟล์] อัปเดตชื่อฟังก์ชัน (breaking rename) + เพิ่มเคส purchase
                                                      ครบ (guard/claim/credential/success/failure) + เคส mapping
  accounting/flowaccount-actions.test.ts      [แก้] เพิ่มเคสส่งบิลซื้อ (allow/reject) + reason ใหม่
  accounting/flowaccount-map.test.ts          [ใหม่] CRUD + validate ของ data layer ใหม่ (มี/ไม่มีสิทธิ์แยกที่ actions)
  accounting/flowaccount-map-actions.test.ts  [ใหม่] guard สิทธิ์/สโคปของ actions ใหม่ (in-scope/out-of-scope)
```

### 1.1 Schema ใหม่ (migration 0071) — ร่าง SQL

```sql
-- mapping ผังบัญชี nova-cx → FlowAccount ต่อลูกค้า (scope: tenant + customer, ดู decision 0.9)
create table if not exists public.flowaccount_account_map (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  customer_id               uuid not null references public.customers(id) on delete cascade,
  account_code              text not null,   -- ตรงตัวกับ chart_of_accounts.code (ไม่ใช่ FK จริง — เหมือน bill_entry_lines.account_code)
  flowaccount_account_code  text not null,   -- รหัสบัญชีฝั่ง FlowAccount ของลูกค้ารายนี้ (กรอกเอง — ดู decision 0.12)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create unique index if not exists uq_flowaccount_account_map
  on public.flowaccount_account_map (tenant_id, customer_id, account_code);
drop trigger if exists trg_flowaccount_account_map_updated on public.flowaccount_account_map;
create trigger trg_flowaccount_account_map_updated before update on public.flowaccount_account_map
  for each row execute function public.set_updated_at();

-- mapping สินค้า/บริการ nova-cx → FlowAccount ต่อลูกค้า
create table if not exists public.flowaccount_product_map (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  customer_id            uuid not null references public.customers(id) on delete cascade,
  product_id             uuid not null references public.products(id) on delete cascade,
  flowaccount_product_id text not null,  -- id ฝั่ง FlowAccount (เก็บเป็น text — parse เป็น number ตอนสร้าง payload)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_flowaccount_product_map
  on public.flowaccount_product_map (tenant_id, customer_id, product_id);
drop trigger if exists trg_flowaccount_product_map_updated on public.flowaccount_product_map;
create trigger trg_flowaccount_product_map_updated before update on public.flowaccount_product_map
  for each row execute function public.set_updated_at();

-- RLS: tenant isolation (pattern 0051 customer_bank_accounts)
alter table public.flowaccount_account_map enable row level security;
create policy tenant_read on public.flowaccount_account_map for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.flowaccount_account_map from anon;
grant select on public.flowaccount_account_map to authenticated;
grant all    on public.flowaccount_account_map to service_role;

alter table public.flowaccount_product_map enable row level security;
create policy tenant_read on public.flowaccount_product_map for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.flowaccount_product_map from anon;
grant select on public.flowaccount_product_map to authenticated;
grant all    on public.flowaccount_product_map to service_role;

notify pgrst, 'reload schema';
```

### 1.2 Schema แก้ (migration 0072) — ร่าง SQL

```sql
-- ★ ชื่อ constraint ตาม default naming ของ Postgres (<table>_<column>_check จาก inline check ใน 0061)
--   ก่อน apply จริง: `\d bill_entries` / `\d flowaccount_sync_log` ยืนยันชื่อจริงก่อน (เผื่อ pg version ต่างกัน)
alter table public.bill_entries
  drop constraint if exists bill_entries_flowaccount_doc_type_check;
alter table public.bill_entries
  add constraint bill_entries_flowaccount_doc_type_check
  check (flowaccount_doc_type in ('tax_invoice','cash_sale','purchase_bill','cash_expense')
         or flowaccount_doc_type is null);

alter table public.flowaccount_sync_log
  drop constraint if exists flowaccount_sync_log_doc_type_check;
alter table public.flowaccount_sync_log
  add constraint flowaccount_sync_log_doc_type_check
  check (doc_type in ('tax_invoice','cash_sale','purchase_bill','cash_expense') or doc_type is null);

notify pgrst, 'reload schema';
```

---

## 2) งานย่อยเรียงลำดับ (เฟส 5)

เลขงาน: ต่อจาก M2 (T12–T22) → เริ่มที่ **T23**

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T23** | Migration 0071 — สร้าง `flowaccount_account_map` + `flowaccount_product_map` (RLS pattern 0051) | `supabase/migrations/0071_flowaccount_account_product_map.sql` | - | apply บน sandbox DB ไม่ error; `notify pgrst,'reload schema'`; unique index กันซ้ำ (tenant,customer,code/product_id) ทำงานจริง (insert ซ้ำ → 23505); เทสต์เดิมทั้งหมดผ่าน (ไม่กระทบตารางเดิม) |
| **T24** | `lib/accounting/flowaccount-map.ts` — `listAccountMap/upsertAccountMap/deleteAccountMap`, `listProductMap/upsertProductMap/deleteProductMap`, `accountMapToRecord()/productMapToRecord()` (pure) | `flowaccount-map.ts` | T23 | unit test: CRUD ปกติ, upsert ทับแถวเดิม (ไม่ insert ซ้ำ), validate ค่าว่าง/ยาวเกินถูกปฏิเสธ, `accountMapToRecord([])` คืน `{}`; คอลัมน์/ตารางยังไม่ apply migration → คืน `[]`/`{ok:false}` แบบ degrade (ไม่ throw) |
| **T25** | `app/chat-audit/accounting/flowaccount-map-actions.ts` — server actions guard `requireAccountingAccess`+`assertCustomerInScope` ครบทุก action (list/upsert/delete ทั้ง 2 ชนิด) | `flowaccount-map-actions.ts` | T24 | unit test: นักบัญชีนอกสโคปแก้ mapping ลูกค้าอื่นไม่ได้; admin/lead ทำได้ทุกลูกค้า; error สุภาพ ไม่หลุด internal; revalidatePath ถูกเรียกหลังเขียนสำเร็จ |
| **T26** | `app/chat-audit/accounting/flowaccount-map/page.tsx` (mirror `opening/page.tsx` — เลือกลูกค้าในสโคป) + `FlowAccountMapPanel.tsx` (2 ตาราง: ผังบัญชี/สินค้า ของลูกค้าที่เลือก พร้อมช่องกรอกรหัส FlowAccount) | 2 ไฟล์ข้างต้น | T25, มี `listChartOfAccounts`/`listProducts` เดิม | เปิดหน้า เลือกลูกค้า → เห็นรายการผังบัญชี/สินค้าที่ active ทั้งหมด + ช่องกรอก/ลบ mapping ต่อแถว; บันทึกแล้วรีเฟรชเห็นค่าที่ตั้งไว้; ลูกค้านอกสโคปไม่มีในตัวเลือก dropdown; typecheck/lint ผ่าน |
| **T27** | `lib/integrations/flowaccount-mapper.ts` — เพิ่มพารามิเตอร์ `maps?` ให้ `buildSalesDocumentPayload` (เติม `sellChartOfAccountCode`/`items[].id` ถ้าพบ mapping ของ `line.accountCode`/`line.productId`) — **ไม่มี mapping = พฤติกรรมเดิมเป๊ะ** | `flowaccount-mapper.ts` | - | unit test: ไม่ส่ง `maps`/`maps={}` → ผลลัพธ์เหมือน M1/M2 เป๊ะ (regression test); ส่ง mapping ที่ตรง `accountCode`/`productId` → `sellChartOfAccountCode`/`items[].id` ถูกเติมถูกต้อง; mapping ไม่ตรงรหัสไหนเลย → ยังว่างเหมือนเดิม (ไม่ throw) |
| **T28** | `lib/accounting/flowaccount-sync.ts` — เส้นทาง sale เดิม: select เพิ่ม `account_code, product_id` ใน `bill_entry_lines`, โหลด `listAccountMap/listProductMap` ของลูกค้า → แปลงเป็น Record → ส่งเข้า `buildSalesDocumentPayload(..., maps)` | `flowaccount-sync.ts` | T24, T27 | unit test: ลูกค้าไม่มี mapping ตั้งไว้เลย → sync สำเร็จเหมือนเดิมทุกประการ (ไม่ regression); ลูกค้ามี mapping ครบ → payload ที่ส่งให้ `createSalesDocument` มี `sellChartOfAccountCode`/`items[].id` ตรงตามที่ตั้งไว้จริง; เทสต์เดิมทั้งหมดของไฟล์นี้ (M1/M2) ยังผ่าน |
| **T29** | Migration 0072 — ALTER check constraint `bill_entries.flowaccount_doc_type` + `flowaccount_sync_log.doc_type` เพิ่ม `purchase_bill`/`cash_expense` | `supabase/migrations/0072_flowaccount_purchase_doc_types.sql` | T23 (เลขไฟล์ต่อกัน) | apply ไม่ error; insert แถวทดสอบด้วยค่าใหม่ทั้ง 2 ค่าใน `bill_entries`/`flowaccount_sync_log` ผ่าน; ค่าเดิม (`tax_invoice`/`cash_sale`) ยังใช้ได้ปกติ; ยืนยันชื่อ constraint จริงก่อน apply (เผื่อ 0.16 คลาดเคลื่อน) |
| **T30** | **[เตรียมงาน — ไม่มีโค้ด]** ยืนยันสเปก endpoint จริงของ FlowAccount OpenAPI สำหรับสร้างเอกสารซื้อ/บันทึกค่าใช้จ่าย (ดู decision 0.3) — บันทึกผลเป็นคอมเมนต์อ้างอิงในโค้ด T31 | - | - | มีสรุป endpoint/payload จริงที่ "ยืนยันแล้ว" ก่อนเริ่ม T31; ถ้ายืนยันไม่ทัน ให้ทำ T31 แบบ TODO ชัดเจน (ตาม M1 T0 contingency) แล้วแจ้ง blocker — ไม่ block T23–T29 (ทำคู่ขนานได้) |
| **T31** | `lib/integrations/flowaccount.ts` — เพิ่ม `FlowAccountPurchaseDocType`, `purchaseEndpointFor()`, `createPurchaseDocument(payload, credential)` (reuse `getAccessToken`/token cache/timeout/error mapping เดิม 100%) | `flowaccount.ts` | T30 | unit test ครอบทุก branch เหมือน `createSalesDocument` (not_configured/auth_failed/validation_error/timeout/network/server_error/success); ใช้ token cache เดียวกับฝั่งขาย (ยิงบิลขาย+ซื้อของลูกค้าเดียวกันติดกัน → cache ใช้ร่วมได้ ไม่ขอ token ซ้ำ — มีเทสต์ยืนยัน) |
| **T32** | `lib/integrations/flowaccount-mapper.ts` — `resolvePurchaseDocType()` + `buildPurchaseDocumentPayload(entry, lines, vendor, maps?)` — ★ `vendor` มาจาก `entry.counterpartyName/counterpartyTaxId` (ผู้ขาย) **ไม่ใช่** `customers` (ดู decision 0.6) | `flowaccount-mapper.ts` | T27 (reuse `buildLineItems`), T29 (รู้ enum ใหม่) | unit test: mapping ปกติ (เชื่อ/จ่ายแล้ว) → `purchase_bill`/`cash_expense` ถูกต้อง, `contactTaxId`=vendor taxId (ไม่ใช่ customer); reject: ไม่มีเลขภาษี vendor (`missing_vendor_tax_id`)/ไม่มี line มูลค่า/ไม่มีวันที่; ฟังก์ชัน pure 100% (ไม่แตะ DB/network); ใช้ `buyChartOfAccountCode` (ไม่ใช่ `sellChartOfAccountCode`) เมื่อมี mapping |
| **T33** | `lib/accounting/flowaccount-sync.ts` — เปลี่ยนชื่อ `syncSaleEntryToFlowAccount`→`syncEntryToFlowAccount()`, dispatch ตาม `entry.entry_type` (`sale`|`purchase` เท่านั้น — อื่น ๆ → reason ใหม่ `unsupported_entry_type`), เส้นทาง purchase ใช้ `entry.counterpartyName/counterpartyTaxId` เป็น vendor + credential/mapping จาก `customer_id` เหมือนเดิม | `flowaccount-sync.ts` | T24, T28, T31, T32 | unit test ครบ: purchase confirmed+มีลูกค้า+vendor มีเลขภาษี → success path เขียน `synced`+`doc_type=purchase_bill/cash_expense`+log; purchase ไม่มีเลขภาษี vendor → `missing_vendor_tax_id`+`failed`+log; `entry_type='unspecified'` → `unsupported_entry_type` ก่อน claim; claim ซ้ำ (race) ยังทำงานเหมือนเดิมทั้ง sale/purchase; เทสต์เดิมของ M1/M2 (sale) ทั้งหมดผ่านหลัง rename |
| **T34** | `app/chat-audit/accounting/flowaccount-actions.ts` — เรียก `syncEntryToFlowAccount` แทนชื่อเดิม + เพิ่ม `REASON_MESSAGE` (`missing_vendor_tax_id`, `unsupported_entry_type`) | `flowaccount-actions.ts` | T33 | unit test: ส่งบิลซื้อ confirmed สำเร็จ/ล้มทุกเหตุผลใหม่ ได้ข้อความไทยสุภาพถูกต้อง; guard สโคป/สิทธิ์เดิม (ทั้ง sale/purchase) ยังทำงานถูก; grep `syncSaleEntryToFlowAccount` ในโค้ด production ต้องว่างเปล่า |
| **T35** | `FlowAccountSyncButton.tsx` + `page.tsx` — เปิดเงื่อนไข `entryType==='sale'||'purchase'` ทั้ง 2 จุด (ปุ่ม + `showFlowAccountCol`) + เพิ่มลิงก์ไปหน้า `/chat-audit/accounting/flowaccount-map` | 2 ไฟล์ข้างต้น | T34 | เปิด `/chat-audit/accounting` แท็บ "ภาษีซื้อ" ของบิล confirmed → เห็นปุ่ม/คอลัมน์ FlowAccount เหมือนแท็บขาย; บิลซื้อ draft/รอระบุ → ไม่เห็นปุ่ม; typecheck/lint ผ่าน; ไม่มี `console.*` ที่มี PII |
| **T36** | อัปเดต/เพิ่มเทสต์ทั้งหมดที่เหลือให้ครบ — `flowaccount.test.ts`, `flowaccount-mapper.test.ts`, `flowaccount-sync.test.ts`, `flowaccount-actions.test.ts`, `flowaccount-map.test.ts` (ใหม่), `flowaccount-map-actions.test.ts` (ใหม่) | 6 ไฟล์เทสต์ข้างต้น | T23–T35 | ทุกไฟล์ผ่าน `npm run test`; ไม่มีเทสต์เดิมพัง/ถูกลบทิ้งโดยไม่มีเหตุผล; coverage ครอบทุก reason/branch ที่ระบุในตาราง DoD ข้อ 3 |
| **T37** | รันชุดตรวจสอบเต็ม + ทดสอบมือกับ FlowAccount sandbox จริง (ทั้งบิลซื้อ + mapping ผังบัญชี/สินค้า) | ทั้งหมดข้างบน | T23–T36 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม + ใหม่ทั้งหมด); ทดลองกดส่งบิลซื้อ confirmed จริง 1 ใบ (มี mapping ตั้งไว้) เข้า sandbox แล้วเช็คเอกสารโผล่ถูกบัญชี/ถูก contact (ผู้ขาย ไม่ใช่ตัวลูกค้า) จริง; ทดลองบิลขายเดิม (มี mapping) ยังส่งได้ปกติไม่ regression |

**Milestone**:
- **เฟส 5-Q (mapping infra, headless-testable)**: T23–T28 — mapping ผังบัญชี/สินค้าใช้งานได้จริงผ่านหน้าเว็บ +
  เอกสารขายเดิม (M1/M2) เติมรหัสอ้างอิงถูกต้องเมื่อมี mapping — ปล่อยใช้งานได้เดี่ยว ๆ ก่อน P เสร็จก็ได้
- **เฟส 5-P (บิลซื้อ, พึ่ง endpoint ที่ยังไม่ยืนยัน)**: T29–T35 — บิลซื้อ sync ได้จริงผ่านหน้าเว็บ
- **เฟส 5-verify**: T36–T37 — ขัดเกลา + verify จริงกับ sandbox ทั้งสองส่วน

---

## 3) Definition of Done (เฟส 5 รวม)

- [ ] นักบัญชี/หัวหน้าที่ดูแลลูกค้ากรอก mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้าได้เองผ่านหน้าเว็บ
      (ไม่ต้องพึ่ง admin/แก้โค้ด)
- [ ] เอกสารขาย (ของเดิม M1/M2) ที่ยังไม่ตั้ง mapping ใด ๆ → พฤติกรรม/payload เหมือนก่อนเฟสนี้ **100%** (ไม่ regression)
- [ ] เอกสารขายที่ลูกค้าตั้ง mapping ผังบัญชี/สินค้าไว้ → `sellChartOfAccountCode`/`items[].id` ถูกเติมถูกต้องตรงกับที่ตั้งไว้
- [ ] ปุ่ม "ส่งไป FlowAccount" โผล่บนบิลซื้อ (`entry_type='purchase'`) ที่ `status='confirmed'` และผูกลูกค้าแล้วด้วย
- [ ] กดส่งบิลซื้อสำเร็จ → เอกสารสร้างจริงใน FlowAccount (sandbox) โดย contact = ผู้ขาย/vendor จริง (`counterpartyName`/
      `counterpartyTaxId`) **ไม่ใช่** ตัวลูกค้า NOVA-CX เอง
- [ ] กดซ้ำ/สองแท็บพร้อมกันกับบิลซื้อ → สร้างเอกสารที่ FlowAccount ได้แค่ครั้งเดียว (reuse atomic claim เดิม)
- [ ] แก้บิลซื้อที่ synced แล้ว → เห็นคำเตือน "ควรส่งใหม่" เหมือนบิลขาย (`needs_resync` engine เดิม)
- [ ] ลูกค้าที่ยังไม่กรอก credential (M2) → บิลซื้อก็กดส่งไม่ได้เหมือนบิลขาย (reason `customer_not_configured` เดิม)
- [ ] vendor ไม่มีเลขภาษี → ปฏิเสธชัดเจน (`missing_vendor_tax_id`) ไม่ยิง fetch เปล่า ๆ
- [ ] mapping ไม่ครบ/ไม่ได้ตั้ง → ยังส่งเอกสารได้ตามปกติ (mapping เป็น enhancement ไม่ใช่ prerequisite บังคับ)
- [ ] ทุก write path ใหม่ (mapping CRUD + purchase sync) ผ่าน `requireAccountingAccess` + `assertCustomerInScope`
- [ ] ไม่มี `console.log`/log ใดที่มี payload เต็ม/เลขภาษี/ยอดเงิน/ชื่อลูกค้า-ผู้ขาย/รหัสบัญชี FlowAccount (PDPA)
- [ ] ไม่มี secret/endpoint ฝังในโค้ดนอกเหนือ `lib/env.ts` (credential ยังมาจาก DB ต่อลูกค้าเหมือน M2)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] เทสต์เดิมของ M1/M2 (ก่อนเฟสนี้) ทั้งหมดยังผ่านหลัง refactor rename ฟังก์ชัน
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

### 4.1 Unit test (ครอบตาม T24, T27–T28, T31–T34)

**`flowaccount-map.ts`/`flowaccount-map-actions.ts` (T24–T25):**
- CRUD ปกติ (create/update/delete mapping ทั้ง 2 ชนิด), upsert ทับแถวเดิมไม่สร้างซ้ำ, validate ค่าว่าง/ยาวเกิน
- สโคป: นักบัญชีนอกสโคปแก้ mapping ลูกค้าอื่นไม่ได้ (เหมือนเทสต์ `customer-admin-actions.test.ts` ของ M2)

**`flowaccount-mapper.ts` (T27, T32) — จุดสำคัญที่สุดของ Q/P:**
- `buildSalesDocumentPayload` ไม่ส่ง `maps`/ส่ง `{}` → ผลลัพธ์เหมือนก่อนเฟสนี้เป๊ะ (regression test บังคับ — เอาผลลัพธ์
  จากเทสต์เดิมของ M1/M2 มาเทียบ byte-ต่อ-byte ของฟิลด์ `sellChartOfAccountCode`/`items[].id`)
- `buildSalesDocumentPayload` ส่ง `maps` ที่มี mapping ตรง `accountCode`/`productId` ของบางบรรทัด (ไม่ใช่ทุกบรรทัด)
  → เติมเฉพาะบรรทัดที่ map เจอ บรรทัดที่ไม่ map ยังว่างเหมือนเดิม
- `resolvePurchaseDocType`: credit/null → `purchase_bill`, cash/transfer/cheque → `cash_expense`
- `buildPurchaseDocumentPayload`: mapping ปกติ ยืนยัน `contactTaxId`/`contactName` = **vendor** (ไม่ใช่ customer
  fixture ที่ตั้งชื่อต่างกันชัดเจนในเทสต์ กันสลับผิดฝั่งโดยไม่ตั้งใจ), reject ครบ 3 เหตุผล (`missing_vendor_tax_id`/
  `no_value_lines`/`missing_doc_date`), ใช้ `buyChartOfAccountCode` ไม่ใช่ `sellChartOfAccountCode`

**`flowaccount.ts` (T31):**
- `createPurchaseDocument` ครอบทุก branch เหมือน `createSalesDocument` (ย้ายชุดเทสต์เดิมมาปรับ endpoint)
- token cache ใช้ร่วมกันระหว่างเรียกขายแล้วซื้อของ credential เดียวกัน (ไม่ขอ token ซ้ำ)

**`flowaccount-sync.ts` (T33) — ครอบทั้ง sale (regression) และ purchase (ใหม่):**
- ทุกเคสเดิมของ M1/M2 (sale) ต้องผ่านหลัง rename ฟังก์ชัน (claim/credential/mapper reject/success/failure)
- purchase: confirmed+มีลูกค้า+vendor มีเลขภาษี+credential ครบ → success เขียน `flowaccount_doc_type` เป็นค่าใหม่ถูกต้อง
- purchase: claim ซ้ำ (race) ถูกปฏิเสธเหมือน sale
- `entry_type='unspecified'` → `unsupported_entry_type` ก่อน claim (ไม่เสีย claim ไปเปล่า ๆ)
- sale + mapping ของลูกค้า → `createSalesDocument` ถูกเรียกด้วย payload ที่มี `sellChartOfAccountCode` ตรงตาม mapping จริง

**`flowaccount-actions.ts` (T34):**
- ส่งบิลซื้อ confirmed สำเร็จ/ล้มทุกเหตุผล (รวมใหม่) → ข้อความไทยสุภาพถูกต้อง ไม่หลุด internal
- guard สโคป/สิทธิ์เดิมยังทำงานถูกต้องทั้ง 2 ประเภทเอกสาร

### 4.2 Integration/manual (บน sandbox จริง — ต้องใช้ FlowAccount sandbox account ที่มีจริง)

1. **[ต้อง sandbox จริง]** ก่อนเริ่ม T31 จริง — ยืนยัน endpoint สร้างเอกสารซื้อ/ค่าใช้จ่ายจาก FlowAccount OpenAPI
   ทางการ (T30) ถ้ามี Postman collection/sandbox access ให้ยิงทดสอบ manual 1 ครั้งนอกโค้ดก่อน เพื่อยืนยัน field
   ที่ถูกต้องก่อนเขียน mapper/client จริง
2. ตั้ง credential ลูกค้า A ให้ครบ (จาก M2) → เข้าหน้า `/chat-audit/accounting/flowaccount-map` → กรอก mapping
   ผังบัญชี 2-3 รายการ + สินค้า 1-2 รายการที่มีอยู่จริงในบัญชี FlowAccount ของลูกค้า A
3. สร้างบิลขาย confirmed ที่มีบรรทัดผูก `account_code`/`product_id` ที่ map ไว้ในข้อ 2 → กดส่ง → **[ต้อง sandbox
   จริง]** เช็คในหน้า FlowAccount ว่ารายการสินค้า/บัญชีที่โผล่ตรงกับ mapping ที่ตั้งไว้จริง (ไม่ใช่แค่ free-text
   เหมือนก่อนเฟสนี้)
4. สร้างบิลซื้อ confirmed (มีเลขภาษีผู้ขาย/vendor ครบ) → กดส่ง → **[ต้อง sandbox จริง]** เช็คเอกสารโผล่ใน FlowAccount
   ของลูกค้า A จริง โดย contact ต้องเป็นชื่อผู้ขาย ไม่ใช่ชื่อลูกค้า A เอง
5. บิลซื้อที่ vendor **ไม่มีเลขภาษี** → กดส่ง → เห็น error ชัดเจน ไม่ยิง fetch ไปเปล่า ๆ
6. เปิด 2 แท็บ กดส่งบิลซื้อเดียวกันพร้อมกัน → **[ต้อง sandbox จริง]** ตรวจว่าได้เอกสารใบเดียว (เหมือนเทสต์เดิมของ
   บิลขาย แต่ต้องทำซ้ำฝั่งซื้อด้วยเพราะ engine ถูก refactor)
7. บิลซื้อที่ synced แล้ว → แก้ยอด/รายละเอียด → บันทึก → เห็นคำเตือน "ควรส่งใหม่"
8. staff นักบัญชีที่ไม่ได้ดูแลลูกค้า A → เปิดหน้า flowaccount-map ของลูกค้า A ไม่ได้/แก้ mapping ไม่ได้
9. ทดสอบว่าเอกสารขายเดิม (ลูกค้าที่ **ไม่มี** mapping ตั้งไว้เลย) ยังส่งได้ปกติเหมือนก่อนเฟสนี้ **[ต้อง sandbox จริง
   เพื่อยืนยันว่าไม่ regression]**

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| **สเปก endpoint บิลซื้อ/ค่าใช้จ่ายที่เดาไว้ (`/purchases`, `/expenses`) ผิดจริง** (ยังไม่ยืนยันแบบ M1 ฝั่งขาย) | รวมจุดยิง fetch ไว้ที่ `createPurchaseDocument()`/`purchaseEndpointFor()` จุดเดียว (เหมือน M1 risk table) แก้ที่เดียวถ้าผิด; T23–T28 (Q ทั้งหมด) ไม่พึ่ง endpoint นี้เลย ปล่อยใช้งานได้ก่อนแม้ P ยังไม่เสร็จ |
| **rename `syncSaleEntryToFlowAccount` → `syncEntryToFlowAccount` กระทบจุดอื่นที่ลืมแก้** | grep ทั้ง repo (`syncSaleEntryToFlowAccount`) ก่อนปิดงาน T33/T34 ต้องว่างเปล่า; TypeScript compile จะจับ import ที่ลืมแก้ได้เองอยู่แล้ว (breaking rename = compile error ทันทีถ้าพลาด) |
| **mapping ผังบัญชี/สินค้าที่นักบัญชีพิมพ์ผิดมือ** (ไม่มี live-fetch มายืนยันว่ารหัสมีจริงในฝั่ง FlowAccount) → เอกสารอาจสร้างไม่สำเร็จ/ลงผิดหมวดใน FlowAccount แบบไม่รู้ตัวจนกว่าจะ sync จริง | mapping เป็น enhancement ไม่ใช่ prerequisite (ไม่มี mapping = ยังส่งได้แบบ free-text เหมือนเดิม); ทดสอบ manual (4.2 ข้อ 3) ก่อนใช้งานจริงกับลูกค้าทุกราย; ถ้า FlowAccount ปฏิเสธรหัสผิด (`validation_error`) ระบบ mark `failed`+error message อยู่แล้ว (ไม่เงียบ) — นักบัญชีแก้ mapping แล้วกดส่งใหม่ได้ |
| **`contactAddress` ของ vendor ว่างเสมอ** (ไม่มีคอลัมน์ที่อยู่ผู้ขายในสคีมาปัจจุบัน — decision 0.15) | ยอมรับข้อจำกัดนี้ในเฟสนี้ (ไม่ใช่ required field ของ FlowAccount); เพิ่มคอลัมน์ `counterparty_address` เป็นงานแยกถ้าลูกค้าต้องการจริง |
| **ชื่อ CHECK constraint ที่เดาไว้ใน migration 0072 ไม่ตรงชื่อจริงใน DB** (ต่าง pg version/ตั้งชื่อเอง) | ใช้ `\d bill_entries`/`\d flowaccount_sync_log` ตรวจชื่อจริงก่อน apply เสมอ (ระบุไว้ใน T29); ถ้าชื่อไม่ตรง แก้ SQL ให้ตรงก่อน apply จริง (dev/staging ก่อนเสมอ ไม่ apply ตรง production) |
| **การเติม mapping ให้เอกสารขายเดิม (0.13) ทำให้ payload ของลูกค้าที่ตั้ง mapping ผิดจากที่เคยส่งมาตลอด** (เคย `""` กลายเป็นมีค่า) อาจกระทบเอกสารเก่าที่เคย sync ไปแล้วถ้ากดส่งใหม่ | mapping มีผลเฉพาะการส่ง**ครั้งใหม่**เท่านั้น (ไม่ auto-resync เอกสารเก่าที่ synced แล้ว — ตรงกับหลักการ manual-trigger เดิม); regression test (4.1) ยืนยันว่าไม่ตั้ง mapping = พฤติกรรมเดิม 100% ก่อนปล่อยจริง |
| **พบว่า contact ของเอกสารขายเดิม (M1/M2) อาจผิดฝั่ง (0.6)** แต่เฟสนี้ตัดสินใจไม่แก้ | แจ้งผู้ใช้ให้รับทราบชัดเจนตอนสรุปงาน (ตามกติกา FLAG ของไฟล์นี้) — ถ้ายืนยันว่าเป็นบั๊กจริง เสนอเป็นงานแก้แยกต่างหาก (ความเสี่ยง regression กับ flow ที่ deploy ใช้งานจริงแล้ว ต้องวางแผนแยก ไม่ผูกกับเฟสนี้) |
| **สินค้า/ผังบัญชีถูกลบ/ปิดใช้งาน (`soft-delete`) ใน nova-cx หลังตั้ง mapping ไว้แล้ว** — mapping row ยังชี้ `product_id`/`account_code` เดิมที่ไม่ active แล้ว | `flowaccount_product_map.product_id` เป็น FK on delete cascade (ถ้า product ถูกลบจริงจะหาย) ส่วน soft-delete (ยัง exist แค่ inactive) mapping ยังใช้ได้ตามปกติ (ไม่ผูก validate is_active) — เพิ่ม UI hint "ไม่ active แล้ว" ในหน้า mapping เป็น nice-to-have ถ้าเวลาเหลือ ไม่ใช่ DoD บังคับ |

---

*(เฟส 6 จะเติมแผนละเอียดต่อท้ายไฟล์นี้เมื่อเริ่มลงมือ — ดูภาพรวมที่หัวเอกสาร)*

---

# เฟส 6 — แผนละเอียด: ขัดเกลา + อัตโนมัติเพิ่มเติม

**สโคป (ตามภาพรวม, เฟสสุดท้ายก่อน merge รวม deploy ทีเดียว):** 3 ฟีเจอร์ ทำเป็น 3 ส่วน **R → S → T**
เรียงจากความเสี่ยง/ความซับซ้อนน้อยไปมาก (ดู 0.1):
- **(R) รายการบันทึกซ้ำ (Recurring JE)** — ตั้ง manual JE (JV/PV/RV) ให้สร้างซ้ำอัตโนมัติทุกเดือน/ไตรมาส/ปี
  (เช่น ค่าเช่า, ค่าบริการรายเดือน) — ต่อยอด `manual_journal_entries` เดิม (เฟส 1 ส่วน C) 100% ไม่แตะ engine
- **(S) งบประมาณ (Budget)** — ตั้งงบต่อรหัสบัญชี/เดือน/ปี เทียบกับยอดเคลื่อนไหวจริงจากงบทดลอง — ต่อยอด
  `trial-balance.ts`/`report-filter.ts`/`statement-inputs.ts` เดิม ไม่มีสูตรคำนวณคู่ขนานใหม่
- **(T) กระทบยอดธนาคาร (Bank Reconciliation)** — เทียบยอดบัญชีธนาคารใน nova-cx กับ statement ธนาคารจริง
  (นำเข้า CSV + กรอกมือ) — ต่อยอด `JournalLine[]`/cash pool concept เดิม (เฟส 4 ส่วน O)

ปิดท้ายด้วย **(U) ทดสอบเต็มระบบรอบสุดท้าย + เช็คลิสต์ก่อน merge รวม** (ดูหมวด 6 ท้ายเอกสาร) — เฟสนี้เป็นเฟส
สุดท้ายก่อน merge เข้า `main` แล้ว deploy ทีเดียวตามที่ผู้ใช้ยืนยันไว้แต่แรก

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `lib/accounting/manual-journal.ts` (เฟส 1 ส่วน C) — `ManualEntryInput`/`validateManualEntryInput`/
  `upsertManualEntry`/`confirmManualEntry` ครบทุกอย่างที่ต้องใช้สร้าง occurrence ใหม่ — **R ไม่ต้องแก้ไฟล์นี้
  เลยแม้แต่บรรทัดเดียว** (เรียกใช้ตรง ๆ จากไฟล์ใหม่ `recurring-journal.ts`)
- `lib/accounting/report-filter.ts::ReportPeriod`/`validMonth` — โมเดลงวดแบบ `YYYY-MM` ที่ใช้ทั้งระบบ
  (formal-statements/reports) — budget ใช้รูปแบบเดียวกัน (ปี+เดือนแยกคอลัมน์ ตรงกับ trial balance movement)
- `lib/accounting/trial-balance.ts::TrialBalanceRow` (`debit`/`credit` = เคลื่อนไหวงวด) — budget เทียบยอดจริง
  จากฟิลด์นี้ตรง ๆ ไม่คำนวณเองใหม่
- `lib/accounting/statement-inputs.ts::loadCombinedJournalLines`/`flattenCombinedJournalLines` — รวม
  manual JE + bill_payments + CN/DN เป็น `JournalLine[]` ชุดเดียวอยู่แล้ว (เฟส 4, 0.13) — bank reconciliation
  ใช้ pipeline เดียวกันนี้ + `buildJournalEntries` (journal.ts) ของบิล กรองเฉพาะ `accountCode` ของบัญชีเงินฝาก
  ที่เลือก เป็น "ฝั่งบัญชี (book side)" — **ไม่สร้างแหล่งข้อมูลคู่ขนานใหม่**
- `lib/accounting/cash-flow-config.ts::cashPoolCodesOf` — concept "เงินสด+เทียบเท่าเงินสด" เดิม (เฟส 4)
  ใช้เป็นตัวกรองบัญชีที่ "กระทบยอดธนาคารได้" (bank reconciliation เลือกได้เฉพาะรหัสในกลุ่มนี้ที่ `bank:true`)
- `lib/accounting/bank-accounts.ts::listCustomerBankAccounts` — บัญชีเงินฝากจริงต่อลูกค้า (เฟส 1) — bank
  reconciliation ทำทีละ 1 บัญชีของลูกค้า (`customer_bank_accounts.id`) ไม่ใช่ทุกบัญชีพร้อมกัน
- `supabase/migrations/0026_scheduled_invitation_rpc.sql` — pattern "atomic RPC (SECURITY DEFINER, service_role
  เท่านั้น)" ที่ทีมใช้มาแล้ว 2 ครั้ง (invitation scheduling, sales-documents doc-number) — recurring JE (R)
  ใช้ pattern เดียวกันสำหรับ "claim รอบที่ถึงกำหนด" กันสร้างซ้ำจาก cron/ปุ่มมือชนกัน
- `app/api/cron/extract-bills/route.ts` + `vercel.json` — pattern cron ที่มีอยู่แล้วทั้งระบบ (CRON_SECRET
  fail-closed, คืน 200 เสมอกัน retry loop, `cron_health` ไม่ได้บังคับต้องใช้ทุก job) — R ใช้ pattern เดียวกัน
  สร้าง cron ใหม่ 1 endpoint
- `app/chat-audit/accounting/UndoDeleteBar.tsx` — แนวคิด "ลบแล้วกู้คืนได้" (soft-delete) — bank reconciliation
  (T) ใช้แนวคิดเดียวกันระดับ "ทั้งชุดที่นำเข้า" (ลบทั้ง batch ถ้านำเข้าไฟล์ผิด ไม่ใช่ทีละบรรทัด)
- `ls supabase/migrations/` ล่าสุด (ยืนยันแล้ว) = `0072_flowaccount_purchase_doc_types.sql` → migration ใหม่
  ของเฟสนี้เริ่มที่ `0073`

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ลำดับ R → S → T ตามความเสี่ยง/ความซับซ้อนจากน้อยไปมาก
- **R (recurring JE)** ต่อยอด `manual_journal_entries` ที่มี validate/engine ครบอยู่แล้ว 100% (เฟส 1) —
  งานใหม่จริง ๆ คือแค่ "ตารางเทมเพลต + ตัวสร้าง occurrence + cron" ไม่แตะ engine เลย — **เสี่ยงต่ำสุด**
- **S (budget)** เป็นตารางใหม่ทั้งหมด (config + comparison report) แต่เป็น **read-only เทียบยอด** ล้วน
  (ไม่มี write path ที่กระทบบัญชีจริงแม้แต่จุดเดียว) — **เสี่ยงปานกลาง** (ความซับซ้อนอยู่ที่ UI กรอกงบ 12 เดือน
  + การจัดกลุ่มตามหมวดบัญชี ไม่ใช่ความเสี่ยง correctness ของบัญชี)
- **T (bank reconciliation)** ต้องมีตารางนำเข้าใหม่ + parser ไฟล์ + UI จับคู่รายการที่ซับซ้อนสุด (2 ฝั่งข้อมูล
  ที่ต้อง reconcile กัน) และเป็นฟีเจอร์แรกในทั้ง 6 เฟสที่ "รับข้อมูลจากภายนอกมาเทียบ" (statement ธนาคาร)
  — **เสี่ยง/ซับซ้อนสุด** ทำทีหลังสุด และให้ R/S ปล่อยใช้งานได้ก่อนแม้ T ยังไม่เสร็จ (milestone แยกกันชัดเจน)

### 0.2 ขอบเขต Recurring JE (R) — ความถี่ที่รองรับ
รองรับ **`monthly` (ทุกเดือน) / `quarterly` (ทุกไตรมาส) / `yearly` (ทุกปี)** เท่านั้น (ตัด `weekly` ออก — ตัวอย่าง
การใช้งานจริงที่ระบุมาทั้งหมด เช่น ค่าเช่า/ค่าบริการรายเดือน เป็นรอบเดือนขึ้นไปเสมอ ไม่มีเคสรายสัปดาห์ — ลดสโคป
โดยไม่กระทบการใช้งานจริง) **[⚠️ FLAG]** ถ้าต้องการ `weekly` ในอนาคต เพิ่ม enum value ได้ทันทีโดยไม่ต้อง
เปลี่ยนโครงสร้าง (แค่เพิ่ม branch ใน `add_months_clamped`-เทียบเท่าและ CASE ของ RPC)

### 0.3 ⚠️ Recurring JE ไม่ auto-confirm เด็ดขาด — สร้างเป็น `draft` เสมอ ต้องให้นักบัญชีกดยืนยันเอง
เหตุผล: manual JE ที่ confirmed แล้วเข้าบัญชีแยกประเภท/งบการเงินทันที (เฟส 1) — ถ้า auto-confirm ยอดผิด
(เช่น เทมเพลตตั้งยอดผิดตั้งแต่ต้น หรือค่าเช่าเปลี่ยนแปลงแต่ลืมแก้เทมเพลต) จะเข้าบัญชีจริงโดยไม่มีใครตรวจก่อน
เลย — เฟสนี้ (เฟสสุดท้ายก่อน merge รวม) เน้นความเสี่ยง regression/ความถูกต้องต่ำสุดเป็นหลัก **ทุก occurrence
ที่ cron สร้างให้ ต้องผ่านการกดยืนยันของนักบัญชีเหมือน manual JE ปกติทุกใบ ไม่มีทางลัด**

### 0.4 Trigger การสร้าง occurrence — cron รายวัน + ปุ่ม "สร้างตอนนี้" กันชน (atomic RPC)
- Cron ใหม่ (`/api/cron/generate-recurring-je`, รันวันละครั้ง — mirror `extract-bills` pattern) สแกนทุก
  เทมเพลตที่ `is_active=true` และ `next_run_date <= วันนี้` ของทุก tenant (service-role, ไม่ผูก tenant เดียว
  — mirror `redecideAllTenants` ของ extract-bills)
- ปุ่ม "สร้างตอนนี้" ในหน้าเทมเพลต (กรณี cron ยังไม่ถึงรอบ/อยากสร้างล่วงหน้า) เรียก endpoint เดียวกันในเชิง
  ตรรกะ (ผ่าน server action ที่เรียกฟังก์ชันเดียวกับ cron ใช้)
- ป้องกันสร้างซ้ำจาก cron กับปุ่มมือชนกันพร้อมกัน (หรือ cron รันซ้อนจาก retry) ด้วย **atomic RPC**
  `claim_recurring_je_occurrence(tenant_id, template_id, today)` (`for update skip locked` + advance
  `next_run_date` ในทีเดียว — pattern เดียวกับ `0026_scheduled_invitation_rpc.sql`) — ถ้า claim ไม่ติด
  (มีคนอื่นกำลังทำอยู่/ยังไม่ถึงรอบ) คืน `claimed:false` เฉย ๆ ไม่ throw

### 0.5 ⚠️ กับดัก date arithmetic ของ Postgres ที่ต้องแก้เอง — `date + interval '1 month'` **ไม่ clamp วันสิ้นเดือน**
พบจากการตรวจสอบก่อนออกแบบ RPC: Postgres `date '2026-01-31' + interval '1 month'` ให้ผลเป็น **'2026-03-03'**
(ไม่ใช่ 28/29 ก.พ.) เพราะ Postgres บวกเดือนก่อนแล้ว "overflow" วันที่ไม่มีจริงไปเดือนถัดไป — ถ้าใช้ตรง ๆ
เทมเพลตที่ตั้งวันที่ 29-31 จะ "เลื่อนวันสร้างเบี้ยวไปเรื่อย ๆ ทุกเดือน" ไม่กลับมาลงตัวอีกเลย (บั๊กเงียบที่ร้ายแรง
มากสำหรับฟีเจอร์ที่ต้อง "ตรงรอบทุกเดือน") **[⚠️ FLAG — แก้เชิงสถาปัตยกรรมตั้งแต่ต้น ไม่ปล่อยผ่าน]**
- แก้โดยเขียน SQL helper `public.add_months_clamped(d date, n int) returns date` เอง: เอาปี/เดือนของ `d`
  บวก `n` เดือน แล้ว **clamp วันที่ให้ไม่เกินวันสุดท้ายของเดือนปลายทาง** (เช่น 31 ม.ค. + 1 เดือน → 28/29 ก.พ.
  ตามปีอธิกสุรทิน, 31 ม.ค. + 1 ปี → 31 ม.ค. ปีถัดไปเป๊ะ, 29 ก.พ. (อธิกสุรทิน) + 1 ปี → 28 ก.พ. ปีถัดไปถ้าไม่ใช่
  ปีอธิกสุรทิน) — ใช้ฟังก์ชันนี้ทั้ง monthly (n=1)/quarterly (n=3)/yearly (n=12) ใน RPC ของ 0.4
- มี TS helper คู่ขนาน `nextRunDateAfter(date, frequency)` (pure, ใช้แสดง preview "รอบถัดไปจะสร้างวันที่..."
  ในหน้า UI เท่านั้น — **ไม่ใช่แหล่งความจริง** RPC/SQL คือแหล่งความจริงของการ advance จริง) — ต้องมี unit test
  เทียบผลลัพธ์ตรงกับพฤติกรรม SQL เป๊ะทุก edge case ข้างต้น (กันโค้ด 2 ที่ไม่ตรงกัน)

### 0.6 ยอดเงินต่อรอบ "คงที่" เท่านั้นในรอบแรก — ไม่รองรับสูตร/ตัวแปรผันแปร
เทมเพลตเก็บ `debit`/`credit` ต่อบรรทัดเป็นตัวเลขคงที่ (เหมือนกันทุกรอบที่ generate) **[⚠️ FLAG]** ถ้ายอด
เปลี่ยนไปในบางเดือน (เช่น ค่าไฟผันแปร) นักบัญชีต้องแก้ occurrence นั้นเองหลัง generate (draft แก้ได้ปกติ
ตาม manual-journal.ts เดิม) หรือปิด `is_active` เทมเพลตแล้วสร้าง manual JE เองเดือนนั้น — ไม่ใช่ prerequisite
ที่ block งานนี้ เป็น backlog แยกถ้าต้องการสูตรคำนวณในอนาคต

### 0.7 เก็บ link occurrence ↔ เทมเพลต — เพิ่มคอลัมน์เดียวใน `manual_journal_entries` (nullable, ไม่กระทบของเดิม)
`manual_journal_entries.recurring_template_id` (nullable, FK `on delete set null`) — ใช้แค่แสดง badge
"สร้างจากรายการซ้ำ" + กรอง/ลิงก์กลับไปเทมเพลตต้นทางในหน้า UI **ไม่มี mapper ไหน (`toJournalLines`/
`toJournalPosting`) ต้องแก้เลย** เพราะ field นี้ไม่ถูกใช้ในการคำนวณบัญชีใด ๆ (เป็น metadata ล้วน)

### 0.8 บัญชี/รหัสในเทมเพลตถูกลบ/ปิดใช้งานก่อนถึงรอบ generate — skip + log ไม่ throw ทั้ง cron
ถ้า `account_code` ในเทมเพลตไม่อยู่ในผังที่ `listChartOfAccounts` คืนมาแล้ว (ลบ/ปิดใช้งานไปแล้วหลังตั้งเทมเพลต)
→ `validateManualEntryInput` เดิมจะปฏิเสธตามปกติ (rejects "ไม่อยู่ในผังบัญชี") — เมื่อเจอเคสนี้ **ไม่ throw
ทั้ง cron run** (ต้อง generate เทมเพลตอื่นของ tenant/ลูกค้าอื่นต่อได้) แต่บันทึกลง `recurring_journal_generation_log`
(status `failed` + message) ให้นักบัญชีเห็นในหน้าเทมเพลตว่ารอบนี้สร้างไม่สำเร็จ ต้องแก้เทมเพลตแล้วกด "สร้างตอนนี้"
เอง (ไม่มี auto-retry เงียบ ๆ — ตรงกับหลักการเดิมของทั้งระบบ เช่น FlowAccount sync)

### 0.9 ขอบเขต Budget (S) — ต่อ (tenant, customer, account_code, year, month)
ตั้งงบเป็นตัวเลขเดียวต่อ "รหัสบัญชี + ปี + เดือน" ของลูกค้า 1 ราย (ไม่มี currency/hierarchy/sub-budget) —
เดือนที่ไม่ได้ตั้งงบ = ถือว่างบ = 0 (ไม่บังคับกรอกครบทุกเดือน/ทุกบัญชี — เดือน/บัญชีไหนไม่สนใจก็เว้นว่างได้)

### 0.10 เทียบยอดจริง — reuse `TrialBalanceRow.debit/credit` (เคลื่อนไหวงวด) ตรง ๆ ไม่มีสูตรคู่ขนาน
ยอดจริงของบัญชีในเดือนหนึ่ง = เรียก pipeline เดิมทั้งชุด (`listEntries` + `filterEntriesForReport` (period
เดือนนั้นเดือนเดียว, `from=to=YYYY-MM`) + `loadCombinedJournalLines` + `buildLedger` + `buildTrialBalance`)
แล้วอ่านค่า `debit`/`credit` ของแถวที่ตรง `account_code` — **ไม่เขียนฟังก์ชันคำนวณยอดเคลื่อนไหวใหม่แม้แต่บรรทัด
เดียว** (ถ้าวันหนึ่ง engine หลักแก้สูตร budget ได้ผลถูกต้องอัตโนมัติตาม ไม่ต้องแก้ 2 ที่)

### 0.11 ทิศทางเทียบงบ — ตามหมวดบัญชี (natural balance) เป็นค่าเริ่มต้น ไม่ให้ผู้ใช้เลือกฝั่งเอง
- หมวด 4 (รายได้) → เทียบกับ **เครดิต**เคลื่อนไหวของบัญชีนั้น (รายได้เพิ่มด้วยเครดิต)
- หมวด 5 (ค่าใช้จ่าย) → เทียบกับ **เดบิต**เคลื่อนไหวของบัญชีนั้น (ค่าใช้จ่ายเพิ่มด้วยเดบิต)
- หมวดอื่น (1/2/3/6) → เทียบกับ **ยอดเคลื่อนไหวสุทธิ** (debit − credit) ของบัญชีนั้น (ใช้ได้ในทางปฏิบัติแต่ไม่ใช่
  เคสหลักที่ตั้งงบ — ตั้งได้เหมือนกันไม่ปิดกั้น แต่ label ต่างจาก 2 หมวดหลัก)
ตัดสินใจไม่ให้ผู้ใช้สลับฝั่งเอง — ลดจุดตั้งค่าผิด/สับสน (ทิศทางบัญชีเป็น convention ตรึงตัวเหมือน
`CATEGORY_BY_DIGIT` เดิม)

### 0.12 กรอกงบ — ตารางกริด 12 เดือนต่อ 1 ปี ต่อ 1 บัญชี (ไม่มี "เฉลี่ยทั้งปีหาร 12 อัตโนมัติ" ในรอบแรก)
หน้าตั้งงบให้เลือกปี → เห็นตารางบัญชีทั้งหมด (จัดกลุ่มตามหมวดเหมือน `searchChartNonBankGrouped`) × 12 ช่องเดือน
กรอกเป็นตัวเลขอิสระต่อช่อง — บันทึกทีเดียวทั้งปี (upsert เป็นชุด ไม่ใช่ทีละเดือน) **[⚠️ FLAG]** ฟีเจอร์ "ตั้งงบ
ทั้งปีแล้วหารเฉลี่ย 12 เดือนอัตโนมัติ" เป็น nice-to-have เพิ่มทีหลังได้ถ้ามีเวลาเหลือ ไม่ใช่ DoD บังคับของเฟสนี้

### 0.13 ขอบเขต Bank Reconciliation (T) — นำเข้า CSV (template ตายตัว) + กรอกมือเสริม
- **นำเข้า CSV**: template คอลัมน์ตายตัว 3 คอลัมน์ `date,description,amount` (`date`=`YYYY-MM-DD`,
  `amount`=ตัวเลขมีเครื่องหมาย: **บวก = เงินเข้าบัญชี, ลบ = เงินออกจากบัญชี** — ตรงกับ convention เดียวกับที่
  `JournalLine` ของบัญชีสินทรัพย์ใช้อยู่แล้ว คือ debit=เพิ่ม/credit=ลด) — เขียน parser เอง (pure function,
  รองรับ BOM UTF-8/CRLF/quoted field ที่มี comma ในคำอธิบาย) **ไม่เพิ่ม npm dependency ใหม่** (format
  statement จริงของแต่ละธนาคารต่างกันเกินจะรองรับทุกเจ้าในรอบแรก — ให้นักบัญชีคัดลอก/แปลงเป็น template นี้เอง
  ก่อนอัปโหลด, ปุ่ม "ดาวน์โหลด template ตัวอย่าง" ช่วยลดความสับสน)
- **กรอกมือ**: เพิ่ม/แก้/ลบรายการเดี่ยวได้ (แก้ typo หลัง import หรือกรณีไม่มีไฟล์ CSV เลย)
- **[⚠️ FLAG]** parser เฉพาะรูปแบบ CSV ตายตัวนี้เท่านั้น — ถ้าต้องการ parse ไฟล์ statement จริงจากธนาคาร
  (PDF/Excel เฉพาะฟอร์แมต) เป็นงานเพิ่มเติมนอกสโคป (ต้องยืนยันฟอร์แมตจริงของแต่ละธนาคารก่อน เหมือนหลักการ
  "ไม่เดาสเปกที่ยังไม่ยืนยัน" ที่ใช้ตลอดทั้งไฟล์นี้)

### 0.14 ฝั่ง "บัญชี (book side)" ของการกระทบยอด — ดึงจาก `JournalLine[]` ที่มีอยู่แล้ว ไม่สร้างที่เก็บข้อมูลใหม่
รวม `buildJournalEntries(entries, chartByCode)` (บิล) + `flattenCombinedJournalLines(loadCombinedJournalLines(...))`
(manual JE/bill_payments/CN-DN) ของลูกค้า+งวดที่เลือก แล้วกรองเฉพาะ `accountCode === รหัสบัญชีเงินฝากที่เลือก`
— ผลลัพธ์คือ "รายการบัญชีทุกใบที่กระทบบัญชีเงินฝากนี้ในงวดนั้น" ตรงกับที่ระบบบันทึกจริงทุกจุด (ไม่มีทาง
ไม่ตรงกับบัญชีแยกประเภท/งบการเงิน เพราะที่มาเดียวกัน)

### 0.15 คีย์จับคู่ฝั่งบัญชี (`bookLineKey`) — composite key จากข้อมูลที่มีอยู่แล้ว ไม่ต้องเพิ่มคอลัมน์ id ใหม่
`JournalLine` ไม่มี id เป็นแถวถาวรใน DB (คำนวณสดทุกครั้งจาก 4 แหล่งข้อมูล) — ใช้คีย์ผสม
`${entryId}:${accountCode}:${side}:${amount}:${ลำดับที่เจอซ้ำ}` (ลำดับกันชนกรณีมี 2 บรรทัดค่าเท่ากันเป๊ะใน
entry เดียวกัน — pure function `buildBookLines()` คำนวณลำดับนี้เอง ไม่ต้อง caller ทำ) — เก็บ **snapshot**
(`entryId`/`date`/`amount`/`description`) ไว้ในแถว `bank_statement_lines` ตอนยืนยันจับคู่ ไม่ใช่แค่คีย์เฉย ๆ
(0.16 ใช้ snapshot นี้ตรวจว่า "ข้อมูลต้นทางเปลี่ยนไปหลังจับคู่ไหม")

### 0.16 ⚠️ รายการต้นทางถูกแก้/ลบหลังจับคู่แล้ว — ไม่ auto-sync คีย์ แต่ "เตือน" ผ่านการเทียบ snapshot
ถ้า manual JE/บิลที่เคยจับคู่ไว้ถูกแก้ยอด/ลบทีหลัง `bookLineKey` เดิมจะหาไม่เจอ/ยอดไม่ตรงกับ snapshot ที่
เก็บไว้ตอนจับคู่ — เฟสนี้ **ไม่พยายาม auto-repair การจับคู่** (ซับซ้อนเกินจำเป็น) แค่ให้หน้าจอ "เทียบยอด"
แสดง badge "รายการต้นทางอาจเปลี่ยนไปแล้ว — ตรวจสอบใหม่" เมื่อ re-compute แล้วหา `bookLineKey` เดิมไม่เจอ/ยอด
ไม่ตรง snapshot ให้นักบัญชีเลือกยกเลิกจับคู่แล้วจับคู่ใหม่เอง (ปุ่ม "ยกเลิกจับคู่" มีอยู่แล้วเป็น baseline)

### 0.17 การจับคู่ (matching) — auto-suggest + manual-confirm เสมอ ไม่ auto-confirm เงียบ ๆ
ระบบแนะนำคู่ที่ **ยอดตรงกัน (`|bookAmount − stmtAmount| < EPSILON`)** และ **วันที่ห่างกันไม่เกิน 7 วัน**
(เผื่อเช็ค/โอนที่ขึ้นบัญชีธนาคารช้ากว่าวันที่บันทึกบัญชี) เรียงจากวันที่ใกล้กันที่สุดก่อน — ผู้ใช้ต้องกด
"ยืนยันจับคู่" ทีละคู่เอง (ตรงกับหลักการเดิมทั้งไฟล์นี้ที่ทุกจุดกระทบข้อมูลจริงต้องผ่านคนกดยืนยัน)

### 0.18 ไม่ auto-post รายการปรับปรุงจากผลต่างที่พบ
ถ้ากระทบยอดแล้วเจอผลต่างจริง (เช่น ค่าธรรมเนียมธนาคารที่ยังไม่ได้บันทึก) **ไม่สร้าง manual JE ให้อัตโนมัติ**
— แสดงเป็น "รายการที่ยังไม่จับคู่" (unmatched) ให้นักบัญชีไปสร้าง manual JE เองผ่านหน้า `/journal-entry`
เดิม (ลดความเสี่ยง auto-JE ผิดหมวดบัญชี/ผิดจำนวนเงินในเฟสสุดท้ายก่อน merge)

### 0.19 ขอบเขตต่อครั้ง — 1 บัญชีเงินฝากของลูกค้า 1 ราย ต่อ 1 งวด (ไม่ทำทีเดียวทุกบัญชี)
เลือกลูกค้า → เลือกบัญชีเงินฝาก (`customer_bank_accounts.id` ของลูกค้านั้น) → เลือกงวด (เดือน) → ทำทีละชุด
(ตรงกับพฤติกรรมกระทบยอดธนาคารจริงที่ทำทีละบัญชีธนาคารเสมอ)

### 0.20 สิทธิ์ทั้ง 3 ฟีเจอร์ — reuse `requireAccountingAccess` + `assertCustomerInScope` เดิมทั้งหมด
ไม่มี admin-only ใหม่ในเฟสนี้ — นักบัญชี/หัวหน้าทีมที่ดูแลลูกค้ารายนั้นทำได้เองทั้ง 3 ฟีเจอร์ (ตั้งเทมเพลตซ้ำ/
ตั้งงบ/กระทบยอดธนาคาร) เหมือนหน้า manual JE/opening balance/bill payments เดิมทุกประการ

### 0.21 ยืนยันเลข migration จริงจาก `ls supabase/migrations/` (ไฟล์ล่าสุด = `0072_flowaccount_purchase_doc_types.sql`)
เฟสนี้ใช้ `0073`, `0074`, `0075` — ให้เช็คซ้ำอีกครั้งก่อน apply จริงเผื่อมีการแก้ไขคาบเกี่ยวระหว่างทาง

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 6

```
supabase/migrations/
  0073_recurring_journal_entries.sql   [ใหม่] recurring_journal_templates, recurring_journal_template_lines,
                                                 recurring_journal_generation_log + ALTER manual_journal_entries
                                                 เพิ่ม recurring_template_id + ฟังก์ชัน add_months_clamped() +
                                                 RPC claim_recurring_je_occurrence()
  0074_account_budgets.sql             [ใหม่] ตาราง account_budgets (tenant, customer, account_code, year,
                                                 month, amount) + RLS pattern เดิม
  0075_bank_reconciliation.sql         [ใหม่] bank_statement_import_batches, bank_statement_lines
                                                 (มีคอลัมน์ match ในตัว — ดู 0.15) + RLS pattern เดิม

lib/
  accounting/
    recurring-journal.ts        [ใหม่] ชนิด RecurringTemplate/Frequency, validateTemplateInput (pure),
                                        nextRunDateAfter(date, frequency) (pure, preview UI เท่านั้น — 0.5),
                                        buildOccurrenceInput(template) → ManualEntryInput (pure), data layer
                                        CRUD (list/upsert/toggleActive/softDelete), generateDueOccurrences(db,
                                        tenantId, today) orchestrator (เรียก RPC claim + upsertManualEntry เดิม
                                        + เขียน log), listGenerationLog
    budget.ts                   [ใหม่] ชนิด AccountBudget, validateBudgetRowInput (pure), data layer
                                        CRUD (list/upsertYear แบบ batch), buildBudgetComparison(budgetRows,
                                        trialBalanceRows, chart) (pure — เทียบยอดจริงตามทิศทาง 0.11)
    bank-reconciliation.ts      [ใหม่] parseBankStatementCsv(csvText) (pure), buildBookLines(journalLines,
                                        accountCode) → BookLine[] + bookLineKeyOf (pure), suggestMatches
                                        (bookLines, statementLines) (pure), data layer (importBatch/
                                        listBatches/softDeleteBatch/listStatementLines/upsertStatementLine/
                                        deleteStatementLine/confirmMatch/unmatch), buildReconciliationSummary
                                        (pure — book balance/statement balance/unmatched diff)

app/
  api/cron/generate-recurring-je/route.ts  [ใหม่] cron รายวัน (mirror extract-bills — CRON_SECRET fail-closed)
                                                    เรียก generateDueOccurrences ทุก tenant

  chat-audit/accounting/
    recurring-journal/
      page.tsx                  [ใหม่] เลือกลูกค้า (mirror journal-entry/page.tsx) → list เทมเพลต + occurrence
                                        ที่สร้างแล้ว (ลิงก์กลับ journal-entry)
      RecurringJournalPanel.tsx [ใหม่] client component: ฟอร์มสร้าง/แก้เทมเพลต (ใช้ AccountCombobox เดิม) +
                                        ปุ่ม "สร้างตอนนี้" ต่อเทมเพลต + toggle เปิด/ปิด + ลบ
      actions.ts                 [ใหม่] server actions guard requireAccountingAccess+assertCustomerInScope
                                        (upsert/toggle/delete/generateNow เรียก generateDueOccurrences เฉพาะ
                                        เทมเพลตเดียว)
    budget/
      page.tsx                   [ใหม่] เลือกลูกค้า + ปี → BudgetPanel (ตั้งงบ) + ตารางเทียบ (เดือน/ไตรมาส/ปี
                                        reuse ReportPeriod)
      BudgetPanel.tsx             [ใหม่] client component: กริดผังบัญชี (จัดกลุ่มหมวด, reuse
                                        searchChartNonBankGrouped) × 12 เดือน + ตารางเทียบงบ/จริง/ผลต่าง/%
      actions.ts                  [ใหม่] server actions (saveBudgetYearAction แบบ batch upsert)
      export/route.ts             [ใหม่] export Excel ตารางเทียบงบ (reuse exceljs pattern จาก reports/export)
    bank-reconciliation/
      page.tsx                    [ใหม่] เลือกลูกค้า → เลือกบัญชีเงินฝาก → เลือกงวด → BankReconciliationPanel
      BankReconciliationPanel.tsx [ใหม่] client component: อัปโหลด CSV/กรอกมือ + 2 คอลัมน์ (book/statement)
                                        + คู่แนะนำให้กดยืนยัน + สรุปยอด/ผลต่างที่ยังไม่จับคู่
      actions.ts                   [ใหม่] server actions (importCsvAction/addManualLineAction/deleteBatchAction/
                                        confirmMatchAction/unmatchAction)

  chat-audit/accounting/page.tsx  [แก้] เพิ่มลิงก์ไปหน้าใหม่ทั้ง 3 (จุดเดียวกับที่มีลิงก์ opening/reports/
                                        flowaccount-map เดิม)

vercel.json                       [แก้] เพิ่ม cron entry "/api/cron/generate-recurring-je" (schedule รายวัน
                                        เช่น "0 2 * * *" — เวลาก่อนเปิดวันทำการไทย)

tests/
  accounting/recurring-journal.test.ts        [ใหม่] validate/nextRunDateAfter (ครอบ edge case 0.5 ครบ)/
                                                       buildOccurrenceInput/CRUD/generateDueOccurrences (mock RPC)
  accounting/budget.test.ts                    [ใหม่] validate/buildBudgetComparison (ทุกทิศทาง 0.11)
  accounting/bank-reconciliation.test.ts       [ใหม่] parseBankStatementCsv (ทุก edge case 0.13)/buildBookLines/
                                                       bookLineKeyOf/suggestMatches/buildReconciliationSummary
  app/recurring-journal-actions.test.ts        [ใหม่] guard สิทธิ์/สโคป + generateNow
  app/budget-actions.test.ts                   [ใหม่] guard สิทธิ์/สโคป + batch upsert
  app/bank-reconciliation-actions.test.ts      [ใหม่] guard สิทธิ์/สโคป + import/match/unmatch
```

### 1.1 Schema ใหม่ (migration 0073) — ร่าง SQL

```sql
-- เฟส 6 ส่วน R (docs/06, หมวด 0.2–0.8) — รายการบันทึกซ้ำ (Recurring Journal Entry)

create table if not exists public.recurring_journal_templates (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  customer_id        uuid not null references public.customers(id) on delete cascade,
  doc_type           text not null check (doc_type in ('JV','PV','RV')),
  memo               text,
  frequency          text not null check (frequency in ('monthly','quarterly','yearly')),
  start_date         date not null,
  next_run_date      date not null,
  end_date           date,
  is_active          boolean not null default true,
  last_generated_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists idx_recurring_je_templates_due
  on public.recurring_journal_templates (tenant_id, next_run_date)
  where deleted_at is null and is_active = true;
create index if not exists idx_recurring_je_templates_customer
  on public.recurring_journal_templates (tenant_id, customer_id) where deleted_at is null;

create table if not exists public.recurring_journal_template_lines (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.recurring_journal_templates(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  account_code  text not null,
  account_name  text,
  description   text,
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0
);
create index if not exists idx_recurring_je_template_lines_template
  on public.recurring_journal_template_lines (tenant_id, template_id);

create table if not exists public.recurring_journal_generation_log (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  template_id      uuid not null references public.recurring_journal_templates(id) on delete cascade,
  run_date         date not null,
  status           text not null check (status in ('generated','failed')),
  message          text,
  manual_entry_id  uuid references public.manual_journal_entries(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_recurring_je_gen_log_template
  on public.recurring_journal_generation_log (tenant_id, template_id, run_date);

-- ★ link occurrence → เทมเพลตต้นทาง (metadata ล้วน — ไม่กระทบ mapper ใด ๆ, ดู 0.7)
alter table public.manual_journal_entries
  add column if not exists recurring_template_id uuid
    references public.recurring_journal_templates(id) on delete set null;

drop trigger if exists trg_recurring_je_templates_updated on public.recurring_journal_templates;
create trigger trg_recurring_je_templates_updated before update on public.recurring_journal_templates
  for each row execute function public.set_updated_at();

-- ★ 0.5: บวกเดือนแบบ "clamp วันสิ้นเดือน" (ต่างจาก `date + interval` ดิบที่ overflow ข้ามเดือน)
create or replace function public.add_months_clamped(d date, n int)
returns date
language plpgsql
immutable
as $$
declare
  target_first date;
  last_day_of_target int;
  target_day int;
begin
  target_first := (date_trunc('month', d) + (n || ' months')::interval)::date;
  last_day_of_target := extract(day from (target_first + interval '1 month - 1 day'))::int;
  target_day := least(extract(day from d)::int, last_day_of_target);
  return (target_first + (target_day - 1) * interval '1 day')::date;
end;
$$;

-- ★ 0.4: claim แบบ atomic (for update skip locked) — กัน cron/ปุ่มมือชนกันสร้างซ้ำ
create or replace function public.claim_recurring_je_occurrence(
  p_tenant_id   uuid,
  p_template_id uuid,
  p_today       date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.recurring_journal_templates%rowtype;
  v_months int;
  v_new_next date;
begin
  select * into v_row
  from public.recurring_journal_templates
  where id = p_template_id and tenant_id = p_tenant_id
    and deleted_at is null and is_active = true
    and next_run_date <= p_today
    and (end_date is null or next_run_date <= end_date)
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  v_months := case v_row.frequency
    when 'monthly' then 1
    when 'quarterly' then 3
    else 12
  end;
  v_new_next := public.add_months_clamped(v_row.next_run_date, v_months);

  update public.recurring_journal_templates
     set next_run_date = v_new_next, last_generated_at = now()
   where id = p_template_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'claimed', true,
    'run_date', v_row.next_run_date,
    'doc_type', v_row.doc_type,
    'memo', v_row.memo,
    'customer_id', v_row.customer_id
  );
end;
$$;

revoke all on function public.claim_recurring_je_occurrence(uuid, uuid, date) from public;
grant execute on function public.claim_recurring_je_occurrence(uuid, uuid, date) to service_role;

alter table public.recurring_journal_templates       enable row level security;
alter table public.recurring_journal_template_lines  enable row level security;
alter table public.recurring_journal_generation_log  enable row level security;
create policy tenant_read on public.recurring_journal_templates for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.recurring_journal_template_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.recurring_journal_generation_log for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.recurring_journal_templates       from anon;
revoke all on public.recurring_journal_template_lines  from anon;
revoke all on public.recurring_journal_generation_log  from anon;
grant select on public.recurring_journal_templates       to authenticated;
grant select on public.recurring_journal_template_lines  to authenticated;
grant select on public.recurring_journal_generation_log  to authenticated;
grant all    on public.recurring_journal_templates       to service_role;
grant all    on public.recurring_journal_template_lines  to service_role;
grant all    on public.recurring_journal_generation_log  to service_role;

notify pgrst, 'reload schema';
```

### 1.2 Schema ใหม่ (migration 0074) — ร่าง SQL

```sql
-- เฟส 6 ส่วน S (docs/06, หมวด 0.9–0.12) — งบประมาณต่อรหัสบัญชี/เดือน/ปี

create table if not exists public.account_budgets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  account_code  text not null,
  year          int not null check (year between 2000 and 2100),
  month         int not null check (month between 1 and 12),
  amount        numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_account_budgets
  on public.account_budgets (tenant_id, customer_id, account_code, year, month);
create index if not exists idx_account_budgets_customer_year
  on public.account_budgets (tenant_id, customer_id, year);

drop trigger if exists trg_account_budgets_updated on public.account_budgets;
create trigger trg_account_budgets_updated before update on public.account_budgets
  for each row execute function public.set_updated_at();

alter table public.account_budgets enable row level security;
create policy tenant_read on public.account_budgets for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.account_budgets from anon;
grant select on public.account_budgets to authenticated;
grant all    on public.account_budgets to service_role;

notify pgrst, 'reload schema';
```

### 1.3 Schema ใหม่ (migration 0075) — ร่าง SQL

```sql
-- เฟส 6 ส่วน T (docs/06, หมวด 0.13–0.19) — กระทบยอดธนาคาร (Bank Reconciliation)
-- ★ match เก็บเป็นคอลัมน์บน bank_statement_lines ตรง ๆ (0.15) — ไม่แยกตาราง match (ลดความซับซ้อน,
--   1 statement line จับคู่ได้กับ 1 book line เท่านั้นในเฟสนี้ — ไม่รองรับ split/many-to-many)

create table if not exists public.bank_statement_import_batches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  bank_account_id uuid not null references public.customer_bank_accounts(id) on delete cascade,
  file_name       text,
  line_count      int not null default 0,
  imported_at     timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists idx_bank_stmt_batches_customer
  on public.bank_statement_import_batches (tenant_id, customer_id, bank_account_id)
  where deleted_at is null;

create table if not exists public.bank_statement_lines (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  bank_account_id       uuid not null references public.customer_bank_accounts(id) on delete cascade,
  batch_id              uuid references public.bank_statement_import_batches(id) on delete cascade,
  stmt_date             date not null,
  description           text,
  amount                numeric(14,2) not null,  -- + = เงินเข้า · − = เงินออก (0.13)
  -- snapshot การจับคู่ (0.15/0.16) — null ทั้งหมด = ยังไม่จับคู่
  matched_book_line_key text,
  matched_entry_id      uuid,
  matched_date          date,
  matched_amount        numeric(14,2),
  matched_at            timestamptz,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index if not exists idx_bank_stmt_lines_account_date
  on public.bank_statement_lines (tenant_id, bank_account_id, stmt_date) where deleted_at is null;
create index if not exists idx_bank_stmt_lines_batch
  on public.bank_statement_lines (tenant_id, batch_id) where deleted_at is null;

alter table public.bank_statement_import_batches enable row level security;
alter table public.bank_statement_lines          enable row level security;
create policy tenant_read on public.bank_statement_import_batches for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.bank_statement_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.bank_statement_import_batches from anon;
revoke all on public.bank_statement_lines          from anon;
grant select on public.bank_statement_import_batches to authenticated;
grant select on public.bank_statement_lines          to authenticated;
grant all    on public.bank_statement_import_batches to service_role;
grant all    on public.bank_statement_lines          to service_role;

notify pgrst, 'reload schema';
```

---

## 2) งานย่อยเรียงลำดับ (เฟส 6)

เลขงาน: ต่อจากเฟส 5 (T23–T37) → เริ่มที่ **T38**

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T38** | Migration 0073 — เทมเพลต+บรรทัด+log + `add_months_clamped()` + RPC `claim_recurring_je_occurrence()` + `recurring_template_id` บน `manual_journal_entries` | `supabase/migrations/0073_recurring_journal_entries.sql` | - | apply ไม่ error; ทดสอบ `add_months_clamped('2026-01-31',1)`→'2026-02-28' (ปีปกติ), `add_months_clamped('2024-01-31',1)`→'2024-02-29' (อธิกสุรทิน), `add_months_clamped('2024-02-29',12)`→'2025-02-28'; RPC คืน `claimed:false` เมื่อยังไม่ถึงรอบ/ไม่ active/ถูกลบ, คืน `claimed:true`+advance `next_run_date` ถูกต้องเมื่อถึงรอบ; เรียกซ้อน 2 session พร้อมกัน (`for update skip locked`) → มีแค่ session เดียว claim สำเร็จ; เทสต์เดิมทั้งหมดผ่าน |
| **T39** | `lib/accounting/recurring-journal.ts` — `validateTemplateInput`, `nextRunDateAfter()` (pure, mirror SQL), `buildOccurrenceInput()` (pure → `ManualEntryInput`), CRUD data layer | `recurring-journal.ts` | T38 | unit test: `nextRunDateAfter` ตรงกับผลลัพธ์ SQL ทุก edge case ของ T38 เป๊ะ; validate ปฏิเสธ `frequency` ที่ไม่รู้จัก/`start_date`ผิดรูป/บรรทัดไม่สมดุล (reuse `isBalanced` จาก manual-journal.ts); `buildOccurrenceInput` คืน `ManualEntryInput` ที่ debit=credit ตรงเทมเพลตเป๊ะ + `docDate`=run_date ที่ได้จาก claim |
| **T40** | `generateDueOccurrences(db, tenantId, today)` — เรียก RPC claim ทุกเทมเพลตที่ถึงกำหนด → `upsertManualEntry` เดิม (status='draft' เสมอ, ตาม 0.3) → เขียน `manual_journal_entries.recurring_template_id` + log ผลทุกกรณี (สำเร็จ/ล้มเหลว ตาม 0.8) — ไม่ throw ทั้งชุดถ้าบางเทมเพลตล้ม | `recurring-journal.ts` | T39 | unit test: เทมเพลตถึงกำหนด+ผังบัญชีมีครบ → สร้าง draft + log `generated`; เทมเพลตที่ `account_code` ถูกลบไปแล้ว → claim สำเร็จแต่ insert ล้ม → log `failed`+message ชัดเจน + เทมเพลตอื่นที่ตามมายังทำงานต่อ (ไม่ throw ทั้ง batch); เทมเพลตยังไม่ถึงรอบ → ข้ามเงียบ ๆ (ไม่ log) |
| **T41** | `app/api/cron/generate-recurring-je/route.ts` (mirror `extract-bills` — CRON_SECRET fail-closed, คืน 200 เสมอกัน retry loop) + `vercel.json` เพิ่ม cron entry | 2 ไฟล์ข้างต้น | T40 | ไม่ตั้ง `CRON_SECRET` → 503 ไม่รัน; auth ผิด → 401; auth ถูก → เรียก `generateDueOccurrences` ทุก tenant ที่มีเทมเพลตถึงกำหนดจริง คืน 200 พร้อมสรุปจำนวน; error ภายใน → catch แล้วคืน 200 (ไม่ retry loop) |
| **T42** | `app/chat-audit/accounting/recurring-journal/{page.tsx,RecurringJournalPanel.tsx,actions.ts}` — CRUD เทมเพลต (reuse `AccountCombobox`) + ปุ่ม "สร้างตอนนี้" (เรียก `generateDueOccurrences` เฉพาะเทมเพลตเดียว บังคับ `today`=วันนี้จริงเสมอ ไม่รับจาก client) + list occurrence ที่สร้างแล้ว (join `manual_journal_entries` ที่ `recurring_template_id` ตรง) ลิงก์ไปหน้า journal-entry | 3 ไฟล์ข้างต้น | T39–T41 | เปิดหน้า สร้างเทมเพลตใหม่ (ค่าเช่ารายเดือน) → เห็นในลิสต์; กด "สร้างตอนนี้" (เทมเพลตถึงกำหนดวันนี้พอดี) → เห็น draft ใหม่ในหน้า journal-entry มี badge เชื่อมเทมเพลต; เทมเพลตยังไม่ถึงรอบ กด "สร้างตอนนี้" → ข้อความแจ้งยังไม่ถึงกำหนด ไม่สร้างอะไร; ลูกค้านอกสโคปแก้เทมเพลตลูกค้าอื่นไม่ได้; typecheck/lint ผ่าน |
| **T43** | เพิ่มลิงก์หน้า `page.tsx` หลัก + เทสต์ actions/`recurring-journal.test.ts`/`recurring-journal-actions.test.ts` ครบ | หลายไฟล์ | T38–T42 | `npm run test` ผ่านทั้งชุด R; ลิงก์จากหน้า accounting หลักไปหน้าใหม่ใช้งานได้จริง |
| **T44** | Migration 0074 — `account_budgets` (unique tenant+customer+account_code+year+month) | `supabase/migrations/0074_account_budgets.sql` | - | apply ไม่ error; insert ซ้ำ (tenant,customer,account_code,year,month) → 23505; เทสต์เดิมทั้งหมดผ่าน |
| **T45** | `lib/accounting/budget.ts` — `validateBudgetRowInput`, CRUD (`listBudgetYear`/`upsertBudgetYear` แบบ batch), `buildBudgetComparison(budgetRows, trialBalanceRows, chart, period)` (pure — ทิศทางตาม 0.11) | `budget.ts` | T44 | unit test: หมวด 4 เทียบเครดิต, หมวด 5 เทียบเดบิต, หมวดอื่นเทียบสุทธิ; เดือน/บัญชีไม่มีงบ → budget=0 ไม่ throw; ผลต่าง/% คำนวณถูก (งบ=0+จริง>0 → % = ไม่มีค่า/แสดง "N/A" ไม่ใช่หารด้วยศูนย์พัง); `upsertBudgetYear` เขียน 12 แถวทีเดียว (ทับของเดิมถ้ามี ไม่ insert ซ้ำ) |
| **T46** | `app/chat-audit/accounting/budget/{page.tsx,BudgetPanel.tsx,actions.ts}` — เลือกลูกค้า+ปี → กริดตั้งงบ (จัดกลุ่มหมวด reuse `searchChartNonBankGrouped`) + ตารางเทียบงบ/จริง/ผลต่าง/% (reuse `ReportPeriod`/`filterEntriesForReport`/`loadCombinedJournalLines`/`buildTrialBalance` เดิมทั้งชุด) | 3 ไฟล์ข้างต้น | T45, มี pipeline เดิมของ formal-statements | ตั้งงบบัญชีค่าใช้จ่าย 12 เดือน → บันทึกครั้งเดียว เปิดใหม่เห็นค่าที่ตั้งไว้ครบ; มีรายการจริงในเดือนนั้น → ตารางเทียบโชว์ผลต่าง/% ถูกต้องตรงกับที่คำนวณด้วยมือ; ลูกค้านอกสโคปเข้าไม่ได้; typecheck/lint ผ่าน |
| **T47** | `app/chat-audit/accounting/budget/export/route.ts` — export Excel ตารางเทียบงบ (reuse `exceljs` pattern จาก `reports/export/route.ts`) | `export/route.ts` | T46 | ดาวน์โหลดไฟล์ .xlsx เปิดได้จริง มีคอลัมน์งบ/จริง/ผลต่าง/% ตรงกับหน้าจอ; guard สิทธิ์เดียวกับหน้า |
| **T48** | เพิ่มลิงก์หน้า `page.tsx` หลัก + เทสต์ `budget.test.ts`/`budget-actions.test.ts` ครบ | หลายไฟล์ | T44–T47 | `npm run test` ผ่านทั้งชุด S |
| **T49** | Migration 0075 — `bank_statement_import_batches` + `bank_statement_lines` (คอลัมน์ match ในตัว) | `supabase/migrations/0075_bank_reconciliation.sql` | - | apply ไม่ error; soft-delete batch (`deleted_at`) → บรรทัดที่ผูก batch ยังอยู่ในตาราง (ต้อง cascade delete จริงหรือ soft-delete ทั้งคู่ให้สอดคล้องกัน — ตัดสินใจ: `bank_statement_lines.batch_id on delete cascade` = ลบ batch จริงลบบรรทัดจริงตาม (batch ใช้ hard-delete เมื่อ "ยกเลิกนำเข้า" ทันทีหลัง import ผิด, ไม่ใช่ soft-delete ธุรกิจระยะยาว) — ระบุชัดใน DoD ของ T51 |
| **T50** | `lib/accounting/bank-reconciliation.ts` (ส่วน pure) — `parseBankStatementCsv()`, `buildBookLines()`+`bookLineKeyOf()`, `suggestMatches()`, `buildReconciliationSummary()` | `bank-reconciliation.ts` | - (pure, ไม่พึ่ง DB) | unit test ครบ 0.13/0.15/0.17: CSV มี BOM/CRLF/quoted comma ผ่าน; แถวรูปแบบผิด (วันที่ผิด/amount ไม่ใช่ตัวเลข) → ปฏิเสธพร้อมเลขบรรทัดที่ผิด; `buildBookLines` คีย์ไม่ชนกันแม้ 2 บรรทัดยอด/entry เหมือนกันเป๊ะ; `suggestMatches` แนะนำเฉพาะคู่ยอดตรง+ห่างกัน≤7วัน เรียงใกล้สุดก่อน ไม่แนะนำคู่ที่จับคู่แล้ว |
| **T51** | `lib/accounting/bank-reconciliation.ts` (ส่วน data layer) — `importBatchFromCsv`(batch+bulk insert), `addManualStatementLine`, `deleteBatch`(hard-delete cascade — ตาม T49), `deleteStatementLine`, `confirmMatch`(เขียน snapshot 0.15), `unmatch`, `listStatementLines`, `listBookLines`(wrap `buildJournalEntries`+`loadCombinedJournalLines`+`buildBookLines`) | `bank-reconciliation.ts` | T49, T50 | unit test: import 100 บรรทัดจาก CSV จริง → นับจำนวนตรง `line_count`; `confirmMatch` เขียน snapshot ครบ 4 ฟิลด์; `unmatch` เคลียร์ snapshot กลับเป็น null ทั้งหมด; ลบ batch → บรรทัดที่ผูกหายไปจริง (cascade) แต่การจับคู่ที่เคย snapshot ไว้ในฝั่งบัญชี (ไม่มี — snapshot อยู่ฝั่ง statement line เท่านั้น) ไม่กระทบข้อมูลบัญชีจริงเลย |
| **T52** | `app/chat-audit/accounting/bank-reconciliation/{page.tsx,BankReconciliationPanel.tsx,actions.ts}` — เลือกลูกค้า→บัญชีเงินฝาก→งวด → อัปโหลด CSV/กรอกมือ + 2 คอลัมน์ (book/statement) + คู่แนะนำกดยืนยัน + สรุปยอด (0.18) | 3 ไฟล์ข้างต้น | T50–T51, มี `listCustomerBankAccounts` เดิม | อัปโหลด CSV ตัวอย่าง → เห็นรายการ statement ครบ; ระบบแนะนำคู่ที่ยอด/วันที่ตรงกันให้เห็นชัด กดยืนยันแล้วรายการหายจากโซน "ยังไม่จับคู่" ทั้งสองฝั่ง; ยกเลิกจับคู่ได้; รายการต้นทางถูกแก้หลังจับคู่ (จำลองในเทสต์) → เห็น badge เตือน (0.16); สรุปยอด book/statement/ผลต่างคำนวณถูกต้อง; ลูกค้า/บัญชีนอกสโคปเข้าไม่ได้ |
| **T53** | เพิ่มลิงก์หน้า `page.tsx` หลัก + เทสต์ `bank-reconciliation.test.ts`/`bank-reconciliation-actions.test.ts` ครบ | หลายไฟล์ | T49–T52 | `npm run test` ผ่านทั้งชุด T |
| **T54** | **[ปิดงานเฟส 6]** regression sweep เต็มระบบข้ามทุกเฟส (1-6) — เปิดทุกหน้าบัญชีที่มีอยู่ ตรวจว่าไม่มีหน้าไหนพังจากคอลัมน์ใหม่ (`recurring_template_id`) หรือฟีเจอร์ใหม่ | ทั้งระบบ | T38–T53 | ทุกหน้า `/chat-audit/accounting/*` เดิม (opening, journal-entry, payments, ar-ap-aging, credit-debit-notes, sales-documents, financial-statements, flowaccount-map ฯลฯ) เปิดได้ปกติไม่ error; รายงาน/งบการเงินยอดไม่เปลี่ยนจากก่อนเฟส 6 (เทียบผลลัพธ์เดียวกันของลูกค้าเดิมก่อน/หลัง) |
| **T55** | รวมทุกฟีเจอร์ + เขียน "เช็คลิสต์ก่อน merge รวม" ให้ครบ (ดูหมวด 6 ท้ายเอกสาร) + อัปเดตหัวไฟล์ roadmap (บรรทัด 35/37 ของภาพรวม) | `docs/06-accounting-features-roadmap.md` | T54 | เช็คลิสต์หมวด 6 ทุกข้อผ่าน/มีหมายเหตุชัดเจนถ้าข้อไหนยังไม่ผ่าน |
| **T56** | รันชุดตรวจสอบเต็ม + ทดสอบมือรอบสุดท้ายก่อน deploy | ทั้งหมด | T38–T55 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่; smoke test มือครบ 6 เฟส (checklist 4.2) |

**Milestone**:
- **เฟส 6-R (recurring JE)**: T38–T43 — ปล่อยใช้งานได้เดี่ยว ๆ ก่อน S/T เสร็จก็ได้ (ไม่พึ่งกัน)
- **เฟส 6-S (budget)**: T44–T48 — ปล่อยใช้งานได้เดี่ยว ๆ เช่นกัน
- **เฟส 6-T (bank reconciliation)**: T49–T53 — พึ่ง `customer_bank_accounts`/`JournalLine` เดิมเท่านั้น ไม่พึ่ง R/S
- **เฟส 6-U (ปิดเฟส/merge)**: T54–T56 — ทำหลังสุดเสมอ (สรุปรวมก่อน merge เข้า `main`)

---

## 3) Definition of Done (เฟส 6 รวม)

- [ ] นักบัญชี/หัวหน้าทีมตั้งเทมเพลตรายการซ้ำได้เอง (ค่าเช่า/ค่าบริการรายเดือน) เลือกความถี่ monthly/quarterly/yearly
- [ ] cron รายวันสร้าง occurrence ใหม่เป็น **draft เสมอ** เมื่อถึงกำหนด — ไม่มีทาง auto-confirm เข้าบัญชีจริงโดยไม่มีคนกดยืนยัน
- [ ] ปุ่ม "สร้างตอนนี้" ใช้งานได้ ไม่สร้างซ้ำเมื่อกดพร้อมกับ cron (claim atomic)
- [ ] เทมเพลตที่ตั้งวันที่ 29-31 ไม่เลื่อนวันสร้างเบี้ยวหลังผ่านเดือนกุมภาพันธ์/เดือนสั้น (clamp ถูกต้อง)
- [ ] เทมเพลตที่ generate ไม่สำเร็จ (บัญชีถูกลบ) มี log ให้เห็นชัดเจน ไม่เงียบหาย ไม่ทำให้เทมเพลตอื่นพังตาม
- [ ] นักบัญชีตั้งงบต่อรหัสบัญชี/เดือน/ปีของลูกค้าตัวเองได้เอง ไม่ต้องกรอกครบทุกบัญชี/ทุกเดือน
- [ ] ตารางเทียบงบ vs จริง คำนวณจาก pipeline งบทดลองเดิมเป๊ะ (ตัวเลขตรงกับหน้า financial-statements/reports เดิมของงวดเดียวกัน)
- [ ] export Excel ตารางเทียบงบใช้งานได้จริง
- [ ] นักบัญชีนำเข้า statement ธนาคาร (CSV template) หรือกรอกมือได้ ต่อบัญชีเงินฝาก 1 บัญชีต่อครั้ง
- [ ] ระบบแนะนำคู่จับคู่ที่ยอด/วันที่ตรงกัน ต้องกดยืนยันเองเสมอ ไม่ auto-confirm เงียบ
- [ ] สรุปยอด book balance/statement balance/ผลต่างที่ยังไม่จับคู่ ถูกต้องตรงกับข้อมูลจริง
- [ ] ไม่มี auto-post manual JE จากผลต่างที่พบในเฟสนี้ (ต้องสร้างเองผ่านหน้า journal-entry เดิมเท่านั้น)
- [ ] รายการต้นทางที่ถูกแก้/ลบหลังจับคู่แล้ว แสดงคำเตือนให้ตรวจสอบใหม่ (ไม่ auto-repair เงียบ)
- [ ] ทุก write path ใหม่ทั้ง 3 ฟีเจอร์ผ่าน `requireAccountingAccess` + `assertCustomerInScope`
- [ ] ไม่มี `console.log`/log ใดที่มีตัวเลข/ชื่อบัญชี/ชื่อลูกค้า/รายละเอียด statement (PDPA)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production
- [ ] เทสต์เดิมของเฟส 1-5 ทั้งหมดยังผ่านหลังเพิ่มคอลัมน์/ตารางใหม่ (ไม่มี regression ข้ามเฟส)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่
- [ ] เช็คลิสต์ก่อน merge รวม (หมวด 6 ด้านล่าง) ผ่านครบทุกข้อ

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

### 4.1 Unit test

**`recurring-journal.ts` (T39–T40) — จุดสำคัญที่สุดของ R:**
- `add_months_clamped`/`nextRunDateAfter` ต้องตรงกันทุก edge case: 31 ม.ค.+1เดือน, 29 ก.พ.(อธิกสุรทิน)+1ปี,
  30 พ.ย.+3เดือน (quarterly ข้ามปี), 31 ธ.ค.+1เดือน (ข้ามปี)
- `generateDueOccurrences`: เทมเพลตถึงกำหนดหลายใบพร้อมกัน (บางใบล้มเหลว) → ใบที่เหลือยัง generate สำเร็จ
  (ไม่ throw ทั้ง batch); เทมเพลตที่ `end_date` ผ่านไปแล้ว → ไม่ claim อีก; เทมเพลต `is_active=false` → ไม่ claim

**`budget.ts` (T45):**
- `buildBudgetComparison`: หมวด 4/5/อื่น ๆ ทิศทางถูกต้องครบ (0.11); งบ=0 ไม่ throw หารศูนย์; ตัวเลขตรงกับ
  `TrialBalanceRow` ของ pipeline เดิม 100% (regression-style test — สร้างข้อมูลชุดเดียวกัน เทียบ 2 ทาง)

**`bank-reconciliation.ts` (T50–T51) — จุดสำคัญที่สุดของ T:**
- `parseBankStatementCsv`: ไฟล์ปกติ/มี BOM/CRLF/quoted comma ในคำอธิบาย/แถวว่าง (ข้าม)/แถวผิดรูปแบบ (ปฏิเสธ
  พร้อมเลขบรรทัด)
- `buildBookLines`+`bookLineKeyOf`: คีย์ไม่ชนกันเมื่อมีบรรทัดค่าเท่ากันซ้ำใน entry เดียว หรือคนละ entry
- `suggestMatches`: ยอดตรง+วันที่ห่างกัน 0/3/7/8 วัน (8 วันต้องไม่ถูกแนะนำ — ทดสอบขอบเขตพอดี); ไม่แนะนำคู่ที่
  ฝั่งใดฝั่งหนึ่งจับคู่ไปแล้ว
- `buildReconciliationSummary`: book balance/statement balance/unmatched diff คำนวณถูกจากชุดข้อมูลผสม
  (บางคู่จับคู่แล้ว บางคู่ยังไม่)

**Actions (`recurring-journal-actions.test.ts`/`budget-actions.test.ts`/`bank-reconciliation-actions.test.ts`):**
- guard สโคป: นักบัญชีนอกสโคปทำรายการของลูกค้าอื่นไม่ได้ ทั้ง 3 ฟีเจอร์ (mirror เทสต์เดิมของ manual JE/opening)
- error สุภาพ ไม่หลุด internal, `revalidatePath` ถูกเรียกหลังเขียนสำเร็จ

### 4.2 Integration/manual (ก่อน deploy จริง — ทำเป็นลำดับสุดท้ายของทั้งเฟส)

1. สร้างเทมเพลตค่าเช่ารายเดือน (วันที่ 31) ของลูกค้าจริง 1 ราย → รัน cron มือ (`curl` endpoint ด้วย
   `CRON_SECRET`) → เห็น draft ใหม่ในหน้า journal-entry พร้อม badge เชื่อมเทมเพลต → กดยืนยัน → เห็นในบัญชี
   แยกประเภท/งบการเงินตามปกติ
2. รัน cron ซ้ำวันเดียวกันอีกครั้ง (จำลอง retry) → ต้อง **ไม่** สร้าง occurrence ซ้ำสอง
3. ตั้งงบรายเดือนของบัญชีค่าใช้จ่ายจริง 1 บัญชี ทั้ง 12 เดือน → เปิดตารางเทียบ เดือนที่มีบิลจริง → เทียบเลขด้วย
   มือกับหน้า financial-statements ของเดือนเดียวกัน → ต้องตรงกัน → export Excel → เปิดไฟล์ตรวจคอลัมน์ครบ
4. เตรียมไฟล์ CSV ตัวอย่าง statement ธนาคาร (จากบัญชีเงินฝากลูกค้าจริง 1 บัญชี, 1 เดือน) → นำเข้า → ระบบแนะนำ
   คู่จับคู่ → ยืนยันทีละคู่จนครบที่จับคู่ได้ → ตรวจสรุปยอด book/statement/ผลต่างให้ตรงกับที่คำนวณด้วยมือ
5. แก้ manual JE ที่เคยจับคู่ไปแล้ว (เปลี่ยนยอด) → กลับมาหน้ากระทบยอด → ต้องเห็น badge เตือน "ตรวจสอบใหม่"
6. ลบ batch นำเข้าที่ผิด (นำเข้าไฟล์ผิดไฟล์) → บรรทัด statement ของ batch นั้นหายทั้งหมด → นำเข้าไฟล์ที่ถูกใหม่
7. staff นักบัญชีที่ไม่ได้ดูแลลูกค้า A → เปิดหน้าใหม่ทั้ง 3 ของลูกค้า A ไม่ได้/แก้ไม่ได้
8. regression: เปิดทุกหน้าบัญชีเดิม (เฟส 1-5) ของลูกค้าที่มีข้อมูลครบ → ยอด/รายงานต้องเหมือนก่อนเฟส 6 ทุกตัวเลข

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| **date arithmetic ของ Postgres overflow วันสิ้นเดือน** (0.5) ถ้าพลาดจุดนี้ เทมเพลตวันที่ 29-31 จะเบี้ยวไปเรื่อย ๆ แบบเงียบ ๆ นานหลายเดือนกว่าจะสังเกตเห็น | เขียน `add_months_clamped()` แยกเป็นฟังก์ชัน SQL เดี่ยว ทดสอบตรงในเทสต์ T38 ด้วยชุด edge case ครบก่อนต่อยอด RPC; unit test TS (`nextRunDateAfter`) เทียบผลลัพธ์กับ SQL ต้องตรงกันเป๊ะทุกเคส |
| **cron/ปุ่มมือชนกันสร้าง occurrence ซ้ำสอง** | atomic RPC (`for update skip locked` + advance ในทีเดียว) เหมือน pattern invitation/doc-number เดิม; มีเทสต์ยิงพร้อมกัน 2 เส้นทางยืนยันว่า claim สำเร็จแค่ครั้งเดียว |
| **เทมเพลตอ้าง account_code ที่ถูกลบ/ปิดใช้งานทีหลัง ทำให้ cron ทั้ง batch ล้มเหลวไปด้วย** | `generateDueOccurrences` ครอบ try/catch ต่อเทมเพลต (ไม่ throw ข้ามไปกระทบเทมเพลตอื่น) + log `failed` ชัดเจนให้นักบัญชีไปแก้เอง (0.8) |
| **budget เทียบยอดผิดทิศทาง (debit/credit) ทำให้ตัวเลขดูเหมือนถูกแต่ตีความผิด** | ล็อกทิศทางตามหมวดบัญชีไว้ตายตัว (0.11) ไม่ให้ผู้ใช้เลือกเอง + unit test เทียบกับ `TrialBalanceRow` ของ pipeline เดิมโดยตรง (ไม่มีสูตรคู่ขนานที่อาจพลาดจุดใดจุดหนึ่ง) |
| **รูปแบบ CSV statement ธนาคารจริงต่างจาก template ที่กำหนด** (แต่ละธนาคาร export ไม่เหมือนกัน) | เอกสาร/UI มีปุ่มดาวน์โหลด template ตัวอย่าง + ข้อความแนะนำแปลงไฟล์ก่อนอัปโหลดชัดเจน; parser ปฏิเสธพร้อมระบุเลขบรรทัด/ปัญหาที่ชัดเจน (ไม่เดา/ไม่ silent-skip แถวผิด); ถ้าต้องการ parse ฟอร์แมตธนาคารเฉพาะเจาะจงในอนาคต เป็นงานแยกที่ต้องยืนยันสเปกไฟล์จริงก่อน (0.13 FLAG) |
| **`bookLineKey` ใช้คีย์ผสมจากข้อมูลที่คำนวณสด — รายการต้นทางถูกแก้/ลบหลังจับคู่แล้วทำให้ match ไม่ตรงเงียบ ๆ** | เก็บ snapshot (amount/date/entryId) ตอนจับคู่ (0.15) + เทียบ snapshot ทุกครั้งที่ re-compute แล้วเตือนถ้าไม่ตรง (0.16) — ไม่ auto-repair แต่ก็ไม่ปล่อยให้ผิดเงียบ ๆ เช่นกัน |
| **บัญชีเงินฝากถูกลบ (`customer_bank_accounts`) หลังมี batch/statement lines ผูกอยู่** | `bank_account_id on delete cascade` — ยอมรับพฤติกรรมนี้ (ลบบัญชีธนาคาร = ข้อมูลกระทบยอดของบัญชีนั้นไม่มีความหมายอีกต่อไป) เตือนในหน้าลบบัญชีธนาคารเดิมถ้ามี batch ผูกอยู่ (nice-to-have ไม่ใช่ DoD บังคับ) |
| **เทสต์เดิม 1-5 พังจากคอลัมน์ใหม่ (`recurring_template_id`) หรือ index ใหม่ที่ชนกับของเดิม** | คอลัมน์ใหม่ nullable + ไม่มี default ที่เปลี่ยนพฤติกรรม query เดิม; รัน `npm run test` เต็มชุดก่อน/หลังทุก migration ใหม่ (T38/T44/T49 แต่ละตัวมีเกณฑ์ "เทสต์เดิมทั้งหมดผ่าน" อยู่แล้วใน DoD ของ task นั้น) |
| **ขอบเขตงานเฟสสุดท้ายกว้าง (3 ฟีเจอร์ใหม่พร้อมกัน) เสี่ยง merge conflict/เวลาไม่พอก่อน deploy** | R/S/T ไม่พึ่งกันเลย (milestone แยกอิสระ) — ถ้าเวลาจำกัด ปล่อย R+S ก่อน (เสี่ยงต่ำ ทดสอบง่ายกว่า) แล้วต่อ T ทีหลังได้โดยไม่กระทบของที่ปล่อยไปแล้ว |

---

## 6) เช็คลิสต์ก่อน merge รวม (ทุกเฟส 1-6 → `main` → deploy ทีเดียว)

> เฟสนี้เป็นเฟสสุดท้ายก่อน merge รวม deploy ครั้งเดียวตามที่ผู้ใช้ยืนยันไว้แต่แรก (หัวไฟล์ บรรทัด 7-11) —
> เช็คลิสต์นี้ครอบทุกจุดที่ต้องตรวจสอบก่อนกด merge จริง ไม่ใช่แค่เฟส 6

### 6.1 Migration ทั้งหมดต้อง apply ครบตามลำดับ ไม่มีเลขซ้ำ/ขาดหาย
- [ ] `ls supabase/migrations/` เรียงต่อเนื่อง 0001–0075 ไม่มีเลขซ้ำ/กระโดดข้าม
- [ ] apply ทุก migration ตามลำดับบน environment ทดสอบ (staging) รอบเดียวจบ ไม่ error สักไฟล์
- [ ] migration ที่มี `[⚠️ FLAG]` เรื่องต้องเช็คก่อน apply จริง (เช่น T29 เฟส 5 — ชื่อ constraint จริง,
      0.3 เฟส 1 — จำนวน tenant จริงก่อน seed ผังบัญชี) ถูกตรวจซ้ำบน production จริงก่อน apply แล้ว
- [ ] `notify pgrst, 'reload schema'` ถูกเรียกครบทุกไฟล์ที่แก้ schema (grep ยืนยัน)

### 6.2 ไม่มี regression ข้ามเฟส
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมดที่ HEAD ของ branch
      ก่อน merge (รันรวมทุกเฟส ไม่ใช่แค่ทดสอบแยกเฟสละครั้ง)
- [ ] เทสต์ของทุกเฟส (1-6) รวมกันแล้วไม่มีไฟล์ไหนถูกลบ/ปิด (skip) โดยไม่มีเหตุผลบันทึกไว้
- [ ] เปิดทุกหน้า `/chat-audit/accounting/*` ที่มีอยู่จริงด้วยบัญชีทดสอบทั้ง 4 บทบาท (admin/executive/
      acc_lead/accountant) อย่างน้อยคนละ 1 หน้าไม่พัง (grep รายชื่อหน้าทั้งหมดจากหมวด 1 ของทุกเฟส)
- [ ] เทียบตัวเลขงบการเงิน/รายงานของลูกค้าทดสอบ 1 ราย (ที่มีข้อมูลครบทุกฟีเจอร์: บิล+manual JE+payment+CN/DN+
      FlowAccount sync) **ก่อน** เฟส 6 กับ **หลัง** เฟส 6 — ต้องเท่ากันทุกตัวเลข (ฟีเจอร์ใหม่ทั้งหมดเป็น
      additive ไม่แก้สูตรคำนวณเดิม)

### 6.3 ความปลอดภัย/สิทธิ์/PDPA ครบทุกจุดที่เพิ่มใหม่
- [ ] ทุก server action ใหม่ (ทั้ง 6 เฟส) ผ่าน `requireAccountingAccess`+`assertCustomerInScope` — grep
      หา action ใหม่ที่ไม่มี guard 2 ตัวนี้ (ต้องว่างเปล่า)
- [ ] ไม่มี `console.log`/log ที่มี PII (ตัวเลข/ชื่อ/เลขภาษี/รายละเอียด statement) หลุดในโค้ด production
      ของทั้ง 6 เฟส (grep `console\.` ในทุกไฟล์ `lib/accounting/`+`app/chat-audit/accounting/`)
- [ ] ไม่มี secret/endpoint ฝังตรงในโค้ดนอกเหนือ `lib/env.ts`/credential จาก DB
- [ ] RLS ของทุกตารางใหม่ (0063-0075) เปิดใช้งานจริง + policy `tenant_read` ทดสอบแล้วว่ากันข้าม tenant ได้จริง

### 6.4 เอกสาร roadmap สมบูรณ์
- [ ] ภาพรวม 6 เฟส (หัวไฟล์) อัปเดตสถานะทุกแถวเป็น "แผนละเอียดในไฟล์นี้" ครบ ไม่มีแถวค้าง "ยังไม่วางแผนละเอียด"
- [ ] ทุกจุดที่ติดป้าย `[⚠️ FLAG]` ตลอดทั้งไฟล์ (6 เฟส) ได้รับการ "แจ้งผู้ใช้รับทราบ" แล้วจริงตามกติกาหัวไฟล์
      (บรรทัด 9-11) — ทำสรุปรายการ FLAG ทั้งหมดแนบท้ายตอนสรุปจบงานให้ผู้ใช้เห็นครบทุกจุดในคราวเดียว
- [ ] gap/บั๊กที่พบระหว่างทางแต่ตัดสินใจ "ไม่แก้ในเฟสนั้น" (เช่น 0.6 เฟส 5 — contact ผิดฝั่งของเอกสารขายเดิม)
      ถูกรวบรวมเป็น backlog แยกให้ผู้ใช้เห็นชัดเจนก่อน merge ว่ายังมีอะไรค้างอยู่บ้าง

### 6.5 Deploy readiness
- [ ] environment variables ที่ฟีเจอร์ใหม่ต้องใช้ (`CRON_SECRET` — ใช้ร่วมของเดิม ไม่มีตัวใหม่) ตั้งค่าครบใน
      production แล้วก่อน merge
- [ ] `vercel.json` cron entry ใหม่ (`generate-recurring-je`) ไม่ชนตารางเวลากับ cron อื่นจนโหลด service-role
      DB หนักเกินไปพร้อมกัน (เทียบ schedule ทั้งหมดในไฟล์)
- [ ] มีแผน rollback ระดับ migration (แต่ละไฟล์ทำอะไรชัดเจน ย้อนกลับได้ถ้าจำเป็นโดยรู้ผลกระทบ — โดยเฉพาะ
      migration ที่ ALTER ตารางเดิม เช่น `manual_journal_entries` เพิ่มคอลัมน์ nullable — ปลอดภัยต่อการย้อนกลับ)
- [ ] ทดสอบมือรอบสุดท้าย (4.2 ของเฟสนี้ + สรุปด้วยตนเองว่า integration test ของเฟส 1-5 ที่เคยทำไว้ยังผ่านอยู่)
      เสร็จสมบูรณ์แล้วก่อนกด merge เข้า `main`

---

*(เฟส 6 เป็นเฟสสุดท้ายตามภาพรวมที่วางไว้ — หลังผ่านเช็คลิสต์หมวด 6 ครบ พร้อม merge เข้า `main` และ deploy)*

---
---

# เฟส 7 — แผนละเอียด: ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติ

**สโคป:** ฟีเจอร์เดียวแต่แบ่งเป็น 2 ส่วนย่อย **V → W** (V=โครง+ค่าเสื่อมอัตโนมัติ เสี่ยงน้อยกว่า, W=จำหน่ายทรัพย์สิน
เสี่ยง/ซับซ้อนกว่าเพราะกระทบ cash-flow classification ด้วย):
- **(V) ทะเบียนทรัพย์สิน + คำนวณ/บันทึกค่าเสื่อมราคาแบบเส้นตรงอัตโนมัติทุกเดือน** — ต่อยอด pattern ของ
  `recurring-journal.ts` (เฟส 6 ส่วน R: atomic RPC claim + cron + ปุ่ม "สร้างตอนนี้" + สร้าง manual JE
  เป็น draft เสมอ) แต่ต่างจาก recurring JE ตรงที่ยอดต่อรอบ **ไม่คงที่ตลอดไป** — ต้องคำนวณจากมูลค่าคงเหลือจริง
  และ **หยุดเองอัตโนมัติ** เมื่อค่าเสื่อมสะสมครบมูลค่าที่ต้องตัด (ราคาทุน − มูลค่าซาก)
- **(W) จำหน่ายทรัพย์สิน (Disposal)** — บันทึกการขาย/ตัดจำหน่าย คำนวณมูลค่าตามบัญชี (NBV) ณ วันจำหน่าย และ
  กำไร/ขาดทุนจากการจำหน่าย สร้าง manual JE ปิดบัญชีทรัพย์สิน/ค่าเสื่อมสะสม

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `lib/accounting/manual-journal.ts::ManualEntryInput`/`upsertManualEntry`/`isBalanced` — ทุก occurrence
  ค่าเสื่อม/รายการจำหน่าย เข้าทางนี้ทั้งหมด (**ไม่แก้ไฟล์นี้เลยแม้แต่บรรทัดเดียว** — reuse ตรง ๆ เหมือนเฟส 6)
- `lib/accounting/recurring-journal.ts::addMonthsClamped`/`isValidCalendarDate` (จาก `bank-reconciliation.ts`
  ที่ export ไว้แล้วให้ข้ามไฟล์ reuse ได้) — reuse ตรง ๆ ไม่เขียนสูตร date arithmetic คู่ขนาน
- `supabase/migrations/0073_recurring_journal_entries.sql::add_months_clamped()` (SQL function, ประกาศ
  `public.` แล้ว) — **reuse ฟังก์ชันเดิมตรง ๆ ใน RPC ของเฟสนี้ ไม่สร้างซ้ำ**
- `supabase/migrations/0063_chart_of_accounts_table.sql` — รหัสสินทรัพย์ถาวร/ค่าเสื่อมสะสม/ค่าเสื่อมราคา
  ที่ seed ไว้แล้วให้ทุก tenant (ยืนยันจากไฟล์จริง): `1610`(ที่ดิน — ไม่มีคู่ค่าเสื่อมสะสมเพราะที่ดินไม่เสื่อม),
  `1615`(อาคาร)+`1615.1`(ค่าเสื่อมสะสม-อาคาร), `1640`(อุปกรณ์สำนักงาน)+`1640.1`, `1645`(รถยนต์)+`1645.1`,
  ฝั่งค่าใช้จ่าย: `5370`(ค่าเสื่อมราคา-อาคาร), `5375`(ค่าเสื่อมราคา-อุปกรณ์สำนักงาน), `5380`(ค่าเสื่อมราคา-รถยนต์)
  — ใช้เป็น**ตัวเลือกแนะนำ**ใน UI แต่ไม่ hardcode FK (ตาม pattern เดิมทั้งระบบ ผู้ใช้เลือก/สร้างรหัสอื่นเองได้
  ผ่านหน้าผังบัญชี เฟส 1 ที่มีอยู่แล้ว)
- `lib/accounting/cash-flow-config.ts::INVESTING_CODES` (เฟส 4) — ปัจจุบันมีแค่รหัสสินทรัพย์หลัก
  (`1610`/`1615`/`1640`/`1645`) **ไม่มีรหัสค่าเสื่อมสะสม `.1`** — เฟสนี้ต้อง**แก้ไฟล์นี้เพิ่ม** (ดู 0.10 ⚠️)
- `app/api/cron/generate-recurring-je/route.ts` + `vercel.json` — pattern cron รายวัน (CRON_SECRET
  fail-closed) ที่มีอยู่แล้ว ใช้เป็นต้นแบบสร้าง cron ใหม่ 1 endpoint
- `ls supabase/migrations/` ล่าสุด (ยืนยันแล้ว) = `0075_bank_reconciliation.sql` → migration ใหม่ของ
  เฟสนี้เริ่มที่ `0076`
- Guard patterns: `requireAccountingAccess`+`assertCustomerInScope` — ทุก action ต้อง derive scope จาก
  resource id ที่กำลังเขียนจริงเสมอ (ตาม pattern ที่แก้ IDOR ไปแล้วตั้งแต่เฟส 3 — **ห้ามเกิดซ้ำ**)

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 วิธีคำนวณค่าเสื่อม — เส้นตรง (Straight-line) เท่านั้นในรอบแรก
เป็นวิธีที่ SME ไทยใช้มากที่สุดในทางปฏิบัติ (เหตุผลเดียวกับที่เฟส 6 ตัด `weekly` ออกจาก recurring JE — ลด
สโคปโดยไม่กระทบการใช้งานจริงส่วนใหญ่) สูตร: `ค่าเสื่อมต่อเดือน = (ราคาทุน − มูลค่าซาก) ÷ อายุการใช้งาน (เดือน)`
**[⚠️ FLAG]** ถ้าต้องการวิธีอื่น (ลดลงเป็นจำนวนเท่า/ยอดผลิตจริง) เป็น backlog แยก ไม่ block เฟสนี้

### 0.2 จุดเริ่มคำนวณ — full-month convention เริ่มเดือนที่ซื้อ ไม่ prorate เป็นวัน
ค่าเสื่อมเดือนแรกคิดเต็มเดือนตั้งแต่เดือนของ `acquisition_date` (ไม่คำนวณเป็นสัดส่วนวันในเดือน) — เหตุผล:
ตรงกับ convention ที่ใช้กันทั่วไปในทางปฏิบัติสำหรับบัญชีปิดรายเดือน และสอดคล้องกับหลักความเรียบง่ายที่ระบบ
ทั้งหมดใช้มาตลอด (recurring JE เฟส 6 ก็ไม่ prorate เป็นวันเช่นกัน) **[⚠️ FLAG]** ถ้าลูกค้าต้องการ prorate
ตามวันจริงเดือนแรก/เดือนสุดท้าย เป็น backlog แยก

### 0.3 ⚠️ ห้าม auto-confirm เด็ดขาด — mirror หลักการ 0.3 ของเฟส 6 (recurring JE) ทุกประการ
ค่าเสื่อมที่ generate อัตโนมัติทุกเดือน (และรายการจำหน่ายทรัพย์สิน) ต้องสร้างเป็น **`draft` เสมอ** ผ่าน
`upsertManualEntry` เดิม — เหตุผลเดียวกับ recurring JE: manual JE ที่ confirmed เข้าบัญชีแยกประเภท/งบการเงิน
ทันที ถ้าตั้งค่าทรัพย์สินผิด (เช่น เลือกรหัสบัญชีผิด/อายุการใช้งานผิด) ต้องมีคนตรวจก่อนเข้าบัญชีจริงเสมอ
**ทุก occurrence ต้องผ่านการกดยืนยันของนักบัญชีเหมือน manual JE ปกติทุกใบ ไม่มีทางลัด**

### 0.4 Trigger การสร้างค่าเสื่อม — cron รายวัน + ปุ่ม "สร้างตอนนี้" กันชนด้วย atomic RPC (mirror เฟส 6 ส่วน R)
- Cron ใหม่ (`/api/cron/generate-fixed-asset-depreciation`, รันวันละครั้ง — mirror `generate-recurring-je`
  เป๊ะ) สแกนทุกทรัพย์สินที่ `status='active'` และ `next_dep_date is not null` และ `next_dep_date <= วันนี้`
  ของทุก tenant
- ปุ่ม "สร้างตอนนี้" ต่อทรัพย์สิน 1 ชิ้น เรียก orchestrator เดียวกับ cron
- ป้องกันชนกัน (cron + ปุ่มมือ/retry) ด้วย **atomic RPC** `claim_fixed_asset_depreciation(tenant_id,
  asset_id, today)` (`for update skip locked` — pattern เดียวกับ `claim_recurring_je_occurrence` เฟส 6
  เป๊ะ) — ถ้า claim ไม่ติด คืน `claimed:false` เฉย ๆ ไม่ throw

### 0.5 ⚠️ ยอดต่อรอบไม่คงที่ตลอดไป — งวดสุดท้ายเป็น "plug" กันเศษสตางค์ค้าง (ต่างจาก recurring JE เฟส 6)
`monthly_depreciation = round2((cost − salvage) / usefulLifeMonths)` ถูกปัดเศษทุกเดือน → ถ้าคูณตรง ๆ
ทุกเดือนจนครบจำนวนงวด อาจมีเศษสตางค์เหลือ/ขาดจากการปัดเศษสะสม (ค่าเสื่อมสะสมสุดท้ายไม่เท่ากับ `cost−salvage`
เป๊ะ) — **แก้โดยงวดสุดท้ายใช้ยอด "ส่วนที่เหลือจริง" แทนยอดคงที่**: `amount = min(monthly_depreciation,
remaining)` โดย `remaining = cost − salvage − accumulated_depreciation` ก่อนหน้า — รับประกันว่าค่าเสื่อม
สะสมรวมทั้งหมดเท่ากับ `cost − salvage` เป๊ะเสมอ ไม่มีเศษตกค้าง

### 0.6 ทรัพย์สินที่ตัดค่าเสื่อมครบแล้ว — `next_dep_date=null` แต่ยัง `status='active'` (ยังเป็นเจ้าของอยู่)
เมื่อค่าเสื่อมสะสม = `cost − salvage` (ครบมูลค่าที่ต้องตัด) → RPC ตั้ง `next_dep_date=null` (ไม่มีรอบถัดไป
ให้ claim อีก) แต่ `status` ยังเป็น `'active'` เพราะทรัพย์สินยังเป็นของลูกค้าอยู่ ยังไม่ได้จำหน่าย — แสดงใน
ทะเบียนเป็น "ตัดค่าเสื่อมครบแล้ว" (NBV = มูลค่าซาก) จนกว่าจะถูกจำหน่ายจริงผ่าน (W)

### 0.7 การจำหน่ายทรัพย์สิน (W) — flow แยก, คำนวณ NBV+กำไร/ขาดทุน ณ วันจำหน่าย, ไม่คิดค่าเสื่อมเดือนที่จำหน่าย
- **ไม่คิดค่าเสื่อมของเดือนที่จำหน่าย** (mirror convention เดียวกับ 0.2 — full-month ตอนซื้อ, ไม่มีเดือน
  จำหน่ายเลย เพื่อความเรียบง่ายสมมาตรกัน) — `disposeAsset()` เคลียร์ `next_dep_date=null` ตรง ๆ โดยไม่ generate
  ค่าเสื่อมงวดสุดท้ายเพิ่มก่อน (ใช้ `accumulated_depreciation` ณ ปัจจุบันตรง ๆ เป็นฐานคำนวณ NBV)
- `NBV ณ วันจำหน่าย = cost − accumulated_depreciation` (ค่า ณ ตอนนั้น)
- `กำไร/ขาดทุนจากการจำหน่าย = ราคาที่ได้รับจริง (proceeds) − NBV`
- Journal ที่สร้าง (draft เสมอ ตาม 0.3): `Dr accum_dep_account_code = accumulated_depreciation` (ล้างค่าเสื่อม
  สะสม), `Dr/Cr เงินสด/บัญชีที่ได้รับ = proceeds` (ผู้ใช้เลือกรหัสบัญชีที่รับเงิน — เงินสด/ธนาคาร/ลูกหนี้),
  `Cr asset_account_code = cost` (ตัดสินทรัพย์ออกที่ราคาทุน), และปรับสมดุลด้วยรหัสบัญชี "กำไร/ขาดทุนจากการ
  จำหน่ายทรัพย์สิน" ที่ผู้ใช้เลือกเอง (ไม่ hardcode/ไม่ seed รหัสใหม่ — ให้เลือกจากผังบัญชีเดิมหรือไปสร้างเอง
  ที่หน้าผังบัญชี เฟส 1 ถ้ายังไม่มี, ตาม pattern self-service เดิมทั้งระบบ)
- จำหน่ายแล้ว `status='disposed'` ล็อกแก้ทะเบียนไม่ได้อีก (แก้ผิดต้องยกเลิกรายการจำหน่าย — ดู 0.8)

### 0.8 ยกเลิกการจำหน่าย (undo disposal) — reset กลับเป็น active ได้ถ้า disposal JE ยัง draft/ถูกยกเลิกยืนยันแล้ว
ถ้ากรอกข้อมูลจำหน่ายผิด (proceeds/วันที่ผิด) และ manual JE ที่สร้างยัง `draft` (ยังไม่ confirm) — อนุญาตให้
"ยกเลิกการจำหน่าย" (`undisposeAsset`) กลับเป็น `status='active'` + ลบ/soft-delete manual JE draft นั้น +
คืน `next_dep_date` เป็นเดือนถัดไปจาก `accumulated_depreciation` เดิม — **ถ้า manual JE ถูก confirm ไปแล้ว
ห้าม undo** (ต้องยกเลิกการยืนยัน JE ก่อนตามกฎเดิมของ manual-journal.ts เอง แล้วค่อย undo disposal)

### 0.9 เชื่อม occurrence/disposal JE กลับไปทรัพย์สินต้นทาง — คอลัมน์ใหม่บน `manual_journal_entries` (metadata ล้วน)
`manual_journal_entries.fixed_asset_id` (nullable, FK `on delete set null`) — ใช้แค่แสดง badge "ค่าเสื่อม/
จำหน่ายทรัพย์สิน: ⟨ชื่อทรัพย์สิน⟩" + ลิงก์กลับทะเบียนทรัพย์สินในหน้า UI **ไม่มี mapper ไหน (`toJournalLines`/
`toJournalPosting`) ต้องแก้เลย** (เหมือน `recurring_template_id` ของเฟส 6 — เป็น metadata ล้วน)

### 0.10 ⚠️ ต้องแก้ `cash-flow-config.ts` (เฟส 4) เพิ่มรหัสค่าเสื่อมสะสม `.1` เข้า `INVESTING_CODES`
**[⚠️ FLAG — แตะไฟล์ของเฟสก่อนหน้า]** รายการค่าเสื่อมราคาปกติ (Dr ค่าเสื่อม/Cr ค่าเสื่อมสะสม) ไม่มีขาไหนแตะ
เงินสดเลย จึงไม่ปรากฏในงบกระแสเงินสดโดยธรรมชาติของข้อมูล (ตามที่เฟส 4 ตัดสินใจไว้แล้ว ข้อ 0.7 เดิม — ยังถูกต้อง
สำหรับกรณีนี้ ไม่ต้องแก้) **แต่รายการจำหน่ายทรัพย์สิน (W) มีขาเงินสดจริง** (`proceeds`) พร้อมขาไม่ใช่เงินสดสอง
ขาที่ต้องจัดกิจกรรมเป็น "ลงทุน" ทั้งคู่ให้สอดคล้องกัน: ขาสินทรัพย์ (`asset_account_code`, มีอยู่แล้วใน
`INVESTING_CODES`) และ **ขาค่าเสื่อมสะสม** (`accum_dep_account_code` = รหัส `.1` — **ยังไม่อยู่ใน
`INVESTING_CODES` ปัจจุบัน** จะตกไปเป็น `operating` โดย fallback ผิดประเภท) — ต้องเพิ่ม `1615.1`/`1640.1`/
`1645.1` เข้า `INVESTING_CODES` ในเฟสนี้ เพื่อให้เงินสดจากการจำหน่ายทรัพย์สินแสดงเป็น "กิจกรรมลงทุน" ครบทั้งขา
สอดคล้องกับการนำเสนองบกระแสเงินสดมาตรฐาน (ไม่แตะ `FINANCING_CODES`/`classifyCashFlowActivity()` เลย เพิ่ม
แค่ 3 รหัสในลิสต์เดิม) — ส่วนขา "กำไร/ขาดทุนจากการจำหน่าย" (0.7) ปล่อยตาม fallback เดิม (`operating`, เพราะ
เป็นรหัสหมวด 4/5 ตามปกติ — ยอมรับได้ในทางปฏิบัติ ไม่ block เฟสนี้)

### 0.11 รหัสบัญชี — ไม่ hardcode FK เหมือนเดิมทั้งระบบ, ใช้ seed เดิมเป็นตัวเลือกแนะนำเท่านั้น
`asset_account_code`/`accum_dep_account_code`/`dep_expense_account_code` เลือกผ่าน `AccountCombobox` เดิม
(เฟส 1) จากผังบัญชีจริงของ tenant — validate แค่ **หมวดถูกต้อง** (`asset_account_code`/`accum_dep_account_code`
ต้องเป็นหมวด "สินทรัพย์", `dep_expense_account_code` ต้องเป็นหมวด "ค่าใช้จ่าย") ไม่ validate ความสัมพันธ์
parent-child ของรหัส (เช่นบังคับว่า `1640` ต้องคู่กับ `1640.1` เท่านั้น) — ปล่อยให้นักบัญชีเลือกเองอย่างอิสระ
เหมือนที่ระบบอื่นทั้งหมดทำ

### 0.12 การแก้ไข/ลบทะเบียนทรัพย์สิน — แก้ได้เฉพาะก่อนมีประวัติค่าเสื่อม (`accumulated_depreciation=0`)
mirror หลักการ "แก้ได้เฉพาะตอน draft" ของ manual JE — ทรัพย์สินที่ยังไม่เคย generate ค่าเสื่อมเลย
(`accumulated_depreciation=0` และ `status='active'`) แก้ไข/ลบ (soft-delete) ได้อิสระ — ถ้ามีประวัติค่าเสื่อม
แล้วแม้แต่งวดเดียว ห้ามแก้ตัวเลขราคาทุน/มูลค่าซาก/อายุการใช้งานย้อนหลัง (จะทำให้ยอดที่ generate ไปแล้วขัดแย้ง
กับสูตรใหม่) — ถ้าตั้งค่าผิดจริงต้องยกเลิกยืนยัน JE ค่าเสื่อมทุกใบที่เกี่ยวข้องก่อน (ตามกฎ manual JE เดิม)
แล้วค่อย soft-delete ทะเบียนทั้งชิ้นทิ้งแล้วสร้างใหม่ **[⚠️ FLAG]** ไม่ทำฟีเจอร์ "แก้ไขทะเบียนแบบมีผลย้อนหลัง
อัตโนมัติ" ในเฟสนี้ (ซับซ้อนเกินจำเป็น เสี่ยงคำนวณผิดเงียบ ๆ)

### 0.13 สิทธิ์ — reuse `requireAccountingAccess`+`assertCustomerInScope` เดิมทั้งหมด ไม่มี admin-only ใหม่
นักบัญชี/หัวหน้าทีมที่ดูแลลูกค้ารายนั้นทำได้เอง (สร้าง/แก้/ลบทะเบียน, สร้างค่าเสื่อมตอนนี้, จำหน่ายทรัพย์สิน)
เหมือนหน้า manual JE/recurring JE เดิมทุกประการ — ทุก action ที่รับ resource id ตรง ๆ (เช่น
`deleteAssetAction`/`disposeAssetAction`) ต้อง derive scope จาก resource นั้นเองก่อนเขียนเสมอ (ตาม pattern
ที่แก้ IDOR ไปแล้วตั้งแต่เฟส 3 — grep ยืนยันก่อนปิดงานว่าไม่มี action ไหนรับ `customerId` เป็นพารามิเตอร์แยก
ที่ไม่ผูกกับ id ของทรัพย์สินที่กำลังเขียนจริง)

### 0.14 ยืนยันเลข migration จริงจาก `ls supabase/migrations/` (ไฟล์ล่าสุด = `0075_bank_reconciliation.sql`)
เฟสนี้ใช้ `0076` เท่านั้น (1 ไฟล์ — ไม่ต้องแก้ schema เดิมนอกจาก ALTER `manual_journal_entries` เพิ่ม 1
คอลัมน์) — ให้เช็คซ้ำอีกครั้งก่อน apply จริงเผื่อมีการแก้ไขคาบเกี่ยวระหว่างทาง

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 7

```
supabase/migrations/
  0076_fixed_assets.sql   [ใหม่] fixed_assets + fixed_asset_depreciation_log + RPC
                                    claim_fixed_asset_depreciation() (reuse add_months_clamped จาก 0073
                                    ตรงๆ ไม่สร้างซ้ำ) + ALTER manual_journal_entries เพิ่ม fixed_asset_id + RLS

lib/
  accounting/
    fixed-assets.ts        [ใหม่] ชนิด FixedAsset/FixedAssetInput/DepreciationLogEntry, validate
                                    (reuse isValidCalendarDate จาก bank-reconciliation.ts, isBalanced
                                    concept ไม่ต้องใช้เพราะไม่ใช่ input แบบ manual JE ตรงๆ),
                                    monthlyDepreciationAmount()/netBookValue() (pure), CRUD data layer
                                    (listAssets/upsertAsset/softDeleteAsset — เฉพาะก่อนมีประวัติ 0.12),
                                    generateOne()/generateDueDepreciation() (orchestrator, mirror
                                    generateOne ของ recurring-journal.ts เป๊ะ รวมการแยก claimErr จริง vs
                                    ยังไม่ถึงรอบ — ★ ต้องทำถูกตั้งแต่ต้น ไม่ทำผิดซ้ำแบบที่เฟส 6 เคยพลาดแล้วแก้),
                                    disposeAsset()/undisposeAsset() (0.7/0.8)
    cash-flow-config.ts     [แก้] INVESTING_CODES เพิ่ม '1615.1','1640.1','1645.1' (0.10 — จุดเดียวที่แก้
                                    ไฟล์เฟส 4 เดิม ไม่แก้ classifyCashFlowActivity()/FINANCING_CODES เลย)

app/
  api/cron/generate-fixed-asset-depreciation/route.ts  [ใหม่] cron รายวัน (mirror
                                    generate-recurring-je — CRON_SECRET fail-closed) เรียก
                                    generateDueDepreciation ทุก tenant

  chat-audit/accounting/
    fixed-assets/
      page.tsx               [ใหม่] เลือกลูกค้า (mirror recurring-journal/page.tsx) → list ทะเบียน
                                    ทรัพย์สิน (active/disposed แยกกลุ่ม) + NBV ปัจจุบันต่อชิ้น
      FixedAssetsPanel.tsx   [ใหม่] client component: ฟอร์มสร้าง/แก้ทะเบียน (AccountCombobox × 3, ล็อกแก้
                                    เมื่อมีประวัติค่าเสื่อมแล้ว 0.12), ปุ่ม "สร้างค่าเสื่อมตอนนี้" ต่อชิ้น,
                                    ปุ่ม/dialog "จำหน่ายทรัพย์สิน" (proceeds+รหัสบัญชีรับเงิน+รหัสบัญชี
                                    กำไร/ขาดทุน), ปุ่ม "ยกเลิกการจำหน่าย" (0.8), ประวัติค่าเสื่อมต่อชิ้น
                                    ลิงก์กลับ journal-entry
      actions.ts               [ใหม่] server actions guard requireAccountingAccess+assertCustomerInScope
                                    (upsertAssetAction/deleteAssetAction/generateNowAction/
                                    disposeAssetAction/undisposeAssetAction) — ทุกตัว derive scope จาก
                                    asset id ที่กำลังเขียนจริง (0.13)
      export/route.ts          [ใหม่] export Excel รายงานทะเบียนทรัพย์สิน (reuse exceljs pattern จาก
                                    budget/export/route.ts)

  chat-audit/accounting/page.tsx, CustomerTabs.tsx  [แก้] เพิ่มลิงก์ "ทะเบียนทรัพย์สิน" (จุดเดียวกับ
                                    opening/reports/flowaccount-map/budget/recurring-journal เดิม)

vercel.json                       [แก้] เพิ่ม cron entry "/api/cron/generate-fixed-asset-depreciation"
                                    (schedule รายวัน เช่น "0 3 * * *" — เยื้องเวลาจาก recurring-je เดิม
                                    กันโหลด service-role DB ชนกันพร้อมกัน)

tests/
  accounting/fixed-assets.test.ts          [ใหม่] validate ทุก branch (หมวดบัญชีผิด/cost≤0/salvage≥cost/
                                    useful_life≤0/วันที่ผิดปฏิทิน), monthlyDepreciationAmount/
                                    netBookValue, งวดสุดท้ายเป็น plug (ทดสอบผลรวมค่าเสื่อมสะสม = cost−salvage
                                    เป๊ะ ไม่มีเศษตกค้าง), generateOne/generateDueDepreciation (claimErr จริง
                                    vs ยังไม่ถึงรอบ แยกกันถูกต้อง — regression guard เทียบกับที่เฟส 6 แก้แล้ว),
                                    disposeAsset/undisposeAsset (NBV/กำไร-ขาดทุนถูกต้องทุกทิศทาง)
  accounting/fixed-assets-actions.test.ts  [ใหม่] guard สโคปครบทุก action (นอกสโคปทำไม่ได้), ป้องกันแก้/ลบ
                                    ทะเบียนที่มีประวัติค่าเสื่อมแล้ว, undisposeAsset ปฏิเสธถ้า JE confirmed แล้ว
  accounting/cash-flow-config.test.ts      [แก้] เพิ่มเทสต์ classifyCashFlowActivity('1615.1'/'1640.1'/
                                    '1645.1') → 'investing' (regression guard เทียบ INVESTING_CODES เดิม
                                    ไม่เปลี่ยนพฤติกรรมของรหัสอื่น)
  accounting/cash-flow.test.ts             [แก้] เพิ่มเทสต์ end-to-end: รายการจำหน่ายทรัพย์สิน (เงินสด+
                                    ค่าเสื่อมสะสม+สินทรัพย์+กำไร/ขาดทุน) → ขาสินทรัพย์และค่าเสื่อมสะสมจัดเป็น
                                    'investing' ทั้งคู่ ผลรวม investing ตรงกับ proceeds เป๊ะ (ปรับตาม
                                    allocation 0.8 ของเฟส 4)
```

### 1.1 Schema ใหม่ (migration 0076) — ร่าง SQL

```sql
-- เฟส 7 (docs/06, หมวด 0.1–0.13) — ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติ

create table if not exists public.fixed_assets (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  customer_id              uuid not null references public.customers(id) on delete cascade,
  name                     text not null,
  asset_account_code       text not null,
  accum_dep_account_code   text not null,
  dep_expense_account_code text not null,
  acquisition_date         date not null,
  cost                     numeric(14,2) not null check (cost > 0),
  salvage_value            numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months       int not null check (useful_life_months > 0),
  monthly_depreciation     numeric(14,2) not null,  -- คำนวณ+เก็บตอนสร้าง (0.1) — งวดสุดท้ายเป็น plug (0.5)
  accumulated_depreciation numeric(14,2) not null default 0,
  -- null = ไม่มีรอบถัดไปให้สร้าง (ตัดค่าเสื่อมครบแล้ว 0.6 หรือจำหน่ายแล้ว) — advance โดย RPC claim เท่านั้น
  next_dep_date            date,
  status                   text not null default 'active' check (status in ('active','disposed')),
  disposal_date            date,
  disposal_proceeds        numeric(14,2),
  disposal_entry_id        uuid references public.manual_journal_entries(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  constraint fixed_assets_salvage_lt_cost check (salvage_value < cost)
);
create index if not exists idx_fixed_assets_tenant_customer
  on public.fixed_assets (tenant_id, customer_id) where deleted_at is null;
create index if not exists idx_fixed_assets_due
  on public.fixed_assets (tenant_id, next_dep_date)
  where deleted_at is null and status = 'active' and next_dep_date is not null;

create table if not exists public.fixed_asset_depreciation_log (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  asset_id         uuid not null references public.fixed_assets(id) on delete cascade,
  period           date not null,  -- เดือนที่คิดค่าเสื่อม (วันที่ 1 ของเดือนนั้น)
  amount           numeric(14,2),
  status           text not null check (status in ('generated','failed')),
  message          text,
  manual_entry_id  uuid references public.manual_journal_entries(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_fixed_asset_dep_log_asset
  on public.fixed_asset_depreciation_log (tenant_id, asset_id, period);

-- ★ link occurrence/disposal → ทรัพย์สินต้นทาง (metadata ล้วน — ไม่กระทบ mapper ใด ๆ, ดู 0.9)
alter table public.manual_journal_entries
  add column if not exists fixed_asset_id uuid
    references public.fixed_assets(id) on delete set null;

drop trigger if exists trg_fixed_assets_updated on public.fixed_assets;
create trigger trg_fixed_assets_updated before update on public.fixed_assets
  for each row execute function public.set_updated_at();

-- ★ 0.4/0.5: claim แบบ atomic (for update skip locked) — กัน cron/ปุ่มมือชนกันสร้างซ้ำ
--   reuse public.add_months_clamped() ที่มีอยู่แล้วจาก migration 0073 ตรง ๆ ไม่สร้างฟังก์ชันซ้ำ
create or replace function public.claim_fixed_asset_depreciation(
  p_tenant_id  uuid,
  p_asset_id   uuid,
  p_today      date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.fixed_assets%rowtype;
  v_remaining numeric(14,2);
  v_amount numeric(14,2);
  v_new_accum numeric(14,2);
  v_new_next date;
begin
  select * into v_row
  from public.fixed_assets
  where id = p_asset_id and tenant_id = p_tenant_id
    and deleted_at is null and status = 'active'
    and next_dep_date is not null and next_dep_date <= p_today
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  v_remaining := round((v_row.cost - v_row.salvage_value - v_row.accumulated_depreciation)::numeric, 2);
  if v_remaining <= 0 then
    -- กันเคสผิดปกติ (ไม่ควรเกิดถ้า invariant ถูกรักษาไว้เสมอ) — เคลียร์รอบถัดไปแทนสร้างยอด 0
    update public.fixed_assets set next_dep_date = null where id = p_asset_id and tenant_id = p_tenant_id;
    return jsonb_build_object('claimed', false);
  end if;

  v_amount := least(v_row.monthly_depreciation, v_remaining);  -- ★ 0.5 งวดสุดท้ายเป็น plug
  v_new_accum := round((v_row.accumulated_depreciation + v_amount)::numeric, 2);

  if round((v_row.cost - v_row.salvage_value - v_new_accum)::numeric, 2) <= 0 then
    v_new_next := null;  -- ★ 0.6 ตัดค่าเสื่อมครบแล้ว — ไม่มีรอบถัดไป
  else
    v_new_next := public.add_months_clamped(v_row.next_dep_date, 1);
  end if;

  update public.fixed_assets
     set accumulated_depreciation = v_new_accum, next_dep_date = v_new_next
   where id = p_asset_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'claimed', true,
    'period', v_row.next_dep_date,
    'amount', v_amount,
    'customer_id', v_row.customer_id,
    'name', v_row.name,
    'dep_expense_account_code', v_row.dep_expense_account_code,
    'accum_dep_account_code', v_row.accum_dep_account_code
  );
end;
$$;

revoke all on function public.claim_fixed_asset_depreciation(uuid, uuid, date) from public;
grant execute on function public.claim_fixed_asset_depreciation(uuid, uuid, date) to service_role;

comment on function public.claim_fixed_asset_depreciation(uuid, uuid, date) is
  'สร้างรายการค่าเสื่อมราคาอัตโนมัติแบบ atomic — increment accumulated_depreciation + advance next_dep_date
   ในทีเดียว (เฟส 7, 0.4/0.5) — mirror claim_recurring_je_occurrence ของเฟส 6';

alter table public.fixed_assets                  enable row level security;
alter table public.fixed_asset_depreciation_log   enable row level security;
create policy tenant_read on public.fixed_assets for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.fixed_asset_depreciation_log for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.fixed_assets                from anon;
revoke all on public.fixed_asset_depreciation_log from anon;
grant select on public.fixed_assets                to authenticated;
grant select on public.fixed_asset_depreciation_log to authenticated;
grant all    on public.fixed_assets                to service_role;
grant all    on public.fixed_asset_depreciation_log to service_role;

notify pgrst, 'reload schema';
```

---

## 2) งานย่อยเรียงลำดับ (เฟส 7)

เลขงาน: ต่อจากเฟส 6 (T38–T56) → เริ่มที่ **T57**

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T57** | Migration 0076 — `fixed_assets`+`fixed_asset_depreciation_log` + RPC `claim_fixed_asset_depreciation()` (reuse `add_months_clamped` เดิม) + `fixed_asset_id` บน `manual_journal_entries` + RLS | `supabase/migrations/0076_fixed_assets.sql` | - | ⚠️ ก่อนสร้างไฟล์ ให้ `ls supabase/migrations/` เช็คว่า 0075 ยังล่าสุดจริง; apply ไม่ error; ทดสอบ SQL ตรง: สร้างทรัพย์สินทดสอบ cost=10000,salvage=1000,useful_life=9 → เรียก RPC 9 ครั้ง (จำลอง 9 เดือน) → เดือนที่ 1-8 ได้ `amount=1000` เป๊ะ, เดือนที่ 9 (สุดท้าย) ได้ plug =1000 พอดี (ไม่มีเศษ) และ `next_dep_date=null` หลังเดือนที่ 9; เรียกซ้อน 2 session พร้อมกันกับ asset เดียวกัน → มีแค่ session เดียว claim สำเร็จ; เทสต์เดิมทั้งหมดผ่าน |
| **T58** | `lib/accounting/fixed-assets.ts` — types, `validateFixedAssetInput` (reuse `isValidCalendarDate` จาก `bank-reconciliation.ts`, ตรวจหมวดบัญชีตาม 0.11), `monthlyDepreciationAmount()`/`netBookValue()` (pure), CRUD data layer (`listAssets`/`upsertAsset`/`softDeleteAsset` — ล็อกแก้/ลบเมื่อมีประวัติค่าเสื่อมแล้ว 0.12) | `fixed-assets.ts` | T57 | unit test: validate ปฏิเสธ `asset_account_code`/`accum_dep_account_code` ที่ไม่ใช่หมวดสินทรัพย์, `dep_expense_account_code` ที่ไม่ใช่หมวดค่าใช้จ่าย, `salvage_value >= cost`, `useful_life_months <= 0`, วันที่ซื้อผิดปฏิทิน (เช่น "2026-02-30"); `monthlyDepreciationAmount(10000,1000,9)` = 1000 พอดี; `upsertAsset` แก้ไม่ได้เมื่อ `accumulated_depreciation>0` (คืน error ชัดเจน) แต่ลบ/แก้ได้ปกติเมื่อยังไม่มีประวัติ |
| **T59** | เพิ่มใน `fixed-assets.ts`: `generateOne(db,tenantId,assetId,today)` เรียก RPC claim → ถ้า `claimErr` จริง (ไม่ใช่แค่ `!claimed`) → log `status:'failed'`+message คืน `{status:'failed',...}` (**ต้องแยก 2 กรณีถูกตั้งแต่ต้น — ดูบั๊กที่เฟส 6 เคยพลาดแล้วแก้ทีหลัง อย่าพลาดซ้ำ**) → ถ้า claim สำเร็จ สร้าง `ManualEntryInput` (docType='JV', lines: Dr `dep_expense_account_code`/Cr `accum_dep_account_code` = amount) → `upsertManualEntry` (draft เสมอ ตาม 0.3) → ผูก `fixed_asset_id` บน entry ที่สร้าง → log `status:'generated'`; `generateDueDepreciation(db,tenantId,today)` วนทุกทรัพย์สิน active ที่ถึงกำหนดของ tenant ครอบ try/catch ต่อชิ้น (ไม่ throw ทั้ง batch) | `fixed-assets.ts` | T58 | unit test: ทรัพย์สินถึงกำหนด+ผังบัญชีครบ → สร้าง draft+log `generated`; ทรัพย์สินที่ `dep_expense_account_code` ถูกลบไปแล้ว → generate ไม่สำเร็จ log `failed` แต่ทรัพย์สินอื่นที่ตามมายัง generate ต่อได้ (ไม่ throw ทั้ง batch); RPC คืน error จริง (mock `claimErr≠null`) → `status:'failed'`+log ทันที (ไม่ใช่ `skipped` เงียบๆแบบที่เฟส 6 เคยพลาด); ยังไม่ถึงรอบ (`claimed:false`,`error:null`) → skip เงียบไม่ log |
| **T60** | เพิ่มใน `fixed-assets.ts`: `disposeAsset(db,tenantId,customerId,assetId,{disposalDate,proceeds,cashAccountCode,gainLossAccountCode})` (0.7) คำนวณ NBV+กำไร/ขาดทุน → สร้าง `ManualEntryInput` (Dr accum_dep=accumulated, Dr/Cr cash=proceeds, Cr asset=cost, ปรับสมดุลด้วย gain/loss leg) → `upsertManualEntry` draft → update `status='disposed'`,`disposal_date`,`disposal_proceeds`,`disposal_entry_id`,`next_dep_date=null`; `undisposeAsset()` (0.8) — reset กลับ `active` เฉพาะถ้า `disposal_entry_id` ยัง draft (ไม่ confirmed) | `fixed-assets.ts` | T58, T59 | unit test: จำหน่ายที่ proceeds>NBV → กำไร (เครดิต gain/loss leg) สมดุลถูกต้อง; proceeds<NBV → ขาดทุน (เดบิต) สมดุลถูกต้อง; proceeds=NBV เป๊ะ → ไม่มี gain/loss leg หรือ leg=0 (ตัดสินใจเรื่อง edge case นี้ให้ชัดในโค้ด: ถ้า gainLoss=0 ไม่ต้องเพิ่ม leg ที่ยอด 0 เข้าไปเลย); `undisposeAsset` สำเร็จเมื่อ JE ยัง draft, ปฏิเสธชัดเจนเมื่อ JE confirmed แล้ว; ทรัพย์สินที่ `status='disposed'` แก้ทะเบียนไม่ได้อีก (ทั้ง `upsertAsset`/`generateOne` ปฏิเสธ) |
| **T61** | `app/api/cron/generate-fixed-asset-depreciation/route.ts` (mirror `generate-recurring-je` — CRON_SECRET fail-closed, คืน 200 เสมอกัน retry loop, วนทุก tenant ที่มีทรัพย์สินถึงกำหนดจริง) + `vercel.json` เพิ่ม cron entry (schedule เยื้องจาก recurring-je เดิม) | 2 ไฟล์ข้างต้น | T59 | ไม่ตั้ง `CRON_SECRET` → 503; auth ผิด → 401; auth ถูก → เรียก `generateDueDepreciation` ทุก tenant ที่มีทรัพย์สินถึงกำหนดจริง คืน 200 พร้อมสรุปจำนวน; error ภายใน → catch แล้วคืน 200 |
| **T62** | ⚠️ แก้ `lib/accounting/cash-flow-config.ts::INVESTING_CODES` เพิ่ม `'1615.1'`,`'1640.1'`,`'1645.1'` (0.10) — **ไม่แก้ไฟล์อื่นของเฟส 4 เลย** | `cash-flow-config.ts` | - | unit test เดิมของ `cash-flow-config.test.ts` ยังผ่านครบ (regression) + เทสต์ใหม่: `classifyCashFlowActivity('1615.1'/'1640.1'/'1645.1')` → `'investing'`; เทสต์ `cash-flow.test.ts` เพิ่มเคส end-to-end จำหน่ายทรัพย์สิน → ขาสินทรัพย์+ค่าเสื่อมสะสมจัดเป็น investing ทั้งคู่ ผลรวม investing ตรงกับ proceeds |
| **T63** | UI: `app/chat-audit/accounting/fixed-assets/{page.tsx,FixedAssetsPanel.tsx,actions.ts}` — CRUD ทะเบียน (AccountCombobox×3), ปุ่ม "สร้างค่าเสื่อมตอนนี้", dialog "จำหน่ายทรัพย์สิน"+"ยกเลิกการจำหน่าย", ประวัติค่าเสื่อมต่อชิ้น ลิงก์กลับ journal-entry | 3 ไฟล์ข้างต้น | T58-T60 | สร้างทะเบียนทรัพย์สินใหม่ → เห็นในลิสต์พร้อม NBV; กด "สร้างค่าเสื่อมตอนนี้" (ถึงกำหนดวันนี้พอดี) → เห็น draft ใหม่ในหน้า journal-entry มี badge เชื่อมทรัพย์สิน; จำหน่ายทรัพย์สิน → เห็นสถานะเปลี่ยนเป็น "จำหน่ายแล้ว" + draft JE กำไร/ขาดทุน; ยกเลิกการจำหน่าย (ก่อน confirm) → กลับเป็น active ปกติ; ลูกค้านอกสโคปเข้าไม่ได้; typecheck/lint ผ่าน |
| **T64** | `app/chat-audit/accounting/fixed-assets/export/route.ts` — export Excel รายงานทะเบียนทรัพย์สิน (reuse `exceljs` pattern จาก `budget/export/route.ts`) | `export/route.ts` | T63 | ดาวน์โหลดไฟล์ .xlsx เปิดได้จริง มีคอลัมน์ชื่อ/ราคาทุน/ค่าเสื่อมสะสม/NBV/สถานะตรงกับหน้าจอ; guard สิทธิ์เดียวกับหน้า |
| **T65** | เพิ่มลิงก์หน้า `page.tsx`/`CustomerTabs.tsx` หลัก + เทสต์ครบ: `tests/accounting/fixed-assets.test.ts`, `fixed-assets-actions.test.ts` (guard สโคป+undo confirmed-blocked) | หลายไฟล์ | T57-T64 | `npm run test` ผ่านทั้งชุดเฟส 7 |
| **T66** | รันชุดตรวจสอบเต็ม + regression sweep ข้ามเฟส 1-7 + ทดสอบมือรอบสุดท้าย | ทั้งหมด | T57-T65 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด; grep `fixed_asset_id`/`fixed-assets.ts` ยืนยันไม่มีจุดตกหล่น; เทียบตัวเลขงบการเงิน/กระแสเงินสดของลูกค้าทดสอบก่อน-หลังเฟส 7 (ที่ไม่มีทรัพย์สินใหม่) ต้องเท่ากันเป๊ะ (ฟีเจอร์นี้ additive ล้วน) |

**Milestone**:
- **เฟส 7-V (V, ทะเบียน+ค่าเสื่อมอัตโนมัติ)**: T57–T61, T63(บางส่วน)–T65 — ใช้งานได้จริงครบวงจร
- **เฟส 7-W (W, จำหน่ายทรัพย์สิน+cash-flow fix)**: T60, T62 — พึ่ง V (ต้องมีทะเบียน+accumulated_depreciation
  ก่อนจะจำหน่ายได้) ทำหลัง V เสร็จ
- **เฟส 7-verify**: T66 — ปิดงาน

---

## 3) Definition of Done (เฟส 7 รวม)

- [ ] นักบัญชี/หัวหน้าทีมสร้างทะเบียนทรัพย์สินของลูกค้าตัวเองได้เอง (ชื่อ, ราคาทุน, มูลค่าซาก, อายุการใช้งาน,
      รหัสบัญชี 3 ตัว) โดยไม่ต้องพึ่ง admin/แก้โค้ด
- [ ] cron รายวันสร้างรายการค่าเสื่อมเป็น **draft เสมอ** เมื่อถึงกำหนด — ไม่มีทาง auto-confirm เข้าบัญชีจริง
      โดยไม่มีคนกดยืนยัน
- [ ] ปุ่ม "สร้างค่าเสื่อมตอนนี้" ใช้งานได้ ไม่สร้างซ้ำเมื่อกดพร้อมกับ cron (claim atomic)
- [ ] ค่าเสื่อมสะสมรวมทุกงวดของทรัพย์สินหนึ่งชิ้น เท่ากับ `cost − salvage` เป๊ะเสมอ (งวดสุดท้ายเป็น plug
      ไม่มีเศษสตางค์ตกค้างจากการปัดเศษสะสม)
- [ ] ทรัพย์สินที่ตัดค่าเสื่อมครบแล้วหยุดสร้างรายการเองอัตโนมัติ (`next_dep_date=null`) ไม่ generate เกินมูลค่า
- [ ] ทรัพย์สินที่ `dep_expense_account_code`/บัญชีอื่นถูกลบไปหลังตั้งทะเบียน → generate ไม่สำเร็จมี log ให้เห็น
      ชัดเจน ไม่เงียบหาย ไม่ทำให้ทรัพย์สินอื่นพังตาม
- [ ] จำหน่ายทรัพย์สินได้จริง คำนวณ NBV+กำไร/ขาดทุนถูกต้อง สร้าง draft JE ให้ตรวจก่อนยืนยันเสมอ
- [ ] ยกเลิกการจำหน่ายได้ถ้า JE ยัง draft (ป้องกันแก้ไม่ได้เมื่อ JE confirmed แล้ว)
- [ ] ทะเบียนที่มีประวัติค่าเสื่อมแล้ว (แม้แต่งวดเดียว) แก้ตัวเลขราคาทุน/มูลค่าซาก/อายุการใช้งานย้อนหลังไม่ได้
- [ ] เงินสดจากการจำหน่ายทรัพย์สินแสดงเป็น "กิจกรรมลงทุน" ในงบกระแสเงินสดครบทั้งขา (สินทรัพย์+ค่าเสื่อมสะสม)
- [ ] รายการค่าเสื่อมปกติ (ไม่ใช่จำหน่าย) ยังคงไม่ปรากฏในงบกระแสเงินสดเลย (ไม่มีขาเงินสด) เหมือนที่เฟส 4
      ตัดสินใจไว้แล้ว — ไม่ regression
- [ ] ทุก write path ใหม่ผ่าน `requireAccountingAccess` + `assertCustomerInScope` (derive จาก resource id
      ที่กำลังเขียนจริงเสมอ — ไม่ซ้ำ pattern IDOR ที่เคยพบในเฟส 3)
- [ ] ไม่มี `console.log`/log ใดที่มีตัวเลข/ชื่อทรัพย์สิน/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production
- [ ] เทสต์เดิมของเฟส 1-6 ทั้งหมดยังผ่านหลังเพิ่มคอลัมน์/ตารางใหม่ (ไม่มี regression ข้ามเฟส) โดยเฉพาะ
      `cash-flow-config.test.ts`/`cash-flow.test.ts` ที่ถูกแก้
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

### 4.1 Unit test

**`fixed-assets.ts` (T58-T60) — จุดสำคัญที่สุดของเฟส:**
- `monthlyDepreciationAmount`/plug งวดสุดท้าย: ทดสอบเคสที่หารไม่ลงตัว (เช่น cost=10000,salvage=0,
  useful_life=7 → ต่อเดือน=1428.57 ปัด 2 ตำแหน่ง → รวม 7 งวดต้องได้ 10000.00 เป๊ะ ไม่ใช่ 10000.01/9999.99)
- `generateOne`: แยก `claimErr` (RPC error จริง) ออกจาก `!claimed` (ยังไม่ถึงรอบ) ให้ถูกต้องตั้งแต่ต้น —
  เทียบกับ regression test ที่เฟส 6 เคยเขียนไว้หลังแก้บั๊กเดียวกัน (`tests/accounting/recurring-journal.test.ts`)
  ใช้เป็นต้นแบบเทสต์เคสนี้
- `disposeAsset`: proceeds>NBV (กำไร), proceeds<NBV (ขาดทุน), proceeds=NBV เป๊ะ (ไม่มี gain/loss leg หรือ
  leg=0 ไม่ทำให้ไม่สมดุล), disposal ก่อนมีประวัติค่าเสื่อมเลย (accumulated=0, NBV=cost เต็ม)

**`cash-flow-config.ts`/`cash-flow.ts` (T62):**
- `classifyCashFlowActivity` ทุกรหัส `.1` ใหม่ → `'investing'`
- end-to-end: journal line ของรายการจำหน่ายทรัพย์สิน (เงินสด+ค่าเสื่อมสะสม+สินทรัพย์+กำไร/ขาดทุน) →
  `buildCashFlowStatement` จัด `investing` รวมตรงกับ `proceeds` เป๊ะ, `reconciled=true`

**Actions (`fixed-assets-actions.test.ts`):**
- guard สโคป: นักบัญชีนอกสโคปทำรายการของลูกค้าอื่นไม่ได้ (ทุก action)
- แก้/ลบทะเบียนที่มีประวัติค่าเสื่อมแล้ว → ปฏิเสธ
- `undisposeAssetAction` เมื่อ JE confirmed แล้ว → ปฏิเสธชัดเจน

### 4.2 Integration/manual (บน dev จริง — ทำต่อเนื่องกันเป็น flow เดียว)

1. สร้างทะเบียนทรัพย์สิน (เช่น "คอมพิวเตอร์สำนักงาน" ราคาทุน 30,000 มูลค่าซาก 0 อายุ 36 เดือน วันที่ซื้อ
   เดือนปัจจุบัน) → กด "สร้างค่าเสื่อมตอนนี้" → เห็น draft ใน journal-entry (30000/36 ≈ 833.33) พร้อม badge
   เชื่อมทรัพย์สิน → กดยืนยัน → เห็นผลในงบทดลอง/งบการเงิน
2. รัน cron มือ (`curl` endpoint ด้วย `CRON_SECRET`) ซ้ำวันเดียวกัน → ต้อง**ไม่**สร้าง occurrence ซ้ำสอง
3. สร้างทรัพย์สินทดสอบอายุสั้น (เช่น 2 เดือน) → generate ค่าเสื่อมครบ 2 งวด → ตรวจว่างวดที่ 2 (สุดท้าย) ได้ยอด
   plug ที่ถูกต้อง (ไม่ใช่ยอดคงที่ปัดเศษ) และ `next_dep_date` กลายเป็นว่าง (ไม่มีปุ่มให้ generate ต่อ)
4. จำหน่ายทรัพย์สินในข้อ 1 (proceeds สูงกว่า NBV เล็กน้อยเพื่อทดสอบกำไร) → ตรวจ draft JE ที่ได้ → ยืนยัน →
   เปิดหน้างบกระแสเงินสดของงวดนั้น → เห็นเงินสดที่ได้รับจัดอยู่ใน "กิจกรรมลงทุน" ครบ (ไม่ตกไปอยู่ operating)
5. ทดสอบยกเลิกการจำหน่ายก่อนยืนยัน JE → ทรัพย์สินกลับเป็น active ปกติ ประวัติค่าเสื่อมเดิมไม่หาย
6. staff นักบัญชีที่ไม่ได้ดูแลลูกค้า A → เปิดหน้าทะเบียนทรัพย์สินของลูกค้า A ไม่ได้/แก้ไม่ได้
7. regression: เปิดหน้าบัญชีเดิมทุกหน้า (เฟส 1-6) ของลูกค้าที่มีข้อมูลครบ → ยอด/รายงาน/งบกระแสเงินสดต้อง
   เหมือนก่อนเฟส 7 เป๊ะ (ทดสอบด้วยลูกค้าที่ไม่มีทรัพย์สินใหม่เลย)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| **การปัดเศษสะสมทำให้ค่าเสื่อมรวมไม่เท่า `cost−salvage` เป๊ะ** (0.5) ถ้าไม่ทำ plug งวดสุดท้ายให้ถูก จะมีเศษสตางค์ค้างเงียบๆ ยากสังเกต | ออกแบบ `amount = min(monthly_depreciation, remaining)` ไว้ในทั้ง RPC (SQL) และตรวจซ้ำด้วย unit test เทียบผลรวมสะสมทั้งหมดต่อทรัพย์สิน ต้อง = `cost−salvage` เป๊ะทุกเคสทดสอบ (รวมเคสหารไม่ลงตัว) |
| **ซ้ำบั๊กเดิมของเฟส 6**: `generateOne` รวม RPC error จริงเข้ากับ "ยังไม่ถึงรอบ" เป็นกรณีเดียวกัน (`skipped` เงียบๆ) — เคยเกิดจริงใน `recurring-journal.ts` มาก่อนแล้วแก้ | เขียนแยก 2 branch ให้ถูกตั้งแต่แรก (ไม่ต้องรอ QC จับ) — อ้างอิงโค้ดที่แก้แล้วของ `recurring-journal.ts::generateOne` เป็นต้นแบบตรงๆ ก่อนเขียนของเฟส 7 |
| **cron/ปุ่มมือชนกันสร้าง occurrence ซ้ำสอง** | atomic RPC (`for update skip locked` + advance ในทีเดียว) เหมือน pattern เฟส 6; มีเทสต์ยิงพร้อมกัน 2 เส้นทางยืนยันว่า claim สำเร็จแค่ครั้งเดียว |
| **แก้ `cash-flow-config.ts` (ไฟล์เฟส 4 เดิม) กระทบ regression ของงบกระแสเงินสดที่ deploy ใช้งานจริงแล้ว** | แก้แค่เพิ่ม 3 รหัสเข้า `INVESTING_CODES` (ไม่แก้ logic/`classifyCashFlowActivity()`/`FINANCING_CODES` เลย) — รัน `cash-flow.test.ts`/`cash-flow-config.test.ts` เดิมทั้งหมดต้องผ่าน 100% ก่อนถือว่า T62 เสร็จ (regression gate เดียวกับที่ทุกเฟสก่อนหน้าใช้) |
| **ทรัพย์สินถูกลบ/ปิดใช้งานรหัสบัญชีหลังตั้งทะเบียนแล้ว** ทำให้ generate ค่าเสื่อมล้มเหลวเรื่อยๆทุกเดือน | `generateOne` ครอบ try/catch ต่อชิ้น + log `failed` ชัดเจนทุกครั้งที่ล้ม (0.8 เดิมของเฟส 6) ให้นักบัญชีเห็นในหน้าทะเบียนแล้วไปแก้รหัสบัญชี/สร้างรหัสใหม่เอง ไม่มี auto-retry เงียบๆ |
| **แก้ทะเบียนที่มีประวัติค่าเสื่อมแล้วโดยไม่ตั้งใจ ทำให้ยอดที่ generate ไปแล้วขัดแย้งกับสูตรใหม่** | ล็อกแก้ราคาทุน/มูลค่าซาก/อายุการใช้งานทันทีที่ `accumulated_depreciation>0` (0.12) — ไม่มีทาง bypass ผ่าน UI ปกติ ต้องยกเลิกยืนยัน JE ทุกใบที่เกี่ยวข้องก่อนแล้ว soft-delete ทะเบียนทั้งชิ้นทิ้งเท่านั้น |
| **จำหน่ายทรัพย์สินผิด (proceeds/วันที่ผิด) แล้วยืนยัน JE ไปแล้ว** — undo ไม่ได้ตามกฎ 0.8 | เหมือนหลักการเดิมทั้งระบบ (manual JE/CN-DN) — ต้องยกเลิกยืนยัน JE ก่อน (กลับเป็น draft) แล้ว `undisposeAsset` จึงทำได้ ข้อความ error ต้องบอกขั้นตอนที่ถูกต้องชัดเจน ไม่ใช่แค่ปฏิเสธเงียบๆ |

---

*(เฟส 7 เป็นฟีเจอร์เพิ่มหลัง merge+deploy เฟส 1-6 แล้ว — ทำตาม pattern เดียวกัน: implement → QC (review+
security+test) → แก้ไขทุกข้อที่พบ → verify เต็มรูป → รวมเข้า branch เดิม/branch ใหม่ → merge+deploy อีกรอบ
เมื่อผู้ใช้ยืนยัน)*

# เฟส 8 — แผนละเอียด: สต็อกสินค้าคงเหลือ + ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ (Inventory / Stock)

**สโคป:** เพิ่มจาก gap analysis เทียบ FlowAccount (2026-08-09) — ผู้ใช้ยืนยันแล้วว่าลูกค้าหลายรายของสำนักงาน
บัญชีนี้เป็นธุรกิจซื้อมาขายไป/มีสต็อกสินค้าจริง และให้ตัวอย่างหน้าจอโปรแกรมบัญชีเดสก์ท็อปไทย (ผังหน้าจอ
รายละเอียดสินค้า/กลุ่มบัญชีสินค้า FIFO/AVERAGE/บัตรสต็อก/รายงานสินค้าคงเหลือแยกหมวด) เป็นตัวอ้างอิงรูปแบบ
รายงานที่ต้องการ — เฟสนี้แบ่งเป็น 2 ส่วน **X → Y**:
- **(X) โครงสต็อก + คำนวณต้นทุนถ่วงเฉลี่ยเคลื่อนที่ (Moving Average) + รายงานบัตรสต็อก/สินค้าคงเหลือ** —
  งานหลัก เสี่ยงปานกลาง (คำนวณ replay ล้วน ไม่มี write path ที่กระทบบัญชีจริงเลย)
- **(Y) เชื่อมกับบิลที่ยืนยันแล้ว (สร้างรายการเข้า/ออกสต็อกจากบิล) + ยอดยกมาสต็อก** — เสี่ยงต่ำกว่า X แต่ทำ
  หลัง X เพราะต้องมีโครงคำนวณก่อน

ต่อยอดของที่มีอยู่แล้วในระบบ (ตรวจโค้ดจริงก่อนวางแผน):
- `lib/accounting/products.ts::Product` (เฟส 1 ส่วน B) — master data มี `sku`/`name`/`unit`/`defaultPrice`/
  `defaultAccountCode` อยู่แล้ว **ไม่มีคอลัมน์จำนวนคงเหลือเลย** (ยืนยันจากไฟล์จริง) — เฟสนี้**ไม่แก้ตาราง
  `products` เดิม** เพิ่มตารางสต็อกแยกต่างหากที่ผูก `product_id` แทน (mirror หลักการเดิมทั้งระบบ: แยกตาราง
  ใหม่เมื่อโครงสร้างข้อมูลต่างกันจริง — เหมือนที่ manual JE/bill_payments/CN-DN แยกจาก bill_entries)
- `supabase/migrations/0065_bill_entry_lines_product_id.sql` — `bill_entry_lines.product_id` มีอยู่แล้ว
  (เลือกผ่าน combobox ใน `EntryEditor.tsx` เวลาแก้บิล) **แต่ `bill_entry_lines` ไม่มีคอลัมน์จำนวน (quantity)
  เลย** (ยืนยันจากการ grep schema จริง — บิลเป็นแบบ VAT invoice ตัดยอดเป็นเงิน ไม่ใช่ qty×unit-price) — เฟสนี้
  ต้องเพิ่มคอลัมน์ `quantity` (nullable) ให้บรรทัดบิลที่ต้องการให้กระทบสต็อก
- `lib/accounting/sales-documents.ts` (เฟส 3 ส่วน K) — มี `quantity`/`unitPrice` ต่อบรรทัดอยู่แล้วจริง แต่
  คอมเมนต์ในไฟล์เองยืนยันว่า **"เป็นแค่ตัวช่วยแสดงผล ไม่บังคับ"** และเป็นเอกสารก่อน/ระหว่างขาย-ซื้อ (ใบเสนอ
  ราคา/PO/ใบวางบิล) **ไม่ใช่เอกสารทางบัญชีจริง** (0.11 ของเฟส 3 ยืนยันว่าไม่กระทบ engine บัญชีเลย) — เฟสนี้
  **ไม่ใช้ `sales_documents` เป็นแหล่งกระทบสต็อกเด็ดขาด** (เอกสารยังไม่เกิดขึ้นจริงทางบัญชี) ใช้ `bill_entries`
  ที่ยืนยันแล้วเท่านั้น (0.7 ด้านล่าง)
- `supabase/migrations/0063_chart_of_accounts_table.sql` — seed เดิมมี `5010 ซื้อสินค้า` เป็น**หมวดค่าใช้จ่าย**
  (ไม่มีรหัส "สินค้าคงเหลือ"/"ต้นทุนขาย" แยกเป็นสินทรัพย์เลย) — **นี่คือหลักฐานว่าระบบทั้งชุดออกแบบตาม
  แนวคิดบัญชีสต็อกแบบ "สิ้นงวด (Periodic)" มาตั้งแต่ต้น** (ซื้อ = ลงค่าใช้จ่ายตรง ๆ, ต้นทุนขายคำนวณตอนปิดงวด
  จาก สต็อกต้นงวด+ซื้อ−สต็อกปลายงวด) ไม่ใช่ "ต่อเนื่อง (Perpetual)" ที่ตัดต้นทุนทุกครั้งที่ขาย — เฟสนี้จึง
  **ออกแบบให้สอดคล้องกับของเดิม** (0.6 ด้านล่าง — สำคัญที่สุดของทั้งเฟส)
- `lib/accounting/opening-balance.ts`+`0054_account_opening_balances.sql` (ก่อนเฟส 1) — pattern "ยอดยกมา
  ต่อบัญชีต่อลูกค้า" ไม่มีวันที่ (ถือเป็น "ก่อนรายการทั้งหมด" เสมอ) ใช้เป็นต้นแบบตรงๆสำหรับ `product_opening_
  balances` (0.11)
- `lib/accounting/statement-inputs.ts`/`trial-balance.ts`/`cash-flow.ts` (เฟส 4) — **ทุกงบคำนวณจากการ replay
  ข้อมูลดิบใหม่ทุกครั้ง ไม่มีการเก็บยอดสะสม/cache ไว้เลยแม้แต่จุดเดียว** — เฟสนี้ยึดหลักการเดียวกันเป๊ะสำหรับ
  ยอดคงเหลือ/ต้นทุนถ่วงเฉลี่ย (0.5 ด้านล่าง) กันบั๊ก backdated-entry ทั้งหมดตั้งแต่ต้น (ไม่ต้องมี invalidate
  cache logic ให้พลาดได้)
- `docs/05-flowaccount-integration.md`/M1-M2 (FlowAccount sync) — precedent "manual-trigger ต่อเอกสาร" (กด
  ปุ่มส่งทีละใบ ไม่ auto-sync พื้นหลัง) — เฟสนี้ใช้ precedent เดียวกันสำหรับการ "ดึงรายการเข้า/ออกสต็อกจากบิล
  ที่ยืนยันแล้ว" (0.7) เพื่อเลี่ยงการแก้ `app/chat-audit/accounting/actions.ts::saveEntryAction` (ไฟล์ที่
  ซับซ้อนที่สุด/ใช้งานหนักที่สุดในระบบ ใช้งานจริงมาตั้งแต่ก่อนเฟส 1) — ไม่แตะไฟล์นี้เลยแม้แต่บรรทัดเดียว
- ตัวอย่างหน้าจอที่ผู้ใช้แนบมา (โปรแกรมบัญชีเดสก์ท็อปไทย) — มี "กลุ่มบัญชีสินค้า" ให้เลือก FIFO/AVERAGE
  ต่อสินค้า, หน่วยย่อย/ใหญ่/ซื้อ/ขาย (unit conversion), หลายคลังสินค้า, ล็อตสินค้า, บัตรสต็อก, รายงานสินค้า
  คงเหลือแยกหมวด — เฟสนี้ **ตัดสโคปเหลือ**: ต้นทุนถ่วงเฉลี่ยเคลื่อนที่วิธีเดียว (0.1), คลังเดียว/ไม่มีล็อต
  (0.2), หน่วยเดียว (0.3 — `products.unit` เดิมพอแล้ว) แต่**คงรายงานบัตรสต็อก+สินค้าคงเหลือแยกหมวดไว้ตรงตาม
  รูปแบบตัวอย่าง** (0.10)

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ⚠️ วิธีคำนวณต้นทุน — ถ่วงเฉลี่ยเคลื่อนที่ (Moving Average) เท่านั้นในรอบแรก ไม่รองรับ FIFO
ตัวอย่างหน้าจอที่ผู้ใช้แนบมาให้เลือกได้ทั้ง FIFO และ AVERAGE ต่อสินค้า (ผ่าน "กลุ่มบัญชีสินค้า") — แต่ FIFO
ต้องเก็บ **cost layer แยกเป็นชุด ๆ ตามรอบที่ซื้อเข้า** (ตัดออกจากชุดที่เก่าสุดก่อน, แบ่งชุดที่ตัดไม่พอดี ฯลฯ)
ซับซ้อนกว่าถ่วงเฉลี่ยเคลื่อนที่มาก (แค่ยอดรวม+ราคาต่อหน่วยเฉลี่ยตัวเดียว อัปเดตทุกครั้งที่รับเข้า) — เลือก
ถ่วงเฉลี่ยเท่านั้นในรอบแรก (ตรงกับตัวอย่างที่ผู้ใช้แนบ "ST02 สินค้าสำเร็จรูป AVERAGE" และเป็นวิธีที่ SME ไทย
ใช้มากที่สุดในทางปฏิบัติ) **[⚠️ FLAG]** ถ้าลูกค้าบางรายต้องใช้ FIFO จริง (เช่น สินค้าที่ต้นทุนผันแปรมาก/มี
วันหมดอายุ) เป็น backlog แยกที่ต้องออกแบบ cost-layer table เพิ่มต่างหาก ไม่ block เฟสนี้

### 0.2 ขอบเขต — คลังสินค้าเดียว (default) ไม่มีล็อต/ซีเรียล/หลายคลัง
ตัดฟีเจอร์ "คลังสินค้า <F8>"/"ล็อตสินค้า <F7>" ของตัวอย่างออกจากสโคปนี้ — สำนักงานบัญชีบันทึกรายการหลังเกิด
เหตุจริงแล้ว (ไม่ได้บริหารคลังหน้างานเอง) ความละเอียดระดับหลายคลัง/ล็อตไม่จำเป็นต่อการปิดงบให้ถูกต้อง
**[⚠️ FLAG]** ถ้าลูกค้าต้องการแยกยอดคงเหลือตามสาขา/คลังจริง เป็น backlog แยก

### 0.3 ขอบเขต — หน่วยเดียวต่อสินค้า (reuse `products.unit` เดิม) ไม่มีตัวคูณแปลงหน่วยย่อย/ใหญ่/ซื้อ/ขาย
`products.unit` (เฟส 1) มีอยู่แล้วเป็น text เดียว (เช่น "ชุด") — เฟสนี้ใช้หน่วยเดียวกันทั้งซื้อ/ขาย/สต็อก
ไม่ทำระบบแปลงหน่วย (เช่น 1 ลัง = 12 ชิ้น) **[⚠️ FLAG]** เป็น backlog แยกถ้าจำเป็นจริง

### 0.4 ⚠️ `bill_entry_lines` ต้องเพิ่มคอลัมน์ `quantity` (nullable) — ไม่มีอยู่เดิม
บิลปัจจุบันเป็นแบบ VAT invoice (ตัดยอดเป็นเงินต่อบรรทัด ไม่ใช่ qty×unit-price) — บรรทัดที่ผูก `product_id`
ไว้แล้ว (เฟส 1) แต่**ไม่มีจำนวน**เลย ทำให้อ้างอิงเป็นรายการสต็อกไม่ได้ ต้องเพิ่มคอลัมน์ `quantity numeric`
(nullable — บิลเดิม/บรรทัดที่ไม่สนใจสต็อกยังคงว่างได้ตามปกติ ไม่กระทบ flow เดิมแม้แต่จุดเดียว) นักบัญชีกรอก
จำนวนเพิ่มเฉพาะบรรทัดที่มี `product_id` และต้องการให้กระทบสต็อก (ไม่บังคับกรอกทุกบรรทัด)

### 0.5 ⚠️ คำนวณยอดคงเหลือ/ต้นทุนถ่วงเฉลี่ยด้วยการ "replay" ประวัติทั้งหมดใหม่ทุกครั้ง — ไม่เก็บยอดสะสม/cache
mirror หลักการที่ใช้กับ ledger/trial-balance/cash-flow ทั้งหมด (เฟส 4): **ไม่มีคอลัมน์ "ยอดคงเหลือปัจจุบัน"
เก็บไว้บนแถวไหนเลย** — ทุกครั้งที่ต้องรู้ยอดคงเหลือ/ต้นทุนเฉลี่ย ณ จุดใดจุดหนึ่ง ให้ดึงรายการเคลื่อนไหวทั้งหมด
ของสินค้านั้น (`product_opening_balances` + `product_stock_movements`) มาเรียงตามวันที่ (แล้ว `created_at`
กันชนวันเดียวกัน) แล้ว "เล่นซ้ำ" คำนวณยอด/ต้นทุนเฉลี่ยไปเรื่อย ๆ ตั้งแต่ต้น (pure function, ไม่แตะ DB) —
**ข้อดี: แก้/ลบรายการย้อนหลัง (backdated entry) ไม่มีทางทำให้ยอดค้างผิดเงียบ ๆ เลย เพราะคำนวณใหม่จากศูนย์ทุก
ครั้งเสมอ** (ต่างจากถ้าเก็บ running balance ต่อแถวซึ่งต้อง invalidate/recompute ท่อนที่เหลือทุกครั้งที่มีการ
แก้ไขย้อนหลัง — เสี่ยงบั๊กสูงกว่ามาก และเฟสนี้เลือกไม่เสี่ยงแบบนั้น)

### 0.6 ⚠️⚠️ ที่สำคัญที่สุดของทั้งเฟส: **ไม่ auto-post ต้นทุนขาย (COGS) เข้าบัญชีแยกประเภทเลย**
ผังบัญชีเดิมของทั้งระบบ (migration 0063) ออกแบบตามแนวคิดบัญชีสต็อกแบบ **สิ้นงวด (Periodic)** อยู่แล้ว (`5010
ซื้อสินค้า` เป็นค่าใช้จ่ายตรง ไม่มีรหัส "สินค้าคงเหลือ" เป็นสินทรัพย์แยก) — ถ้าเฟสนี้ auto-post COGS แบบ
ต่อเนื่อง (Perpetual: Dr ต้นทุนขาย/Cr สินค้าคงเหลือ ทุกครั้งที่ขาย) จะ**ขัดกับโครงสร้างบัญชีเดิมทั้งระบบ**
ต้องเพิ่มรหัสบัญชีใหม่+เปลี่ยนวิธีลงบัญชีซื้อของทุกบิลที่ผูก `product_id` ไปด้วย (breaking change กับ flow
เดิมที่ deploy ใช้งานจริงแล้ว) — **ตัดสินใจ: เฟสนี้เป็น "ชั้นติดตามจำนวน+มูลค่าคงเหลือ" คู่ขนานเท่านั้น ไม่มี
write path กระทบบัญชีแยกประเภท/งบการเงินเลยแม้แต่จุดเดียว** — นักบัญชียังคงลงบัญชีซื้อแบบเดิมทุกประการ (Dr
`5010`/ค่าใช้จ่ายอื่น) แล้วใช้ **รายงานสินค้าคงเหลือของเฟสนี้** เป็นตัวเลขอ้างอิงตอนปิดงวด (สิ้นเดือน/สิ้นปี)
ไปสร้าง **manual JE เอง** ผ่านฟีเจอร์เดิม (เฟส 1 ส่วน C) เพื่อปรับปรุงต้นทุนขาย/สินค้าคงเหลือตามสูตร
periodic (`ต้นทุนขาย = สต็อกต้นงวด + ซื้อ − สต็อกปลายงวด`) — **[⚠️ FLAG — decision สำคัญที่สุด ต้องแจ้งผู้ใช้
ให้รับทราบชัดเจน]** ถ้าในอนาคตต้องการ auto-post COGS แบบ perpetual จริง ต้องมีรอบคุยเรื่องรหัสบัญชีใหม่+
ผลกระทบต่อ flow ซื้อเดิมก่อน เป็นงานแยกที่ใหญ่กว่าเฟสนี้มาก

### 0.7 จุดกระทบสต็อก — เฉพาะ `bill_entries` ที่ `status='confirmed'` เท่านั้น ไม่ใช่ `sales_documents`
`sales_documents` (เฟส 3 ส่วน K: ใบเสนอราคา/PO/ใบวางบิล) เป็นเอกสารก่อน/ระหว่างขาย-ซื้อ ยังไม่ใช่รายการที่
เกิดขึ้นจริงทางบัญชี (0.11 ของเฟส 3 เขียนไว้ชัดว่า "ไม่กระทบ engine บัญชีเลย") — เฟสนี้ **ไม่ใช้เป็นแหล่ง
กระทบสต็อกเด็ดขาด** ใช้แค่ `bill_entries`+`bill_entry_lines` ที่ `entry_type∈{sale,purchase}` และ
`status='confirmed'` และบรรทัดมี `product_id`+`quantity` ครบเท่านั้น: `purchase`→เข้าสต็อก (IN),
`sale`→ออกสต็อก (OUT)

### 0.8 ⚠️ Trigger การสร้างรายการสต็อกจากบิล — **manual-trigger ต่อบิล (ปุ่มกดเอง) ไม่ hook เข้า `saveEntryAction`**
mirror precedent ของ FlowAccount sync (M1/M2, `docs/05`) ที่เป็น "กดส่งทีละใบ" ไม่ auto-sync พื้นหลัง — เหตุผล
เดียวกัน: `app/chat-audit/accounting/actions.ts::saveEntryAction` เป็นไฟล์ที่ซับซ้อนและใช้งานหนักที่สุดใน
ระบบ (จัดการ draft/confirm/แก้บิลที่ยืนยันแล้ว/payment method ฯลฯ พร้อมกัน) — **เฟสนี้ไม่แก้ไฟล์นี้เลยแม้แต่
บรรทัดเดียว** เพื่อไม่เสี่ยง regression กับ flow หลักที่ deploy ใช้งานจริงมานานที่สุดในระบบ — แทนที่ด้วยปุ่ม
แยก "บันทึกรับ/จ่ายสต็อกจากบิลนี้" ที่หน้ารายการบิล (mirror ปุ่ม FlowAccount sync ที่มีอยู่แล้วในหน้าเดียวกัน)
กดแล้วสร้าง `product_stock_movements` จากบรรทัดที่มี `product_id`+`quantity` ของบิลนั้น (atomic claim กันกด
ซ้ำสร้างซ้ำสอง — เหมือน `flowaccount_sync_log`/recurring JE) — **ไม่มีทาง auto-trigger จากการยืนยันบิลเลย**

### 0.9 บิลที่ถูกแก้/ยกเลิกยืนยันหลังสร้างรายการสต็อกไปแล้ว — ไม่ auto-sync คีย์ แต่ต้อง "ยกเลิก" รายการสต็อกเอง
ถ้าบิลถูกแก้ไขจำนวน/ยกเลิกยืนยันหลังกดสร้างรายการสต็อกไปแล้ว (0.8) — รายการสต็อกที่สร้างไว้แล้ว**ไม่ auto-
sync ตาม** (mirror หลักการ 0.16 ของ bank reconciliation เฟส 6 — ไม่ auto-repair) นักบัญชีต้องกด "ยกเลิกรายการ
สต็อก" (soft-delete movement นั้น) เองก่อนแล้วกด "บันทึกรับ/จ่ายสต็อก" ใหม่ให้ตรงกับบิลที่แก้แล้ว — หน้า
รายการสต็อกของบิลนั้นแสดง badge เตือนถ้าตรวจพบว่ายอด/จำนวนในบิลไม่ตรงกับที่เคยสร้าง movement ไว้ (เทียบ
snapshot คล้าย 0.15/0.16 ของ bank reconciliation)

**✅ implemented (2026-08-10, แก้จาก QC finding 🟡):** เพิ่ม `bill_entries.stock_synced_at` เข้า
`BillEntry.stockSync` (`lib/accounting/queries.ts` — `StockSyncInfo`/`mapStockSync`, best-effort pattern
เดียวกับ `flowaccountSync`) เทียบกับ `bill_entries.updated_at` — `updated_at > stock_synced_at` →
`needsResync=true` → badge ส้ม "บิลถูกแก้ — สต็อกอาจไม่ตรง" ที่ `RowActions.tsx` (ข้าง ๆ ปุ่ม "บันทึกรับ/
จ่ายสต็อก") ไม่ block ปุ่มใด ๆ — เป็นแค่ป้ายเตือนให้นักบัญชีไปตรวจ/ยกเลิก+บันทึกใหม่เอง

### 0.10 รายงาน — บัตรสต็อก (Stock Card) + สินค้าคงเหลือแยกหมวด (mirror รูปแบบตัวอย่างที่ผู้ใช้แนบ)
- **บัตรสต็อกต่อสินค้า**: รายการเคลื่อนไหวเรียงตามวันที่ (รับ/จ่าย/คงเหลือ พร้อมจำนวน+ราคาต่อหน่วย+มูลค่า
  ต่อรายการ, อ้างอิงเอกสารต้นทาง) — mirror โครงสร้างตัวอย่างที่แนบมาเป๊ะ (คอลัมน์ วันที่/เลขที่/รายการรับ/
  รายการจ่าย/คงเหลือ/เอกสารอ้างอิง)
- **สินค้าคงเหลือแยกตามหมวดสินค้า ณ วันที่**: รวมทุกสินค้า จัดกลุ่มตามหมวด (ใช้ `products` ไม่มีหมวดเดิม —
  เฟสนี้เพิ่ม `category` เป็น text อิสระที่นักบัญชีกรอกเอง ไม่ผูก FK, ค่า default = "สินค้า" ถ้าไม่กรอก) แสดง
  จำนวน/ราคาต่อหน่วยเฉลี่ย/มูลค่ารวมต่อสินค้า+รวมยอดหมวด+รวมทั้งสิ้น
- export Excel ทั้ง 2 รายงาน (reuse `exceljs` pattern เดิม)

### 0.11 ยอดยกมาสต็อก (Opening Balance) — ตารางใหม่ mirror `account_opening_balances` เป๊ะ (ไม่มีวันที่)
`product_opening_balances` (tenant, customer, product_id, quantity, unit_cost, note) — **ไม่มีคอลัมน์วันที่**
(ถือเป็น "ก่อนรายการเคลื่อนไหวทั้งหมดเสมอ" เหมือนยอดยกมาบัญชีเดิม) ใช้เป็นจุดเริ่มการ replay (0.5) เสมอ —
unique ต่อ (customer, product) เหมือน `account_opening_balances`

### 0.12 สต็อกติดลบ — อนุญาต ไม่ hard-block แต่แสดงคำเตือนชัดเจน
เฟสนี้เป็นชั้นติดตาม/รายงานคู่ขนาน (0.6) ไม่ใช่ตัวควบคุมทางการเงินที่บังคับกฎเข้มงวด — ถ้าคำนวณแล้วยอด
คงเหลือติดลบ (เช่น บันทึกขายก่อนบันทึกซื้อที่มาก่อนจริง เพราะข้อมูลย้อนหลัง/AI อ่านไม่ครบ) **ไม่ block การ
สร้างรายการ** แต่แสดง badge เตือนชัดเจนในบัตรสต็อก/รายงาน ("คงเหลือติดลบ — ตรวจสอบรายการที่ตกหล่น") ให้
นักบัญชีไปหาสาเหตุเอง (ตรงกับหลักการ "ไม่ auto-repair/ไม่ปิดบังความผิดปกติ" ที่ใช้ทั้งไฟล์นี้)

### 0.13 สิทธิ์ — reuse `requireAccountingAccess`+`assertCustomerInScope` เดิมทั้งหมด ไม่มี admin-only ใหม่
เหมือนฟีเจอร์อื่นทุกตัว — ทุก action ที่รับ resource id ตรง ๆ (เช่น ลบ movement/แก้ opening balance) ต้อง
derive scope จาก resource นั้นเองก่อนเขียนเสมอ (pattern IDOR-safe ตั้งแต่เฟส 3 — ห้ามเกิดซ้ำ)

### 0.14 ยืนยันเลข migration จริงจาก `ls supabase/migrations/` ก่อน apply จริง
ณ วันที่วางแผน (2026-08-09) ไฟล์ล่าสุดคือ `0076_fixed_assets.sql` (เฟส 7 ที่กำลังทำคู่ขนานอยู่) → เฟสนี้ควร
ใช้ `0077` **แต่ต้องเช็ค `ls supabase/migrations/` ซ้ำอีกครั้งก่อน apply จริงเสมอ** เพราะเฟส 7 อาจสร้าง
migration เพิ่มระหว่างทาง (คนละ agent ทำงานคู่ขนานกันอยู่ในเซสชันนี้)

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — เฟส 8

```
supabase/migrations/
  00XX_product_stock.sql   [ใหม่] ★ ยืนยันเลขจริงก่อนสร้าง (0.14) — bill_entry_lines เพิ่มคอลัมน์ quantity
                                     (nullable) + products เพิ่มคอลัมน์ category (nullable text, 0.10) +
                                     product_opening_balances (mirror 0054) + product_stock_movements
                                     (movement_type, quantity, unit_cost, source_bill_entry_line_id
                                     nullable FK, memo, movement_date) + RLS

lib/
  accounting/
    product-stock.ts        [ใหม่] ชนิด StockMovement/StockMovementInput/StockLedgerRow, validate
                                     (quantity>0, unit_cost>=0 เมื่อเป็น IN-type, movement_date ผิดปฏิทิน
                                     reuse isValidCalendarDate จาก bank-reconciliation.ts), pure:
                                     computeStockLedger(openingBalance, movements) → replay ตามลำดับ
                                     วันที่+created_at คำนวณ moving-average ต่อจุด (0.5), buildStockCard()
                                     (mirror ตัวอย่างที่แนบ), buildInventoryValuationReport(allProducts
                                     ledgers) (จัดกลุ่มตาม category, 0.10), data layer: listMovements/
                                     createManualAdjustment/createMovementsFromBill(billEntryId — 0.7/0.8,
                                     atomic claim กันกดซ้ำ mirror flowaccount_sync_log)/softDeleteMovement/
                                     upsertProductOpeningBalance/listProductOpeningBalances

app/chat-audit/accounting/
  inventory/
    page.tsx                 [ใหม่] เลือกลูกค้า (mirror budget/page.tsx) → แท็บ "บัตรสต็อก" (เลือกสินค้า)
                                     / "สินค้าคงเหลือแยกหมวด" (ทั้งหมด ณ วันที่)
    InventoryPanel.tsx        [ใหม่] client: ตารางบัตรสต็อก (mirror ตัวอย่างที่แนบ), ตารางสินค้าคงเหลือ
                                     แยกหมวด+รวมยอด, ปุ่ม "บันทึกปรับปรุงสต็อก" (manual adjustment เข้า/ออก),
                                     ฟอร์มยอดยกมาต่อสินค้า, badge เตือนสต็อกติดลบ (0.12)
    actions.ts                [ใหม่] server actions guard requireAccountingAccess+assertCustomerInScope
                                     (createAdjustmentAction/deleteMovementAction/upsertOpeningBalanceAction)
    export/route.ts            [ใหม่] export Excel ทั้ง 2 รายงาน (reuse exceljs pattern จาก budget/export)

  RowActions.tsx              [แก้] เพิ่มปุ่ม "บันทึกรับ/จ่ายสต็อก" ต่อแถวบิล (เฉพาะ confirmed + มีบรรทัดที่
                                     product_id+quantity ครบอย่างน้อย 1 บรรทัด) — mirror ปุ่ม FlowAccount
                                     sync ที่มีอยู่แล้วในไฟล์เดียวกัน (0.8 — **ไม่แก้ actions.ts/saveEntryAction
                                     เลย** action ใหม่แยกไฟล์ต่างหาก)
  stock-sync-actions.ts       [ใหม่] server action เดียว `syncStockFromBillAction(entryId)` — โหลดบิล+บรรทัด
                                     ที่ product_id+quantity ครบ → เรียก createMovementsFromBill (atomic)
  page.tsx, CustomerTabs.tsx  [แก้] เพิ่มลิงก์ "สต็อกสินค้า" (จุดเดียวกับ opening/reports/budget/
                                     recurring-journal/fixed-assets เดิม)

app/chat-audit/admin/products/
  ProductsPanel.tsx           [แก้] เพิ่มช่องกรอก "หมวดสินค้า" (category, text อิสระ 0.10)
  actions.ts                  [แก้] รับ category เพิ่มใน upsert (validate ความยาว, ไม่บังคับกรอก)

tests/
  accounting/product-stock.test.ts        [ใหม่] validate ทุก branch, computeStockLedger (ถ่วงเฉลี่ย
                                     เคลื่อนที่ถูกต้องทุกกรณี รวม backdated-entry ที่ replay ใหม่ได้ถูกต้อง
                                     เสมอ — พิสูจน์ไม่มีบั๊ก cache), buildStockCard/buildInventoryValuationReport
                                     (จัดกลุ่มหมวดถูกต้อง), createMovementsFromBill (atomic กันกดซ้ำ, กรอง
                                     เฉพาะบรรทัดที่ product_id+quantity ครบ), สต็อกติดลบไม่ throw มีคำเตือน
  chat-admin/inventory-actions.test.ts    [ใหม่] guard สโคปครบทุก action
  chat-admin/products-actions.test.ts     [แก้] เพิ่มเทสต์ category field (ไม่ regression ของเดิม)
```

---

## 2) งานย่อยเรียงลำดับ (เฟส 8)

เลขงาน: ต่อจากเฟส 7 (T57–T66) → เริ่มที่ **T67**

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T67** | Migration ใหม่ — ⚠️ ยืนยันเลขไฟล์ล่าสุดจริงก่อนสร้าง (0.14) — `bill_entry_lines.quantity` (nullable) + `products.category` (nullable) + `product_opening_balances`(mirror 0054) + `product_stock_movements` + RLS | migration ใหม่ | - | apply ไม่ error; insert บิลเดิม/บรรทัดเดิมที่ไม่มี quantity ยังทำงานปกติ (ค่า null ไม่กระทบ flow เดิม); เทสต์เดิมทั้งหมดผ่าน 100% |
| **T68** | `lib/accounting/product-stock.ts` — types, validate, `computeStockLedger()` (pure — ★ จุดสำคัญที่สุด) | `product-stock.ts` | T67 | unit test: ถ่วงเฉลี่ยเคลื่อนที่ถูกต้องทุกกรณี (รับหลายรอบราคาต่างกัน → ราคาเฉลี่ยเปลี่ยนถูกต้องตามสูตร ตรงกับตัวอย่างบัตรสต็อกที่ผู้ใช้แนบ: รับ200@70→เฉลี่ย68.333 ตรงกับตัวอย่างจริง); แทรกรายการย้อนหลัง (backdated) แล้ว replay ใหม่ → ยอด/เฉลี่ยถูกต้องเสมอ (ไม่มีบั๊ก cache); สต็อกติดลบไม่ throw คืน flag เตือน |
| **T69** | เพิ่มใน `product-stock.ts`: `buildStockCard()`/`buildInventoryValuationReport()` (0.10) + data layer `listMovements`/`upsertProductOpeningBalance`/`listProductOpeningBalances`/`createManualAdjustment`/`softDeleteMovement` | `product-stock.ts` | T68 | unit test: บัตรสต็อกเรียงตามวันที่ถูกต้องตรงรูปแบบตัวอย่าง; รายงานคงเหลือจัดกลุ่มหมวดถูกต้อง+รวมยอดถูก; opening balance ใช้เป็นจุดเริ่ม replay ก่อนรายการอื่นเสมอไม่ว่า movement_date จะเป็นอะไร |
| **T70** | เพิ่มใน `product-stock.ts`: `createMovementsFromBill(db,tenantId,entryId)` (0.7/0.8 — atomic claim กันกดซ้ำ mirror `flowaccount_sync_log`, กรองเฉพาะบรรทัดที่ `product_id`+`quantity` ครบของบิลนั้น, purchase→IN ใช้ `unit_cost` จาก amount/quantity ต่อบรรทัด, sale→OUT ไม่ต้องมี unit_cost — ใช้ moving-average ตอน replay) | `product-stock.ts` | T68 | unit test: บิลซื้อ 1 ใบมีหลายบรรทัด (บางบรรทัดไม่มี product_id/quantity → ข้าม ไม่สร้าง movement) → สร้าง movement เฉพาะบรรทัดที่ครบ; กดซ้ำ (จำลอง 2 request พร้อมกัน) → สร้างได้แค่ครั้งเดียว; บิล sale สร้าง OUT ถูกต้อง |
| **T71** | `app/chat-audit/accounting/stock-sync-actions.ts` [ใหม่ไฟล์เดียว] `syncStockFromBillAction(entryId)` guard `requireAccountingAccess`+`assertCustomerInScope` (derive scope จาก entry จริง) + `RowActions.tsx` [แก้] เพิ่มปุ่ม "บันทึกรับ/จ่ายสต็อก" (0.8 — **ห้ามแก้ `actions.ts`/`saveEntryAction` เด็ดขาด**) | 2 ไฟล์ข้างต้น | T70 | เปิดหน้าบิลจริง (confirmed, มีบรรทัด product_id+quantity ครบ) → เห็นปุ่มใหม่ → กด → เห็นรายการในหน้าสต็อก; กดซ้ำ → ไม่สร้างซ้ำสอง (แจ้งข้อความชัดเจน); บิลที่ไม่มีบรรทัดครบเงื่อนไข → ไม่เห็นปุ่มเลย; grep ยืนยัน `saveEntryAction`/`actions.ts` ไม่ถูกแก้แม้แต่บรรทัดเดียว |
| **T72** | UI: `app/chat-audit/accounting/inventory/{page.tsx,InventoryPanel.tsx,actions.ts}` — เลือกลูกค้า → แท็บบัตรสต็อก/สินค้าคงเหลือแยกหมวด, ปุ่มบันทึกปรับปรุงสต็อกมือ, ฟอร์มยอดยกมา, badge เตือนติดลบ | 3 ไฟล์ข้างต้น | T69 | เปิดหน้าจริง เลือกสินค้า → เห็นบัตรสต็อกตรงรูปแบบตัวอย่างที่แนบ; ตั้งยอดยกมา → บัตรสต็อกเริ่มจากยอดนั้นถูกต้อง; บันทึกปรับปรุงมือ (เช่น สินค้าเสียหาย) → เห็นผลในบัตรสต็อกทันที; ลูกค้านอกสโคปเข้าไม่ได้ |
| **T73** | `app/chat-audit/accounting/inventory/export/route.ts` — export Excel ทั้ง 2 รายงาน (reuse `exceljs` pattern จาก `budget/export/route.ts`) | `export/route.ts` | T72 | ดาวน์โหลด .xlsx เปิดได้จริง ตัวเลขตรงกับหน้าจอ |
| **T74** | `app/chat-audit/admin/products/{ProductsPanel.tsx,actions.ts}` [แก้] เพิ่มช่องกรอก/รับค่า `category` (0.10) — **ไม่แก้ field อื่นของ product เดิมเลย** | 2 ไฟล์ข้างต้น | T67 | เพิ่ม/แก้หมวดสินค้าได้ผ่านหน้าเดิม; สินค้าที่ไม่กรอกหมวด → default "สินค้า" ในรายงาน (0.10); เทสต์เดิมของ `products-actions.test.ts` ยังผ่านครบ |
| **T75** | เพิ่มลิงก์หน้า `page.tsx`/`CustomerTabs.tsx` หลัก + เทสต์ครบ: `tests/accounting/product-stock.test.ts`, `tests/chat-admin/inventory-actions.test.ts` | หลายไฟล์ | T67-T74 | `npm run test` ผ่านทั้งชุดเฟส 8 |
| **T76** | รันชุดตรวจสอบเต็ม + regression sweep ข้ามเฟส 1-8 + ทดสอบมือรอบสุดท้าย | ทั้งหมด | T67-T75 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด; grep ยืนยัน `saveEntryAction`/`app/chat-audit/accounting/actions.ts` ไม่ถูกแก้เลย (0.8); ไม่มี write path ใดของเฟสนี้กระทบ `journal.ts`/`ledger.ts`/`statements.ts`/`cash-flow.ts` เลย (0.6 — grep ยืนยัน `product-stock.ts` ไม่ import ไฟล์เหล่านี้แม้แต่บรรทัดเดียว) |

**Milestone**:
- **เฟส 8-X (โครง+รายงาน)**: T67–T69, T72–T75(บางส่วน) — ใช้งานได้จริงด้วยการปรับปรุงมือ+ยอดยกมาก่อน
- **เฟส 8-Y (เชื่อมบิล)**: T70–T71 — เพิ่มความสะดวก ไม่ block X
- **เฟส 8-verify**: T76 — ปิดงาน

---

## 3) Definition of Done (เฟส 8 รวม)

- [ ] นักบัญชี/หัวหน้าทีมตั้งยอดยกมาสต็อกต่อสินค้าของลูกค้าตัวเองได้เอง
- [ ] กดปุ่ม "บันทึกรับ/จ่ายสต็อก" จากบิลที่ยืนยันแล้ว (มีบรรทัด product_id+quantity ครบ) สร้างรายการสต็อกได้
      จริง กดซ้ำไม่สร้างซ้ำสอง (atomic)
- [ ] บัตรสต็อกต่อสินค้าแสดงประวัติรับ/จ่าย/คงเหลือ+ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ถูกต้องตรงตามตัวอย่างที่ผู้ใช้
      ให้มา — ตรวจเทียบเลขมือ
- [ ] รายงานสินค้าคงเหลือแยกหมวด รวมยอดถูกต้องตรงกับบัตรสต็อกรายตัว
- [ ] บันทึกปรับปรุงสต็อกมือได้ (สินค้าเสียหาย/นับสต็อกจริงต่างจากระบบ ฯลฯ)
- [ ] **ไม่มี write path ใดของเฟสนี้กระทบบัญชีแยกประเภท/งบการเงิน/งบกระแสเงินสดเลยแม้แต่จุดเดียว** (0.6) —
      ตัวเลขงบการเงินของลูกค้าทดสอบก่อน-หลังเฟส 8 ต้องเท่ากันเป๊ะ (additive ล้วน)
- [ ] **`app/chat-audit/accounting/actions.ts`/`saveEntryAction` ไม่ถูกแก้เลยแม้แต่บรรทัดเดียว** (0.8) — grep
      ยืนยันก่อนปิดงาน
- [ ] สต็อกติดลบไม่ทำให้ระบบ error/throw มีคำเตือนให้เห็นชัดเจนในรายงาน
- [ ] แก้/ยกเลิกยืนยันบิลหลังสร้างรายการสต็อกแล้ว ไม่ auto-sync ตาม (0.9) นักบัญชีต้องจัดการเองผ่านปุ่มยกเลิก
      รายการสต็อก
- [ ] ทุก write path ใหม่ผ่าน `requireAccountingAccess` + `assertCustomerInScope` (derive จาก resource id
      ที่กำลังเขียนจริงเสมอ — ไม่ซ้ำ pattern IDOR ที่เคยพบในเฟส 3)
- [ ] ไม่มี `console.log`/log ใดที่มีจำนวน/มูลค่า/ชื่อสินค้า/ชื่อลูกค้า (PDPA)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production
- [ ] เทสต์เดิมของเฟส 1-7 ทั้งหมดยังผ่านหลังเพิ่มคอลัมน์/ตารางใหม่ (ไม่มี regression ข้ามเฟส)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

### 4.1 Unit test

**`product-stock.ts::computeStockLedger` (T68) — จุดสำคัญที่สุดของเฟส:**
- reproduce ตัวอย่างบัตรสต็อกที่ผู้ใช้แนบมาตรงๆด้วยตัวเลขเดียวกัน: ยอดยกมา 100@65.000 → รับ 200@70.000
  (คงเหลือ 300@68.333) → จ่าย 50@68.333 (คงเหลือ 250@69.000... **ตรวจสูตรจริงจากตัวอย่างให้ตรงเป๊ะ** เพราะ
  ตัวเลข "ราคาต่อหน่วยคงเหลือ" ในภาพเปลี่ยนแม้ตอนจ่ายออก (ไม่ใช่แค่ตอนรับเข้า) — ต้องตรวจว่าตัวอย่างใช้สูตร
  ถ่วงเฉลี่ยเคลื่อนที่แบบ "คำนวณเฉลี่ยใหม่ทุกครั้งที่มีการรับเข้าเท่านั้น ค่าเฉลี่ยไม่เปลี่ยนตอนจ่ายออก" หรือ
  แบบอื่น — ถ้าตัวเลขไม่ตรงให้ปรับสูตรใน `computeStockLedger` จนกว่าจะ reproduce ตัวอย่างได้เป๊ะทุกแถว)
- แทรกรายการย้อนหลัง (backdated) ระหว่างรายการที่มีอยู่แล้ว → replay ใหม่ → ยอด/เฉลี่ยของรายการที่ตามมา
  เปลี่ยนถูกต้องตามลำดับใหม่ (พิสูจน์ 0.5)
- สต็อกติดลบ (จ่ายมากกว่าที่มี) → ไม่ throw, คืน flag เตือนในแถวที่ติดลบ

**`buildInventoryValuationReport`**: จัดกลุ่มตาม `category` ถูกต้อง, สินค้าไม่มี category → เข้ากลุ่ม default
"สินค้า", รวมยอดต่อหมวด+รวมทั้งสิ้นถูกต้อง

**`createMovementsFromBill` (T70)**: บิลผสม (บางบรรทัดมี product_id+quantity บางบรรทัดไม่มี) → สร้าง movement
เฉพาะบรรทัดที่ครบเงื่อนไข; เรียกซ้อน 2 ครั้งพร้อมกัน (จำลอง double-click) → สร้างสำเร็จแค่ครั้งเดียว

**Actions**: guard สโคปครบทุก action, `syncStockFromBillAction` derive scope จาก entry id จริงเสมอ (ไม่รับ
customerId แยกที่ไม่ผูกกับ entry)

### 4.2 Integration/manual (บน dev จริง)

1. ตั้งหมวดสินค้าที่หน้า Product Master เดิม (เฟส 1) → ตั้งยอดยกมาสต็อกสินค้า 1 ตัว → เปิดบัตรสต็อก เห็นยอด
   ยกมาถูกต้อง
2. สร้างบิลซื้อยืนยันแล้ว มีบรรทัดผูก product_id+quantity → กดปุ่ม "บันทึกรับสต็อก" → เห็นรายการรับใหม่ใน
   บัตรสต็อก ราคาเฉลี่ยเปลี่ยนถูกต้อง
3. สร้างบิลขายยืนยันแล้ว (สินค้าเดียวกัน) → กดปุ่ม "บันทึกจ่ายสต็อก" → เห็นรายการจ่าย คงเหลือลดถูกต้อง
4. เปิดรายงาน "สินค้าคงเหลือแยกหมวด" → ตรวจยอด/มูลค่าตรงกับบัตรสต็อกของสินค้านั้น
5. แก้ไขบิลซื้อในข้อ 2 (เปลี่ยนจำนวน) หลังสร้าง movement ไปแล้ว → เปิดหน้าสต็อกของบิลนั้น → เห็น badge เตือน
   ไม่ตรงกัน (0.9) → กด "ยกเลิกรายการสต็อก" แล้วกด "บันทึกรับสต็อก" ใหม่ → ตรงกันแล้ว
6. export Excel ทั้ง 2 รายงาน → เปิดไฟล์ตรวจคอลัมน์/ตัวเลขตรงกับหน้าจอ
7. staff นักบัญชีที่ไม่ได้ดูแลลูกค้า A → เปิดหน้าสต็อกของลูกค้า A ไม่ได้
8. regression: เปิดหน้าบัญชีเดิมทุกหน้า (เฟส 1-7) ของลูกค้าที่มีข้อมูลครบ → ยอด/รายงาน/งบการเงิน/งบกระแส
   เงินสดต้องเหมือนก่อนเฟส 8 เป๊ะ (ฟีเจอร์นี้เป็นชั้นคู่ขนานล้วน ไม่กระทบบัญชีจริงเลย ตาม 0.6)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| **สูตรถ่วงเฉลี่ยเคลื่อนที่ที่ implement ไม่ตรงกับตัวอย่างที่ผู้ใช้ให้มา** (มีรายละเอียดปลีกย่อยหลายแบบว่าคำนวณเฉลี่ยใหม่ตอนไหนบ้าง) | reproduce ตัวเลขจากตัวอย่างภาพที่แนบมาให้ตรงเป๊ะเป็น unit test บังคับก่อนถือว่า T68 เสร็จ (ไม่ใช่แค่เขียนสูตรตามความเข้าใจทั่วไปแล้วผ่าน) |
| **auto-post COGS แบบ perpetual โดยไม่ตั้งใจ ขัดกับผังบัญชีเดิม** (0.6) — ถ้า implement พลาดไปเรียก `upsertManualEntry` หรือ engine บัญชีใดๆจาก `product-stock.ts` | grep ยืนยันก่อนปิดงาน (T76) ว่า `product-stock.ts` ไม่ import `manual-journal.ts`/`journal.ts`/`ledger.ts`/`statements.ts` เลยแม้แต่บรรทัดเดียว — เหมือน pattern ที่ `sales-documents.ts` เฟส 3 ใช้ยืนยันตัวเองว่าไม่กระทบ engine |
| **แก้ `saveEntryAction`/`actions.ts` โดยไม่ตั้งใจ (ไฟล์ที่เสี่ยงสูงสุดในระบบ)** | ออกแบบ action สต็อกเป็นไฟล์แยกใหม่ทั้งหมด (`stock-sync-actions.ts`) ไม่แก้ `actions.ts` เดิมเลย — grep ยืนยันก่อนปิดงาน |
| **backdated entry ทำให้ replay ผิดถ้า sort ผิดลำดับ** (วันเดียวกันหลายรายการ) | sort ด้วย `movement_date` แล้ว `created_at` เป็น tiebreak เสมอ (เหมือน `bank-reconciliation.ts::buildBookLines` ที่แก้ปัญหาคีย์ชนกันแบบเดียวกันมาแล้ว) + unit test ยืนยันลำดับ deterministic |
| **สินค้าที่ไม่มี category เดิม (ก่อนเฟสนี้) ทำให้รายงานแยกหมวดดูรกเพราะเข้ากลุ่ม default ทั้งหมด** | ไม่ใช่บั๊ก เป็นพฤติกรรมที่ยอมรับได้ตาม 0.10 (default="สินค้า") — นักบัญชีไปตั้งหมวดเพิ่มเองทีละสินค้าได้ผ่านหน้า Product Master เดิม ไม่ต้อง migration data ย้อนหลัง |
| **จำนวน call site ที่ต้องเพิ่มปุ่ม/ลิงก์ (RowActions/page.tsx/CustomerTabs) เสี่ยง gap แบบที่เจอซ้ำทุกเฟส** | grep ยืนยันครบก่อนปิดงาน (T76) เหมือนที่ L1/H1/T54/T66 ของเฟสก่อนหน้าทำสำเร็จมาแล้วทุกครั้ง |

---

*(เฟส 8 เป็นฟีเจอร์เพิ่มหลังเฟส 7 — ทำตาม pattern เดียวกัน: implement → QC (review+security+test) → แก้ไข
ทุกข้อที่พบ → verify เต็มรูป → รวมเข้า branch → merge+deploy เมื่อผู้ใช้ยืนยัน)*
