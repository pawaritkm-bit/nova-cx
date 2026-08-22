import Link from "next/link";
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
} from "@/lib/accounting/recurring-invoice";
import RecurringInvoicePanel from "./RecurringInvoicePanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** เพดานเทมเพลตที่ดึงประวัติ generate log ต่อ 1 ครั้งเปิดหน้า (กันลูกค้าตั้งเทมเพลตเยอะผิดปกติแล้วช้า) */
const LOG_FETCH_LIMIT = 50;

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
  let q = service
    .from("customers")
    .select("id, customer_code, name")
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .order("customer_code", { ascending: true, nullsFirst: false })
    .limit(5000);
  if (access.allowedCustomerIds !== null) {
    const ids = [...access.allowedCustomerIds];
    if (ids.length === 0) return [];
    q = q.in("id", ids);
  }
  const { data } = await q;
  const rows = (data ?? []) as { id: string; customer_code: string | null; name: string | null }[];
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/recurring-invoice — "ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ" (wishlist ข้อ 4)
 *   เลือกลูกค้า (ในสโคป) → ตั้ง/แก้/เปิดปิด/ลบเทมเพลตค่าบริการรายเดือน/ไตรมาส/ปี → cron/ปุ่ม "สร้างตอนนี้"
 *   สร้างเป็นใบแจ้งหนี้จริง (bill_entries entry_type='sale', ดราฟต์เสมอ) ป้อนเข้า VAT/ลูกหนี้ค้างชำระ
 *
 * ★ guard + scope เดียวกับหน้า journal-entry/recurring-journal (resolveAccountingAccess)
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 */
export default async function RecurringInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ" subtitle="ตั้งเทมเพลตให้สร้างใบแจ้งหนี้ซ้ำอัตโนมัติ">
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

  const templates = validCustomerId ? await listTemplates(service, access.tenantId, validCustomerId) : [];
  const templateIds = templates.map((t) => t.id);
  const occurrences =
    templateIds.length > 0
      ? await listOccurrencesByTemplateIds(service, access.tenantId, validCustomerId, templateIds)
      : [];

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
      title="ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ"
      subtitle="ตั้งเทมเพลตค่าบริการรายเดือน/ไตรมาส/ปี ให้สร้างใบแจ้งหนี้ (ดราฟต์) อัตโนมัติทุกรอบ"
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
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อตั้งใบแจ้งหนี้แบบวนซ้ำ</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <RecurringInvoicePanel
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
