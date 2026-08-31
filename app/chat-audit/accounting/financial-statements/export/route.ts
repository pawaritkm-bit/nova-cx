import { NextResponse } from "next/server";
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
import { buildFormalStatementsWorkbook } from "@/lib/accounting/statements-excel";
import { resolveComparePeriod, type ComparePeriodMode, type PeriodRange } from "@/lib/accounting/comparative-period";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** แปลง ComparePeriodMode ดิบจาก query string → type ที่ถูกต้อง (fallback 'none') — mirror หน้าจอ N1 */
function asCompareMode(v: string | null): ComparePeriodMode {
  return v === "prev_period" || v === "prev_year" || v === "custom" ? v : "none";
}

/**
 * GET /chat-audit/accounting/financial-statements/export?customerId=<uuid>&from=YYYY-MM&to=YYYY-MM
 *   &draft=1&compareMode=none|prev_period|prev_year|custom&compareFrom=&compareTo=
 *   Export งบการเงินฉบับทางการ (กำไรขาดทุน + ฐานะการเงิน) ของลูกค้า 1 ราย เป็นไฟล์ .xlsx จริง
 *   — mirror reports/export/route.ts เดิมแต่เรียก buildFormalStatementsWorkbook() แทน (N3)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่ log เนื้อบิล/ชื่อลูกค้า
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const from = validMonth(url.searchParams.get("from"));
  const to = validMonth(url.searchParams.get("to"));
  const includeDraft = url.searchParams.get("draft") === "1"; // default (0.10): เฉพาะที่ยืนยันแล้ว
  const compareMode = asCompareMode(url.searchParams.get("compareMode"));
  const compareFromRaw = url.searchParams.get("compareFrom");
  const compareToRaw = url.searchParams.get("compareTo");

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

    const { data: customerTypeRow } = await service
      .from("customers")
      .select("customer_type")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if ((customerTypeRow as { customer_type?: string } | null)?.customer_type !== "company") {
      return NextResponse.json(
        { error: "forbidden", message: "การปิดงบใช้ได้เฉพาะลูกค้านิติบุคคล" },
        { status: 403 }
      );
    }

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

    const currentRange: PeriodRange = { from, to };
    const comparePeriod =
      compareMode === "none"
        ? null
        : resolveComparePeriod(currentRange, compareMode, { from: compareFromRaw, to: compareToRaw });

    let compare: { formal: ReturnType<typeof buildFormalStatements>; label: string } | null = null;
    if (comparePeriod) {
      const comparePeriodFull = { from: comparePeriod.from, to: comparePeriod.to, includeDraft };
      const compareCumulativePeriod = { ...comparePeriodFull, from: "" };
      const [compareCombined, compareCumulativeCombined] = await Promise.all([
        loadCombinedJournalLines(service, access.tenantId, entries, comparePeriodFull, chartByCode),
        loadCombinedJournalLines(service, access.tenantId, entries, compareCumulativePeriod, chartByCode),
      ]);
      const compareFormal = buildFormalStatements(
        entries,
        compareCombined,
        compareCumulativeCombined,
        opening,
        chartByCode,
        comparePeriodFull,
        chart
      );
      compare = { formal: compareFormal, label: periodLabel(comparePeriod.from, comparePeriod.to) };
    }

    // ป้ายกิจการ (รหัส+ชื่อ) สำหรับหัวรายงาน + ชื่อไฟล์ (ใช้รหัสเท่านั้นในชื่อไฟล์ — PDPA)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";
    const currentLabel = periodLabel(from, to);

    const xlsx = await buildFormalStatementsWorkbook(formal, { entityLabel, periodLabel: currentLabel }, currentLabel, compare);

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const periodPart = from || to ? `-${from || "เริ่ม"}_${to || "ล่าสุด"}` : "";
    const filename = `งบการเงินฉบับทางการ${codePart}${periodPart}.xlsx`;
    const asciiFallback = `formal-statements${codePart}.xlsx`;

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
