import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { getRunWithLines, type PayrollRun, type PayrollRunLine } from "@/lib/accounting/payroll";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_FMT = "#,##0.00";
const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** สร้าง workbook เดียว: สรุปรอบเงินเดือนต่อพนักงาน (mirror fixed-assets/export/route.ts pattern) */
function buildPayrollWorkbook(
  run: PayrollRun,
  lines: PayrollRunLine[],
  header: { entityLabel: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("รอบเงินเดือน");
  ws.addRow([`รายงานสรุปรอบเงินเดือน — งวด ${MONTH_LABELS[run.payPeriodMonth]} ${run.payPeriodYear}`]).font = { bold: true, size: 14 };
  ws.addRow([header.entityLabel]);
  ws.addRow([`วันที่จ่าย: ${run.payDate}`]);
  ws.addRow([]);
  const headRow = ws.addRow([
    "รหัสพนักงาน",
    "ชื่อ-นามสกุล",
    "เงินเดือน/ค่าจ้าง",
    "รายรับเพิ่มเติม",
    "โบนัส",
    "หักอื่น ๆ",
    "ค่าชดเชยเลิกจ้าง",
    "ภาษีหัก ณ ที่จ่าย",
    "ภาษีหัก ณ ที่จ่าย (ค่าชดเชย)",
    "ประกันสังคม (ลูกจ้าง)",
    "ประกันสังคม (นายจ้าง)",
    "เงินเดือนสุทธิ",
  ]);
  headRow.font = { bold: true };
  headRow.alignment = { vertical: "middle", horizontal: "center" };

  let totals = {
    gross: 0,
    additions: 0,
    bonus: 0,
    deductions: 0,
    severance: 0,
    pit: 0,
    severancePit: 0,
    ssoEmp: 0,
    ssoEmpr: 0,
    net: 0,
  };
  for (const l of lines) {
    ws.addRow([
      l.employeeCode ?? "",
      l.employeeFullName,
      l.grossSalary,
      l.otherAdditions,
      l.bonusAmount,
      l.otherDeductions,
      l.severanceAmount,
      l.pitWithheld,
      l.severancePitWithheld,
      l.ssoEmployee,
      l.ssoEmployer,
      l.netPay,
    ]);
    totals = {
      gross: totals.gross + l.grossSalary,
      additions: totals.additions + l.otherAdditions,
      bonus: totals.bonus + l.bonusAmount,
      deductions: totals.deductions + l.otherDeductions,
      severance: totals.severance + l.severanceAmount,
      pit: totals.pit + l.pitWithheld,
      severancePit: totals.severancePit + l.severancePitWithheld,
      ssoEmp: totals.ssoEmp + l.ssoEmployee,
      ssoEmpr: totals.ssoEmpr + l.ssoEmployer,
      net: totals.net + l.netPay,
    };
  }
  const totalRow = ws.addRow([
    "รวมทั้งสิ้น",
    "",
    totals.gross,
    totals.additions,
    totals.bonus,
    totals.deductions,
    totals.severance,
    totals.pit,
    totals.severancePit,
    totals.ssoEmp,
    totals.ssoEmpr,
    totals.net,
  ]);
  totalRow.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [14, 26, 16, 14, 12, 12, 16, 16, 18, 16, 16, 16][i] ?? 14));
  [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].forEach((col) => (ws.getColumn(col).numFmt = NUMBER_FMT));

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * GET /chat-audit/accounting/payroll/export?runId=<uuid>&customerId=<uuid>
 *   Export รายงานสรุปรอบเงินเดือน (T119) — สิทธิ์ (default deny): resolveAccountingAccess + customerInScope
 * ★ PDPA: ไม่รวมเลขบัตรประชาชนในรายงาน (ไม่จำเป็นต่อการตรวจสอบยอด/ลิงก์บัญชี)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const customerId = url.searchParams.get("customerId") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(runId) || !UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุรอบเงินเดือน/ลูกค้า" }, { status: 400 });
  }

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }
    if (!customerInScope(access, customerId)) {
      return NextResponse.json({ error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" }, { status: 403 });
    }

    const detail = await getRunWithLines(service, access.tenantId, customerId, runId);
    if (!detail) {
      return NextResponse.json({ error: "not_found", message: "ไม่พบรอบเงินเดือน" }, { status: 404 });
    }

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";

    const xlsx = await buildPayrollWorkbook(detail.run, detail.lines, { entityLabel });

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const periodPart = `${detail.run.payPeriodYear}-${String(detail.run.payPeriodMonth).padStart(2, "0")}`;
    const filename = `รอบเงินเดือน-${periodPart}${codePart}.xlsx`;
    const asciiFallback = `payroll-${periodPart}${codePart}.xlsx`;

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
