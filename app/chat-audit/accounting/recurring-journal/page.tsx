import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import {
  listTemplates,
  listOccurrencesByTemplateIds,
  listGenerationLog,
  type GenerationLogEntry,
} from "@/lib/accounting/recurring-journal";
import RecurringJournalPanel from "./RecurringJournalPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** เพดานเทมเพลตที่ดึงประวัติ generate log ต่อ 1 ครั้งเปิดหน้า (กันลูกค้าตั้งเทมเพลตเยอะผิดปกติแล้วช้า) */
const LOG_FETCH_LIMIT = 50;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/**
 * รายชื่อลูกค้าในสโคปของผู้เรียก (id + label) — สำหรับ dropdown เลือกลูกค้า
 *   - admin/lead (allowedCustomerIds=null): ทุกลูกค้าใน tenant
 *   - accountant: เฉพาะลูกค้าที่ตัวเองดูแล
 */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/recurring-journal — "รายการบันทึกซ้ำ" (เฟส 6 ส่วน R)
 *   เลือกลูกค้า (ในสโคป) → ตั้ง/แก้/เปิดปิด/ลบเทมเพลตค่าเช่า/ค่าบริการรายเดือน (JV/PV/RV ซ้ำอัตโนมัติ)
 *   + ดูรายการ (occurrence) ที่ cron/ปุ่ม "สร้างตอนนี้" สร้างไว้แล้ว ลิงก์กลับหน้าลงบันทึกบัญชีเอง
 *
 * ★ guard + scope เดียวกับหน้า journal-entry (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 */
export default async function RecurringJournalPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="รายการบันทึกซ้ำ" subtitle="ตั้งรายการให้สร้างซ้ำอัตโนมัติ">
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
  // ผังบัญชีของ tenant — โหลดครั้งเดียว ส่งลง RecurringJournalPanel (combobox เลือกบัญชี + validate ฝั่ง server)
  const chart = await listChartOfAccounts(service, access.tenantId);

  // ลูกค้าที่เลือก (validate uuid + ต้องอยู่ในสโคป)
  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const templates = validCustomerId ? await listTemplates(service, access.tenantId, validCustomerId) : [];
  const templateIds = templates.map((t) => t.id);
  const occurrences =
    templateIds.length > 0
      ? await listOccurrencesByTemplateIds(service, access.tenantId, validCustomerId, templateIds)
      : [];

  // ประวัติ generate (0.8) — ต่อเทมเพลต (จำนวนเทมเพลตต่อลูกค้าปกติน้อย ไม่ใช่ N+1 ที่มีผล perf จริง)
  const logByTemplate = new Map<string, GenerationLogEntry[]>();
  for (const t of templateIds.slice(0, LOG_FETCH_LIMIT)) {
    logByTemplate.set(t, await listGenerationLog(service, access.tenantId, t));
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="รายการบันทึกซ้ำ"
      subtitle="ตั้ง JV/PV/RV ให้สร้างซ้ำอัตโนมัติทุกเดือน/ไตรมาส/ปี (เช่น ค่าเช่า, ค่าบริการรายเดือน)"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          {/* เลือกลูกค้า (form GET — คงสโคป server-side) */}
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
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อตั้งรายการบันทึกซ้ำ</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <RecurringJournalPanel
              customerId={validCustomerId}
              templates={templates}
              occurrences={occurrences}
              generationLog={Object.fromEntries(logByTemplate)}
              chart={chart}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
