import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { periodLabel, validMonth } from "@/lib/accounting/report-filter";
import { loadCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { buildFormalStatements } from "@/lib/accounting/formal-statements";
import { resolveComparePeriod, type ComparePeriodMode, type PeriodRange } from "@/lib/accounting/comparative-period";
import FinancialStatementPrintDoc from "../FinancialStatementPrintDoc";
import "../financial-statements.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** แปลง ComparePeriodMode ดิบจาก query string → type ที่ถูกต้อง (fallback 'none') — mirror หน้าจอ N1 */
function asCompareMode(v: string | undefined): ComparePeriodMode {
  return v === "prev_period" || v === "prev_year" || v === "custom" ? v : "none";
}

/**
 * /chat-audit/accounting/financial-statements/print — หน้าพิมพ์งบการเงินฉบับทางการ (เฟส 4 ส่วน N2)
 *   mirror wht-cert/page.tsx: server component โหลดข้อมูล + letterhead ลูกค้า (business_name/tax_id/address)
 *   → ส่งให้ FinancialStatementPrintDoc (client, พิมพ์ผ่าน window.print())
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง) — เหมือนหน้าจอ N1 ทุกจุด
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่มี write path (อ่าน+คำนวณ+แสดงผลอย่างเดียว)
 */
export default async function FinancialStatementsPrintPage({
  searchParams,
}: {
  searchParams: Promise<{
    customerId?: string;
    from?: string;
    to?: string;
    draft?: string;
    compareMode?: string;
    compareFrom?: string;
    compareTo?: string;
  }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return <ErrorShell message="ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)" />;
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/financial-statements");

  const customerId = (sp.customerId ?? "").trim();
  if (!UUID_RE.test(customerId)) {
    return <ErrorShell message="ไม่พบลูกค้า — เปิดหน้าพิมพ์จากหน้า “งบการเงินฉบับทางการ” อีกครั้ง" />;
  }
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  // หัวกระดาษ = ข้อมูลลูกค้า (business_name/tax_id, mirror wht-cert)
  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id, customer_code, customer_type")
    .eq("id", customerId)
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!custRow) {
    return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  }
  if ((custRow as { customer_type?: string }).customer_type !== "company") {
    return <ErrorShell message="การปิดงบใช้ได้เฉพาะลูกค้านิติบุคคล" />;
  }
  const cust = custRow as {
    id: string;
    name: string | null;
    business_name: string | null;
    tax_id: string | null;
    customer_code: string | null;
    customer_type: "company";
  };
  const businessName = (cust.business_name || cust.name || "").trim();

  // ที่อยู่ลูกค้า — best-effort (คอลัมน์ address เพิ่งเพิ่ม migration 0058 อาจยังไม่ apply, mirror wht-cert)
  let customerAddress = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (!error) customerAddress = (data as { address: string | null } | null)?.address ?? "";
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }

  const from = validMonth(sp.from);
  const to = validMonth(sp.to);
  const includeDraft = sp.draft === "1";
  const compareMode = asCompareMode(sp.compareMode);
  const currentRange: PeriodRange = { from, to };
  const comparePeriod =
    compareMode === "none"
      ? null
      : resolveComparePeriod(currentRange, compareMode, { from: sp.compareFrom, to: sp.compareTo });

  const { entries } = await listEntries(service, access.tenantId, { customerId });
  const opening = await listOpeningBalances(service, access.tenantId, customerId);
  const chart = await listChartOfAccounts(service, access.tenantId);
  const chartByCode = buildChartByCode(chart);

  const period = { from, to, includeDraft };
  // ★ 0.3 (แก้บั๊กรอบตรวจโค้ด) — โหลด combinedLines 2 ชุด: flow (period จริง) + cumulative (ตัด from ทิ้ง
  //   {from:"", to}) ให้ buildFormalStatements ใช้ balanceSheet/openingCash แบบสะสมจริงตั้งแต่ต้น
  const cumulativePeriod = { ...period, from: "" };
  const [combined, cumulativeCombined] = await Promise.all([
    loadCombinedJournalLines(service, access.tenantId, entries, period, chartByCode),
    loadCombinedJournalLines(service, access.tenantId, entries, cumulativePeriod, chartByCode),
  ]);
  const formal = buildFormalStatements(entries, combined, cumulativeCombined, opening, chartByCode, period, chart);
  // ตรวจ "รายการตกหล่น" ให้ผู้จัดทำเห็นก่อนเซ็นพิมพ์ (0.2 — ไม่ปิดบัง เหมือนจอ N1)
  const skippedCount = formal.flow.journal.skipped.length;

  let compareFormal = null as ReturnType<typeof buildFormalStatements> | null;
  if (comparePeriod) {
    const comparePeriodFull = { from: comparePeriod.from, to: comparePeriod.to, includeDraft };
    const compareCumulativePeriod = { ...comparePeriodFull, from: "" };
    const [compareCombined, compareCumulativeCombined] = await Promise.all([
      loadCombinedJournalLines(service, access.tenantId, entries, comparePeriodFull, chartByCode),
      loadCombinedJournalLines(service, access.tenantId, entries, compareCumulativePeriod, chartByCode),
    ]);
    compareFormal = buildFormalStatements(
      entries,
      compareCombined,
      compareCumulativeCombined,
      opening,
      chartByCode,
      comparePeriodFull,
      chart
    );
  }

  const currentPeriodLabel = periodLabel(from, to);
  const comparePeriodLabel = comparePeriod ? periodLabel(comparePeriod.from, comparePeriod.to) : null;

  return (
    <FinancialStatementPrintDoc
      businessName={businessName}
      taxId={cust.tax_id ?? ""}
      address={customerAddress}
      periodLabel={currentPeriodLabel}
      comparePeriodLabel={comparePeriodLabel}
      income={formal.flow.incomeStatement}
      compareIncome={compareFormal?.flow.incomeStatement ?? null}
      balance={formal.balanceSheet}
      compareBalance={compareFormal?.balanceSheet ?? null}
      cashFlow={formal.cashFlow}
      compareCashFlow={compareFormal?.cashFlow ?? null}
      equity={formal.equityChange}
      skippedCount={skippedCount}
      backHref={`/chat-audit/accounting/financial-statements?customerId=${customerId}`}
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด, mirror wht-cert) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="fs-shell">
      <div className="fs-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting" className="fs-btn">
          ← กลับหน้าลงบันทึกบัญชี
        </a>
      </div>
    </div>
  );
}
