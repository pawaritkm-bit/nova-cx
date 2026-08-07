import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, monthBounds, round2, effectiveTaxMonth, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildVatReport, type VatReportKind } from "@/lib/accounting/vat-report";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_FMT = "#,##0.00";

/** เพดานกันค่าปลอมจาก POST (body) */
const MAX_ROWS = 5000;
const MAX_TEXT = 300;
const MAX_MONEY = 1e12;

/** แถวแสดงผลสำหรับ Excel (วันที่/สถานประกอบการ = ข้อความสำเร็จรูปแล้ว) */
type VatExcelRow = {
  dateText: string;
  docNo: string;
  partyName: string;
  partyTaxId: string;
  estab: string;
  baseVat: number;
  baseExempt: number;
  vat: number;
};
type VatExcelTotals = { count: number; baseVat: number; baseExempt: number; vat: number };

/** coerce → string ตัดความยาว (กัน payload ยักษ์) */
function clampText(v: unknown): string {
  return typeof v === "string" ? v.slice(0, MAX_TEXT) : "";
}
/** coerce → number ปลอดภัย: NaN/Infinity → 0, clamp ช่วง, ปัด 2 */
function clampMoney(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return round2(Math.max(-MAX_MONEY, Math.min(MAX_MONEY, n)));
}

const THAI_MONTHS = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** เลื่อนเดือน 'YYYY-MM' ไป delta เดือน (ติดลบ = ย้อนหลัง) */
function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  let y = Number(m[1]);
  let mo = Number(m[2]) + delta;
  while (mo < 1) { mo += 12; y -= 1; }
  while (mo > 12) { mo -= 12; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** YYYY-MM → "ก.ค. 2569" (คืน "ทุกเดือน" ถ้าไม่มี) */
function shortMonthLabel(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  return `${THAI_MONTHS[Number(m[2])]} ${Number(m[1]) + 543}`;
}

/** ISO → dd/mm/พ.ศ. (คืน "" ถ้าไม่มี) */
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const [y, mm, dd] = iso.slice(0, 10).split("-");
  return `${dd}/${mm}/${Number(y) + 543}`;
}

/** ป้ายช่วงวันสำหรับหัว Excel — ทั้งเดือนพอดี = "ก.ค. 2569" · ไม่งั้น = "01/06/2569 - 30/06/2569" */
function periodLabelOf(from: string, to: string): string {
  const fm = from.slice(0, 7);
  const b = monthBounds(fm);
  if (b && fm === to.slice(0, 7) && from === b.first && to === b.last) {
    return shortMonthLabel(fm);
  }
  return `${thaiDate(from)} - ${thaiDate(to)}`;
}

/**
 * Excel รายงานภาษีซื้อ/ขาย (ฟอร์มราชการ) — หัวรายงาน + ตาราง + แถวรวมท้าย
 *   คอลัมน์ตรงกับหน้าจอ: ลำดับ | วดป | เลขที่ | คู่ค้า | เลขภาษี | สนญ. | คิด VAT | ยกเว้น | VAT
 */
