import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, monthBounds, effectiveTaxMonth, type ListEntriesFilter } from "@/lib/accounting/queries";
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

/** เดือนปัจจุบันตามเวลาไทย → "YYYY-MM" (ใช้เป็น default เมื่อไม่ได้ส่ง month มา) */
function currentMonthThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** ISO (YYYY-MM-DD) → "dd/mm/พ.ศ." (คืน "" ถ้าพัง) */
function thaiDateShort(iso: string): string {
  if (!DATE_RE.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * ป้ายหัวรายงานจากช่วงวันที่ [from, to]
 *   - ถ้าเป็น "ทั้งเดือนพอดี" (from=วันที่1 & to=วันสุดท้ายของเดือนเดียวกัน) → "เดือนภาษี มิถุนายน ปี พ.ศ. 2569"
 *   - ไม่งั้น → "ตั้งแต่ 01/06/2569 ถึง 15/06/2569"
 */
function periodLabelOf(from: string, to: string): string {
  const fm = from.slice(0, 7);
  const bounds = monthBounds(fm);
  if (bounds && fm === to.slice(0, 7) && from === bounds.first && to === bounds.last) {
    return `เดือนภาษี ${monthLabelOf(fm)}`;
  }
  return `ตั้งแต่ ${thaiDateShort(from)} ถึง ${thaiDateShort(to)}`;
}

/**
 * รายการเดือนย้อนหลัง `count` เดือน (นับจากเดือนปัจจุบันเวลาไทย) สำหรับ dropdown เลือกเดือน
 *   คืน [{ value: "YYYY-MM", label: "กรกฎาคม 2569" }, ...] เรียงจากใหม่→เก่า
 */
function recentMonthOptions(count: number): { value: string; label: string }[] {
  const cur = currentMonthThai();
  let y = Number(cur.slice(0, 4));
  let mi = Number(cur.slice(5, 7));
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const value = `${y}-${String(mi).padStart(2, "0")}`;
    out.push({ value, label: `${THAI_MONTHS[mi]} ${y + 543}` });
    mi -= 1;
    if (mi < 1) {
      mi = 12;
      y -= 1;
    }
  }
  return out;
}

/** เลื่อนเดือน 'YYYY-MM' ไป delta เดือน (delta ติดลบ = ย้อนหลัง) */
function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  let y = Number(m[1]);
  let mo = Number(m[2]) + delta;
  while (mo < 1) { mo += 12; y -= 1; }
  while (mo > 12) { mo -= 12; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
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
 *   customer=<uuid> (จำเป็น) · type=purchase|sale (จำเป็น) · month=YYYY-MM (ถ้าไม่ระบุ = เดือนปัจจุบันเวลาไทย)
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session · PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */
export default async function VatReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    type?: string;
    month?: string;
    from?: string;
    to?: string;
  }>;
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

  // ---- ช่วงวันที่รายงาน ----
  //   รับ from/to (YYYY-MM-DD) เป็นหลัก · ถ้าไม่ส่ง/พัง → default = ทั้งเดือนปัจจุบัน (เวลาไทย)
  //   ถ้ามีข้างเดียว → เติมอีกข้างแบบช่วงวันเดียว (กัน range ค้าง)
  const fromParam = (sp.from ?? "").trim();
  const toParam = (sp.to ?? "").trim();
  const fromValid = DATE_RE.test(fromParam) ? fromParam : "";
  const toValid = DATE_RE.test(toParam) ? toParam : "";

  let fromDate: string;
  let toDate: string;
  if (fromValid || toValid) {
    fromDate = fromValid || toValid;
    toDate = toValid || fromValid;
    // ใส่กลับด้าน → สลับให้ (หัวรายงาน/ช่องวันจะได้เรียงถูก)
    if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  } else {
    const b = monthBounds(currentMonthThai())!;
    fromDate = b.first;
    toDate = b.last;
  }

  // ปุ่มลัด "ทั้งเดือน": เดือนอ้างอิง = เดือนของ fromDate
  const selectedMonth = fromDate.slice(0, 7);
  const monthOptions = recentMonthOptions(24);
  if (!monthOptions.some((o) => o.value === selectedMonth)) {
    monthOptions.unshift({
      value: selectedMonth,
      label: monthLabelOf(selectedMonth).replace(" ปี พ.ศ. ", " "),
    });
  }

  const periodLabel = periodLabelOf(fromDate, toDate);

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

  // ---- ดึง entries ตามลูกค้า+ประเภท+ช่วงวัน แล้ว build รายงาน ----
  //   ★ ภาษีขาย: กรอง doc_date ในช่วง [from, to] ตามปกติ
  //   ★ ภาษีซื้อ: ยึด "เดือนที่ใช้ภาษี" (effectiveTaxMonth = input_tax_month ?? เดือน doc_date)
  //     บิลเดือนก่อน (≤6 เดือน) ที่ยกมาใช้ในช่วงนี้ต้องเข้ารายงานด้วย → ดึงกว้างขึ้นแล้วกรองในแอป
  let report;
  try {
    if (kind === "purchase") {
      const startMonth = fromDate.slice(0, 7);
      const endMonth = toDate.slice(0, 7);
      // ดึงบิลซื้อ doc_date ตั้งแต่ 6 เดือนก่อน startMonth ถึง toDate (ครอบบิลที่ยกเดือนมาใช้)
      const lowerBound = monthBounds(shiftMonth(startMonth, -6))?.first ?? fromDate;
      const { entries } = await listEntries(service, tenantId, {
        customerId,
        entryType: "purchase",
        dateFrom: lowerBound,
        dateTo: toDate,
      });
      // คัดเฉพาะบิลที่ "ใช้ภาษีในเดือน" อยู่ในช่วงเดือนที่เลือก [startMonth, endMonth]
      const inPeriod = entries.filter((e) => {
        const tm = effectiveTaxMonth(e); // null = บิลไม่มีวันที่ + ไม่ระบุเดือน → ตัดออก
        return tm != null && tm >= startMonth && tm <= endMonth;
      });
      report = buildVatReport(inPeriod, "purchase");
    } else {
      const filter: ListEntriesFilter = {
        customerId,
        entryType: "sale",
        dateFrom: fromDate,
        dateTo: toDate,
      };
      const { entries } = await listEntries(service, tenantId, filter);
      report = buildVatReport(entries, "sale");
    }
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  // ---- ลิงก์ Excel (route แยก คง scope/filter เดิม) — export ช่วงวันเดียวกันเสมอ ----
  const ex = new URLSearchParams();
  ex.set("customer", customerId);
  ex.set("type", kind);
  ex.set("from", fromDate);
  ex.set("to", toDate);
  const excelHref = `/chat-audit/accounting/vat-report/export?${ex.toString()}`;

  return (
    <VatReportDoc
      customerId={customerId}
      kind={kind}
      companyName={companyName}
      companyTaxId={(cust.tax_id ?? "").trim()}
      companyAddress={companyAddress}
      periodLabel={periodLabel}
      fromDate={fromDate}
      toDate={toDate}
      selectedMonth={selectedMonth}
      monthOptions={monthOptions}
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
