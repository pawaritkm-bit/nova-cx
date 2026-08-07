# FlowAccount OpenAPI Integration — แผนงาน M1 (MVP: ส่งใบกำกับภาษี/ใบเสร็จขาย แบบ manual-trigger)

ทิศทาง: **NOVA-CX → FlowAccount (ส่งออกอย่างเดียว)** ไม่มีขาดึงข้อมูลกลับ ไม่มี auto-sync
เป้าหมาย M1: ปุ่ม **"ส่งไป FlowAccount"** ที่หน้า `/chat-audit/accounting` ต่อบิลขาย (`entry_type='sale'`)
ที่ยืนยันแล้ว (`status='confirmed'`) — กดทีละใบ ไม่มี background job ไม่มี auto-retry เงียบ

อ้างอิง input: บทวิเคราะห์ของ analyst (โครงสร้าง `bill_entries`/`bill_entry_lines`/`customers`,
pattern integration เดิม `lib/integrations/nova-sales-query.ts`, env ที่ตั้งไว้แล้วใน `.env.example`)

---

## 0) การตัดสินใจสำคัญที่ต้องยืนยัน/ล็อกไว้ก่อนเริ่มโค้ด

### 0.1 ไม่ vendor FlowAccount TypeScript SDK — เขียน REST client เองแบบบาง (thin fetch client)
เหตุผล:
- โปรเจกต์นี้ไม่มี pattern เพิ่ม SDK ของ 3rd-party service เลย (`package.json` มีแค่ exceljs/jszip/qrcode/zod)
  — integration เดิมทุกตัว (`lib/integrations/nova-sales-*.ts`) เขียนด้วย `fetch` + `AbortController` ตรง ๆ
  เพื่อคุมเรื่อง timeout / PDPA logging / error shape ได้เต็มที่
- SDK ชุมชน (`flowaccount-openapi-sdk` → `flowaccount-typescript-node-client`) ไม่ใช่ของทางการ
  FlowAccount เอง ไม่รู้สถานะ maintenance/type quality ที่แน่ชัด — เพิ่ม supply-chain surface โดยไม่จำเป็น
- M1 ใช้แค่ 2 endpoint (ขอ token + สร้างเอกสารขาย 1 ใบ) — เขียนเองสั้นกว่าและคุม log ได้ตรงมาตรฐานทีม
- **ใช้ type definition ของ SDK เป็นเอกสารอ้างอิง** (ดู field ชื่ออะไรบ้าง) ได้ แต่ไม่ import เป็น runtime dependency

### 0.2 ชนิดเอกสารที่จะสร้างใน FlowAccount — ยืนยันแล้ว 100% จาก OpenAPI spec ทางการ (2026-08-05)
ตาม `payment_method` ของ `bill_entries`:
- `payment_method = credit` (เชื่อ ยังไม่รับเงิน) → สร้างเป็น **Tax Invoice** (`POST /tax-invoices`)
- `payment_method = cash/transfer/cheque` (รับเงินแล้ว) → สร้างเป็น **Cash Sale** (`POST /cash-invoices`)
- **ไม่ส่งข้อมูล WHT** ในรอบแรก — ส่งแค่ยอดก่อน VAT + VAT ต่อบรรทัด + ยอดรวม
- **ไม่ส่งข้อมูลการชำระเงิน** (payment sub-object) ในรอบแรก — ทั้งสอง endpoint นี้ (แบบ `SimpleDocument`
  ไม่ใช่ `.../with-payment`) สร้างเอกสารในสถานะ "รอดำเนินการ" เหมือนกัน ต่างกันแค่ "ชนิดเอกสาร" — การมาร์ค
  "เก็บเงินแล้ว" ต้องใช้ endpoint `.../with-payment` ซึ่งต้องมี `bankAccountId` ฝั่ง FlowAccount ที่เรายังไม่มี
  mapping (ผูกกับ M2+) — นักบัญชีไปกดเก็บเงินเองใน FlowAccount ได้ตามปกติ ไม่ใช่ scope ของปุ่มนี้
- Response สำเร็จ (schema `SimpleDocumentResponse`): `data.recordId` = doc id, `data.documentSerial` = เลขที่เอกสาร

