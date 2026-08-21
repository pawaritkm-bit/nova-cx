# LINE → OneDrive — คู่มือเปิดใช้ "เก็บไฟล์จาก LINE ลงโฟลเดอร์ตามชื่อลูกค้า"

> **โค้ดเสร็จครบแล้ว** (OneDrive backend + จัดโฟลเดอร์ตามลูกค้า + dedup + retry) —
> เอกสารนี้คือขั้นตอน **setup ครั้งเดียว** เพื่อเปิดใช้ ("ยังไม่ได้ตั้ง" ไม่ใช่ "ยังไม่มี")

---

## มันทำงานยังไง (flow — สร้างเสร็จแล้ว)
```
ลูกค้าส่งไฟล์/รูปใน LINE OA (care=finovas care / sale=สนง)
  → webhook เก็บ metadata (message_attachments)
  → cron (processPendingAttachments) ดึง binary จาก LINE
  → คัดกรอง (รูป: เก็บเฉพาะเอกสารการเงิน / ไฟล์ PDF: เก็บหมด) + dedup (sha256)
  → เก็บที่ storage backend ที่เลือก → path = ROOT/<ชื่อลูกค้า>/<เดือน>/<ไฟล์>
```
- **customerFolder = ชื่อลูกค้า/กลุ่ม LINE** (resolveCustomerFolder) — ตรงกับที่ต้องการ ✅
- backend เลือกได้ 3 แบบผ่าน `BILL_STORAGE_BACKEND`: `supabase` (default) / `drive` (Google) / **`onedrive`**

---

## STEP 1 — Azure AD: ลงทะเบียน App (ครั้งเดียว)
ที่ portal.azure.com → Microsoft Entra ID → App registrations → New registration:
1. ตั้งชื่อ (เช่น `nova-cx-onedrive`) → Register → เก็บ **Application (client) ID** + **Directory (tenant) ID**
2. Certificates & secrets → New client secret → เก็บ **ค่า secret** (โชว์ครั้งเดียว)
3. **API permissions** → Add → Microsoft Graph → **Application permissions** → `Files.ReadWrite.All`
   → กด **"Grant admin consent"** (สำคัญ — app-only ต้องมี consent ถึงเขียน OneDrive ได้)

## STEP 2 — ตั้ง env (local + Vercel)
```
BILL_STORAGE_BACKEND=onedrive
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<client secret>
ONEDRIVE_USER=<UPN เจ้าของ OneDrive เช่น finovas@wanwanach.com>
ONEDRIVE_ROOT=NOVA-Bills          # optional (default NOVA-Bills)
```
- [ ] ตั้งใน `.env.local` (dev) + **Vercel Production** (`npx vercel env add ...`)
- ⚠️ ขาด 4 ตัวแรกตัวใดตัวหนึ่ง = ปิดฟีเจอร์เงียบ ๆ (ไม่ error) → กลับไปใช้ backend เดิม
- `ONEDRIVE_USER` = บัญชีที่ไฟล์จะไปเก็บใน OneDrive ของคนนั้น

## STEP 3 — เชื่อมลงเครื่องคอม (hybrid — ได้ฟรี)
ที่เครื่องออฟฟิศ: ล็อกอิน **OneDrive desktop** ด้วยบัญชี `ONEDRIVE_USER`
→ โฟลเดอร์ `NOVA-Bills/<ชื่อลูกค้า>/<เดือน>/...` **sync ลงเครื่องอัตโนมัติ** = ตรงกับ "เก็บในเครื่องตามชื่อลูกค้า" เป๊ะ (ไม่ต้องเขียน agent เอง)

## STEP 4 — deploy + verify
- [ ] deploy nova-cx (env ใหม่ apply ตอน deploy)
- [ ] ส่งไฟล์ทดสอบเข้า LINE OA (มีลูกค้าผูกกลุ่ม) → รอ cron (~5 นาที) → เช็คใน OneDrive `NOVA-Bills/<ชื่อลูกค้า>/<เดือน>/`
- [ ] เช็คว่า sync ลงเครื่องผ่าน OneDrive desktop

---

## หมายเหตุสำคัญ
- ครอบ **ทั้ง 2 OA** (care + sale) — ไฟล์จากทั้งคู่ archive ลง OneDrive ตามลูกค้า
- **"อ่าน" (extract) แยกจาก "เก็บ":** การอ่านบิล/สเตทเมนต์/แพลตฟอร์มทำโดย extractor ของ nova-cx (และไฟล์ใหญ่แก้แล้วใน PR #39) — คนละส่วนกับการ archive ไฟล์ลง OneDrive นี้
- ลูกค้าที่ยังไม่ผูกกลุ่ม → เก็บใต้โฟลเดอร์ `unassigned`
- dedup ด้วย sha256 — ไฟล์เดิมส่งซ้ำ ไม่อัปซ้ำ

## Troubleshooting
| อาการ | สาเหตุ | แก้ |
|---|---|---|
| ไฟล์ไม่ขึ้น OneDrive | env ไม่ครบ / backend ยังเป็น supabase | ตั้ง 5 env + `BILL_STORAGE_BACKEND=onedrive` + redeploy |
| 401/403 ตอนอัป | ยังไม่ grant admin consent / permission ผิด | Azure → grant consent `Files.ReadWrite.All` (Application) |
| ไฟล์อยู่ OneDrive แต่ไม่ลงเครื่อง | OneDrive desktop ไม่ได้ล็อกอิน/sync | ล็อกอิน `ONEDRIVE_USER` บน OneDrive desktop |
| เก็บใต้ `unassigned` | ลูกค้า/กลุ่มยังไม่ถูกผูกชื่อ | ผูกลูกค้ากับกลุ่ม LINE |

---

## ⚠️ ที่ต้องทำเอง (ผมทำแทนไม่ได้ = Azure admin/secret)
1. Azure app registration + client secret + **admin consent** (STEP 1)
2. ตั้ง env บน Vercel + local (STEP 2)
3. ล็อกอิน OneDrive desktop ที่เครื่องออฟฟิศ (STEP 3)

> โค้ดพร้อมแล้ว — ทำ STEP 1–3 ครบ + deploy = ไฟล์จาก LINE ไหลลง OneDrive ตามชื่อลูกค้า + sync ลงเครื่องอัตโนมัติ
