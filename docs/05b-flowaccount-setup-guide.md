# FlowAccount — คู่มือ "วิธีส่งบิลเข้า FlowAccount" (setup + usage)

> โค้ด integration **เสร็จครบแล้ว** (M1 ส่งใบกำกับภาษีขาย/ซื้อ manual + M2 credential ต่อลูกค้า) —
> เอกสารนี้คือขั้นตอน **setup + ใช้งาน** ที่ต้องทำครั้งเดียวเพื่อให้ปุ่ม "ส่ง FlowAccount" ทำงาน
> ("ยังไม่รู้ส่งยังไง" = ยังไม่ได้ทำ step 2 + 3 ด้านล่าง — ไม่ใช่บั๊ก)

---

## ภาพรวม flow
```
บิลใน NOVA-CX (confirmed, sale/purchase, มีลูกค้า)
  → กดปุ่ม "ส่ง FlowAccount" (หน้า /chat-audit/accounting)
  → ระบบขอ OAuth token (shared config) + ใช้ credential ของลูกค้ารายนั้น (M2)
  → สร้าง Tax Invoice / เอกสารซื้อ ใน FlowAccount
  → บันทึกสถานะ synced + doc id
```

---

## STEP 1 — Env (shared config) ✅ ตั้งแล้ว (test) / ต้องทำ prod

`getFlowAccountSharedConfig()` ต้องมีครบ 3 ตัว (ขาดตัวใด = ปิดปุ่มเงียบ ๆ):

| env | ค่าปัจจุบัน (.env.local) | หมายเหตุ |
|---|---|---|
| `FLOWACCOUNT_TOKEN_URL` | `https://openapi.flowaccount.com/test/token` | ✅ (test) |
| `FLOWACCOUNT_API_BASE_URL` | `https://openapi.flowaccount.com/test` | ✅ (test) |
| `FLOWACCOUNT_SCOPE` | `flowaccount-api` | ✅ |

- [ ] **ตั้ง 3 ตัวนี้บน Vercel (Production)** ด้วย (ตอนนี้มีแค่ในเครื่อง) — `npx vercel env add ...`
- [ ] **สลับ test → prod เมื่อพร้อมยิงจริง:** เอา `/test` ออก → `https://openapi.flowaccount.com/token` + `.../` (ยืนยัน URL prod จาก FlowAccount OpenAPI docs ก่อน)
- ⚠️ `FLOWACCOUNT_CLIENT_ID/SECRET` ใน env = ของเก่า M1 **ไม่ใช้แล้ว** (ย้ายไปเก็บต่อลูกค้าใน DB — ดู STEP 3)

## STEP 2 — Apply migrations บน Supabase (ครั้งเดียว)
ตรวจว่า apply ครบบน DB prod:
- [ ] `0061_flowaccount_sync.sql` (คอลัมน์สถานะ sync + ตาราง log)
- [ ] `0062_customers_flowaccount_credential.sql` (client_id / client_secret_enc ต่อลูกค้า)
- [ ] `0071_flowaccount_account_product_map.sql` (map ผังบัญชี/สินค้า)
- [ ] `0072_flowaccount_purchase_doc_types.sql` (เอกสารซื้อ)
```sql
-- verify เร็ว:
select column_name from information_schema.columns
  where table_name='customers' and column_name like 'flowaccount%';
```

## STEP 3 — ตั้ง FlowAccount credential ต่อลูกค้า (สำคัญสุด — จุดที่มักลืม)
credential เป็นแบบ **1 ชุดต่อ 1 บริษัทลูกค้า** (M2) — ต้องตั้งให้แต่ละลูกค้าที่จะส่ง:

1. ขอ **FlowAccount OpenAPI credential** (client_id + client_secret) ของบริษัทลูกค้ารายนั้น จาก FlowAccount (เมนู Developer/API ในบัญชี FlowAccount ของลูกค้า)
2. หน้า **`/chat-audit/accounting`** → เลือกลูกค้า → **CustomerAdminControls** (แก้ไขข้อมูลลูกค้า):
   - กรอก **FlowAccount client id** (ไม่ใช่ความลับ — prefill ได้)
   - กรอก **FlowAccount client secret** (เข้ารหัสก่อนเก็บ DB — ช่องนี้ว่างเสมอ ไม่ prefill)
   - บันทึก → `hasFlowAccountCredential = true`
3. ล้าง/เปลี่ยน credential ได้ที่ปุ่ม "ล้างรหัสลับ FlowAccount" (มี confirm)
- ⚠️ ถ้าลูกค้า**ยังไม่ตั้ง credential** → กดส่งจะ fail (ไม่มี token ของลูกค้ารายนั้น)

## STEP 4 — วิธีส่งจริง (usage)
ปุ่ม **"ส่ง FlowAccount"** จะโผล่**เฉพาะบิลที่:**
- `status = 'confirmed'` (ยืนยันแล้ว — บิล draft/รอระบุ ไม่โชว์ปุ่ม)
- `entry_type = 'sale'` หรือ `'purchase'`
- มีลูกค้า (customerId)

→ ไปหน้า `/chat-audit/accounting` → แท็บภาษีขาย/ซื้อ → บิล confirmed → กด **"ส่ง FlowAccount"**
→ สำเร็จ = มาร์ค `synced` + เก็บ doc id · ล้มเหลว = `failed` + เหตุผลสั้น (กดลองใหม่ได้)

---

## Troubleshooting ("กดแล้วไม่ไป / ไม่เห็นปุ่ม")
| อาการ | สาเหตุ | แก้ |
|---|---|---|
| ไม่เห็นปุ่มเลย | บิลยังไม่ confirmed / ไม่ใช่ sale-purchase / ไม่มีลูกค้า | ยืนยันบิล + ผูกลูกค้าก่อน |
| ปุ่มขึ้น "ยังไม่เปิดการเชื่อม" | shared config (STEP 1) ไม่ครบบน env นั้น | ตั้ง 3 env + redeploy |
| กดแล้ว fail `auth_failed` | credential ลูกค้า (STEP 3) ผิด/ยังไม่ตั้ง | ตั้ง client_id/secret ของลูกค้า |
| fail `validation_error` | บิลไม่มีเลขภาษีลูกค้า / ไม่มี line มูลค่า>0 / ไม่มีวันที่ | เติมข้อมูลบิลให้ครบ |
| fail `timeout` | ยิงไปแล้วไม่รู้ผล (อาจสร้างจริงใน FlowAccount) | เช็คใน FlowAccount ก่อนกดซ้ำ |

---

## ⚠️ 2 อย่างที่ต้องทำเอง (ผมทำแทนไม่ได้ = ความลับ/บัญชีภายนอก)
1. **FlowAccount OpenAPI client_id/secret ต่อลูกค้า** (ขอจาก FlowAccount → กรอกใน STEP 3)
2. **Apply migrations + ตั้ง env บน Vercel prod** (STEP 1–2)

> โค้ดพร้อมส่งแล้ว — ทำ 4 step นี้ครบ = กดปุ่มส่งได้ทันที · เริ่ม test env ก่อน (สร้างเอกสารทดสอบใน FlowAccount) แล้วค่อยสลับ prod
