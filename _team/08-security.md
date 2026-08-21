# ตรวจความปลอดภัย — เฟส 9b กลุ่ม BG (แจ้งเตือนวันครบกำหนดยื่นภาษี)

**Path ตรวจ:** `.claude/worktrees/bg-on-bc` (branch `feat/accounting-phase9b-bg`)
**Diff เทียบกับ:** `feat/accounting-phase9b-bc-non-monthly` (เฉพาะการเปลี่ยนแปลงของ BG — 6 ไฟล์, +713 บรรทัด ล้วนเป็นไฟล์ใหม่/เพิ่มเข้า ไม่มีการแก้ไฟล์เดิม)

## ไฟล์ที่ตรวจ
- `app/api/cron/generate-payroll-filing-reminders/route.ts` (ใหม่)
- `lib/accounting/payroll-filing-reminders.ts` (ใหม่)
- `supabase/migrations/0098_payroll_filing_reminders.sql` (ใหม่)
- `app/chat-audit/accounting/payroll/page.tsx` (แก้ — เพิ่ม banner)
- `tests/accounting/payroll-filing-reminders.test.ts` (ใหม่)
- `vercel.json` (แก้ — เพิ่ม cron schedule รายวัน 04:00)

## สรุปผลตรวจแต่ละข้อ

1. **Cron auth (`CRON_SECRET`) fail-closed**
   - `const secret = process.env.CRON_SECRET; if (!secret) return 503` — ไม่มี default/fallback secret ใดๆ ในโค้ด, ไม่ตั้ง env → ปิด endpoint จริง
   - เทียบ auth ด้วย `isValidCronAuth(auth, secret)` จาก `lib/http.ts` ซึ่งเรียก `constantTimeEqual(authHeader, \`Bearer ${secret}\`)` — เป็น constant-time comparison จริง ไม่ใช่ `===` ตรงๆ
   - โครงทั้งหมด (503 ไม่ตั้ง secret / 401 auth ผิด / catch แล้วคืน 200 กัน retry loop / `today` มาจาก `todayIsoThai()` server-side เท่านั้นไม่รับจาก client) mirror `app/api/cron/generate-recurring-je/route.ts` ทุกจุด ยืนยันด้วย diff เทียบสองไฟล์ตรงกัน 100% ในส่วน auth/error-handling — **ผ่าน**

2. **Migration `0098_payroll_filing_reminders.sql` — RLS**
   - `enable row level security` ✓
   - `create policy tenant_read ... for select to authenticated using (tenant_id = public.current_tenant_id())` ✓
   - `revoke all on ... from anon` ✓
   - `grant select ... to authenticated` + `grant all ... to service_role` ✓
   - เทียบกับ `0094_payroll_monthly_filings.sql` (ต้นแบบที่อ้างว่า mirror) — โครง RLS ตรงกันเป๊ะ (select-only ไม่มี insert/update/delete policy ให้ authenticated เลย ถูกต้องเพราะเขียนได้แค่ cron ผ่าน service-role)
   - ลำดับไฟล์ migration ต่อเนื่องไม่ชนกับ 0091-0097 ที่มีอยู่แล้วในบรานช์นี้ — **ผ่าน**

3. **UI banner ใน `payroll/page.tsx` — scope tenantId/customerId**
   - `validCustomerId` ได้มาจาก `customers.some((c) => c.id === rawCustomer)` โดย `customers` มาจาก `fetchScopedCustomers(service, access)` ที่ query ด้วย `eq("tenant_id", access.tenantId)` และกรองซ้ำด้วย `access.allowedCustomerIds` ถ้ามี — ไม่มีทาง inject customerId ข้าม tenant/ข้ามสิทธิ์ผ่าน query string ได้
   - `listActiveFilingReminders(service, access.tenantId, validCustomerId)` query `payroll_monthly_filings` ด้วย `eq("tenant_id", tenantId).eq("customer_id", customerId)` ก่อน แล้วเอา `periodIds` ที่ scope แล้วไป filter `payroll_filing_reminders` ต่อด้วย `eq("tenant_id", tenantId).in("filing_period_id", periodIds)` — สอง-ชั้นการกรองกันไม่ให้เห็น reminder ของลูกค้า/tenant อื่นแม้ table `payroll_filing_reminders` เองไม่มีคอลัมน์ `customer_id` ตรงๆ — **ผ่าน ไม่รั่วข้ามลูกค้า/tenant**

