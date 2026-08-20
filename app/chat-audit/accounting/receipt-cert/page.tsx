import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { lineNet } from "@/lib/accounting/queries";
import ReceiptCertDoc, { type ReceiptCertItem } from "./ReceiptCertDoc";
import "./receipt-cert.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/receipt-cert — "ใบรับรองแทนใบเสร็จรับเงิน"
 *
 * เอกสารที่ลูกค้า (ผู้จ่าย) ออกเมื่อจ่ายค่าใช้จ่ายแล้วผู้รับเงินออกใบเสร็จไม่ได้
 *   → หัวกระดาษ = ข้อมูล "ลูกค้า" (ผู้จ่าย/ผู้รับรอง) ไม่ใช่ Finovas
 *
 * เข้าได้ 2 ทาง (ผ่าน searchParams):
 *   - ?customer=<uuid>            → ฟอร์มเปล่าของลูกค้า (ดึงหัวกระดาษให้)
 *   - ?customer=<uuid>&bill=<uuid> → prefill รายการ/จำนวนเงิน/วันที่ จากบิลใบนั้น
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 *   ★ tenantId จาก session (ไม่เชื่อ client)
 *   ★ Phase 1: ไม่บันทึกลง DB / ไม่ auto-number — เลขที่เอกสารเป็นช่องกรอก (มี default แนะนำ)
 *   ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */

/** วันที่วันนี้ (เวลาไทย) รูปแบบ dd/mm/พ.ศ. — ค่า default ของช่อง "วันที่" */
function todayThaiDate(): string {
  // ใช้ timeZone Asia/Bangkok กันเหลื่อมวัน (บทเรียนทีม: ตัดเดือนตามเวลาไทย)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  return `${get("day")}/${get("month")}/${y + 543}`;
}

