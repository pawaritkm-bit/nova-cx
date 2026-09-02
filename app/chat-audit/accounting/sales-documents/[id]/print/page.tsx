import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { getSalesDocument } from "@/lib/accounting/sales-documents";
import SalesDocumentPrintDoc from "../../SalesDocumentPrintDoc";
import "../../sales-documents.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/sales-documents/[id]/print — พิมพ์ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล 1 ใบ
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ หัวกระดาษ (ผู้ออกเอกสาร) = ข้อมูล "ลูกค้า" ของสำนักงาน (business_name/tax_id/address) เสมอทั้ง 3
 *   ประเภท (mirror receipt-cert/wht-cert) — counterparty (ลูกค้าปลายทาง/ผู้ขาย) เก็บแยกในตัวเอกสารแล้ว
 * ★ เนื้อหาที่แสดง = สำเนา ณ เวลาที่บันทึก (ไม่ join สดกับ bill_entries/products อีก — 0.14)
 */
export default async function SalesDocumentPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!getSupabaseEnv()) {
    return <ErrorShell message="ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)" />;
  }
  if (!UUID_RE.test(id)) {
    return <ErrorShell message="ไม่พบเอกสาร" />;
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const doc = await getSalesDocument(service, access.tenantId, id);
  if (!doc) {
    return <ErrorShell message="ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" />;
  }
  if (!customerInScope(access, doc.customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id")
    .eq("id", doc.customerId)
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  const cust = custRow as { id: string; name: string | null; business_name: string | null; tax_id: string | null } | null;

  // ที่อยู่ลูกค้า — best-effort (คอลัมน์ address เพิ่งเพิ่ม migration 0058 อาจยังไม่ apply, mirror wht-cert)
  let businessAddress = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", doc.customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (!error) businessAddress = (data as { address: string | null } | null)?.address ?? "";
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }
  // โทรศัพท์ผู้ออก — best-effort (โชว์หัวกระดาษตามฟอร์มตัวอย่าง 2026-09-02)
  let businessPhone = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("phone")
      .eq("id", doc.customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (!error) businessPhone = ((data as { phone: string | null } | null)?.phone ?? "").trim();
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }

  const businessName = (cust?.business_name || cust?.name || "").trim();

  return (
    <SalesDocumentPrintDoc
      document={doc}
      issuerName={businessName}
      issuerTaxId={cust?.tax_id ?? ""}
      issuerAddress={businessAddress}
      issuerPhone={businessPhone}
      backHref="/chat-audit/accounting/sales-documents"
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="sd-shell">
      <div className="sd-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting/sales-documents" className="sd-btn">
          ← กลับหน้าใบเสนอราคา/PO/วางบิล
        </a>
      </div>
    </div>
  );
}
