# FlowAccount OpenAPI Integration — แผนงาน M1 (MVP: ส่งใบกำกับภาษี/ใบเสร็จขาย แบบ manual-trigger)

> ## ⛔ ยกเลิกทั้งระบบแล้ว (2026-08-27)
> **ผู้ใช้ตัดสินใจตัดการเชื่อม FlowAccount ออกทั้งหมด — ทำทุกอย่างในระบบ NOVA-CX ให้ครบแทน**
> (ฟีเจอร์บัญชีใน CX ครบแล้วตามโรดแมป docs/06 เฟส 1-10b จึงไม่จำเป็นต้อง sync ไปโปรแกรมภายนอกอีก)
>
> สิ่งที่ลบออกจากโค้ด (commit เดียวกับโน้ตนี้):
> - `lib/integrations/flowaccount.ts` / `flowaccount-mapper.ts` (REST client + mapper)
> - `lib/accounting/flowaccount-sync.ts` / `flowaccount-map.ts` (sync engine + mapping)
> - UI: ปุ่ม "ส่งไป FlowAccount" + คอลัมน์สถานะในตารางบิล, หน้า `flowaccount-map`,
>   ช่อง credential (client id/secret) ในแผงจัดการลูกค้า + `clearFlowAccountCredentialAction`
> - env: `getFlowAccountSharedConfig` (FLOWACCOUNT_TOKEN_URL/API_BASE_URL/SCOPE ไม่ถูกอ่านแล้ว
>   — ลบออกจาก Vercel/.env ได้)
>
> สิ่งที่ **ไม่ลบ** (non-destructive — ไม่มี migration ทำลายข้อมูล):
> - คอลัมน์ DB เดิม (`bill_entries.flowaccount_*`, `customers.flowaccount_client_id/_secret_enc`)
>   และตาราง log/mapping — ปล่อยเป็นคอลัมน์/ตารางว่างที่ไม่มีโค้ดอ่าน-เขียนอีกต่อไป
>
> เนื้อหาด้านล่างเก็บไว้เป็นประวัติการออกแบบเท่านั้น — อย่าใช้เป็น spec งานใหม่


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

> ⚠️ **อัปเดต (M2 — ดูหมวดท้ายไฟล์นี้)**: ข้อจำกัด 0.3 นี้ถูกยกเลิกแล้วในแผน M2 ข้างล่าง — ย้าย credential
> ไปเก็บเข้ารหัสต่อลูกค้าจริง `FLOWACCOUNT_CUSTOMER_ID`/`FLOWACCOUNT_CLIENT_ID`/`FLOWACCOUNT_CLIENT_SECRET`
> (env ระดับเดียว) **ถูกลบทิ้งทั้งหมด** หลัง M2 เสร็จ

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

> ⚠️ **หมายเหตุ**: ป้าย "M2" ในหัวข้อนี้เขียนไว้ตอนวางแผน M1 (ยังไม่ตัดสินใจลำดับ M2 จริง) — ลำดับจริงที่ทำ
> ต่อจาก M1 คือ **"FlowAccount credential ต่อลูกค้า"** (ดูหมวดท้ายไฟล์นี้) ไม่ใช่บิลซื้อ/ค่าใช้จ่ายตามที่ร่างไว้ตรงนี้
> — บิลซื้อ/ค่าใช้จ่ายเลื่อนไปเป็นงานถัดไปหลังรองรับหลายบริษัทเสร็จ

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

---
---

# M2 — FlowAccount credential ต่อลูกค้า (แผนละเอียด)

M1 (ข้างบน) merge เข้า `main` แล้ว — โครง sync (`bill_entries.flowaccount_*`, `flowaccount_sync_log`,
claim แบบ atomic, client/mapper/orchestration) ใช้ต่อได้เลยทั้งหมด **M2 นี้ไม่แตะ business logic การสร้าง
เอกสาร/การ claim/การ map เลย** — แก้แค่ "credential มาจากไหน" จาก env กลางตัวเดียว (1 บริษัท) →
เก็บเข้ารหัสต่อลูกค้าแต่ละราย (หลายบริษัทพร้อมกันได้จริง) ตามที่ analyst วิเคราะห์ไว้แล้ว (สรุปซ้ำเป็น decision
ล็อกไว้ในหมวด 0 ด้านล่าง — ไม่วิเคราะห์ซ้ำ)

เลขงาน: **ต่อจาก M1 (T0–T11) → เริ่มที่ T12**

---

## 0) การตัดสินใจที่ล็อกไว้ก่อนเริ่มโค้ด (จาก input วิเคราะห์ + ตัดสินใจเพิ่มของ planner)

### 0.1 encryption — ใช้ `lib/crypto/field.ts` เดิม ไม่สร้างใหม่
`encryptField()`/`decryptField()`/`hasEncKey()` (AES-256-GCM, token `v1:<iv>.<tag>.<ciphertext>`,
derive จาก `CREDENTIAL_ENC_KEY`) ใช้เข้ารหัส/ถอดรหัส `flowaccount_client_secret_enc` ได้ตรง ๆ

### 0.2 schema — เพิ่ม 2 คอลัมน์บน `customers` แบบ non-destructive (pattern 0058/0059)
- `flowaccount_client_id text` — เก็บเป็น **plain text** (เทียบเท่า "username"/public identifier ไม่ใช่ secret)
- `flowaccount_client_secret_enc text` — เก็บเป็น **ciphertext** (`encryptField()` แล้วเท่านั้น — ห้ามมี
  plaintext ลงคอลัมน์นี้เด็ดขาดในทุก code path)
