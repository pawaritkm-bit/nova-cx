import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { isWhtCertEligible, buildWhtCertLines, type WhtCertLine } from "@/lib/accounting/wht-cert";
import WhtCertDoc from "./WhtCertDoc";
import "./wht-cert.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/wht-cert — "หนังสือรับรองหัก ณ ที่จ่าย"
 *
 * เอกสารที่ลูกค้า (ผู้จ่ายเงิน/ผู้มีหน้าที่หักภาษี) ออกให้ผู้รับเงินตอนซื้อบิลที่มี WHT
 *   → หัวกระดาษ = ข้อมูล "ลูกค้า" (ผู้จ่าย/ผู้ออก) ไม่ใช่ Finovas (mirror receipt-cert 0.2)
 *   → ผู้ถูกหักภาษี (ผู้รับเงิน) = counterparty_name/counterparty_tax_id ของบิล
 *
 * เข้าได้ 2 ทาง (ผ่าน searchParams):
 *   - ?customer=<uuid>            → ฟอร์มเปล่าของลูกค้า (ดึงหัวกระดาษให้)
 *   - ?customer=<uuid>&bill=<uuid> → prefill รายการ WHT จากบิลใบนั้น (ต้อง isWhtCertEligible เท่านั้น)
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 *   ★ tenantId จาก session (ไม่เชื่อ client)
 *   ★ print-only: ไม่บันทึกลง DB / ไม่มี migration ใหม่ / ไม่ auto-number — เลขที่เอกสารเป็นช่องกรอก
 *   ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */

/** วันที่วันนี้ (เวลาไทย) รูปแบบ dd/mm/พ.ศ. — ค่า default ของช่อง "วันที่" */
function todayThaiDate(): string {
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

/** แถวบิล (prefill) — คืน lines ที่ eligible + วันที่บิล + ผู้ถูกหักภาษี + ภ.ง.ด.
 *   (scope tenant + ต้องเป็นลูกค้ารายเดียวกัน + ต้อง isWhtCertEligible เท่านั้น)
 */
async function loadBillPrefill(
  service: SupabaseClient,
  tenantId: string,
  billId: string,
  customerId: string
): Promise<
  | {
      items: WhtCertLine[];
      docDate: string;
      counterpartyName: string;
      counterpartyTaxId: string;
      whtForm: "pnd3" | "pnd53" | null;
    }
  | { error: string }
> {
  const { data: entry } = await service
    .from("bill_entries")
    .select("id, customer_id, entry_type, doc_date, counterparty_name, counterparty_tax_id, wht_form")
    .eq("id", billId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!entry) return { error: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" };
  const e = entry as {
    id: string;
    customer_id: string | null;
    entry_type: string;
    doc_date: string | null;
    counterparty_name: string | null;
    counterparty_tax_id: string | null;
    wht_form: string | null;
  };
  // บิลต้องเป็นของลูกค้ารายนี้ (กันดึงข้ามลูกค้า/นอกสโคป)
  if (e.customer_id !== customerId) return { error: "บิลนี้ไม่ได้ผูกกับลูกค้ารายนี้" };

  const { data: lineData } = await service
    .from("bill_entry_lines")
    .select("line_no, description, amount, wht_rate, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", billId)
    .order("line_no", { ascending: true });

  const lines = ((lineData ?? []) as {
    line_no: number;
    description: string | null;
    amount: number | string | null;
    wht_rate: number | string | null;
    wht_amount: number | string | null;
  }[]).map((l) => ({
    description: l.description,
    amount: num(l.amount),
    whtRate: num(l.wht_rate),
    whtAmount: num(l.wht_amount),
  }));

  // ★ ปฏิเสธ/แสดง error ชัดเจนถ้าบิลนี้ไม่ eligible (ไม่ใช่บิลซื้อ หรือไม่มีบรรทัด WHT เลย)
  if (!isWhtCertEligible({ entryType: e.entry_type, lines })) {
    return { error: "บิลนี้ไม่มีรายการหัก ณ ที่จ่าย หรือไม่ใช่บิลซื้อ — ออกหนังสือรับรองไม่ได้" };
  }

  const billDate = isoToThaiDate(e.doc_date);
  return {
    items: buildWhtCertLines(lines, billDate),
    docDate: billDate,
    counterpartyName: e.counterparty_name ?? "",
    counterpartyTaxId: e.counterparty_tax_id ?? "",
    whtForm: e.wht_form === "pnd3" || e.wht_form === "pnd53" ? e.wht_form : null,
  };
}

export default async function WhtCertPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; bill?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return <ErrorShell message="ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)" />;
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const customerId = (sp.customer ?? "").trim();
  if (!UUID_RE.test(customerId)) {
    return <ErrorShell message="ไม่พบลูกค้า — เปิดหนังสือรับรองจากการ์ดลูกค้า หรือแถวบิลอีกครั้ง" />;
  }
  // ★ สโคป: นักบัญชีออกหนังสือรับรองได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  // หัวกระดาษ = ข้อมูลลูกค้า (ผู้จ่ายเงิน/ผู้มีหน้าที่หัก) — business_name/tax_id/address
  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id, customer_code")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!custRow) {
    return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  }
  const cust = custRow as {
    id: string;
    name: string | null;
    business_name: string | null;
    tax_id: string | null;
    customer_code: string | null;
  };

  // ที่อยู่ลูกค้า — best-effort (คอลัมน์ address เพิ่งเพิ่ม migration 0058 อาจยังไม่ apply)
  let customerAddress = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!error) customerAddress = (data as { address: string | null } | null)?.address ?? "";
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }

  const businessName = (cust.business_name || cust.name || "").trim();

  // prefill จากบิล (ถ้าส่ง ?bill= มา และผ่านสโคป + eligible)
  const billId = (sp.bill ?? "").trim();
  let items: WhtCertLine[] = [];
  let docDate = "";
  let counterpartyName = "";
  let counterpartyTaxId = "";
  let whtForm: "pnd3" | "pnd53" | null = null;
  if (UUID_RE.test(billId)) {
    const pre = await loadBillPrefill(service, tenantId, billId, customerId);
    if ("error" in pre) {
      return <ErrorShell message={pre.error} />;
    }
    items = pre.items;
    docDate = pre.docDate;
    counterpartyName = pre.counterpartyName;
    counterpartyTaxId = pre.counterpartyTaxId;
    whtForm = pre.whtForm;
  }
  if (items.length === 0) items = [{ date: "", description: "", amount: 0, whtRate: 0, whtAmount: 0 }];
  if (!docDate) docDate = todayThaiDate();

  return (
    <WhtCertDoc
      payerName={businessName}
      payerTaxId={cust.tax_id ?? ""}
      payerAddress={customerAddress}
      payeeName={counterpartyName}
      payeeTaxId={counterpartyTaxId}
      docDate={docDate}
      whtForm={whtForm}
      items={items}
      backHref="/chat-audit/accounting"
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="whtc-shell">
      <div className="whtc-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting" className="whtc-btn">
          ← กลับหน้าลงบันทึกบัญชี
        </a>
      </div>
    </div>
  );
}