async function buildVatReportWorkbook(
  kind: VatReportKind,
  rows: VatExcelRow[],
  totals: VatExcelTotals,
  header: { companyName: string; companyAddress: string; companyTaxId: string; monthLabel: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const title = kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ";
  const ws = wb.addWorksheet(title);

  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([header.companyName]);
  if (header.companyAddress) ws.addRow([header.companyAddress]);
  ws.addRow([`เลขประจำตัวผู้เสียภาษี: ${header.companyTaxId || "-"}    สำนักงานใหญ่`]);
  ws.addRow([`เดือนภาษี ${header.monthLabel}`]);
  ws.addRow([]);

  const partyHeader =
    kind === "sale" ? "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ" : "ชื่อผู้ขายสินค้า/ผู้ให้บริการ";
  const head = ws.addRow([
    "ลำดับที่",
    "วัน/เดือน/ปี",
    "เลขที่ใบกำกับ",
    partyHeader,
    "เลขประจำตัวผู้เสียภาษี",
    "สถานประกอบการ",
    "มูลค่าที่คิด VAT",
    "มูลค่าที่ยกเว้น VAT",
    "ภาษีมูลค่าเพิ่ม",
  ]);
  head.font = { bold: true };
  head.alignment = { horizontal: "center", wrapText: true };

  rows.forEach((r, i) => {
    ws.addRow([
      i + 1,
      r.dateText,
      r.docNo,
      r.partyName,
      r.partyTaxId,
      r.estab,
      round2(r.baseVat),
      round2(r.baseExempt),
      round2(r.vat),
    ]);
  });

  const total = ws.addRow([
    "",
    "",
    "",
    "",
    "",
    `รวมทั้งสิ้น ${totals.count} รายการ`,
    round2(totals.baseVat),
    round2(totals.baseExempt),
    round2(totals.vat),
  ]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [8, 12, 16, 30, 18, 16, 16, 16, 14][i] ?? 14));
  [7, 8, 9].forEach((n) => (ws.getColumn(n).numFmt = MONEY_FMT));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** สร้าง response ดาวน์โหลด .xlsx (ชื่อไฟล์ไทย + ascii fallback) */
function xlsxResponse(
  xlsx: Buffer,
  kind: VatReportKind,
  codePart: string,
  rangePart: string
): NextResponse {
  const kindName = kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ";
  const filename = `${kindName}${codePart}${rangePart}.xlsx`;
  const asciiFallback = `vat-report${codePart}.xlsx`;
  return new NextResponse(xlsx as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": XLSX_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}

/**
 * GET /chat-audit/accounting/vat-report/export?customer=<uuid>&type=purchase|sale&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   (รองรับ month=YYYY-MM แบบเดิมด้วย — จะแปลงเป็นช่วงทั้งเดือน) · ดาวน์โหลด .xlsx
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข · ชื่อไฟล์ใช้รหัสลูกค้า/ช่วงวันเท่านั้น
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customer") ?? "";
  const typeParam = url.searchParams.get("type") ?? "";
  const kind: VatReportKind = typeParam === "sale" ? "sale" : "purchase";

  // ช่วงวัน: รับ from/to เป็นหลัก · fallback month=YYYY-MM → แปลงเป็นทั้งเดือน
  const fromParam = url.searchParams.get("from") ?? "";
  const toParam = url.searchParams.get("to") ?? "";
  const monthParam = url.searchParams.get("month") ?? "";
  const fromValid = DATE_RE.test(fromParam) ? fromParam : "";
  const toValid = DATE_RE.test(toParam) ? toParam : "";
  let fromDate = "";
  let toDate = "";
  if (fromValid || toValid) {
    fromDate = fromValid || toValid;
    toDate = toValid || fromValid;
    if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  } else {
    const b = monthBounds(monthParam);
    if (b) {
      fromDate = b.first;
      toDate = b.last;
    }
  }

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้า" }, { status: 400 });
  }

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }
    if (!customerInScope(access, customerId)) {
      return NextResponse.json(
        { error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" },
        { status: 403 }
      );
    }
    const tenantId = access.tenantId;

    // หัวกระดาษ (ชื่อ/เลขภาษี/รหัส) — address ดึงแยก best-effort (คอลัมน์เพิ่งเพิ่ม)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, business_name, tax_id")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const c =
      (cust as { customer_code: string | null; name: string | null; business_name: string | null; tax_id: string | null } | null) ??
      null;
    let companyAddress = "";
    try {
      const { data: addrRow } = await service
        .from("customers")
        .select("address")
        .eq("id", customerId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      companyAddress = ((addrRow as { address: string | null } | null)?.address ?? "").trim();
    } catch {
      companyAddress = "";
    }

    // ★ ภาษีซื้อยึด "เดือนที่ใช้ภาษี" (effectiveTaxMonth) — บิลยกเดือนมาใช้ก็เข้ารายงาน
    //   ภาษีขาย = กรอง doc_date ตามช่วงปกติ
    let report;
    if (kind === "purchase" && fromDate && toDate) {
      const startMonth = fromDate.slice(0, 7);
      const endMonth = toDate.slice(0, 7);
      const lowerBound = monthBounds(shiftMonth(startMonth, -6))?.first ?? fromDate;
      const { entries } = await listEntries(service, tenantId, {
        customerId,
        entryType: "purchase",
        dateFrom: lowerBound,
        dateTo: toDate,
      });
      const inPeriod = entries.filter((e) => {
        const tm = effectiveTaxMonth(e);
        return tm != null && tm >= startMonth && tm <= endMonth;
      });
      report = buildVatReport(inPeriod, "purchase");
    } else {
      const filter: ListEntriesFilter = { customerId, entryType: kind };
      if (fromDate) filter.dateFrom = fromDate;
      if (toDate) filter.dateTo = toDate;
      const { entries } = await listEntries(service, tenantId, filter);
      report = buildVatReport(entries, kind);
    }

    const periodLabel = fromDate && toDate ? periodLabelOf(fromDate, toDate) : "ทุกเดือน";
    // แปลงรายงาน (server) → แถวแสดงผล Excel
    const excelRows: VatExcelRow[] = report.rows.map((r) => ({
      dateText: thaiDate(r.docDate),
      docNo: r.docNo,
      partyName: r.partyName,
      partyTaxId: r.partyTaxId ?? "",
      estab: r.isHeadOffice ? "สำนักงานใหญ่" : "",
      baseVat: r.baseVat,
      baseExempt: r.baseExempt,
      vat: r.vat,
    }));
    const xlsx = await buildVatReportWorkbook(
      kind,
      excelRows,
      {
        count: report.totals.count,
        baseVat: report.totals.baseVatTotal,
        baseExempt: report.totals.baseExemptTotal,
        vat: report.totals.vatTotal,
      },
      {
        companyName: (c?.business_name || c?.name || "กิจการ").trim(),
        companyAddress,
        companyTaxId: (c?.tax_id ?? "").trim(),
        monthLabel: periodLabel,
      }
    );

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const rangePart = fromDate && toDate ? `-${fromDate}_${toDate}` : "";
    return xlsxResponse(xlsx, kind, codePart, rangePart);
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}

/**
 * POST /chat-audit/accounting/vat-report/export
 *   body JSON = ค่าที่นักบัญชี "แก้บนจอ" (header + rows) → สร้าง .xlsx ให้ตรงที่เห็น
 *   ★ ยอดรวมคิดใหม่ที่ server จาก rows (ไม่เชื่อ total จาก client)
 *   ★ สิทธิ์เหมือน GET (default deny) · validate/clamp ค่าที่รับมา · PDPA: ไม่ log ค่า
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_params", message: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const customerId = typeof b.customer === "string" ? b.customer : "";
  const kind: VatReportKind = b.kind === "sale" ? "sale" : "purchase";
  const fromRaw = typeof b.from === "string" ? b.from : "";
  const toRaw = typeof b.to === "string" ? b.to : "";
  let fromDate = DATE_RE.test(fromRaw) ? fromRaw : "";
  let toDate = DATE_RE.test(toRaw) ? toRaw : "";
  if (fromDate && toDate && fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้า" }, { status: 400 });
  }

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }
    if (!customerInScope(access, customerId)) {
      return NextResponse.json(
        { error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" },
        { status: 403 }
      );
    }
    const tenantId = access.tenantId;

    // customer_code สำหรับตั้งชื่อไฟล์เท่านั้น (ไม่ใช้ค่าจาก DB เป็นเนื้อรายงาน — เนื้อมาจาก body)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null } | null) ?? null;

    // แปลง rows จาก body → แถว Excel (clamp กันค่าปลอม) + คิดยอดรวมใหม่
    const rawRows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
    let baseVat = 0;
    let baseExempt = 0;
    let vat = 0;
    const excelRows: VatExcelRow[] = rawRows.map((rr) => {
      const r = (rr ?? {}) as Record<string, unknown>;
      const row: VatExcelRow = {
        dateText: clampText(r.dateText),
        docNo: clampText(r.docNo),
        partyName: clampText(r.partyName),
        partyTaxId: clampText(r.partyTaxId),
        estab: clampText(r.estab),
        baseVat: clampMoney(r.baseVat),
        baseExempt: clampMoney(r.baseExempt),
        vat: clampMoney(r.vat),
      };
      baseVat += row.baseVat;
      baseExempt += row.baseExempt;
      vat += row.vat;
      return row;
    });

    const header = (b.header ?? {}) as Record<string, unknown>;
    const monthLabel = fromDate && toDate ? periodLabelOf(fromDate, toDate) : "ทุกเดือน";
    const xlsx = await buildVatReportWorkbook(
      kind,
      excelRows,
      { count: excelRows.length, baseVat: round2(baseVat), baseExempt: round2(baseExempt), vat: round2(vat) },
      {
        companyName: clampText(header.companyName) || "กิจการ",
        companyAddress: clampText(header.companyAddress),
        companyTaxId: clampText(header.companyTaxId),
        monthLabel,
      }
    );

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const rangePart = fromDate && toDate ? `-${fromDate}_${toDate}` : "";
    return xlsxResponse(xlsx, kind, codePart, rangePart);
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}