/** แปลง doc_date (YYYY-MM-DD) → dd/mm/พ.ศ. (คืน "" ถ้าไม่มี/พัง) */
function isoToThaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/** ตัวเลขปลอดภัย (NaN/null → 0) */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** ดึง "ชื่อผู้ติดต่อ" ของลูกค้า (ข้าพเจ้า/ผู้จ่าย) — best-effort */
async function loadContactName(
  service: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<string | null> {
  // 1) ผู้ติดต่อหลักใน customer_contacts (คอลัมน์ name เป็น plain text — ไม่เข้ารหัส)
  try {
    const { data } = await service
      .from("customer_contacts")
      .select("name, is_primary")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .limit(5);
    for (const c of (data ?? []) as { name: string | null; is_primary: boolean }[]) {
      if (c.name && c.name.trim()) return c.name.trim();
    }
  } catch {
    // ตาราง/คอลัมน์ผิดพลาดชั่วคราว → ลอง fallback ต่อ
  }
  // 2) fallback: ชื่อที่แสดงของบัญชี LINE ที่ผูกลูกค้ารายนี้
  try {
    const { data } = await service
      .from("line_users")
      .select("display_name")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .limit(1);
    const dn = (data?.[0] as { display_name: string | null } | undefined)?.display_name;
    if (dn && dn.trim()) return dn.trim();
  } catch {
    // degrade เงียบ ๆ
  }
  return null;
}

type BillHeader = {
  customerId: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
  items: ReceiptCertItem[];
  docDate: string;
};

/** ดึงบิล (header + รายการ) จาก bill id (scope tenant) — ใช้ได้ทั้งบิลที่ผูก/ไม่ผูกลูกค้า
 *   ★ scope จริงเช็คที่ caller (customerInScope ถ้ามีลูกค้า) — ที่นี่กันแค่ tenant */
async function loadBill(
  service: SupabaseClient,
  tenantId: string,
  billId: string
): Promise<BillHeader | null> {
  const { data: entry } = await service
    .from("bill_entries")
    .select("id, customer_id, doc_date, buyer_name, counterparty_name, counterparty_tax_id")
    .eq("id", billId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!entry) return null;
  const e = entry as {
    id: string;
    customer_id: string | null;
    doc_date: string | null;
    buyer_name: string | null;
    counterparty_name: string | null;
    counterparty_tax_id: string | null;
  };

  const { data: lineData } = await service
    .from("bill_entry_lines")
    .select("line_no, description, amount, vat_amount, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", billId)
    .order("line_no", { ascending: true });

  const billDate = isoToThaiDate(e.doc_date);
  const items: ReceiptCertItem[] = ((lineData ?? []) as {
    line_no: number;
    description: string | null;
    amount: number | string | null;
    vat_amount: number | string | null;
    wht_amount: number | string | null;
  }[]).map((l) => ({
    // วันที่แต่ละแถว = วันที่บิล (ทุกบรรทัดของบิลเดียวกันใช้วันเดียว)
    date: billDate,
    description: l.description ?? "",
    // จำนวนเงินที่ "จ่ายจริง" ต่อบรรทัด = มูลค่า + VAT − หัก ณ ที่จ่าย
    amount: lineNet({
      amount: num(l.amount),
      vatAmount: num(l.vat_amount),
      whtAmount: num(l.wht_amount),
    }),
    note: "",
  }));

  return {
    customerId: e.customer_id,
    buyerName: e.buyer_name,
    buyerTaxId: e.counterparty_tax_id,
    items,
    docDate: billDate,
  };
}

export default async function ReceiptCertPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; bill?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ErrorShell message="ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)" />
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const customerParam = (sp.customer ?? "").trim();
  const billId = (sp.bill ?? "").trim();

  // ★ เปิดได้ 2 ทาง: มีลูกค้า (customer) หรือมีบิล (bill) อย่างน้อยหนึ่งอย่าง
  //   → รองรับ "ทุกบิล" รวมบิลที่ยังไม่ผูกลูกค้า (ตามที่ลูกค้าสั่ง: ปุ่มขึ้นทุกบิล)
  if (!UUID_RE.test(customerParam) && !UUID_RE.test(billId)) {
    return <ErrorShell message="เปิดใบรับรองจากแถวบิล หรือการ์ดลูกค้าอีกครั้ง" />;
  }

  // โหลดบิลก่อน (ถ้ามี) — ได้ header (buyer/tax) + รายการ + ลูกค้าที่ผูกกับบิล
  let bill: BillHeader | null = null;
  if (UUID_RE.test(billId)) {
    bill = await loadBill(service, tenantId, billId);
  }

  // ลูกค้าที่ใช้ทำหัวกระดาษ = param (ถ้าให้มา) หรือ ลูกค้าที่ผูกกับบิล
  const customerId = UUID_RE.test(customerParam) ? customerParam : bill?.customerId ?? "";

  // ★ สโคป: ถ้ามีลูกค้า → นักบัญชีต้องดูแลลูกค้ารายนั้น · บิลที่ยังไม่ผูกลูกค้า → ผ่าน (tenant + สิทธิ์บัญชีพอ)
  if (UUID_RE.test(customerId) && !customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  // หัวกระดาษ = ข้อมูลลูกค้า (ผู้จ่าย/ผู้รับรอง) — ถ้าไม่มีลูกค้า ใช้ชื่อ "ผู้ซื้อ" ที่อ่านได้จากบิลแทน (นักบัญชีแก้ได้)
  let defaultPayerName = "";
  let taxId = "";
  if (UUID_RE.test(customerId)) {
    const { data: custRow } = await service
      .from("customers")
      .select("id, name, business_name, tax_id, customer_code")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    const cust = custRow as { name: string | null; business_name: string | null; tax_id: string | null } | null;
    if (cust) {
      const businessName = (cust.business_name || cust.name || "").trim();
      const contactName = await loadContactName(service, tenantId, customerId);
      defaultPayerName = contactName || businessName;
      taxId = cust.tax_id ?? "";
    }
  }
  // ไม่มีลูกค้า/ไม่มีชื่อ → เดาจากบิล (ผู้ซื้อ) ให้นักบัญชีแก้
  if (!defaultPayerName) defaultPayerName = bill?.buyerName ?? "";
  if (!taxId) taxId = bill?.buyerTaxId ?? "";

  const items: ReceiptCertItem[] =
    bill && bill.items.length > 0 ? bill.items : [{ date: "", description: "", amount: 0, note: "" }];
  const docDate = bill?.docDate || todayThaiDate();

  return (
    <ReceiptCertDoc
      customerName={defaultPayerName}
      taxId={taxId}
      docDate={docDate}
      items={items}
      backHref="/chat-audit/accounting"
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="rcv-shell">
      <div className="rcv-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting" className="rcv-btn">
          ← กลับหน้าลงบันทึกบัญชี
        </a>
      </div>
    </div>
  );
}