- ทั้งคู่ nullable — ลูกค้าที่ยังไม่กรอก = ยังไม่เปิดใช้การเชื่อมต่อ (ไม่กระทบลูกค้ารายอื่น)

### 0.3 credential ไหลจาก DB → client เป็นพารามิเตอร์ (ไม่ใช่ module อ่าน env เอง)
เปลี่ยน `lib/env.ts::getFlowAccountConfig()` (เดิมอ่าน clientId/secret จาก env รวมกับ
tokenUrl/apiBaseUrl/scope) → แยกเป็น 2 ส่วน:
- **`getFlowAccountSharedConfig()`** (env กลาง — เหมือนกันทุกบริษัท): `tokenUrl` / `apiBaseUrl` / `scope`
- **`FlowAccountCredential`** (`{ clientId, clientSecret }`) — มาจาก DB ต่อลูกค้า ไม่ใช่ env อีกต่อไป —
  ประกาศ type นี้ใน `lib/integrations/flowaccount.ts` (ไม่ใช่ `env.ts` เพราะไม่ได้มาจาก env)

`getAccessToken()` / `createSalesDocument()` **ต้องรับ `credential` เป็นพารามิเตอร์** แทนที่จะดึงเอง —
caller (`flowaccount-sync.ts`) เป็นคนโหลด+ถอดรหัส credential ของลูกค้ารายนั้นแล้วส่งเข้ามา

### 0.4 ⚠️ token cache ต้อง keyed by `clientId` — จุดเสี่ยงบั๊ก cross-tenant ที่ร้ายแรงที่สุดของ M2
เดิม M1 มี `cachedToken` เป็นตัวแปร module-level ตัวเดียว (สมมติว่ามีลูกค้าเดียวทั้งระบบ) — ถ้าไม่แก้จุดนี้
พอมี 2 บริษัทพร้อมกัน **token ของลูกค้า A จะถูกนำไปยิงสร้างเอกสารให้ลูกค้า B โดยไม่ตั้งใจ** (เอกสารไปโผล่ผิด
บัญชี FlowAccount ของลูกค้า) — เปลี่ยนเป็น `Map<clientId, {accessToken, expiresAtMs}>` และมี **unit test พิสูจน์
ตรง ๆ ว่า credential 2 ตัวไม่ปนกัน** (ดูหมวด 4 — เป็นเทสต์บังคับ ไม่ใช่ nice-to-have)

### 0.5 ลบ `FLOWACCOUNT_CUSTOMER_ID` allowlist ทิ้งทั้งหมด (ไม่จำเป็นอีกต่อไป)
เมื่อ credential แยกตามลูกค้าโดยธรรมชาติแล้ว (ลูกค้าไม่มี credential = sync ไม่ได้เอง) allowlist เดิมที่จำกัด
"1 บริษัทเท่านั้น" ไม่มีประโยชน์อีกต่อไป — ลบ:
- `getFlowAccountAllowedCustomerId()` ออกจาก `lib/env.ts`
- allowlist block ทั้งก้อนใน `app/chat-audit/accounting/flowaccount-actions.ts`
- `FLOWACCOUNT_CUSTOMER_ID` ออกจาก `.env.example`
- `FLOWACCOUNT_CLIENT_ID` / `FLOWACCOUNT_CLIENT_SECRET` (env กลาง) ออกจาก `.env.example` ด้วย —
  ย้ายไปกรอกต่อลูกค้าในหน้าเว็บแทน (เหลือแค่ `FLOWACCOUNT_TOKEN_URL`/`FLOWACCOUNT_API_BASE_URL`/`FLOWACCOUNT_SCOPE`
  เป็น env กลาง)

### 0.6 สิทธิ์แก้ credential — ใช้ guard เดิมของ `updateCustomerFieldsAction` (ผู้ใช้ยืนยันแล้ว 2026-08-07)
นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น (`assertCustomerInScope`) แก้ได้ ไม่ใช่ admin-only — **ไม่แยก server
action ใหม่** เพิ่มเป็นฟิลด์ใน `UpdateCustomerFieldsInput` ของ action เดิมเลย (เหมือน address/phone)

### 0.7 UI: client_secret ห้ามโชว์ค่ากลับมาเด็ดขาด — "แก้ไข" = พิมพ์ค่าใหม่ทับ ไม่ใช่แก้ค่าเดิม
`flowaccount_client_secret_enc` เทียบเท่ารหัสผ่านเข้าบัญชี FlowAccount ของลูกค้า:
- server **ไม่เคย** ส่ง `decryptField()` แล้วออกไปให้ browser (ไม่ผ่าน props/JSON/console เด็ดขาด)
- ฟอร์มส่งแค่ **`hasSecret: boolean`** (มี/ไม่มี ciphertext อยู่) ให้ client component โชว์สถานะ
  ("ตั้งค่าไว้แล้ว" / "ยังไม่ตั้งค่า") — ช่อง input ของ secret **เริ่มต้นว่างเสมอ** ไม่ prefill
