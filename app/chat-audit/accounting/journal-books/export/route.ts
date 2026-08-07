import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, monthBounds, round2, type ListEntriesFilter } from "@/lib/accounting/queries";
import {
  buildJournalBooks,
  zipPosting,
  visibleBooks,
  BOOK_ORDER,
  BOOK_LABELS,
  type JournalBook,
  type BookKind,
} from "@/lib/accounting/journal-books";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_FMT = "#,##0.00";

/** เพดานกันค่าปลอมจาก POST (body) */
const MAX_ROWS = 5000;
const MAX_TEXT = 300;
const MAX_MONEY = 1e12;

/** แถวแสดงผลสำหรับ Excel (1 บรรทัดตาราง) — เดบิต/เครดิต null = ฝั่งว่าง */
type JbExcelRow = {
  dateText: string;
  docNo: string;
  description: string;
  debitAcct: string;
  debit: number | null;
  creditAcct: string;
  credit: number | null;
};

function clampText(v: unknown): string {
  return typeof v === "string" ? v.slice(0, MAX_TEXT) : "";
}
/** number | null: ค่าว่าง/ไม่ใช่ตัวเลข → null (ฝั่งนั้นเว้นว่าง) · มีค่า → clamp+ปัด2 */
function clampMoneyOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return round2(Math.max(-MAX_MONEY, Math.min(MAX_MONEY, n)));
}

const THAI_MONTHS = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
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
/** ป้ายช่วงวัน — ทั้งเดือนพอดี = "มิ.ย. 2569" · ไม่งั้น = "01/06/2569 - 30/06/2569" */
function periodLabelOf(from: string, to: string): string {
  const fm = from.slice(0, 7);
  const b = monthBounds(fm);
  if (b && fm === to.slice(0, 7) && from === b.first && to === b.last) {
    return shortMonthLabel(fm);
  }
  return `${thaiDate(from)} - ${thaiDate(to)}`;
}

