import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import {
  listAssets,
  listOccurrencesByAssetIds,
  listDepreciationLog,
  type DepreciationLogEntry,
} from "@/lib/accounting/fixed-assets";
import FixedAssetsPanel from "./FixedAssetsPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** เพดานทรัพย์สินที่ดึงประวัติค่าเสื่อมต่อ 1 ครั้งเปิดหน้า (กันลูกค้าที่มีทรัพย์สินเยอะผิดปกติแล้วช้า) */
const LOG_FETCH_LIMIT = 100;

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
 * /chat-audit/accounting/fixed-assets — "ทะเบียนทรัพย์สินถาวร" (เฟส 7 ส่วน V)
 *   เลือกลูกค้า (ในสโคป) → ตั้ง/แก้/ลบทะเบียนทรัพย์สิน + คำนวณ/บันทึกค่าเสื่อมราคาแบบเส้นตรงอัตโนมัติ
 *   ทุกเดือน + ดูรายการ (occurrence) ที่ cron/ปุ่ม "สร้างค่าเสื่อมตอนนี้" สร้างไว้แล้ว ลิงก์กลับหน้าลงบันทึก
 *   บัญชีเอง
 *
 * ★ guard + scope เดียวกับหน้า journal-entry/recurring-journal (resolveAccountingAccess) — นักบัญชี
 *   เห็นเฉพาะลูกค้าตัวเอง
 * ★ implement ทั้งเฟส 7-V (ทะเบียน+ค่าเสื่อมอัตโนมัติ) และเฟส 7-W (ปุ่ม "จำหน่ายทรัพย์สิน"/"ยกเลิกการจำหน่าย")
 *   — ดู FixedAssetsPanel.tsx/actions.ts (dialog จำหน่ายทรัพย์สิน + ปุ่มยกเลิกการจำหน่าย ทำงานครบแล้ว)
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 */
export default async function FixedAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ทะเบียนทรัพย์สินถาวร" subtitle="ทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติ">
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
  // ผังบัญชีของ tenant — โหลดครั้งเดียว ส่งลง FixedAssetsPanel (combobox เลือกบัญชี × 3 + validate ฝั่ง server)
  const chart = await listChartOfAccounts(service, access.tenantId);

  // ลูกค้าที่เลือก (validate uuid + ต้องอยู่ในสโคป)
  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const assets = validCustomerId ? await listAssets(service, access.tenantId, validCustomerId) : [];
  const assetIds = assets.map((a) => a.id);
  const occurrences =
    assetIds.length > 0
      ? await listOccurrencesByAssetIds(service, access.tenantId, validCustomerId, assetIds)
      : [];

  // ประวัติค่าเสื่อมต่อทรัพย์สิน (จำนวนทรัพย์สินต่อลูกค้าปกติน้อย ไม่ใช่ N+1 ที่มีผล perf จริง)
  const logByAsset = new Map<string, DepreciationLogEntry[]>();
  for (const a of assetIds.slice(0, LOG_FETCH_LIMIT)) {
    logByAsset.set(a, await listDepreciationLog(service, access.tenantId, a));
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ทะเบียนทรัพย์สินถาวร"
      subtitle="ทะเบียนทรัพย์สิน + คำนวณ/บันทึกค่าเสื่อมราคาแบบเส้นตรงอัตโนมัติทุกเดือน"
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
          {validCustomerId ? (
            <a href={`/chat-audit/accounting/fixed-assets/export?customerId=${validCustomerId}`} className="btn btn-ghost">
              ออก Excel
            </a>
          ) : null}
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อจัดการทะเบียนทรัพย์สินถาวร</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <FixedAssetsPanel
              customerId={validCustomerId}
              assets={assets}
              occurrences={occurrences}
              depreciationLog={Object.fromEntries(logByAsset)}
              chart={chart}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