- ผลตามมา: ต้องแยกความหมาย "เว้นว่างไว้ = ไม่แตะ" ออกจาก "ต้องการล้างค่า" อย่างชัดเจน (ต่างจาก
  address/phone ที่ `""` = ล้างได้เลยเพราะ prefill ค่าจริงไว้ในฟอร์ม) — ดูรายละเอียดการออกแบบใน T21

---

## 1) โครงสร้างไฟล์ (ใหม่/แก้) — M2

```
supabase/migrations/
  0062_customers_flowaccount_credential.sql   [ใหม่] customers.flowaccount_client_id (text)
                                                       + customers.flowaccount_client_secret_enc (text)

lib/
  env.ts                                       [แก้] ลบ getFlowAccountConfig()/getFlowAccountAllowedCustomerId()
                                                       เพิ่ม getFlowAccountSharedConfig()
  integrations/
    flowaccount.ts                             [แก้] getAccessToken(credential)/createSalesDocument(payload, credential)
                                                       รับ credential เป็นพารามิเตอร์ + token cache → Map keyed by clientId
  accounting/
    flowaccount-sync.ts                        [แก้] โหลด+ถอดรหัส credential ของลูกค้า → ส่งต่อให้ client
                                                       เพิ่ม reason ใหม่ customer_not_configured

app/chat-audit/accounting/
  flowaccount-actions.ts                       [แก้] ลบ allowlist FLOWACCOUNT_CUSTOMER_ID ทั้งก้อน
  customer-admin-actions.ts                    [แก้] เพิ่มฟิลด์ flowaccountClientId/flowaccountClientSecret
                                                       ใน updateCustomerFieldsAction (ไม่ใช่ action ใหม่)
  CustomerAdminControls.tsx                    [แก้] เพิ่ม UI กรอก client id/secret (secret มี "ล้างรหัสลับ" แยก)
  page.tsx                                     [แก้] เพิ่ม fetchCustomerFlowAccountStatus() + ส่ง prop

tests/
  integrations/flowaccount.test.ts             [แก้ทั้งไฟล์] อัปเดต signature ทุกเทสต์เดิม + เพิ่มเทสต์ cache แยกตาม clientId
  accounting/flowaccount-sync.test.ts          [แก้] เพิ่มเคส customer_not_configured / ถอดรหัสล้มเหลว / ส่ง credential ถูกต้อง
  accounting/flowaccount-actions.test.ts       [แก้] ลบเทสต์ allowlist เดิม + เพิ่มเคส customer_not_configured
  accounting/customer-admin-actions.test.ts    [ใหม่] ครอบ encrypt/clear/no-op/ไม่มี CREDENTIAL_ENC_KEY

.env.example                                   [แก้] ลบ FLOWACCOUNT_CUSTOMER_ID/FLOWACCOUNT_CLIENT_ID/
                                                       FLOWACCOUNT_CLIENT_SECRET · อัปเดตคอมเมนต์อธิบายว่า
                                                       credential ย้ายไปกรอกต่อลูกค้าในหน้าเว็บแล้ว
```

### 1.1 Schema ใหม่ (migration 0062) — ร่าง SQL

```sql
alter table public.customers
  add column if not exists flowaccount_client_id text,
  add column if not exists flowaccount_client_secret_enc text;

comment on column public.customers.flowaccount_client_id is
  'FlowAccount OAuth client_id ของลูกค้ารายนี้ (plain — ไม่ใช่ secret)';
comment on column public.customers.flowaccount_client_secret_enc is
  'FlowAccount OAuth client_secret — เข้ารหัสด้วย lib/crypto/field.ts (encryptField) เท่านั้น ห้าม plaintext';

notify pgrst, 'reload schema';
```
(ไม่มี RLS ใหม่ — ใช้ policy เดิมของ `customers` เหมือน 0058/0059; ดูหมายเหตุความเสี่ยงเรื่อง RLS ในหมวด 5)

---

## 2) งานย่อยเรียงลำดับ (M2)

