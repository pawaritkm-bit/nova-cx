import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listBillPaymentsForEntries } from "@/lib/accounting/bill-payments";
import { listNotesForEntries, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { buildAgingReport } from "@/lib/accounting/aging";
import AgingReportDoc from "./AgingReportDoc";
import "../vat-report/vat-report.css";
import "./aging-report.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** วันนี้เวลาไทย → "YYYY-MM-DD" (default asOfDate) */
function todayThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** ตัวเลือกเดือนย้อนหลัง (ใหม่→เก่า) — ★ 2026-09-04 ผู้ใช้: "ตรงเลือกเดือนเลือกวัน
 *  อยากให้แท็บเลือกเหมือนหน้าสมุดรายวัน" (mirror recentMonthOptions ของ journal-books) */
const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
function recentMonthOptions(count: number): { value: string; label: string }[] {
  const cur = todayThai().slice(0, 7);
  let y = Number(cur.slice(0, 4));
  let mi = Number(cur.slice(5, 7));
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ value: `${y}-${String(mi).padStart(2, "0")}`, label: `${THAI_MONTHS[mi]} ${y + 543}` });
    mi -= 1;
    if (mi < 1) {
      mi = 12;
      y -= 1;
    }
  }
  return out;
}

/** ISO → dd/mm/พ.ศ. (คืน "" ถ้าพัง) */
function thaiDateShort(iso: string): string {
  if (!DATE_RE.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

function printedAtThai(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${Number(get("year")) + 543} ${get("hour")}:${get("minute")}`;
}

/**
 * /chat-audit/accounting/ar-ap-aging — "รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้" (AR/AP Aging)
 *   searchParams: customer=<uuid> (จำเป็น) · asOf=YYYY-MM-DD (ไม่ระบุ = วันนี้เวลาไทย)
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง) — pattern เดียวกับ
 *   vat-report/page.tsx (ลูกค้ามาจาก query param ที่ยิงมาจากปุ่มในหน้าลูกค้า ไม่ใช่ dropdown ในหน้านี้)
 * ★ tenantId จาก session · PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข
 */
export default async function ArApAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; asOf?: string }>;
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

  const asOfParam = (sp.asOf ?? "").trim();
  const asOfDate = DATE_RE.test(asOfParam) ? asOfParam : todayThai();

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name")
    .eq("id", customerId).eq("tenant_id", tenantId).is("deleted_at", null)
    .maybeSingle();
  if (!custRow) return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  const cust = custRow as { name: string | null; business_name: string | null };
  const companyName = (cust.business_name || cust.name || "กิจการ").trim();

  let report;
  try {
    const { entries } = await listEntries(service, tenantId, { customerId });
    const paymentsByEntry = await listBillPaymentsForEntries(service, tenantId, entries.map((e) => e.id));
    // เฟส 3 ส่วน J (0.6): CN/DN "confirmed" ของบิลในสโคปนี้ → ปรับยอดค้าง/bucket ให้ถูกต้อง
    const notesByEntry = await listNotesForEntries(service, tenantId, entries.map((e) => e.id));
    const netAdjByEntry = netAdjustmentByEntry(notesByEntry);
    report = buildAgingReport(entries, paymentsByEntry, asOfDate, netAdjByEntry);
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  const excelHref = `/chat-audit/accounting/ar-ap-aging/export?customer=${customerId}&asOf=${asOfDate}`;

  return (
    <AgingReportDoc
      customerId={customerId}
      companyName={companyName}
      asOfDate={asOfDate}
      asOfLabel={thaiDateShort(asOfDate)}
      monthOptions={recentMonthOptions(24)}
      printedAt={printedAtThai()}
      report={report}
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
