import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import {
  buildReport,
  isReportType,
  canExportReports,
  type ReportFilter,
} from "@/lib/reports";
import { resolveViewer } from "@/lib/dashboard/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/export?type=monthly|team&cycle=2026-07&survey_type=A
 *   - Export CSV (มี BOM ให้ Excel ไทยไม่เพี้ยน) — อ่านผ่าน scoped client
 *   - สิทธิ์ (H1/M1 — allow-list, default deny):
 *       * ข้อมูลถูก scope โดย view เสมอ (ไม่ leak ข้าม scope) และ
 *       * gate export "ทั้ง team และ monthly (มี customer_id)" เฉพาะบทบาทใน allow-list
 *         (executive/admin/acc_lead/sales_lead/cs); member/ไม่มีบทบาท → 403 (fail-closed)
 *   - ต้องมี session จริง (auth.uid) มิฉะนั้น 401
 *   - ยังไม่ตั้ง env DB → 503 degraded
 */
export async function GET(req: Request) {
  const requestId = newRequestId();
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "monthly";

  if (!isReportType(type)) {
    return NextResponse.json(
      { error: "invalid_type", message: "ชนิดรายงานไม่รองรับ (monthly|team)" },
      { status: 400 }
    );
  }

  if (!getSupabaseEnv()) {
    return NextResponse.json(
      {
        error: "db_unavailable",
        message: "ยังไม่ได้ตั้งค่าฐานข้อมูล (degraded)",
        request_id: requestId,
      },
      { status: 503 }
    );
  }

  const filter: ReportFilter = {
    cycle: url.searchParams.get("cycle") ?? undefined,
    surveyType: url.searchParams.get("survey_type") ?? undefined,
  };

  try {
    const db = await createClient();
    const viewer = await resolveViewer(db);

    // ต้องมี session จริงก่อน (M3): ไม่มี auth.uid → ปฏิเสธ ไม่ประเมินสิทธิ์จาก param
    if (!viewer.hasSession) {
      return NextResponse.json(
        { error: "unauthorized", message: "ต้องเข้าสู่ระบบก่อนออกรายงาน" },
        { status: 401 }
      );
    }

    // gate allow-list (default deny): อนุญาต export เฉพาะบทบาทที่มีสิทธิ์ดูข้อมูลผูกลูกค้า
    // member (accountant/sales) หรือไม่มีบทบาท → 403 (fail-closed) ครอบทั้ง team + monthly
    if (!canExportReports(viewer.role)) {
      return NextResponse.json(
        { error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" },
        { status: 403 }
      );
    }

    const report = await buildReport(db, type, filter);

    return new NextResponse(report.body, {
      status: 200,
      headers: {
        "content-type": report.contentType,
        "content-disposition": `attachment; filename="${report.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    logServerError("reports-export", requestId, e);
    return serverErrorResponse(requestId);
  }
}
