import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { isCreditEligibleForPayment } from "@/lib/accounting/bill-payments";
import { loadOutstandingFxGroup, listFxPeriodRevaluations, type FxOutstandingGroup } from "@/lib/accounting/fx-revaluation";
import type { FxEligibleEntryType } from "@/lib/accounting/fx";
import FxRevaluationPanel from "./FxRevaluationPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** วันนี้เวลาไทย → "YYYY-MM-DD" (ใช้เป็น asOfDate เริ่มต้นของยอดคงค้าง FX ที่แสดง) */
function todayThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** รายชื่อลูกค้าในสโคปของผู้เรียก (id + label) — สำหรับ dropdown เลือกลูกค้า */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/** กลุ่ม (currency+entryType) ทั้งหมดที่ลูกค้ารายนี้มีบิลเชื่อสกุลต่างประเทศยืนยันแล้วอยู่จริง */
function distinctFxGroups(entries: { entryType: string; currency?: string | null }[]): {
  currency: string;
  entryType: FxEligibleEntryType;
}[] {
  const seen = new Set<string>();
  const out: { currency: string; entryType: FxEligibleEntryType }[] = [];
  for (const e of entries) {
    if (!e.currency) continue;
    if (e.entryType !== "sale" && e.entryType !== "purchase") continue;
    const key = `${e.currency}|${e.entryType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ currency: e.currency, entryType: e.entryType });
  }
  return out.sort((a, b) => (a.currency + a.entryType).localeCompare(b.currency + b.entryType));
}

/**
 * /chat-audit/accounting/fx-revaluation — "ปรับปรุงอัตราแลกเปลี่ยนปลายงวด" (เฟส 10b)
 *   เลือกลูกค้า (ในสโคป) → เห็นยอดคงค้าง FX แยกตาม currency/entryType (ก่อน VAT) + ประวัติ JV
 *   ปรับปรุง/กลับรายการเดิม (พร้อม live status) → สร้าง/ยืนยันได้จากหน้านี้เท่านั้น (0.13)
 */
export default async function FxRevaluationPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ปรับปรุงอัตราแลกเปลี่ยนปลายงวด" subtitle="Unrealized FX Revaluation">
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

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  let groups: FxOutstandingGroup[] = [];
  let history: Awaited<ReturnType<typeof listFxPeriodRevaluations>> = [];
  let loadError = false;
  const asOfDate = todayThai();

  if (validCustomerId) {
    try {
      const { entries } = await listEntries(service, access.tenantId, { customerId: validCustomerId });
      const eligible = entries.filter((e) => isCreditEligibleForPayment(e) && !!e.currency);
      const fxGroups = distinctFxGroups(eligible);
      groups = await Promise.all(
        fxGroups.map((g) =>
          loadOutstandingFxGroup(service, access.tenantId, validCustomerId, g.currency, g.entryType, asOfDate)
        )
      );
      history = await listFxPeriodRevaluations(service, access.tenantId, validCustomerId);
    } catch {
      loadError = true;
    }
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ปรับปรุงอัตราแลกเปลี่ยนปลายงวด"
      subtitle="Unrealized FX Revaluation — สร้าง/ยืนยัน JV ปรับปรุง + กลับรายการอัตโนมัติ (auto-reversing)"
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
            <p className="empty">เลือกลูกค้าด้านบนเพื่อปรับปรุงอัตราแลกเปลี่ยนปลายงวด</p>
          </div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <FxRevaluationPanel customerId={validCustomerId} groups={groups} history={history} asOfDate={asOfDate} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
