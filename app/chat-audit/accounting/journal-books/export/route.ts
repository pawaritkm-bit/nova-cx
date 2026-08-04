import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, round2, type ListEntriesFilter } from "@/lib/accounting/queries";
import {
  buildJournalBooks,
  zipPosting,
  BOOK_ORDER,
  type JournalBook,
} from "@/lib/accounting/journal-books";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_FMT = "#,##0.00";

const THAI_MONTHS = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
function shortMonthLabel(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  return `${THAI_MONTHS[Number(m[2])]} ${Number(m[1]) + 543}`;
}
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const [y, mm, dd] = iso.slice(0, 10).split("-");
  return `${dd}/${mm}/${Number(y) + 543}`;
}

/** 1 worksheet ต่อ 1 เล่ม — หัวคอลัมน์ + แถวใบสำคัญ (zip เดบิต/เครดิต) + แถวรวม */
function addBookSheet(wb: ExcelJS.Workbook, book: JournalBook, headerLine: string): void {
  const ws = wb.addWorksheet(book.label.replace(/[\\/*?:[\]]/g, " ").slice(0, 31));
  ws.addRow([book.label]).font = { bold: true, size: 14 };
  ws.addRow([headerLine]);
  ws.addRow([]);

  const head = ws.addRow([
    "วันที่", "เลขที่", "คำอธิบาย", "บัญชี (เดบิต)", "เดบิต", "บัญชี (เครดิต)", "เครดิต",
  ]);
  head.font = { bold: true };
  head.alignment = { horizontal: "center", wrapText: true };

  for (const p of book.postings) {
    const rows = zipPosting(p);
    rows.forEach((r, i) => {
      ws.addRow([
        i === 0 ? thaiDate(p.date) : "",
        i === 0 ? (p.docNo ?? "") : "",
        i === 0 ? p.description : "",
        r.debit ? `${r.debit.accountCode} ${r.debit.accountName}` : "",
        r.debit ? round2(r.debit.amount) : "",
        r.credit ? `${r.credit.accountCode} ${r.credit.accountName}` : "",
        r.credit ? round2(r.credit.amount) : "",
      ]);
    });
  }

  const total = ws.addRow([
    "", "", "", `รวม ${book.postings.length} รายการ`,
    round2(book.totalDebit), "", round2(book.totalCredit),
  ]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [12, 14, 26, 26, 14, 26, 14][i] ?? 14));
  [5, 7].forEach((n) => (ws.getColumn(n).numFmt = MONEY_FMT));
}

/**
 * GET /chat-audit/accounting/journal-books/export?customer=<uuid>&month=YYYY-MM
 *   ดาวน์โหลดสมุดรายวัน 5 เล่มเป็น .xlsx (1 sheet/เล่ม)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข · ชื่อไฟล์ใช้รหัสลูกค้า/เดือนเท่านั้น
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customer") ?? "";
  const monthParam = url.searchParams.get("month") ?? "";
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";

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

    const filter: ListEntriesFilter = { customerId };
    if (validMonth) filter.month = validMonth;
    const { entries } = await listEntries(service, tenantId, filter);
    const { books } = buildJournalBooks(entries);

    const wb = new ExcelJS.Workbook();
    wb.creator = "NOVA-CX";
    wb.created = new Date();
    const headerLine = `${companyName}   เดือน ${shortMonthLabel(validMonth)}`;
    for (const kind of BOOK_ORDER) addBookSheet(wb, books[kind], headerLine);

    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const monthPart = validMonth ? `-${validMonth}` : "";
    const filename = `สมุดรายวัน${codePart}${monthPart}.xlsx`;
    const asciiFallback = `journal-books${codePart}.xlsx`;

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
