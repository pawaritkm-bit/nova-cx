# NOVA Sales → NOVA-CX Integration API (M2 chunk 1)

Contract สำหรับให้ **NOVA Sales** ยิงเข้ามาเมื่อเปิดลูกค้า/ปิดดีล เพื่อ sync ข้อมูล
เข้ามาที่ NOVA-CX และ trigger แบบประเมินเซล (C = ขายได้ / D = ขายไม่ได้) โดยอัตโนมัติ

## Authentication
ทุก endpoint ต้องแนบ header:

```
x-api-key: <NOVA_SALES_API_KEY>
```

- ค่า `NOVA_SALES_API_KEY` ตั้งใน env ทั้งสองระบบ (อ่านจาก env เท่านั้น — ไม่ hardcode)
- ถ้าฝั่ง NOVA-CX ยังไม่ตั้ง key → ตอบ `503` (endpoint ปิดไว้ ไม่เปิดโล่ง)
- key ไม่ตรง/ไม่ส่ง → `401` (เทียบแบบ constant-time กัน timing attack)
- **ผูก API key ↔ tenant:** ตั้ง `NOVA_SALES_TENANT_ID` → ระบบรับเฉพาะ `payload.tenant_id` ที่ตรงเท่านั้น
  ไม่ตรง → `403` (กัน key เดียวเขียนข้าม tenant)
- **Cross-tenant guard:** ทุก id ใน payload (`customer_id` / `customer_code` / `sales_employee_id` /
  `owner_employee_id`) ถูก query ยืนยันว่าอยู่ tenant เดียวกัน + มีจริง + ไม่ soft-deleted ก่อนเขียน
  (ไม่พบ → `400`)

Content-Type: `application/json`

---

## 1) POST `/api/integrations/nova-sales/customer`
สร้าง/อัปเดตลูกค้า (+ lead ถ้ามี) แบบ idempotent ผ่าน `external_customer_id`

### Request body
| field | type | required | หมายเหตุ |
|---|---|---|---|
| `tenant_id` | uuid | ✓ | tenant ปลายทาง |
| `name` | string | ✓ | ชื่อลูกค้า |
| `external_customer_id` | string | – | id ฝั่ง NOVA Sales (ใช้ทำ idempotency) |
| `customer_code` | string | – | รหัสลูกค้า (unique ต่อ tenant) |
| `business_name` | string | – | |
| `service_start_date` | string (date) | – | |
| `status` | `active\|cancelled\|prospect` | – | default `active` |
| `contact` | object | – | `{name, phone, email}` (ยังไม่บันทึก PII — รอ util เข้ารหัส) |
| `lead` | object | – | `{external_lead_id, name, source, owner_employee_id}` |

### Response
```json
{ "ok": true, "customer_id": "<uuid>", "created": true, "lead_id": "<uuid|null>" }
```
- `created=true` → `201`, มีอยู่แล้ว/อัปเดต → `200`
- ยิงซ้ำด้วย `external_customer_id` เดิม = อัปเดตระเบียนเดิม (ไม่สร้างซ้ำ)

---

## 2) POST `/api/integrations/nova-sales/deal-status`
อัปเดตสถานะดีล + บันทึกประวัติ + trigger แบบประเมินเซลเมื่อปิด Won/Lost

### Request body
| field | type | required | หมายเหตุ |
|---|---|---|---|
| `tenant_id` | uuid | ✓ | |
| `external_deal_id` | string | ✓ | id ดีลฝั่ง NOVA Sales (idempotency) |
| `status` | `open\|won\|lost` | ✓ | won→ประเมิน C, lost→ประเมิน D |
| `customer_id` **หรือ** `customer_code` | uuid / string | ✓ (อย่างใดอย่างหนึ่ง) | ผูกลูกค้า |
| `sales_employee_id` | uuid | – | เซลเจ้าของดีล (เข้า assignee snapshot) |
| `external_lead_id` | string | – | |
| `stage` | string | – | |
| `amount` | number (≥0) | – | |
| `closed_at` | string (timestamptz) | – | default = now เมื่อ won/lost |

### Response
```json
{
  "ok": true,
  "opportunity_id": "<uuid>",
  "created": true,
  "status_changed": true,
  "previous_status": "open",
  "invitation": { "id": "<uuid>", "created": true, "surveyType": "C" }
}
```

### พฤติกรรม
- **Idempotent:** ผูกดีลด้วย `external_deal_id` (unique ต่อ tenant) — ยิงซ้ำ = อัปเดตดีลเดิม ไม่สร้างซ้ำ
- เปลี่ยนสถานะ → เขียน `sales_status_history`
- Won/Lost + มีลูกค้า → สร้าง `survey_invitation` (C/D) **1 ครั้ง/ดีล**
  (กันซ้ำด้วย `idempotency_key = nova-sales:deal:<external_deal_id>:<C|D>`
  และ `UNIQUE(customer_id, survey_type, cycle_period)` โดย `cycle_period = deal:<external_deal_id>`)
- แล้ว enqueue `job_queue(queue=notification)` เพื่อให้ worker ส่ง Flex/Push ผ่าน **OA Sale**
  (การส่ง LINE จริงอยู่ใน chunk ถัดไป)
- `invitation = null` เมื่อยังไม่ตั้ง template C/D active สำหรับ tenant นั้น

---

## Error format
```json
{ "error": "server_error", "message": "เกิดข้อผิดพลาด...", "request_id": "<uuid>" }
```
- error ฝั่ง server จะไม่คืน DB error ดิบ → คืนข้อความ generic + `request_id` (log ไว้ฝั่ง server ให้สืบย้อน)

| status | ความหมาย |
|---|---|
| 400 | payload ไม่ผ่าน Zod / ขาด customer reference / id ไม่พบใน tenant |
| 401 | API key ผิด/ไม่ส่ง |
| 403 | `tenant_id` ไม่ตรงกับ API key (`NOVA_SALES_TENANT_ID`) |
| 503 | ยังไม่ตั้ง `NOVA_SALES_API_KEY` หรือ Supabase env |
| 500 | error ฝั่ง server (generic + request_id) |

## Migration ที่เกี่ยว
- `0019_nova_sales_integration.sql` — เพิ่ม `external_ref` (+ partial unique index) บน
  `customers` / `sales_leads` / `sales_opportunities` เพื่อทำ idempotency
- `0020_survey_submit_rpc.sql` — RPC `submit_survey_response` (atomic) ที่ฝั่ง submit เรียกใช้

## TODO (chunk ถัดไป / prod)
- **Rate limiting** (Security M-2): ยังไม่ทำ — ควรใส่ IP/key-based throttle หน้า integration endpoints
- ส่ง Flex/Push จริงผ่าน OA Sale (ตอนนี้ enqueue `job_queue(notification)` ไว้ให้ worker)
- Owner-binding LIFF เต็มรูป: verify LINE ID token → `line_users.id` (ดู NOTE ในโค้ด route)
