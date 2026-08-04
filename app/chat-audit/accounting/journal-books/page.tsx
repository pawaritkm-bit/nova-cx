import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, monthBounds, type ListEntriesFilter, type BillEntry } from "@/lib/accounting/queries";
import { buildJournalBooks } from "@/lib/accounting/journal-books";
import { purchaseFetchLowerBound, filterPurchaseByTaxMonth } from "@/lib/accounting/tax-month";
import JournalBooksDoc from "./JournalBooksDoc";
import "../vat-report/vat-report.css";
import "./journal-books.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function monthLabelOf(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  return `${THAI_MONTHS[Number(m[2])]} ปี พ.ศ. ${Number(m[1]) + 543}`;
}

/** เดือนปัจจุบันเวลาไทย → "YYYY-MM" (ใช้เป็น default ช่วงวัน) */
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

/** ตัวเลือกเดือนย้อนหลัง count เดือน สำหรับปุ่มลัด "ทั้งเดือน" (ใหม่→เก่า) */
function recentMonthOptions(count: number): { value: string; label: string }[] {
  const cur = currentMonthThai();
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

/** ISO → "dd/mm/พ.ศ." (คืน "" ถ้าพัง) */
function thaiDateShort(iso: string): string {
  if (!DATE_RE.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/** ป้ายหัวจากช่วง [from, to] — ทั้งเดือนพอดี = "มิถุนายน ปี พ.ศ. 2569" · ไม่งั้น = "ตั้งแต่ … ถึง …" */
function periodLabelOf(from: string, to: string): string {
  const fm = from.slice(0, 7);
  const b = monthBounds(fm);
  if (b && fm === to.slice(0, 7) && from === b.first && to === b.last) {
    return monthLabelOf(fm);
  }
  return `ตั้งแต่ ${thaiDateShort(from)} ถึง ${thaiDateShort(to)}`;
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
 * /chat-audit/accounting/journal-books — สมุดรายวัน 5 เล่ม ต่อลูกค้า/เดือน
 *   searchParams: customer=<uuid> (จำเป็น) · month=YYYY-MM (ไม่ระบุ = ทุกเดือน)
 *
 * ★ guard: resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ ดึงบิลทุกประเภท (ซื้อ/ขาย/รอระบุ) → buildJournalBooks จัดเล่ม + คัดบิลที่ลงไม่ได้
 * ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข
 */
export default async function JournalBooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    month?: string;
    from?: string;
    to?: string;
    book?: string;
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

  const customerId = (sp.customer ?? "").trim();
  if (!UUID_RE.test(customerId)) {
    return <ErrorShell message="ไม่พบลูกค้า — เปิดรายงานจากการ์ดลูกค้าอีกครั้ง" />;
  }
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  // ---- ช่วงวันที่ (เหมือนรายงานภาษี) ----
  //   from/to เป็นหลัก · fallback month=YYYY-MM → ทั้งเดือน · ไม่มีทั้งคู่ → เดือนปัจจุบันเวลาไทย
  const fromParam = (sp.from ?? "").trim();
  const toParam = (sp.to ?? "").trim();
  const monthParam = (sp.month ?? "").trim();
  const fromValid = DATE_RE.test(fromParam) ? fromParam : "";
  const toValid = DATE_RE.test(toParam) ? toParam : "";

  let fromDate: string;
  let toDate: string;
  if (fromValid || toValid) {
    fromDate = fromValid || toValid;
    toDate = toValid || fromValid;
    if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  } else {
    const b = monthBounds(monthParam) ?? monthBounds(currentMonthThai())!;
    fromDate = b.first;
    toDate = b.last;
  }

  const selectedMonth = fromDate.slice(0, 7);
  const monthOptions = recentMonthOptions(24);
  if (!monthOptions.some((o) => o.value === selectedMonth)) {
    monthOptions.unshift({
      value: selectedMonth,
      label: monthLabelOf(selectedMonth).replace(" ปี พ.ศ. ", " "),
    });
  }
  const periodLabel = periodLabelOf(fromDate, toDate);

  // เล่มเริ่มต้น (ส่งมาจากรายงานภาษี เช่น book=sale) — Doc จะ validate เอง
  const initialBook = (sp.book ?? "all").trim();

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name")
    .eq("id", customerId).eq("tenant_id", tenantId).is("deleted_at", null)
    .maybeSingle();
  if (!custRow) return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  const cust = custRow as { name: string | null; business_name: string | null };
  const companyName = (cust.business_name || cust.name || "กิจการ").trim();

  let result;
  try {
    const startMonth = fromDate.slice(0, 7);
    const endMonth = toDate.slice(0, 7);

    // ★ บิลซื้อ: ยึด "เดือนที่ใช้ภาษี" (effectiveTaxMonth = input_tax_month ?? เดือน doc_date)
    //   บิลเดือนก่อน (≤6 เดือน) ที่ยกมายื่นในช่วงนี้ต้องเข้าสมุดรายวัน(ซื้อ)ด้วย → ดึงกว้างแล้วกรองในแอป
    //   (สอดคล้องรายงานภาษีซื้อ — บิลยกเดือนไปโผล่ในเดือนที่ยื่นจริง)
    const lowerBound = purchaseFetchLowerBound(startMonth, fromDate);
    const purchaseFilter: ListEntriesFilter = {
      customerId,
      entryType: "purchase",
      dateFrom: lowerBound,
      dateTo: toDate,
    };
    // ★ บิลขาย/อื่น ๆ: คงกรอง doc_date ในช่วง [from, to] เดิม (ไม่ยกเดือน)
    const otherFilter: ListEntriesFilter = { customerId, dateFrom: fromDate, dateTo: toDate };

    const [purchaseRes, otherRes] = await Promise.all([
      listEntries(service, tenantId, purchaseFilter),
      listEntries(service, tenantId, otherFilter),
    ]);

    const purchaseInPeriod = filterPurchaseByTaxMonth(purchaseRes.entries, startMonth, endMonth);
    const nonPurchase = otherRes.entries.filter((e) => e.entryType !== "purchase");
    const entries: BillEntry[] = [...purchaseInPeriod, ...nonPurchase];
    result = buildJournalBooks(entries);
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  return (
    <JournalBooksDoc
      customerId={customerId}
      companyName={companyName}
      periodLabel={periodLabel}
      fromDate={fromDate}
      toDate={toDate}
      selectedMonth={selectedMonth}
      monthOptions={monthOptions}
      initialBook={initialBook}
      printedAt={printedAtThai()}
      books={result.books}
      skipped={result.skipped}
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