| รหัส | สิ่งที่ต้องทำ | ไฟล์ | ขึ้นกับ | เกณฑ์เสร็จ (DoD) |
|---|---|---|---|---|
| **T12** | Migration 0062 — เพิ่ม `flowaccount_client_id` (text) + `flowaccount_client_secret_enc` (text) บน `customers` | `supabase/migrations/0062_customers_flowaccount_credential.sql` | - | apply บน sandbox DB ไม่ error; `notify pgrst,'reload schema'`; รันเทสต์เดิมทั้งหมดผ่าน (ไม่กระทบ query/flow เดิมของ `customers`) |
| **T13** | `lib/env.ts` — ลบ `getFlowAccountConfig()`/`getFlowAccountAllowedCustomerId()` เพิ่ม `getFlowAccountSharedConfig()` (คืน `null` ถ้าขาด tokenUrl/apiBaseUrl/scope ตัวใดตัวหนึ่ง) | `lib/env.ts` | T12 | unit test ใหม่ครอบ `getFlowAccountSharedConfig` (ครบ/ขาด); `grep -rn "getFlowAccountConfig\|getFlowAccountAllowedCustomerId"` ในโค้ด production (นอกเทสต์) ต้องว่างเปล่า; typecheck ผ่าน |
| **T14** | `lib/integrations/flowaccount.ts` — เปลี่ยน `getAccessToken(credential)` / `createSalesDocument(payload, credential)` ให้รับ `FlowAccountCredential` เป็นพารามิเตอร์; ดึง shared config เองจาก `getFlowAccountSharedConfig()`; **token cache: `cachedToken` (ตัวแปรเดี่ยว) → `Map<string, {accessToken, expiresAtMs}>` keyed by `credential.clientId`**; `__resetFlowAccountTokenCacheForTests()` ล้างทั้ง map | `lib/integrations/flowaccount.ts` | T13 | ไม่ตั้ง shared config → `not_configured` แม้ credential ครบ (ไม่ยิง fetch); credential ต่างกัน → cache แยกกันจริง (ดู T-test บังคับในหมวด 4); ไม่ log `clientSecret`/`accessToken` เต็มค่า (log แค่ status/reason เหมือนเดิม) |
| **T15** | `lib/accounting/flowaccount-sync.ts` — select เพิ่ม `flowaccount_client_id, flowaccount_client_secret_enc` จาก `customers`; ถอดรหัสด้วย `decryptField` (จับ throw ทุกกรณี — คีย์ไม่ตั้ง/ciphertext เพี้ยน/ไม่มี client_id หรือ secret); ไม่ครบ → reason ใหม่ `customer_not_configured`; ส่ง credential ต่อให้ `createSalesDocument(payload, credential)` | `lib/accounting/flowaccount-sync.ts` | T12, T14 | เพิ่ม `customer_not_configured` ใน `SyncRejectReason` + `REASON_LABEL` ("ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount"); เช็ค credential เกิด**หลัง claim** (สอดคล้อง pattern เดิมที่ business guard บนคอลัมน์ `bill_entries` เช็คก่อน claim ส่วน guard ที่ต้องโหลด `customers` เช็คหลัง claim) → เขียน `failed` + insert log เหมือน mapper reject เดิม; ไม่ log ciphertext/plaintext ของ secret ที่ใดเลย |
| **T16** | `app/chat-audit/accounting/flowaccount-actions.ts` — ลบ import `getFlowAccountAllowedCustomerId` + ลบ allowlist block ทั้งก้อน; เพิ่มข้อความ `customer_not_configured` ใน `REASON_MESSAGE` | `flowaccount-actions.ts` | T15 | ปุ่มส่งได้ตามสโคปนักบัญชีอย่างเดียว (ไม่มี allowlist เพิ่มอีกชั้น); ข้อความ error สุภาพ ไม่หลุด reason ดิบ |
| **T17** | `.env.example` — ลบ `FLOWACCOUNT_CUSTOMER_ID`/`FLOWACCOUNT_CLIENT_ID`/`FLOWACCOUNT_CLIENT_SECRET`; แก้คอมเมนต์หมวด FlowAccount อธิบายว่า credential ย้ายไปกรอกต่อลูกค้าที่หน้า `/chat-audit/accounting` แล้ว (เหลือ `FLOWACCOUNT_TOKEN_URL`/`FLOWACCOUNT_API_BASE_URL`/`FLOWACCOUNT_SCOPE` เป็น env กลาง) | `.env.example` | T13 | ตรวจด้วยตา — ไม่มี env credential ต่อบริษัทหลงเหลือ; ไม่ลบ `CREDENTIAL_ENC_KEY` (ยังใช้อยู่) |
| **T18** | อัปเดตเทสต์เดิมที่พังจากเปลี่ยน signature — `tests/integrations/flowaccount.test.ts` (เขียนใหม่ทั้งไฟล์ตาม signature ใหม่) + `tests/accounting/flowaccount-sync.test.ts` (เพิ่มเคส) + `tests/accounting/flowaccount-actions.test.ts` (ลบเคส allowlist, เพิ่ม `customer_not_configured`) | 3 ไฟล์เทสต์ข้างต้น | T14, T15, T16 | ทุกไฟล์ผ่าน `npm run test`; **มี unit test พิสูจน์ token cache แยกตาม clientId ตรง ๆ** (รายละเอียด test case บังคับในหมวด 4) — ถือเป็นเกณฑ์เสร็จเดี่ยว ๆ ของ task นี้ ขาดไม่ได้ |
| **T19** | `app/chat-audit/accounting/customer-admin-actions.ts` — เพิ่ม `flowaccountClientId?: string \| null` และ `flowaccountClientSecret?: string \| null` ใน `UpdateCustomerFieldsInput`; clientId เขียนแบบ best-effort เหมือน address/phone (`""` = ล้าง, `undefined` = ไม่แตะ); secret: `""` = ล้าง (`null`), ค่าไม่ว่าง = ต้อง `hasEncKey()` ก่อน ถ้าไม่มี key → คืน `{ok:false}` พร้อมข้อความชัดเจน **ห้าม fallback เขียน plaintext เด็ดขาด**, มี key → `encryptField()` แล้วค่อยเขียน; response message ไม่มี plaintext/ciphertext ของ secret ปนอยู่ | `customer-admin-actions.ts` | T12 | เพิ่ม `tests/accounting/customer-admin-actions.test.ts` (ใหม่) ครอบ: ตั้ง secret ใหม่ → เขียน ciphertext ที่ `decryptField()` กลับมาได้ค่าตรงกับที่กรอก, ล้าง secret (`""`) → เขียน `null`, ไม่ส่ง field มา → ไม่แตะคอลัมน์เลย, ตั้ง secret ตอนไม่มี `CREDENTIAL_ENC_KEY` → `ok:false` + **DB ไม่ถูกเขียนเลย** (ยืนยันด้วย mock ops ว่าไม่มี update ที่มี plaintext), migration ยังไม่ apply (คอลัมน์ไม่มี) → degrade เหมือน address/phone (save ช่องอื่นสำเร็จ + note เตือน) |
| **T20** | `app/chat-audit/accounting/page.tsx` — เพิ่ม `fetchCustomerFlowAccountStatus(service, tenantId, ids)` (best-effort try/catch แบบ `fetchCustomerAddresses`) คืน `Map<string, {clientId: string \| null; hasSecret: boolean}>` — select `id, flowaccount_client_id, flowaccount_client_secret_enc` แต่ **map ต้องไม่เก็บค่า secret_enc ดิบไว้ที่ไหนเลยนอกฟังก์ชันนี้** (แปลงเป็น boolean ทันที) → wire เข้า `Promise.all` เดิม + ส่ง prop ให้ `CustomerAdminControls` | `page.tsx` | T12 | คอลัมน์ยังไม่ apply migration → คืน map ว่าง ไม่ crash หน้า (เหมือน address/phone); ciphertext ไม่หลุดออกไปใน props ที่ serialize ไป client component (ตรวจด้วย grep และอ่าน rendered HTML/JSON ตอน dev ว่าไม่มี `v1:` ciphertext token โผล่) |
| **T21** | `CustomerAdminControls.tsx` — เพิ่มช่อง "FlowAccount Client ID" (prefill ได้เหมือน phone, `""`=ล้าง) + ช่อง "FlowAccount Client Secret" **เริ่มว่างเสมอ** พร้อม checkbox/ปุ่ม "ล้างรหัสลับ" แยกต่างหาก + ข้อความสถานะ ("เชื่อมต่อไว้แล้ว"/"ยังไม่ได้ตั้งค่า" จาก `hasSecret`); ตอน submit: ส่ง key `flowaccountClientSecret` เฉพาะเมื่อผู้ใช้พิมพ์ค่าใหม่ หรือกด "ล้างรหัสลับ" เท่านั้น — ถ้าเว้นว่างไว้เฉย ๆ **ห้ามส่ง key นี้ไปเลย** (ไม่ใช่ส่ง `undefined`/`""` เข้าใจผิดเป็นล้าง) | `CustomerAdminControls.tsx` | T19, T20 | ทดสอบมือ: กรอก secret ใหม่ + บันทึก → รีเฟรชหน้า → ช่อง secret ต้องว่างอีกครั้ง (ไม่โชว์ค่าเดิม) + สถานะขึ้น "เชื่อมต่อไว้แล้ว"; เว้นว่าง secret ไว้แล้วกดบันทึก (แก้แค่ client id) → secret เดิมไม่หาย (ทดสอบด้วย sync จริงว่ายังส่งได้); กดล้างรหัสลับ → `hasSecret=false`; typecheck+lint ผ่าน; **grep โค้ดหน้านี้ + devtools network tab ต้องไม่มี ciphertext/plaintext ของ secret หลุดออกมาเลย** |

