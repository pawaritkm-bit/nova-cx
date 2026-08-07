import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, type ListEntriesFilter } from "@/lib/accounting/queries";
import { defaultSbtBase } from "@/lib/accounting/sbt-report";
import SbtReportDoc from "./SbtReportDoc";
import "../vat-report/vat-report.css";
import "./sbt-report.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** YYYY-MM → "กรกฎาคม ปี พ.ศ. 2569" (คืน "ทุกเดือน" ถ้าไม่มี/พัง) */
function monthLabelOf(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  return `${THAI_MONTHS[Number(m[2])]} ปี พ.ศ. ${Number(m[1]) + 543}`;
}

/** วันที่/เวลาพิมพ์ (เวลาไทย) → "04/08/2569 09:30" */
function printedAtThai(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${Number(get("year")) + 543} ${get("hour")}:${get("minute")}`;
}

/** ที่อยู่ลูกค้า (best-effort — คอลัมน์ address เพิ่ง apply 0058) */
async function loadAddress(
  service: SupabaseClient, tenantId: string, customerId: string
): Promise<string> {
  try {
    const { data, error } = await service
      .from("customers").select("address")
      .eq("id", customerId).eq("tenant_id", tenantId).maybeSingle();
    if (error) return "";
    return ((data as { address: string | null } | null)?.address ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * /chat-audit/accounting/sbt-report — รายงาน ภธ.40 (ภาษีธุรกิจเฉพาะ) ต่อลูกค้า/เดือน
 *   searchParams: customer=<uuid> (จำเป็น) · month=YYYY-MM (ไม่ระบุ = ทุกเดือน)
 *
 * ★ guard: resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */
export default async function SbtReportPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; month?: string }>;
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
    return <ErrorShell message="ไม่พบลูกค้า — เปิดรายงานจากการ์ดลูกค้าอีกครั้ง" />;
  }
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  const monthParam = (sp.month ?? "").trim();
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id")
    .eq("id", customerId).eq("tenant_id", tenantId).is("deleted_at", null)
    .maybeSingle();
  if (!custRow) return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  const cust = custRow as {
    name: string | null; business_name: string | null; tax_id: string | null;
  };
  const companyName = (cust.business_name || cust.name || "กิจการ").trim();
  const companyAddress = await loadAddress(service, tenantId, customerId);

  // ฐานเริ่มต้น = รายได้ฝั่งขายก่อน VAT ของเดือน (แก้ได้ต่อในหน้า)
  let base = 0;
  try {
    const filter: ListEntriesFilter = { customerId, entryType: "sale" };
    if (validMonth) filter.month = validMonth;
    const { entries } = await listEntries(service, tenantId, filter);
    base = defaultSbtBase(entries);
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  return (
    <SbtReportDoc
      companyName={companyName}
      companyTaxId={(cust.tax_id ?? "").trim()}
      companyAddress={companyAddress}
      monthLabel={monthLabelOf(validMonth)}
      printedAt={printedAtThai()}
      defaultBase={base}
      backHref="/chat-audit/accounting"
    />
  );
}

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
