import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { isAIConfigured } from "@/lib/ai/provider";
import AskAiPanel from "./AskAiPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../accounting.css";
import "./ask-ai.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
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

/**
 * /chat-audit/accounting/ask-ai — "ถาม AI เรื่องข้อมูลธุรกิจ" (wishlist backlog ข้อ 3)
 *   นักบัญชีเลือกลูกค้า (ในสโคป) แล้วพิมพ์คำถามภาษาธรรมชาติเกี่ยวกับข้อมูลบัญชีของลูกค้ารายนั้น
 *
 * ★ guard + scope เดียวกับหน้าอื่น (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ ขอบเขตคำถาม v1: ยอดขาย/ยอดซื้อรายเดือน, ลูกหนี้/เจ้าหนี้ค้างชำระ, จำนวนบิลรอระบุประเภท
 * ★ AI เห็นแค่ "ข้อความคำถามที่นักบัญชีพิมพ์" (ไม่มีข้อมูลลูกค้า/ตัวเลขการเงินส่งออกไปเลย) —
 *   ดู lib/ai/business-qa.ts
 */
export default async function AskAiPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ถาม AI" subtitle="ถามคำถามเกี่ยวกับข้อมูลธุรกิจของลูกค้า">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/ask-ai");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const aiReady = isAIConfigured();

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ถาม AI"
      subtitle="ถามคำถามเกี่ยวกับข้อมูลธุรกิจของลูกค้า (ยอดขาย/ซื้อรายเดือน, ลูกหนี้/เจ้าหนี้ค้างชำระ, บิลรอระบุประเภท)"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          <form method="get" className="acc-opening-cust">
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={validCustomerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">เปิด</button>
          </form>
          <span className="acc-toolbar-spacer" />
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {!aiReady ? (
          <div className="card">ยังไม่ได้ตั้งค่า AI (OPENAI_API_KEY) — กรุณาติดต่อผู้ดูแลระบบก่อนใช้งาน</div>
        ) : customers.length === 0 ? (
          <div className="card"><p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p></div>
        ) : !validCustomerId ? (
          <div className="card"><p className="empty">เลือกลูกค้าด้านบนเพื่อเริ่มถามคำถาม</p></div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <AskAiPanel customerId={validCustomerId} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