**Milestone**:
- **M2-A (backend, headless)**: T12–T18 — รองรับหลายบริษัทได้สมบูรณ์ระดับ data layer + client แล้ว
  ทดสอบผ่าน unit/integration test ล้วน (ยังไม่มี UI ให้กรอก credential จริง — ทดสอบผ่าน DB ตรงหรือ script ได้)
- **M2-B (UI ใช้งานจริง)**: T19–T21 — นักบัญชีกรอก credential ผ่านหน้าเว็บได้เอง ไม่ต้องพึ่ง env/admin เข้า DB ตรง
- **M2-C (verify + rollout)**: T22 (ด้านล่าง)

| **T22** | รันชุดตรวจสอบเต็ม + ทดสอบมือ multi-customer จริง + ขั้นตอน rollout (ดูหมวด 5 เรื่อง cutover จาก env เดิม) | ทั้งหมดข้างบน | T12–T21 | `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด (ไม่มี error/warning ใหม่); ทดสอบมือหัวข้อ 4.2 ครบทุกข้อ; ยืนยันว่าไม่มีลูกค้ารายเดิม (ถ้ามีที่ใช้งานจริงผ่าน env M1) ตกค้างไม่มี credential ใน DB ก่อนปิดการอ่าน env เดิม |

---

## 3) Definition of Done (M2 รวม)

- [ ] นักบัญชี/หัวหน้าที่ดูแลลูกค้า (หรือ admin) กรอก FlowAccount client id/secret ต่อลูกค้าแต่ละรายได้เองผ่าน
      หน้า `/chat-audit/accounting` ไม่ต้องพึ่งผู้ดูแลระบบตั้ง env
- [ ] ลูกค้า 2 บริษัทขึ้นไป กด "ส่งไป FlowAccount" **พร้อมกัน/ใกล้เคียงกัน** → เอกสารของแต่ละบริษัทไปลง
      บัญชี FlowAccount ที่ถูกต้องตรงกับ credential ของบริษัทนั้นเสมอ — **ไม่มีการปนกันข้ามลูกค้าแม้แต่ครั้งเดียว**
- [ ] ลูกค้าที่ยังไม่กรอก credential → กดปุ่มส่งได้ผลลัพธ์ชัดเจน "ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount"
      ไม่ crash ไม่ทำให้ลูกค้ารายอื่นกระทบ
- [ ] `flowaccount_client_secret_enc` ไม่เคยปรากฏเป็น plaintext ที่ใดเลย: ไม่อยู่ใน log, ไม่อยู่ใน response ของ
      server action ใด ๆ, ไม่ถูกส่งไป client component (ตรวจด้วย grep + manual devtools check)
- [ ] ตั้ง secret ใหม่โดยไม่มี `CREDENTIAL_ENC_KEY` → ปฏิเสธชัดเจน **ไม่มี fallback เขียน plaintext ลง DB เด็ดขาด**
- [ ] แก้ credential ได้ตามสโคปเดิม (`assertCustomerInScope`) — นักบัญชีแก้ credential ลูกค้านอกสโคปไม่ได้
- [ ] ลบ `FLOWACCOUNT_CUSTOMER_ID` allowlist logic ออกจากโค้ดจริงหมดแล้ว (ไม่ใช่แค่ comment out)
- [ ] `.env.example` ไม่มี `FLOWACCOUNT_CLIENT_ID`/`FLOWACCOUNT_CLIENT_SECRET`/`FLOWACCOUNT_CUSTOMER_ID` หลงเหลือ
- [ ] ไม่มี `console.log`/log ใดที่มี client_secret (plaintext หรือ ciphertext), เลขภาษี, ยอดเงิน, ชื่อลูกค้า (PDPA)
- [ ] ไม่มี mock/stub ปนอยู่ใน critical flow ของโค้ด production (mock ใช้ในเทสต์เท่านั้น)
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` ผ่านทั้งหมด ไม่มี error/warning ใหม่
- [ ] ก่อนปิดการอ่าน env credential เดิม (ถ้ามีลูกค้าที่ใช้งานจริงผ่าน M1 env-based อยู่ก่อนแล้ว) ต้องกรอก
      credential ของลูกค้ารายนั้นเข้า DB ให้เรียบร้อยก่อน/ทันทีตอน deploy (ดูหมวด 5)