### 0.3 ⚠️ ปมสถาปัตยกรรมที่ต้องระวัง: 1 credential FlowAccount ต่อ 1 บริษัท
`FLOWACCOUNT_CLIENT_ID/SECRET` เป็น env **ระดับเดียว** (ไม่ผูกกับ `customers` แต่ละราย) แต่ NOVA-CX
1 tenant (สำนักงานบัญชี) ดูแลลูกค้าได้หลายบริษัท (`customers` หลายแถว) — ถ้าลูกค้า 2 บริษัทเปิดใช้ปุ่มนี้
พร้อมกัน เอกสารของทั้งคู่จะไปลงบัญชีเดียวกันใน FlowAccount (ผิด). M1 **จำกัดขอบเขตไว้ที่ 1 บริษัทลูกค้า**
โดยเพิ่ม env allowlist ใหม่:

```
FLOWACCOUNT_CUSTOMER_ID=   # uuid ของ customers.id ที่อนุญาตให้ส่ง — เว้นว่าง = ไม่บังคับ (dev only)
```

ถ้าตั้งไว้ → server action ปฏิเสธบิลของลูกค้าอื่นทันที (ปุ่มก็ไม่โชว์ในหน้า UI ถ้า customerId ไม่ตรง)
**M2+ ค่อยย้าย credential ไปเก็บต่อลูกค้า (encrypted ตาม pattern `CREDENTIAL_ENC_KEY`)** ถ้าจะเปิดหลายบริษัท
พร้อมกันจริง — ไม่รวมใน M1

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้)

```
supabase/migrations/
  0061_flowaccount_sync.sql            [ใหม่] คอลัมน์ sync status บน bill_entries + ตาราง log

lib/
  env.ts                                [แก้] เพิ่ม getFlowAccountConfig() / getFlowAccountAllowedCustomerId()
  integrations/
    flowaccount.ts                      [ใหม่] OAuth client_credentials + REST client (token cache, timeout, ไม่ throw)
    flowaccount-mapper.ts               [ใหม่] pure mapper: bill_entries+lines+customer → payload FlowAccount
  accounting/
    flowaccount-sync.ts                 [ใหม่] orchestration: claim (atomic guard) → map → เรียก client → เขียนผล+log
    queries.ts                          [แก้] เพิ่ม field flowaccountSync ใน BillEntry + select คอลัมน์ใหม่

app/chat-audit/accounting/
  flowaccount-actions.ts                [ใหม่] "use server" — guard สิทธิ์/สโคป/allowlist แล้วเรียก flowaccount-sync
  FlowAccountSyncButton.tsx             [ใหม่] client component ปุ่ม/ป้ายสถานะ (4 state)
  RowActions.tsx                        [แก้] เสียบปุ่มเข้าแถวบิลขายที่ confirmed
  page.tsx                              [แก้] ส่ง prop flowaccountSync ให้ RowActions
  actions.ts                            [แก้] saveEntryAction: แก้บิลที่ synced แล้ว → set needs_resync=true

tests/
  integrations/flowaccount.test.ts          [ใหม่]
  accounting/flowaccount-mapper.test.ts     [ใหม่]
  accounting/flowaccount-sync.test.ts       [ใหม่]
  accounting/flowaccount-actions.test.ts    [ใหม่]

.env.example                            [แก้] เพิ่มคอมเมนต์ FLOWACCOUNT_CUSTOMER_ID (ตัวแปรอื่นมีอยู่แล้ว)
```

### 1.1 Schema ใหม่ (migration 0061)
```
bill_entries เพิ่มคอลัมน์ (nullable/default, non-destructive):
  flowaccount_sync_status     text not null default 'not_synced'
                               check in ('not_synced','syncing','synced','failed')
  flowaccount_doc_type        text check in ('tax_invoice','cash_sale') or null
  flowaccount_doc_id          text   -- id เอกสารฝั่ง FlowAccount
  flowaccount_doc_no          text   -- เลขที่เอกสารฝั่ง FlowAccount (อาจต่างจาก doc_no เรา)
  flowaccount_synced_at       timestamptz
  flowaccount_last_error      text   -- ข้อความสั้น ไม่มี payload/PII
  flowaccount_last_attempted_at timestamptz
  flowaccount_needs_resync    boolean not null default false

ตารางใหม่ flowaccount_sync_log (audit ทุกครั้งที่กดส่ง — สำเร็จ/ล้ม):
  id, tenant_id, entry_id (fk bill_entries on delete cascade), doc_type,
  status ('success'|'failed'), flowaccount_doc_id, error_message, requested_by, created_at
  RLS: authenticated select (tenant scope) · service_role all (เขียนผ่าน server action เท่านั้น)
```

