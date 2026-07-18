import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeAccountantReport } from "@/lib/reports/report-access";
import {
  buildMonthlyReport,
  reportToSheet,
  isValidPeriod,
  ReportAccessError,
} from "@/lib/reports/accountant-report";
import { buildXlsx, XLSX_CONTENT_TYPE } from "@/lib/reports/xlsx";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/accountant/export?employeeId=<uuid>&period=YYYY-MM
 *   Export รายงานประเมินนักบัญชีรายเดือนเป็นไฟล์ .xlsx จริง
 *   สิทธิ์ (tier — default deny):
 *     - ต้องมี session (auth.uid) มิฉะนั้น 401
 *     - บทบาทต้องอยู่ใน allow-list (canSeeAccountantReport) มิฉะนั้น 403
 *     - สิทธิ์รายบุคคลบังคับใน buildMonthlyReport (resolveReportAccess) → ReportAccessError = 403
 *       · hr → คะแนนนับเฉพาะ eval ที่ confirmed
 */
export async function GET(req: Request) {
  const requestId = newRequestId();
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId") ?? "";
  const period = url.searchParams.get("period") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json(
      { error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล (degraded)", request_id: requestId },
      { status: 503 }
    );
  }
  if (!employeeId || !isValidPeriod(period)) {
    return NextResponse.json(
      { error: "invalid_params", message: "ต้องระบุ employeeId และ period (YYYY-MM)" },
      { status: 400 }
    );
  }

  try {
    const db = await createClient();
    const viewer = await resolveEvalViewer(db);

    if (!viewer.role || !viewer.tenantId) {
      return NextResponse.json({ error: "unauthorized", message: "ต้องเข้าสู่ระบบก่อน" }, { status: 401 });
    }
    if (!canSeeAccountantReport(viewer.role)) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }

    // ★ อ่านด้วย service-role แต่ tier/tenant บังคับใน builder (จาก session)
    const service = createServiceRoleClient();
    const report = await buildMonthlyReport(service, viewer, { employeeId, period });
    const xlsx = buildXlsx([reportToSheet(report)]);
    const filename = `report-${period}-${employeeId.slice(0, 8)}.xlsx`;

    return new NextResponse(xlsx as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ReportAccessError) {
      return NextResponse.json({ error: "forbidden", message: e.message }, { status: 403 });
    }
    logServerError("reports-accountant-export", requestId, e);
    return serverErrorResponse(requestId);
  }
}
