import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import { buildReport, isReportType, type ReportFilter } from "@/lib/reports";
import { resolveViewer } from "@/lib/dashboard/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/export?type=monthly|team&cycle=2026-07&survey_type=A
 *   - Export CSV (มี BOM ให้ Excel ไทยไม่เพี้ยน) — อ่านผ่าน scoped client
 *   - สิทธิ์:
 *       * ข้อมูลถูก scope โดย view เสมอ (member เห็นเฉพาะของตน) → ไม่ leak ข้าม scope
 *       * gate เพิ่ม: รายงาน "team" ห้ามบทบาทสมาชิก (accountant/sales) ดึง
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

    // gate ตามสิทธิ์: รายงานทีมสงวนให้หัวหน้า/ผู้บริหาร/แอดมิน/CS
    if (
      type === "team" &&
      (viewer.role === "accountant" || viewer.role === "sales")
    ) {
      return NextResponse.json(
        { error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงานระดับทีม" },
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