**กลไกกันส่งซ้ำ (แก้ risk #1 ตรง ๆ):** claim ด้วย 1 คำสั่ง SQL เดียว
```sql
update bill_entries
  set flowaccount_sync_status = 'syncing', flowaccount_last_attempted_at = now()
  where id = :entryId and tenant_id = :tenantId
    and flowaccount_sync_status in ('not_synced','failed')
  returning id;
```
ถ้า 0 แถว = มีคนกดไปแล้ว/กำลังส่งอยู่ → ปฏิเสธทันที (atomic ที่ระดับ Postgres row lock กันกดซ้ำ/สองแท็บ
พร้อมกันได้จริง ไม่ใช่แค่เช็ค-แล้ว-ค่อยเขียนแบบ 2 ขั้นตอนที่มี race)

---

## 2) งานย่อยเรียงลำดับ (M1)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T0** | ยืนยันสเปกจริงจาก Postman collection ที่ analyst ให้ (endpoint สร้าง tax invoice/cash sale, token endpoint, ทรง request/response, error format) — บันทึกผลเป็นคอมเมนต์ในโค้ด T3 | — (เตรียมงาน) | - | มีสรุป endpoint/payload จริงที่ "ยืนยันแล้ว" ไม่ใช่เดา ก่อนเริ่ม T3; ถ้ายืนยันไม่ได้ทันเวลา ให้ทำ T3 แบบ TODO ชัดเจนตาม pattern `nova-sales-query.ts` แล้วแจ้ง blocker |
| **T1** | Migration 0061 — คอลัมน์ sync status + ตาราง `flowaccount_sync_log` | `supabase/migrations/0061_flowaccount_sync.sql` | - | apply บน sandbox DB ไม่ error · RLS/grant ตาม pattern (`0046`,`0013`) · `notify pgrst, 'reload schema'` · ไม่กระทบ query/flow เดิม (รันเทสต์เดิมทั้งหมดผ่าน) |
| **T2** | `lib/env.ts` — `getFlowAccountConfig()` (คืน `null` ถ้าขาด token/base/id/secret ตัวใดตัวหนึ่ง) + `getFlowAccountAllowedCustomerId()` | `lib/env.ts`, `.env.example` | - | unit test ครอบ: ครบ env → คืน config, ขาดตัวใดตัวหนึ่ง → null; ไม่ throw |
| **T3** | `lib/integrations/flowaccount.ts` — `getAccessToken()` (client_credentials + cache in-memory ตามอายุ token) + `createSalesDocument(payload)` (POST + timeout 8s + AbortController) | `lib/integrations/flowaccount.ts` | T0, T2 | ยึด pattern `nova-sales-query.ts` เป๊ะ: ไม่ตั้ง env → `{ok:false, reason:"not_configured"}` ไม่ยิง fetch; token/create fail → reason ตาม HTTP status (`auth_failed`/`validation_error`/`timeout`/`network`/`server_error`) ไม่ throw; **ไม่ log payload เต็ม/เลขภาษี/ยอดเงิน** (log แค่ status/reason); unit test มี fetch mock ครอบทุก branch |
| **T4** | `lib/integrations/flowaccount-mapper.ts` — `resolveDocType(paymentMethod)` + `buildSalesDocumentPayload(entry, lines, customer)` (pure, validate ก่อน map) | `lib/integrations/flowaccount-mapper.ts` | T3 (รู้ทรง payload ที่ client ต้องการ) | คืน `{ok:false, reason}` ถ้า: ไม่มีลูกค้าเลขภาษี (จำเป็นสำหรับใบกำกับภาษี), ไม่มี line ที่มูลค่า>0, ไม่มี doc_date; unit test ครอบ mapping ปกติ + ทุก reject case; ฟังก์ชัน pure 100% (ไม่แตะ DB/network) |
| **T5** | `lib/accounting/flowaccount-sync.ts` — `claimEntryForSync()` (atomic guard) + `syncSaleEntryToFlowAccount()` (โหลดข้อมูลเต็ม → claim → map → เรียก client → เขียนผล + insert log เสมอ) | `lib/accounting/flowaccount-sync.ts` | T1, T3, T4 | unit test (mock db ตาม pattern `actions-lib.test.ts`) ครอบ: claim สำเร็จครั้งแรก, claim ซ้ำ (จำลอง 0 แถว) → ปฏิเสธ, business guard (ไม่ confirmed/ไม่ใช่ sale/ไม่มีลูกค้า → ปฏิเสธก่อนยิง แม้ FlowAccount config ครบ), success path → `synced`+doc_id+log success, failure path → `failed`+error สั้น+log failed |
| **T6** | `app/chat-audit/accounting/flowaccount-actions.ts` — server action `sendToFlowAccountAction(entryId)` | `flowaccount-actions.ts` | T5 | guard ครบ: `requireAccountingAccess` + `assertCustomerInScope` + allowlist `FLOWACCOUNT_CUSTOMER_ID` (ถ้าตั้ง) + เรียก sync → `revalidatePath` → คืนข้อความไทยสุภาพ (ไม่หลุด error ดิบ); test ครอบ: ปฏิเสธนักบัญชีนอกสโคป, ปฏิเสธ customer ไม่ตรง allowlist, ปฏิเสธ entry ไม่ confirmed/ไม่ใช่ sale, success/failure คืนข้อความถูกต้อง |
| **T7** | `lib/accounting/queries.ts` — เพิ่ม `flowaccountSync` ใน `BillEntry` + select คอลัมน์ใหม่ | `queries.ts` | T1 | เทสต์เดิม (`queries.test.ts`) ผ่านหมด + เทสต์ใหม่ยืนยัน mapping คอลัมน์ถูกต้อง (รวม fallback ถ้าคอลัมน์ยังไม่ apply migration ต้องไม่ทำให้ query ทั้งหน้าพัง — ตาม pattern `input_tax_month`) |
| **T8** | `FlowAccountSyncButton.tsx` — client component 4 state (`not_synced/failed` → ปุ่มส่ง, `syncing` → disabled, `synced`+`!needsResync` → ป้ายเขียว, `synced`+`needsResync` → ป้ายเตือน+ปุ่มส่งใหม่) | `FlowAccountSyncButton.tsx` | T6, T7 | ใช้ `useTransition`+`router.refresh()` ตาม pattern `RowActions.tsx`; ไม่ render อะไรถ้า `entryType≠'sale'` หรือ `status≠'confirmed'` หรือไม่มีลูกค้า; typecheck+lint ผ่าน; ไม่มี `console.*` ที่มี PII |
| **T9** | เสียบปุ่มเข้าหน้าจริง | `RowActions.tsx`, `page.tsx` | T7, T8 | เปิด `/chat-audit/accounting` แท็บ "ภาษีขาย" ของบิล confirmed → เห็นปุ่ม; บิล draft/ซื้อ/รอระบุ → ไม่เห็นปุ่ม (ตรวจด้วยตาจริงบน dev/staging) |
| **T10** | `actions.ts` — `saveEntryAction`: แก้บิลที่ `flowaccount_sync_status='synced'` → set `flowaccount_needs_resync=true` (best-effort, try/catch แยก ไม่ทำให้ save ทั้งใบล้ม) | `actions.ts` | T1 | unit test: แก้บิลที่ synced แล้ว → `needs_resync=true`; แก้บิลที่ยังไม่ synced → ไม่แตะคอลัมน์นี้; คอลัมน์ยังไม่ apply migration → save ยังสำเร็จ (degrade เหมือน `input_tax_month`) |
| **T11** | รันชุดตรวจสอบเต็ม + ทดสอบมือกับ FlowAccount sandbox จริง | ทั้งหมดข้างบน | T1–T10 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (เทสต์เดิม 1579+ ตัว + เทสต์ใหม่); ทดลองกดส่งบิลขาย confirmed จริง 1 ใบเข้า sandbox แล้วเช็คเอกสารโผล่ใน FlowAccount จริง; ทดลอง "กดรัว/สองแท็บพร้อมกัน" ต้องได้เอกสารแค่ใบเดียว |

**Milestone**: T1–T7 = โครงหลัก (data layer + client) รันได้แบบ headless (ทดสอบผ่าน unit test ล้วน) ·
T8–T10 = ต่อ UI ให้ใช้งานจริงได้ครบ · T11 = ขัดเกลา + verify จริงกับ sandbox

---

## 3) Definition of Done (M1 รวม)

- [ ] ปุ่ม "ส่งไป FlowAccount" โผล่เฉพาะบิลขาย (`entry_type='sale'`) ที่ `status='confirmed'` และผูกลูกค้าแล้ว
- [ ] กดส่งสำเร็จ → เอกสารไปสร้างจริงใน FlowAccount (sandbox) + หน้า UI โชว่ "ส่งแล้ว ✓" พร้อมเวลา/เลขที่เอกสาร
- [ ] กดซ้ำ/สองแท็บพร้อมกัน (double-click, race) → สร้างเอกสารที่ FlowAccount **ได้แค่ครั้งเดียว**
- [ ] แก้บิลที่ synced แล้ว → เห็น flag/คำเตือน "แก้ไขแล้ว ควรส่งใหม่" ไม่เงียบ
- [ ] FlowAccount error/timeout → เก็บ error message สั้น ๆ + ปุ่ม "ลองส่งใหม่" ให้กดเอง (ไม่มี auto-retry เบื้องหลัง)
- [ ] ไม่ตั้ง env FlowAccount ครบ → ปุ่มไม่ error หน้าเว็บ (โหมด degrade แจ้ง "ยังไม่เปิดการเชื่อม" เหมือน `nova-sales-query`)
- [ ] `FLOWACCOUNT_CUSTOMER_ID` (ถ้าตั้ง) บังคับได้จริง — ลูกค้าอื่นกดส่งไม่ได้
- [ ] ทุก write path ผ่าน `requireAccountingAccess` + `assertCustomerInScope` (นักบัญชีส่งได้เฉพาะลูกค้าที่ตัวเองดูแล)
- [ ] ไม่มี `console.log`/log ใดที่มี payload เต็ม, เลขภาษี, ยอดเงิน, ชื่อลูกค้า (PDPA)
- [ ] ไม่มี secret ฝังในโค้ด (อ่านผ่าน `lib/env.ts` เท่านั้น)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

**Unit test (ครอบตาม T3–T7, T10 ข้างบน):**
- `flowaccount.ts`: not_configured (ไม่ยิง fetch), token fetch สำเร็จ/ล้ม, create document สำเร็จ/4xx/5xx/timeout/network error, cache token (ไม่ยิง token ซ้ำถ้ายังไม่หมดอายุ)
- `flowaccount-mapper.ts`: mapping ปกติ (ครบ VAT/ไม่มี VAT ผสมกันในใบเดียว), reject เมื่อไม่มีเลขภาษีลูกค้า/ไม่มี line ที่มีมูลค่า/ไม่มีวันที่บิล
- `flowaccount-sync.ts`: claim ปกติ, claim ซ้ำ (race) ถูกปฏิเสธ, business guard (draft/purchase/ไม่มีลูกค้า) ถูกปฏิเสธก่อนยิง, success/failure เขียนคอลัมน์+log ถูกต้อง
- `flowaccount-actions.ts`: guard สิทธิ์/สโคป/allowlist ทุกกรณี, ข้อความ error เป็นภาษาไทยสุภาพ ไม่หลุด internal

**Integration/manual (บน sandbox จริง — `https://openapi.flowaccount.com/test`):**
1. ตั้ง env sandbox ครบ → สร้างบิลขาย confirmed 1 ใบ (มีเลขภาษีลูกค้า) → กดส่ง → เช็คโผล่ในหน้า FlowAccount จริง
2. บิลขายที่ลูกค้า**ไม่มีเลขภาษี** → กดส่ง → ต้องเห็น error ชัดเจน ไม่ยิง fetch ไปเปล่า ๆ
3. จำลอง credential ผิด (`FLOWACCOUNT_CLIENT_SECRET` ผิด) → กดส่ง → เห็น error "auth_failed" ไม่ crash หน้า
4. จำลอง network ช้า/timeout (ปิด wifi ชั่วคราว หรือชี้ URL ผิด) → เห็น error + ปุ่ม "ลองส่งใหม่" ไม่ auto-retry
5. เปิด 2 แท็บ กดส่งบิลเดียวกันพร้อมกัน (หรือ double-click เร็ว ๆ) → ตรวจใน FlowAccount ว่าได้เอกสารใบเดียว
6. บิลที่ synced แล้ว → เข้าไปแก้ยอด/รายละเอียด → บันทึก → กลับมาดูสถานะต้องเห็นคำเตือน "ควรส่งใหม่"
7. staff นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → เปิดหน้า ต้องไม่เห็น/กดปุ่มส่งบิลของลูกค้าคนอื่นไม่ได้ (ทดสอบผ่าน session นักบัญชีจริง)
8. ตั้ง `FLOWACCOUNT_CUSTOMER_ID` เป็นลูกค้า A → บิลของลูกค้า B (แม้ confirmed+sale) ต้องกดส่งไม่ได้

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| Endpoint/payload จริงจาก Postman collection ไม่ตรงกับที่เดาไว้ (T0 ยืนยันไม่ทันหรือสเปกเปลี่ยน) | เขียน `buildUrl()`/payload builder แยกเป็นฟังก์ชันเดียวจุดเดียว (ตาม pattern `nova-sales-query.ts`) แก้ที่เดียวถ้าผิด; ไม่ block งานอื่น — เทสต์ยังผ่านด้วย fetch mock ระหว่างรอยืนยันจริง |
| ปม 1-credential-ต่อ-1-บริษัท ไม่ตรงกับโมเดล multi-customer ของ NOVA-CX | ล็อกด้วย `FLOWACCOUNT_CUSTOMER_ID` allowlist ใน M1 (ทำแล้วใน T2/T6); เลื่อนรองรับหลายบริษัทไปงานถัดไป (เก็บ credential เข้ารหัสต่อลูกค้า) |
| FlowAccount sandbox ไม่เสถียร/ปิดปรับปรุงช่วง dev | พัฒนา+เทสต์ด้วย fetch mock ทั้งหมดก่อน (T3–T7 ไม่ต้องพึ่ง sandbox จริง); manual sandbox test (T11) เป็นขั้นสุดท้ายเท่านั้น ไม่ block การพัฒนาหลัก |
| Timeout ที่ไม่รู้ผล (ยิงไปแล้วแต่ response ไม่ทันกลับ — เอกสารอาจถูกสร้างจริงที่ FlowAccount) | มาร์คเป็น `failed` (เพราะไม่รู้ผลจริง) ไม่มาร์ค `synced` มั่ว; ก่อนกด "ลองส่งใหม่" โชว์คำเตือนให้นักบัญชีเช็คในโปรแกรม FlowAccount ก่อน (M1 ยังไม่ทำ search-by-doc-no กันซ้ำอัตโนมัติ — ต้องเพิ่ม endpoint ค้นหาเอกสารซึ่งเกินขอบเขต M1) |
| แก้บิลที่ synced แล้ว ไม่มีทาง auto-update/auto-cancel เอกสารที่ FlowAccount | ขอบเขต M1 ตั้งใจแค่ "เตือน" (`needs_resync`) ให้คนไปจัดการที่โปรแกรม FlowAccount เอง — ไม่ auto-sync กลับ (สอดคล้องกับหลักการ manual-trigger ที่ analyst แนะนำ) |
| ผังบัญชี/หมวดภาษีของ FlowAccount ฝั่งขายไม่ตรงกับผังกลางของเรา (chart-of-accounts.ts) | M1 ไม่ส่ง account_code ของเราไป FlowAccount เลย (ส่งแค่ยอด/VAT/รายละเอียดสินค้าเป็น free-text) — เลี่ยงปัญหา mapping ผังบัญชีไปก่อน รอ M4 |

---

## 6) M2–M4 (สรุปสั้น — ทำต่อในอนาคต ไม่รวมใน M1)

**M2 — บิลซื้อ/ค่าใช้จ่าย (`entry_type='purchase'`)**
ใช้โครง sync-status เดิม (คอลัมน์/ตาราง log ที่ M1 ออกแบบไว้แล้วเป็น generic รองรับ `doc_type` อื่นได้)
เพิ่ม mapper ใหม่ map ไป `expensesApi`/`purchaseOrderApi` ของ FlowAccount — ยากกว่าฝั่งขายเพราะต้องรู้
หมวดค่าใช้จ่าย/ภาษีซื้อ (input VAT) ที่ FlowAccount ต้องการ ซึ่งอาจต้องพึ่ง M4 (chart mapping) มาก่อนบางส่วน

**M3 — Contacts (ข้อมูลลูกค้า)**
เมื่อนักบัญชียืนยัน/แก้ข้อมูลลูกค้าใน CX (ชื่อ/เลขภาษี/ที่อยู่) → push upsert ไป FlowAccount `contactsApi`
(pattern เดียวกับ `pushCustomerTaxId` ที่ส่งกลับ NOVA Sale) ต้องเก็บ `customers.flowaccount_contact_id`
ไว้ทำ idempotency (กันสร้าง contact ซ้ำทุกครั้งที่แก้)

**M4 — สินค้า/ผังบัญชี**
sync ผังบัญชีกลาง (`lib/accounting/chart-of-accounts.ts`) ไป FlowAccount `productsApi`/chart-of-accounts
endpoint แบบ bulk ครั้งเดียว (ไม่ใช่ manual ต่อบิล) — ต้องทำ mapping table ระหว่างรหัสบัญชีของเรา ↔
รหัสบัญชีฝั่ง FlowAccount (ไม่ตรง 1:1 แน่นอน) เก็บไว้ใน DB ตารางใหม่ (เช่น `chart_account_flowaccount_map`)

---

## 7) Backlog หลัง M1 — ฟีเจอร์ที่ FlowAccount มีแต่ NOVA-CX ยังไม่มี (ผู้ใช้ยืนยันลำดับ 2026-08-05)

ผู้ใช้ยืนยันแล้วว่า **ทำ M1 (sync FlowAccount) ให้จบก่อน** แล้วค่อยพัฒนาฟีเจอร์เหล่านี้เพิ่มในระบบ NOVA-CX เอง
(คนละเรื่องกับการ sync ไป FlowAccount — เป็นการ "เพิ่มความสามารถให้ NOVA-CX เทียบเท่า FlowAccount" ในจุดที่ยังขาด)
ทั้งหมดต้องผ่าน analyst → planner → ด่านอนุมัติแผน ก่อนเริ่มโค้ดเช่นเดียวกับ M1 นี้ — รายการนี้เป็นแค่ backlog เริ่มต้น
ยังไม่ใช่แผนละเอียด:

1. **สินค้า/บริการ (Products) + ผังบัญชีจริงในระบบ** — เพิ่มตาราง `products` (SKU/ราคา/หน่วย) และย้าย
   `lib/accounting/chart-of-accounts.ts` จาก hardcode ไปเป็นตาราง `chart_of_accounts` ที่แก้ได้ — เป็นฐานที่
   M2/M4 ข้างบนต้องใช้อยู่แล้ว จึงควรทำก่อนสามข้อถัดไป
2. **ใบหัก ณ ที่จ่าย (WHT Certificate)** — ออกเอกสารจริงจากข้อมูล `wht_rate/wht_amount` ที่มีอยู่แล้วใน
   `bill_entry_lines` (ปัจจุบันเก็บแค่ตัวเลข ไม่มีเอกสารออก) — ใกล้เคียง pattern ใบรับรองแทนใบเสร็จที่มีอยู่แล้ว
   (`receipt-cert/`)
3. **ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล (Quotation / PO / Billing Note)** — เอกสารช่วงก่อน-ระหว่างขาย-ซื้อ ที่ระบบ
   ยังไม่มีเลย (ตอนนี้ NOVA-CX จับบิลที่เกิดขึ้นแล้วเท่านั้น ไม่ได้ใช้ "ออก" เอกสารต้นทาง)
4. **งบการเงิน (P&L / งบแสดงฐานะการเงิน)** — ต่อยอดจากรายงานภาษี/สมุดรายวันที่มีอยู่ ประมวลจาก `bill_entries`
   ที่มีจริงในระบบ ไม่ต้องรอข้อมูลจากภายนอก

ลำดับความสำคัญยังไม่ระบุระหว่าง 4 ข้อนี้ — ต้องคุยกับผู้ใช้อีกครั้งตอนเริ่มรอบถัดไปว่าจะทำอันไหนก่อน