---

## 4) แนวทางการทดสอบ (สำหรับ tester)

### 4.1 Unit test — จุดที่ต้องครอบ (ต่อ T14–T19)

**`flowaccount.ts` (T14, T18) — สำคัญที่สุดของ M2:**
- ไม่ตั้ง `getFlowAccountSharedConfig()` (env กลางขาด) → `not_configured` แม้ `credential` ที่ส่งเข้ามาครบ
- **★ เทสต์บังคับ — token cache แยกตาม clientId (พิสูจน์ cross-tenant ไม่ปนกัน)**:
  1. `getAccessToken(credentialA)` → คืน `tokenA`, ยิง fetch 1 ครั้ง
  2. `getAccessToken(credentialA)` ซ้ำ (ก่อนหมดอายุ) → คืน `tokenA` จาก cache, **ไม่ยิง fetch เพิ่ม**
  3. `getAccessToken(credentialB)` (clientId ต่างกัน) → ต้อง**ยิง fetch ใหม่** (ไม่ใช้ cache ของ A) และคืน `tokenB`
     (mock fetch แยกผลตามค่า `client_id` ใน form body ของแต่ละ request — ไม่ใช่แยกตามลำดับเรียกเฉย ๆ)
  4. `getAccessToken(credentialA)` เรียกอีกครั้งหลังจากขอ B ไปแล้ว → ยังได้ `tokenA` ที่ถูกต้อง (ไม่ใช่ `tokenB`
     รั่วมาทับ cache ของ A)
- **★ เทสต์บังคับ — `createSalesDocument` ยิง concurrent สองลูกค้าแล้ว Bearer token ต้องไม่สลับกัน**:
  ยิง `Promise.all([createSalesDocument(payloadA, credentialA), createSalesDocument(payloadB, credentialB)])`
  พร้อมกัน (mock fetch คืนค่าตาม body/URL ที่ส่งมาจริง ไม่ใช่ตามลำดับ call) → ตรวจ header
  `Authorization` ของ request ที่ยิงไป endpoint ของ A ต้องเป็น `Bearer tokenA` เท่านั้น (และของ B เป็น
  `Bearer tokenB` เท่านั้น) — ทดสอบนี้จำลองสถานการณ์ 2 นักบัญชีกดส่งบิลคนละบริษัทพร้อมกันจริงบน instance เดียวกัน
- ย้ายเคสเดิมทั้งหมดของ M1 (401/403/4xx/5xx/timeout/network/response ไม่มี id) มาปรับ signature ให้ส่ง
  `credential` เข้าไปด้วย — ผลลัพธ์ยังต้องเหมือนเดิมทุกเคส

**`flowaccount-sync.ts` (T15, T18):**
- ลูกค้าไม่มี `flowaccount_client_id`/`flowaccount_client_secret_enc` (เป็น `null` ทั้งคู่) → `customer_not_configured`
  หลัง claim, เขียน `failed` + insert log, **ไม่เรียก `createSalesDocument`**
- ลูกค้ามี `client_id` แต่ `client_secret_enc` เป็น `null` (กรอกไม่ครบ) → `customer_not_configured` เช่นกัน
- `client_secret_enc` เป็น ciphertext ที่ decrypt ไม่ได้ (คนละคีย์/เพี้ยน — จำลองด้วยสตริงมั่ว) → จับ throw จาก
  `decryptField` ได้ → `customer_not_configured` (ไม่ throw ทะลุขึ้นไปทำให้ทั้ง request 500)
