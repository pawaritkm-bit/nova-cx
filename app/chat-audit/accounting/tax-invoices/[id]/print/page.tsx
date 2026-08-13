import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { getTaxInvoice } from "@/lib/accounting/tax-invoice";
import TaxInvoicePrintDoc from "../../TaxInvoicePrintDoc";
import "../../tax-invoices.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/tax-invoices/[id]/print — พิมพ์ใบกำกับภาษี 1 ใบ
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ หัวกระดาษ (ผู้ออกเอกสาร/ผู้ขาย) = ข้อมูล "ลูกค้า" ของสำนักงาน (business_name/tax_id/address) เสมอ
 *   (mirror sales-documents/[id]/print — customer ในระบบนี้ = นิติบุคคลที่ออกเอกสารจริง)
 * ★ เนื้อหาที่แสดง = สำเนา ณ เวลาที่ออกเอกสาร (tax_invoice_lines) — ไม่ join สดกับบิลต้นทางอีก
 */
export default async function TaxInvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
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

  const invoice = await getTaxInvoice(service, access.tenantId, id);
  if (!invoice) {
    return <ErrorShell message="ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" />;
  }
  if (!customerInScope(access, invoice.customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id")
    .eq("id", invoice.customerId)
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  const cust = custRow as { id: string; name: string | null; business_name: string | null; tax_id: string | null } | null;

  // ที่อยู่ผู้ขาย — best-effort (คอลัมน์ address เพิ่งเพิ่ม migration 0058 อาจยังไม่ apply, mirror wht-cert/sales-documents)
  let sellerAddress = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", invoice.customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (!error) sellerAddress = (data as { address: string | null } | null)?.address ?? "";
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }

  const sellerName = (cust?.business_name || cust?.name || "").trim();

  return (
    <TaxInvoicePrintDoc
      invoice={invoice}
      sellerName={sellerName}
      sellerTaxId={cust?.tax_id ?? ""}
      sellerAddress={sellerAddress}
      backHref="/chat-audit/accounting/tax-invoices"
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="ti-shell">
      <div className="ti-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting/tax-invoices" className="ti-btn">
          ← กลับหน้าใบกำกับภาษี
        </a>
      </div>
    </div>
  );
}
