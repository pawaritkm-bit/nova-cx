import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { buildStatements, asReportKey } from "@/lib/accounting/statements";
import { buildStatementsWorkbook } from "@/lib/accounting/statements-excel";
import { filterEntriesForReport, periodLabel, validMonth } from "@/lib/accounting/report-filter";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /chat-audit/accounting/reports/export?customerId=<uuid>&from=YYYY-MM&to=YYYY-MM&draft=1&report=all|journal|ledger|trial|income|balance
 *   Export งบการเงินของลูกค้า 1 ราย เป็นไฟล์ .xlsx จริง (หลายชีท หรือเลือกงบเดียว)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่ log เนื้อบิล/ชื่อลูกค้า
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const from = validMonth(url.searchParams.get("from"));
  const to = validMonth(url.searchParams.get("to"));
  const includeDraft = url.searchParams.get("draft") !== "0";
  const report = asReportKey(url.searchParams.get("report"));

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

    const { entries } = await listEntries(service, access.tenantId, { customerId });
    const filtered = filterEntriesForReport(entries, { from, to, includeDraft });
    const opening = await listOpeningBalances(service, access.tenantId, customerId);
    const statements = buildStatements(filtered, opening);

    // ป้ายกิจการ (รหัส+ชื่อ) สำหรับหัวรายงาน + ชื่อไฟล์ (ใช้รหัสเท่านั้นในชื่อไฟล์ — PDPA)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";
    const pLabel = periodLabel(from, to);

    const xlsx = await buildStatementsWorkbook(statements, { entityLabel, periodLabel: pLabel }, report);

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const reportName: Record<string, string> = {
      all: "งบการเงิน",
      journal: "สมุดรายวัน",
      ledger: "บัญชีแยกประเภท",
      trial: "งบทดลอง",
      income: "งบกำไรขาดทุน",
      balance: "งบแสดงฐานะการเงิน",
    };
    const periodPart = from || to ? `-${from || "เริ่ม"}_${to || "ล่าสุด"}` : "";
    const filename = `${reportName[report]}${codePart}${periodPart}.xlsx`;
    const asciiFallback = `statements${codePart}.xlsx`;

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