- success path: mock `createSalesDocument` แล้วตรวจว่าถูกเรียกด้วย `credential.clientId`/`clientSecret`
  ที่ตรงกับค่าที่ decrypt ได้จริงจากแถวลูกค้านั้น (ไม่ใช่ credential ของลูกค้าอื่นที่ mock ไว้ในเคสอื่น)
- ย้ายเคสเดิมของ M1 ทั้งหมด (not_found/not_sale/not_confirmed/missing_customer/already_syncing/mapper reject
  ทั้ง 3 แบบ/success/failure) ให้ยังผ่านเหมือนเดิม (เพิ่มแค่ mock ลูกค้าให้มี credential ครบในเคสที่ต้องไปถึง client)

**`flowaccount-actions.ts` (T16, T18):**
- ลบเคส allowlist เดิมทั้งหมด (`FLOWACCOUNT_CUSTOMER_ID`)
- เพิ่มเคส `customer_not_configured` → ข้อความ "ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount"
- เคสสโคปนักบัญชี (in-scope/out-of-scope) ของ M1 ยังต้องผ่านเหมือนเดิมทุกเคส

**`customer-admin-actions.ts` (T19 — ไฟล์ใหม่):**
- ตั้ง `flowaccountClientSecret` ค่าใหม่ (มี `CREDENTIAL_ENC_KEY` ใน test env) → เขียนคอลัมน์ด้วยค่าที่
  `decryptField()` แล้วตรงกับ plaintext ที่ส่งเข้าไป (round-trip จริง ไม่ mock `encryptField`/`decryptField`)
- ตั้ง `flowaccountClientSecret: ""` → เขียน `null` (ล้าง)
- ไม่ส่ง `flowaccountClientSecret` มาเลย (`undefined`) → ไม่มี `update` เรียกคอลัมน์นี้เลย
- ลบ `process.env.CREDENTIAL_ENC_KEY` ก่อนเทสต์ แล้วส่งค่าใหม่ที่ไม่ว่าง → คืน `{ok:false}` +
  **ยืนยันด้วย mock ops ว่าไม่มีการ `update` คอลัมน์ secret เกิดขึ้นเลย** (กันเขียน plaintext หลุด)
- migration ยังไม่ apply (จำลอง error จาก update คอลัมน์ client_id/secret) → save ช่องอื่น (ชื่อ/เลขภาษี) ยัง
  สำเร็จตามปกติ (degrade เหมือน address/phone)
- สโคป: นักบัญชีนอกสโคปแก้ credential ลูกค้าไม่ได้ (`assertCustomerInScope` throw)

### 4.2 Integration/manual (บน sandbox จริง หรือ credential ปลอมที่ควบคุมผลได้)

1. สร้างลูกค้า A + กรอก credential จริง (sandbox) ผ่านหน้าเว็บ → กดส่งบิลขาย confirmed 1 ใบ → เอกสารโผล่ใน
   FlowAccount ของบัญชี A จริง
2. สร้างลูกค้า B + กรอก credential **คนละชุด** (เช่น sandbox account อื่น หรือค่าผิดโดยตั้งใจ) → กดส่งบิลของ B
   → ต้องไม่โผล่ในบัญชี A และถ้า credential ผิดจริงต้องเห็น `auth_failed` ของ B เท่านั้น ไม่กระทบ A
3. **ทดสอบ concurrency จริง**: เปิด 2 browser session (นักบัญชีคนละคนหรือ tab คนละลูกค้า) กดส่งบิลของ A และ B
   พร้อมกันในเวลาไล่เลี่ยกัน (ภายใน 1-2 วินาที) → ตรวจใน FlowAccount ทั้งสองบัญชีว่าได้เอกสารถูกบัญชีตรงคนละใบ
   ไม่มีใบไหนไปโผล่ผิดบัญชี
4. ลูกค้า C ยังไม่กรอก credential เลย → กดส่ง → เห็นข้อความ "ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount" ทันที
5. กรอก client secret ใหม่ให้ลูกค้า A แล้วบันทึก → รีเฟรชหน้า → ช่อง secret ต้องว่าง (ไม่โชว์ค่าเดิม) —
   เปิด devtools Network tab ตรวจ response ของ server action ว่าไม่มี ciphertext/plaintext ของ secret
6. staff นักบัญชีที่ไม่ได้ดูแลลูกค้า A → เปิดฟอร์มแก้ลูกค้า A ไม่ได้/แก้ credential ไม่ได้ (สโคปเดิม)
7. ปิด `CREDENTIAL_ENC_KEY` ชั่วคราวใน env ทดสอบ (dev เท่านั้น) → ลองตั้ง client secret ใหม่ → ต้องเห็น error
   ชัดเจน ไม่เงียบเขียน plaintext ลง DB (เช็คใน DB ตรง ๆ ว่าคอลัมน์ยังเป็นค่าก่อนหน้า/null)

---

## 5) ความเสี่ยงของแผน & แผนสำรอง

