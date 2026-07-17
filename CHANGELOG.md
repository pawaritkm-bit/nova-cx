# Changelog

รูปแบบตาม [Keep a Changelog](https://keepachangelog.com/) · เวอร์ชันตาม [Semantic Versioning](https://semver.org/)

## [1.0.0] — 2026-07-17

เวอร์ชันแรกที่ใช้งานจริง (production): https://nova-cx.vercel.app

### ระบบหลัก
- **แบบประเมิน 4 แบบผ่าน LINE OA + LIFF**: A สำนักงาน (ราย 3 เดือน → กลุ่ม LINE), B นักบัญชี (รายเดือน → แชตส่วนตัว, per-subject), C เซลปิดได้, D เซลปิดไม่ได้
- **2 LINE OA**: Care (A/B) + Sale (C/D) — webhook + LIFF + notification (Vercel Cron + Postgres job_queue)
- **AI น้อง NOVA** (OpenAI): redact PII → วิเคราะห์ sentiment/urgency → guardrail C-01..04/C-15 → เปิด complaint case อัตโนมัติ + human-in-the-loop
- **Dashboard ตามบทบาท (7 roles)** + แถบแจ้งเตือนเคสด่วน + SLA countdown; Sample Size guard (n<5); pseudonymity (ผู้ถูกประเมินไม่เห็นชื่อลูกค้า)
- **ระบบจัดการข้อมูลจริง (Admin)**: ทีมบัญชี / พนักงาน / ลูกค้า / มอบหมายลูกค้า→นักบัญชี
- **Auth**: Supabase Auth (email/password) + middleware guard + RBAC จาก session
- **Integration NOVA Sales**: `deal-status` (Won→C push / Lost→D คืนลิงก์) + `customer` upsert; รับ `sales_employee_name` แล้ว resolve เป็น employee เอง; idempotent + tenant guard

### ความปลอดภัย / PDPA
- Multi-tenant RLS (deny-by-default) + pseudonymity ที่ชั้น view + column-grant (0025/0027)
- Token แบบประเมิน 256-bit + single-use + หมดอายุ; integration auth constant-time; cron fail-closed
- Security headers (Referrer-Policy / HSTS / nosniff / X-Frame ยกเว้น /liff)

### Database
- Migrations 0001–0028 (41 ตาราง + RLS + RBAC + RPC atomic + seed + unique index)

### ทดสอบ
- vitest 364 passed / 21 skipped (DB-integration) · tsc / lint / build ผ่าน · QC (security + reviewer + qc) ผ่าน ไม่มี Critical/High

### หนี้ที่ยังค้าง (แผนถัดไป)
- owner-binding แบบประเมิน (verify LINE ID token), rate limiting (Vercel WAF), รายงาน XLSX/PDF, decrypt phone (call-list), FR-PD-04 เปิดตัวตนในเคส, user provisioning จริง (แทน demo)