4. **console.log ข้อมูลการเงิน/ลูกค้า (PDPA)**
   - grep `console\.` ในทุกไฟล์ที่แก้/สร้างใหม่ (route.ts, payroll-filing-reminders.ts, page.tsx, test) → ไม่พบเลย
   - จุดเดียวที่เกี่ยวข้องคือ `logServerError` (ใช้ `console.error` ภายใน `lib/http.ts` ซึ่งไม่ได้แก้ในเฟสนี้) รับ context string + requestId + error stack — ไม่มีการส่ง tenantId/customerId/ยอดเงินเข้าไปในอาร์กิวเมนต์จาก route นี้เลย ตรงกับคอมเมนต์ในไฟล์ที่ระบุไว้ชัดเจนว่า "ไม่ log ชื่อลูกค้า/พนักงาน/ยอดเงินที่ไหนในไฟล์นี้" — **ผ่าน**

5. **Cron route ไม่มี `requireAccountingAccess` แต่ scope ทุก tenant ถูกต้องระหว่าง scan**
   - `generateDueReminders` query `payroll_monthly_filings` แบบไม่กรอง tenant (ตั้งใจ สแกนทุก tenant เพราะเป็น service-role cron) แต่ทุกแถวที่ได้มามี `tenant_id` ติดมาด้วยจาก DB จริง (ไม่ใช่จาก input ผู้ใช้) และ insert ลง `payroll_filing_reminders` ด้วย `tenant_id: row.tenant_id` ของแถวนั้นเสมอ — ไม่มีจุดใดที่ tenant ID ของแถวหนึ่งไปปนกับแถวอื่น (ไม่มี aggregate/join ข้าม tenant,วนลูปทีละแถวอิสระ)
   - ไม่มี input จาก user/client เข้าสู่ query เลย (auth เป็น secret เท่านั้น, `today` มาจาก server clock) จึงไม่มีช่องให้แก้ query param เพื่อ enumerate tenant อื่น
   - เทียบกับ `generateForAllTenants` ของ `generate-recurring-je` (ต้นแบบที่อ้าง mirror) หลักการเดียวกัน (สแกนรวมแล้วประมวลผลแยกต่อ tenant/แถว) — **ผ่าน**

## ตรวจเพิ่มเติมที่ทำเอง
- grep หา secret/password/api-key/token hardcode ทั้ง diff → พบแค่ `process.env.CRON_SECRET` (ถูกต้อง ไม่มี hardcode)
- ตรวจ `vercel.json` diff → เพิ่ม cron schedule ธรรมดา ไม่มีข้อมูลอ่อนไหว
- ตรวจไฟล์ทดสอบ (`payroll-filing-reminders.test.ts`) → ใช้ in-memory fake DB, ไม่มี credential จริงหรือข้อมูลลูกค้าจริง

## 🔴 ร้ายแรง (ต้องแก้ก่อนปล่อย)
ไม่มี

## 🟡 ควรแก้
ไม่มี

## 🟢 แนะนำเสริมความแข็งแรง
- ไม่มีข้อสำคัญเพิ่มเติม — โค้ดมีคอมเมนต์อธิบายเหตุผลความปลอดภัย/scope ไว้ละเอียดในตัวไฟล์เองอยู่แล้ว (ช่วย traceability ได้ดีเช่นเดียวกับกลุ่ม BE ก่อนหน้า)
- (ไม่บังคับ) ถ้าอนาคตมีการเพิ่มช่องทางแจ้งเตือนจริง (LINE/อีเมล) ให้ทบทวนอีกรอบว่า payload ที่ส่งออกไม่มี PII เกินจำเป็น — ตอนนี้ยังเป็นแค่ log ภายในระบบเท่านั้นจึงไม่มีความเสี่ยงรั่วออกนอกระบบ

## สรุปตัดสิน: **ผ่านด้านความปลอดภัย**

หมายเหตุ: ไม่พบไฟล์ `_team-knowledge/standards.md` หรือ `_team/02-analysis.md` ในทั้ง repo หลักและ worktree นี้ (โฟลเดอร์ `_team-knowledge/` ไม่มีอยู่จริง, `_team/` มีแค่ `05-review.md` ของเฟสก่อนหน้า) จึงตรวจโดยอิงมาตรฐานความปลอดภัยทั่วไปที่สอดคล้องกับ pattern เดิมของโปรเจกต์ (`generate-recurring-je`) แทน ไม่มีมาตรฐานใหม่ที่ต้องเสนอบันทึกเพิ่มจากการตรวจครั้งนี้ (โค้ดกลุ่มนี้ยึด pattern เดิมทั้งหมด ไม่มีอะไรใหม่ที่ต่างออกไป)
