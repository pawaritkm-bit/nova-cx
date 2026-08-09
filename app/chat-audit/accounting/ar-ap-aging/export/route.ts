import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, round2 } from "@/lib/accounting/queries";
import { listBillPaymentsForEntries } from "@/lib/accounting/bill-payments";
import { buildAgingReport, AGING_BUCKET_LABELS, AGING_BUCKET_ORDER, type AgingRow } from "@/lib/accounting/aging";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONEY_FMT = "#,##0.00";

/** วันนี้เวลาไทย → "YYYY-MM-DD" (default asOfDate) */
function todayThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function thaiDateShort(iso: string): string {
  if (!DATE_RE.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/** 1 worksheet ต่อฝั่ง (ลูกหนี้/เจ้าหนี้) — หัวคอลัมน์ + แถวต่อคู่ค้า + แถวรวม */
function addAgingSheet(
  wb: ExcelJS.Workbook,
  label: string,
  headerLine: string,
  rows: AgingRow[],
  totals: Record<string, number>
): void {
  const ws = wb.addWorksheet(label.replace(/[\\/*?:[\]]/g, " ").slice(0, 31));
  ws.addRow([label]).font = { bold: true, size: 14 };
  ws.addRow([headerLine]);
  ws.addRow([]);

  const head = ws.addRow(["คู่ค้า", ...AGING_BUCKET_ORDER.map((k) => AGING_BUCKET_LABELS[k]), "รวม"]);
  head.font = { bold: true };
  head.alignment = { horizontal: "center", wrapText: true };

  for (const r of rows) {
    ws.addRow([r.counterpartyName, ...AGING_BUCKET_ORDER.map((k) => round2(r.buckets[k] ?? 0)), round2(r.total)]);
  }

  const grandTotal = AGING_BUCKET_ORDER.reduce((s, k) => s + (totals[k] ?? 0), 0);
  const total = ws.addRow([
    `รวม ${rows.length} คู่ค้า`,
    ...AGING_BUCKET_ORDER.map((k) => round2(totals[k] ?? 0)),
    round2(grandTotal),
  ]);
  total.font = { bold: true };

  const moneyColStart = 2;
  const moneyColEnd = 1 + AGING_BUCKET_ORDER.length + 1;
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 30 : 14));
  for (let col = moneyColStart; col <= moneyColEnd; col++) {
    ws.getColumn(col).numFmt = MONEY_FMT;
  }
}

/**
 * GET /chat-audit/accounting/ar-ap-aging/export?customer=<uuid>&asOf=YYYY-MM-DD
 *   ดาวน์โหลดรายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้เป็น .xlsx (2 ชีท: ลูกหนี้/เจ้าหนี้)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข · ชื่อไฟล์ใช้รหัสลูกค้า/วันที่เท่านั้น
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customer") ?? "";
  const asOfParam = url.searchParams.get("asOf") ?? "";
  const asOfDate = DATE_RE.test(asOfParam) ? asOfParam : todayThai();

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

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, business_name")
      .eq("id", customerId).eq("tenant_id", tenantId).maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null; business_name: string | null } | null) ?? null;
    const companyName = (c?.business_name || c?.name || "กิจการ").trim();

    const { entries } = await listEntries(service, tenantId, { customerId });
    const paymentsByEntry = await listBillPaymentsForEntries(service, tenantId, entries.map((e) => e.id));
    const report = buildAgingReport(entries, paymentsByEntry, asOfDate);

    const wb = new ExcelJS.Workbook();
    wb.creator = "NOVA-CX";
    wb.created = new Date();
    const headerLine = `${companyName}   ณ วันที่ ${thaiDateShort(asOfDate)}`;
    addAgingSheet(wb, "ลูกหนี้การค้า (AR)", headerLine, report.ar, report.totalsByBucket.ar);
    addAgingSheet(wb, "เจ้าหนี้การค้า (AP)", headerLine, report.ap, report.totalsByBucket.ap);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const filename = `ลูกหนี้เจ้าหนี้ค้างชำระ${codePart}-${asOfDate}.xlsx`;
    const asciiFallback = `ar-ap-aging${codePart}.xlsx`;
    return new NextResponse(buf as unknown as BodyInit, {
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
