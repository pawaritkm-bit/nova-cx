import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listProducts } from "@/lib/accounting/products";
import { listSalesDocuments, listBillingCandidates } from "@/lib/accounting/sales-documents";
import SalesDocumentsPanel from "./SalesDocumentsPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";
import "./sales-documents.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * /chat-audit/accounting/sales-documents — "ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล" (เฟส 3 ส่วน K)
 *   เลือกลูกค้า (ในสโคป) → แท็บ 3 ประเภท (สลับในจอ) → list เอกสาร + สร้าง/แก้ไข draft/ออกเอกสาร/ยกเลิก
 *
 * ★ guard + scope เดียวกับหน้า credit-debit-notes/payments (resolveAccountingAccess)
 * ★ ไม่กระทบ accounting engine เลย (0.11) — เอกสารกลุ่มนี้เป็นแค่งานเอกสารช่วยขาย
 */
export default async function SalesDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ใบเสนอราคา/PO/วางบิล" subtitle="เอกสารช่วยขายก่อน/ระหว่างขาย-ซื้อ">
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

  let documents: Awaited<ReturnType<typeof listSalesDocuments>> = [];
  let billingCandidates: Awaited<ReturnType<typeof listBillingCandidates>> = [];
  let products: Awaited<ReturnType<typeof listProducts>> = [];
  let loadError = false;
  // ★ 2026-09-03 ตัวอย่างสดข้างฟอร์ม — ข้อมูลผู้ออก + โลโก้/ตรา (best-effort เหมือนหน้าพิมพ์)
  let issuerName = "";
  let issuerTaxId = "";
  let issuerAddress = "";
  let issuerPhone = "";
  let logoUrl = "";
  let stampUrl = "";
  if (validCustomerId) {
    try {
      [documents, billingCandidates, products] = await Promise.all([
        listSalesDocuments(service, access.tenantId, validCustomerId),
        listBillingCandidates(service, access.tenantId, validCustomerId),
        listProducts(service, access.tenantId),
      ]);
    } catch {
      loadError = true;
    }
    try {
      const { data: custRow } = await service
        .from("customers")
        .select("name, business_name, tax_id")
        .eq("id", validCustomerId)
        .eq("tenant_id", access.tenantId)
        .is("deleted_at", null)
        .maybeSingle();
      const cust = custRow as { name: string | null; business_name: string | null; tax_id: string | null } | null;
      issuerName = (cust?.business_name || cust?.name || "").trim();
      issuerTaxId = cust?.tax_id ?? "";
    } catch {
      // best-effort — หัวกระดาษตัวอย่างว่างได้
    }
    try {
      const { data, error } = await service
        .from("customers")
        .select("address, phone")
        .eq("id", validCustomerId)
        .eq("tenant_id", access.tenantId)
        .maybeSingle();
      if (!error) {
        const r = data as { address: string | null; phone: string | null } | null;
        issuerAddress = r?.address ?? "";
        issuerPhone = (r?.phone ?? "").trim();
      }
    } catch {
      // คอลัมน์ยังไม่ apply → ปล่อยว่าง
    }
    try {
      const { data: signedLogo } = await service.storage
        .from("bills")
        .createSignedUrl(`${access.tenantId}/customer-logos/${validCustomerId}`, 3600);
      logoUrl = signedLogo?.signedUrl ?? "";
      const { data: signedStamp } = await service.storage
        .from("bills")
        .createSignedUrl(`${access.tenantId}/customer-logos/${validCustomerId}.stamp`, 3600);
      stampUrl = signedStamp?.signedUrl ?? "";
    } catch {
      // ไม่มีโลโก้ — ตัวอย่างใช้กล่องอักษรย่อ
    }
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล"
      subtitle="เอกสารช่วยขายก่อน/ระหว่างขาย-ซื้อ — ไม่กระทบยอดบัญชี"
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
            <p className="empty">เลือกลูกค้าด้านบนเพื่อสร้างใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล</p>
          </div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <SalesDocumentsPanel
              customerId={validCustomerId}
              documents={documents}
              billingCandidates={billingCandidates}
              products={products}
              issuerName={issuerName}
              issuerTaxId={issuerTaxId}
              issuerAddress={issuerAddress}
              issuerPhone={issuerPhone}
              logoUrl={logoUrl}
              stampUrl={stampUrl}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
