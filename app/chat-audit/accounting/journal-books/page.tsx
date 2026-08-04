import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildJournalBooks } from "@/lib/accounting/journal-books";
import JournalBooksDoc from "./JournalBooksDoc";
import "../vat-report/vat-report.css";
import "./journal-books.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function monthLabelOf(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return "ทุกเดือน";
  return `${THAI_MONTHS[Number(m[2])]} ปี พ.ศ. ${Number(m[1]) + 543}`;
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
    .select("id, name, business_name")
    .eq("id", customerId).eq("tenant_id", tenantId).is("deleted_at", null)
    .maybeSingle();
  if (!custRow) return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  const cust = custRow as { name: string | null; business_name: string | null };
  const companyName = (cust.business_name || cust.name || "กิจการ").trim();

  let result;
  try {
    const filter: ListEntriesFilter = { customerId };
    if (validMonth) filter.month = validMonth;
    const { entries } = await listEntries(service, tenantId, filter);
    result = buildJournalBooks(entries);
  } catch {
    return <ErrorShell message="อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration" />;
  }

  const ex = new URLSearchParams();
  ex.set("customer", customerId);
  if (validMonth) ex.set("month", validMonth);
  const excelHref = `/chat-audit/accounting/journal-books/export?${ex.toString()}`;

  return (
    <JournalBooksDoc
      companyName={companyName}
      monthLabel={monthLabelOf(validMonth)}
      printedAt={printedAtThai()}
      books={result.books}
      skipped={result.skipped}
      excelHref={excelHref}
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