/** 1 worksheet ต่อ 1 เล่ม — หัวคอลัมน์ + แถวแสดงผล + แถวรวม (ทำงานจาก display rows) */
function addBookSheet(
  wb: ExcelJS.Workbook,
  label: string,
  headerLine: string,
  rows: JbExcelRow[],
  totalDebit: number,
  totalCredit: number,
  docCount: number
): void {
  const ws = wb.addWorksheet(label.replace(/[\\/*?:[\]]/g, " ").slice(0, 31));
  ws.addRow([label]).font = { bold: true, size: 14 };
  ws.addRow([headerLine]);
  ws.addRow([]);

  const head = ws.addRow([
    "วันที่", "เลขที่", "คำอธิบาย", "บัญชี (เดบิต)", "เดบิต", "บัญชี (เครดิต)", "เครดิต",
  ]);
  head.font = { bold: true };
  head.alignment = { horizontal: "center", wrapText: true };

  for (const r of rows) {
    ws.addRow([
      r.dateText,
      r.docNo,
      r.description,
      r.debitAcct,
      r.debit == null ? "" : round2(r.debit),
      r.creditAcct,
      r.credit == null ? "" : round2(r.credit),
    ]);
  }

  const total = ws.addRow([
    "", "", "", `รวม ${docCount} รายการ`,
    round2(totalDebit), "", round2(totalCredit),
  ]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [12, 14, 26, 26, 14, 26, 14][i] ?? 14));
  [5, 7].forEach((n) => (ws.getColumn(n).numFmt = MONEY_FMT));
}

/** แตกใบสำคัญของ 1 เล่ม (server) → แถวแสดงผล Excel */
function bookToRows(book: JournalBook): JbExcelRow[] {
  const out: JbExcelRow[] = [];
  for (const p of book.postings) {
    const rows = zipPosting(p);
    rows.forEach((r, i) => {
      out.push({
        dateText: i === 0 ? thaiDate(p.date) : "",
        docNo: i === 0 ? p.docNo ?? "" : "",
        description: i === 0 ? p.description : "",
        debitAcct: r.debit ? `${r.debit.accountCode} ${r.debit.accountName}` : "",
        debit: r.debit ? r.debit.amount : null,
        creditAcct: r.credit ? `${r.credit.accountCode} ${r.credit.accountName}` : "",
        credit: r.credit ? r.credit.amount : null,
      });
    });
  }
  return out;
}

/** นับ "รายการ" (ใบสำคัญ) = แถวที่ขึ้นต้นใบใหม่ (มีวันที่/เลขที่/คำอธิบาย) */
function countDocs(rows: JbExcelRow[]): number {
  return rows.filter((r) => r.dateText.trim() || r.docNo.trim() || r.description.trim()).length;
}

/**
 * GET /chat-audit/accounting/journal-books/export?customer=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD&book=<kind>
 *   (รองรับ month=YYYY-MM แบบเดิม → ทั้งเดือน) · ดาวน์โหลดสมุดรายวันเป็น .xlsx (1 sheet/เล่ม)
 *   book = ระบุเล่มเดียว (purchase/sale/…) · ไม่ระบุ/all = ครบทุกเล่ม
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข · ชื่อไฟล์ใช้รหัสลูกค้า/ช่วงวันเท่านั้น
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customer") ?? "";
  const bookParam = url.searchParams.get("book") ?? "all";

  // ช่วงวัน: from/to เป็นหลัก · fallback month=YYYY-MM → ทั้งเดือน
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

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, business_name")
      .eq("id", customerId).eq("tenant_id", tenantId).maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null; business_name: string | null } | null) ?? null;
    const companyName = (c?.business_name || c?.name || "กิจการ").trim();

    const filter: ListEntriesFilter = { customerId };
    if (fromDate) filter.dateFrom = fromDate;
    if (toDate) filter.dateTo = toDate;
    const { entries } = await listEntries(service, tenantId, filter);
    const { books } = buildJournalBooks(entries);

    const wb = new ExcelJS.Workbook();
    wb.creator = "NOVA-CX";
    wb.created = new Date();
    const periodPart = fromDate && toDate ? periodLabelOf(fromDate, toDate) : "ทุกเดือน";
    const headerLine = `${companyName}   ${periodPart}`;
    // เล่มที่ export: ระบุ book → เล่มเดียว · ไม่งั้น = ครบตาม BOOK_ORDER
    const exportBooks = visibleBooks(bookParam);
    for (const kind of exportBooks) {
      const book = books[kind];
      const rows = bookToRows(book);
      addBookSheet(wb, book.label, headerLine, rows, book.totalDebit, book.totalCredit, book.postings.length);
    }

    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const rangePart = fromDate && toDate ? `-${fromDate}_${toDate}` : "";
    return xlsxResponse(buf, codePart, rangePart);
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}

/** สร้าง response ดาวน์โหลด .xlsx สมุดรายวัน (ชื่อไฟล์ไทย + ascii fallback) */
function xlsxResponse(buf: Buffer, codePart: string, rangePart: string): NextResponse {
  const filename = `สมุดรายวัน${codePart}${rangePart}.xlsx`;
  const asciiFallback = `journal-books${codePart}.xlsx`;
  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": XLSX_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}

/**
 * POST /chat-audit/accounting/journal-books/export
 *   body JSON = ค่าที่นักบัญชี "แก้บนจอ" (books[].rows) → สร้าง .xlsx ให้ตรงที่เห็น
 *   ★ ยอดรวมเดบิต/เครดิตคิดใหม่ที่ server จาก rows (ไม่เชื่อ total จาก client)
 *   ★ export เฉพาะเล่มที่เลือก (book) · ป้ายชื่อเล่มยึด BOOK_LABELS (ไม่เชื่อ client)
 *   ★ สิทธิ์เหมือน GET (default deny) · validate/clamp · PDPA: ไม่ log ค่า
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
  const bookParam = typeof b.book === "string" ? b.book : "all";
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

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, business_name")
      .eq("id", customerId).eq("tenant_id", tenantId).maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null; business_name: string | null } | null) ?? null;
    const companyName = (c?.business_name || c?.name || "กิจการ").trim();

    // map kind → rows จาก body (clamp กันค่าปลอม)
    const rowsByKind = {} as Record<BookKind, JbExcelRow[]>;
    for (const k of BOOK_ORDER) rowsByKind[k] = [];
    const rawBooks = Array.isArray(b.books) ? b.books : [];
    for (const rb of rawBooks) {
      const bk = (rb ?? {}) as Record<string, unknown>;
      const kind = bk.kind;
      if (typeof kind !== "string" || !(BOOK_ORDER as string[]).includes(kind)) continue;
      const rawRows = Array.isArray(bk.rows) ? bk.rows.slice(0, MAX_ROWS) : [];
      rowsByKind[kind as BookKind] = rawRows.map((rr) => {
        const r = (rr ?? {}) as Record<string, unknown>;
        return {
          dateText: clampText(r.dateText),
          docNo: clampText(r.docNo),
          description: clampText(r.description),
          debitAcct: clampText(r.debitAcct),
          debit: clampMoneyOrNull(r.debit),
          creditAcct: clampText(r.creditAcct),
          credit: clampMoneyOrNull(r.credit),
        };
      });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "NOVA-CX";
    wb.created = new Date();
    const periodPart = fromDate && toDate ? periodLabelOf(fromDate, toDate) : "ทุกเดือน";
    const headerLine = `${companyName}   ${periodPart}`;
    const exportBooks = visibleBooks(bookParam);
    for (const kind of exportBooks) {
      const rows = rowsByKind[kind];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const r of rows) {
        if (r.debit != null) totalDebit += r.debit;
        if (r.credit != null) totalCredit += r.credit;
      }
      addBookSheet(wb, BOOK_LABELS[kind], headerLine, rows, round2(totalDebit), round2(totalCredit), countDocs(rows));
    }

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const rangePart = fromDate && toDate ? `-${fromDate}_${toDate}` : "";
    return xlsxResponse(buf, codePart, rangePart);
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}
