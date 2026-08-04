import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, monthBounds, round2, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildVatReport, type VatReport, type VatReportKind } from "@/lib/accounting/vat-report";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_FMT = "#,##0.00";

const THAI_MONTHS = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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
  report: VatReport,
  header: { companyName: string; companyAddress: string; companyTaxId: string; monthLabel: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const title = report.kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ";
  const ws = wb.addWorksheet(title);

  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([header.companyName]);
  if (header.companyAddress) ws.addRow([header.companyAddress]);
  ws.addRow([`เลขประจำตัวผู้เสียภาษี: ${header.companyTaxId || "-"}    สำนักงานใหญ่`]);
  ws.addRow([`เดือนภาษี ${header.monthLabel}`]);
  ws.addRow([]);

  const partyHeader =
    report.kind === "sale" ? "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ" : "ชื่อผู้ขายสินค้า/ผู้ให้บริการ";
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

  report.rows.forEach((r, i) => {
    ws.addRow([
      i + 1,
      thaiDate(r.docDate),
      r.docNo,
      r.partyName,
      r.partyTaxId ?? "",
      r.isHeadOffice ? "สำนักงานใหญ่" : "",
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
    `รวมทั้งสิ้น ${report.totals.count} รายการ`,
    round2(report.totals.baseVatTotal),
    round2(report.totals.baseExemptTotal),
    round2(report.totals.vatTotal),
  ]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [8, 12, 16, 30, 18, 16, 16, 16, 14][i] ?? 14));
  [7, 8, 9].forEach((n) => (ws.getColumn(n).numFmt = MONEY_FMT));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
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

    const filter: ListEntriesFilter = { customerId, entryType: kind };
    if (fromDate) filter.dateFrom = fromDate;
    if (toDate) filter.dateTo = toDate;
    const { entries } = await listEntries(service, tenantId, filter);
    const report = buildVatReport(entries, kind);

    const periodLabel = fromDate && toDate ? periodLabelOf(fromDate, toDate) : "ทุกเดือน";
    const xlsx = await buildVatReportWorkbook(report, {
      companyName: (c?.business_name || c?.name || "กิจการ").trim(),
      companyAddress,
      companyTaxId: (c?.tax_id ?? "").trim(),
      monthLabel: periodLabel,
    });

    const kindName = kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ";
    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const rangePart = fromDate && toDate ? `-${fromDate}_${toDate}` : "";
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
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}
