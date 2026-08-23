import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { listEmployees, maskIdCardNo, type PayrollEmployee } from "@/lib/accounting/payroll-employees";
import { getOrCreateDefaultSettings } from "@/lib/accounting/payroll-settings";
import PayrollEmployeesPanel from "./PayrollEmployeesPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";
// ★ 2026-08-12 (wishlist ข้อ 2, พบจาก independent review) — Server Action ของหน้านี้ (bulkImportEmployeesAction)
//   วนสร้างพนักงานได้สูงสุด MAX_IMPORT_ROWS แถวก่อน return ผลลัพธ์เดียว ค่า default ของ maxDuration บน
//   Vercel (10-15s) ไม่พอสำหรับไฟล์ที่มีหลายร้อยแถว — ต้องขยายให้ตรงกับ pattern เดียวกับ route ที่หนักอื่น ๆ
//   (ดู vercel.json — app/api/**/route.ts ตั้งไว้ 60s) เพราะ Server Action ผูกกับ maxDuration ของ page ที่เรียก
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/** ★ 0.12 PDPA: มาสก์เลขบัตรประชาชนเป็นค่าเริ่มต้นตั้งแต่ชั้น server ก่อนส่งลง client component เลย
 *   (ไม่ส่งเลขเต็มลง HTML/props ตั้งแต่แรก — ต้องกดปุ่ม "เผยเลขเต็ม" เรียก revealIdCardAction เอาเลขจริง
 *   มาแสดงชั่วคราวในจอเท่านั้น) */
function toMaskedEmployee(e: PayrollEmployee): PayrollEmployee {
  return { ...e, idCardNo: maskIdCardNo(e.idCardNo) };
}

/**
 * /chat-audit/accounting/payroll-employees — "ทะเบียนพนักงาน/ตั้งค่าเงินเดือน" (เฟส 9 ส่วน AC)
 *   เลือกลูกค้า (ในสโคป) → ทะเบียนพนักงานของบริษัทลูกค้า (★ ไม่ใช่ public.employees เดิม, 0.2) + แท็บตั้งค่า
 *   บัญชีที่ใช้เมื่อสร้างรายการบัญชีจากรอบเงินเดือน (payroll_settings, 0.11)
 */
export default async function PayrollEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ทะเบียนพนักงาน/เงินเดือน" subtitle="ทะเบียนพนักงานลูกค้า + ตั้งค่าบัญชีเงินเดือน">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);
  const chart = await listChartOfAccounts(service, access.tenantId);

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const employees = validCustomerId ? await listEmployees(service, access.tenantId, validCustomerId) : [];
  const maskedEmployees = employees.map(toMaskedEmployee);
  const settings = validCustomerId ? await getOrCreateDefaultSettings(service, access.tenantId, validCustomerId) : null;

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ทะเบียนพนักงาน/เงินเดือน"
      subtitle="ทะเบียนพนักงานของบริษัทลูกค้า + ตั้งค่าบัญชีที่ใช้เมื่อสร้างรายการบัญชีจากรอบเงินเดือน"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          <form method="get" className="acc-opening-cust">
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={validCustomerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">เปิด</button>
          </form>
          <span className="acc-toolbar-spacer" />
          {validCustomerId ? (
            <Link href={`/chat-audit/accounting/payroll?customerId=${validCustomerId}`} className="btn btn-ghost">
              ไปหน้ารอบเงินเดือน →
            </Link>
          ) : null}
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อจัดการทะเบียนพนักงาน/ตั้งค่าเงินเดือน</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            {settings ? (
              <PayrollEmployeesPanel customerId={validCustomerId} employees={maskedEmployees} settings={settings} chart={chart} />
            ) : null}
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
