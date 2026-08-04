import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildVatReport, type VatReportKind } from "@/lib/accounting/vat-report";
import VatReportDoc from "./VatReportDoc";
import "./vat-report.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ชื่อเดือนภาษาไทยเต็ม (index 1-12) */
const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** YYYY-MM → "กรกฎาคม ปี พ.ศ. 2569" (คืน "ทุกเดือน" ถ้าไม่มี/พัง) */
function monthLabelOf(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  const year = Number(m[1]) + 543;
  const mi = Number(m[2]);
  return `${THAI_MONTHS[mi]} ปี พ.ศ. ${year}`;
}

/** วันที่/เวลาพิมพ์ (เวลาไทย) → "04/08/2569 09:30" */
function printedAtThai(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year")) + 543;
  return `${get("day")}/${get("month")}/${y} ${get("hour")}:${get("minute")}`;
}

/**
 * ดึงที่อยู่ลูกค้า (customers.address) แบบ best-effort
 *   — คอลัมน์ address เพิ่งเพิ่มด้วย migration 0058 · ถ้ายังไม่ apply → query error → คืน ""
 *     (degrade เงียบ ไม่ทำหน้าพัง) · PDPA: ไม่ log ค่าที่อยู่
 */
async function loadAddress(
  service: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<string> {
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return "";
    const addr = (data as { address: string | null } | null)?.address;
    return (addr ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * /chat-audit/accounting/vat-report — "รายงานภาษีซื้อ / รายงานภาษีขาย" (ฟอร์มราชการ)
 *   ต่อลูกค้า 1 ราย + เดือนภาษี → เอกสารพิมพ์/บันทึก PDF + ดาวน์โหลด Excel
 *
 * searchParams:
 *   customer=<uuid> (จำเป็น) · type=purchase|sale (จำเป็น) · month=YYYY-MM (ถ้าไม่ระบุ = ทุกเดือน)
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session · PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */
export default async function VatReportPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; type?: string; month?: string }>;
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

  // ---- validate param ----
  const customerId = (sp.customer ?? "").trim();
  if (!UUID_RE.test(customerId)) {
    return <ErrorShell message="ไม่พบลูกค้า — เปิดรายงานจากการ์ดลูกค้าอีกครั้ง" />;
  }
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  const typeParam = (sp.type ?? "").trim();
  const kind: VatReportKind = typeParam === "sale" ? "sale" : "purchase";

  const monthParam = (sp.month ?? "").trim();
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";

  // ---- หัวกระดาษ = ข้อมูลลูกค้า ----
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
    name: string | null;
    business_name: string | null;
    tax_id: string | null;
    customer_code: string | null;
  };
  const companyName = (cust.business_name || cust.name || "กิจการ").trim();
  const companyAddress = await loadAddress(service, tenantId, customerId);

  // ---- ดึง entries ตามลูกค้า+ประเภท+เดือน แล้ว build รายงาน ----
  const filter: ListEntriesFilter = { customerId, entryType: kind };
  if (validMonth) filter.month = validMonth;

  let report;
  try {
    const { entries } = await listEntries(service, tenantId, filter);
    report = buildVatReport(entries, kind);
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  // ---- ลิงก์ Excel (route แยก คง scope/filter เดิม) ----
  const ex = new URLSearchParams();
  ex.set("customer", customerId);
  ex.set("type", kind);
  if (validMonth) ex.set("month", validMonth);
  const excelHref = `/chat-audit/accounting/vat-report/export?${ex.toString()}`;

  return (
    <VatReportDoc
      kind={kind}
      companyName={companyName}
      companyTaxId={(cust.tax_id ?? "").trim()}
      companyAddress={companyAddress}
      monthLabel={monthLabelOf(validMonth)}
      printedAt={printedAtThai()}
      rows={report.rows}
      totals={report.totals}
      excelHref={excelHref}
      backHref="/chat-audit/accounting"
    />
  );
}

/** กรอบ error/สิทธิ์ (standalone — พิมพ์สะอาด ไม่ใช้ ChatAuditFrame) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="vr-shell">
      <div className="vr-page" style={{ maxWidth: 520, textAlign: "center" }}>
        <p style={{ fontSize: 16, marginBottom: 20 }}>{message}</p>
        <a href="/chat-audit/accounting" className="vr-btn vr-btn-ghost">
          ← กลับหน้าลงบันทึกบัญชี
        </a>
      </div>
    </div>
  );
}