| ความเสี่ยง | แผนสำรอง |
|---|---|
| **Token cache ปนกันข้ามลูกค้า** (ความเสี่ยงหลักของ M2 ทั้งแผน) — ถ้า refactor พลาดจุดใดจุดหนึ่งใน T14 เอกสารของลูกค้า A อาจไปสร้างผิดบัญชี FlowAccount ของลูกค้า B โดยไม่มีใครรู้ทันที (ไม่ error ให้เห็น) | บังคับมี unit test พิสูจน์ตรง ๆ ตามหมวด 4.1 (เทสต์ concurrent สองเครดิต) เป็นเกณฑ์เสร็จของ T18 ที่ขาดไม่ได้ + manual concurrency test จริงในหมวด 4.2 ข้อ 3 ก่อนถือว่า M2 เสร็จ; code review เน้นจุดเดียว: ไม่มี module-level state ตัวเดียวเหลืออยู่ใน `flowaccount.ts` เลย (grep หา `let cachedToken` ต้องไม่เจอ) |
| **Rollout/cutover จาก env เดิม** — ถ้ามีลูกค้าที่ใช้งานจริงผ่าน M1 (`FLOWACCOUNT_CLIENT_ID/SECRET` env + `FLOWACCOUNT_CUSTOMER_ID` allowlist) อยู่ก่อน deploy M2 → พอ deploy เสร็จ ลูกค้ารายนั้นจะ**หยุดส่งได้ทันที**จนกว่าจะมีคนกรอก credential เดิมเข้า DB ให้ (เพราะ env ถูกลบไม่อ่านอีกแล้ว) | ก่อน deploy M2 เช็คว่ามี `FLOWACCOUNT_CUSTOMER_ID` ตั้งอยู่จริงใน production หรือไม่ ถ้ามี → เตรียม copy ค่า `FLOWACCOUNT_CLIENT_ID`/`FLOWACCOUNT_CLIENT_SECRET` เดิมไว้ แล้วกรอกให้ลูกค้ารายนั้นผ่านหน้าเว็บทันทีในนาทีที่ deploy เสร็จ (ก่อนนักบัญชีกดส่งบิลถัดไป) — ถือเป็นขั้นตอน manual รวมอยู่ใน T22 |
| **RLS ของ `customers`** อนุญาต `authenticated` (admin/executive Supabase Auth) select แถวที่ `can_access_customer(id)` ผ่าน — แปลว่า `flowaccount_client_secret_enc` (ciphertext) selectable ได้ตรงถ้ามีคน query ตารางนี้ตรงผ่าน client ฝั่ง browser (ปกติแอปไม่ทำแบบนี้ แต่เป็นช่องโหว่เชิงทฤษฎี) | ciphertext เข้ารหัสอยู่แล้ว (AES-256-GCM) ต่อให้ select ออกไปได้ก็ยังถอดไม่ได้ถ้าไม่มี `CREDENTIAL_ENC_KEY`; ระยะสั้นยอมรับความเสี่ยงนี้ (เท่ากับ pattern เดิมของ `chat_messages.content_enc`); ถ้าต้องการเข้มกว่านี้ ให้พิจารณาย้ายคอลัมน์ credential ไปตารางแยก `customer_flowaccount_credentials` ที่ RLS ปิดสนิทสำหรับ `authenticated` (select เฉพาะ service_role) — เกินขอบเขต M2 นี้ ระบุเป็น backlog ถ้า reviewer เห็นว่าจำเป็น |
| **UI เข้าใจผิดระหว่าง "เว้นว่าง=ไม่แตะ" กับ "เว้นว่าง=ล้าง"** สำหรับช่อง secret (ต่างจาก address/phone ที่ `""`=ล้างได้ตรง ๆ) — ถ้า developer ทำตาม pattern เดิมเป๊ะโดยไม่อ่าน 0.7 อาจเผลอส่ง `""` ทุกครั้งที่ฟอร์ม submit แล้วลบ secret ที่ตั้งไว้ทิ้งโดยไม่ตั้งใจ | ระบุ design ไว้ชัดในหมวด 0.7 และ T21: client component ต้องไม่ใส่ key `flowaccountClientSecret` ในอ็อบเจกต์ที่ส่งเลยถ้าผู้ใช้ไม่ได้พิมพ์/ไม่ได้กดล้าง (ไม่ใช่ส่ง `""`); เพิ่ม unit test T19 กรณี `undefined` ยืนยันว่าไม่มี `update` เรียกคอลัมน์เลย เป็นเกณฑ์เสร็จบังคับ |
| **หลายลูกค้าพร้อมกันทำให้ token cache โตเรื่อย ๆ ไม่มีการเคลียร์** (memory เพิ่มตามจำนวนลูกค้าที่เคย sync) | scope เล็ก (คลิกครั้งต่อครั้ง ไม่ auto-sync) ทำให้จำนวน entry ใน map เท่ากับจำนวนลูกค้าที่เปิดใช้จริงเท่านั้น (ไม่ใช่ต่อ request) — ยอมรับได้ในระดับ M2 นี้ ไม่ต้องทำ eviction; ถ้าจำนวนลูกค้าโตมากในอนาคตค่อยพิจารณา LRU/TTL sweep |
| Endpoint/mapper/claim logic ของ M1 มีบั๊กแฝงที่ยังไม่เจอ แล้วมาปนกับงาน M2 ทำให้ debug สับสนว่าใหม่หรือเก่า | M2 ไม่แตะ `flowaccount-mapper.ts`/claim SQL/`bill_entries` schema เลย (เฉพาะจุดที่ระบุใน T13–T21 เท่านั้น) — ถ้าเจอบั๊กใน mapper/claim ระหว่างทดสอบ M2 ให้แยกเป็นงานอื่น ไม่ผูกรวมกับ M2 |
