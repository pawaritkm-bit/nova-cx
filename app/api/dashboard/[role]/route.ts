import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import {
  getExecDashboard,
  getMemberDashboard,
  getLeadDashboard,
} from "@/lib/dashboard/queries";
import { resolveViewer, dashboardViewForRole } from "@/lib/dashboard/session";
import { isRoleCode } from "@/lib/dashboard/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/[role]
 *   - อ่าน metrics ตามบทบาท ผ่าน scoped client (view/RLS บังคับ scope + visibility)
 *   - M3: ต้องมี session จริง (auth.uid) — ถ้าไม่มี → 401
 *     บทบาทที่ใช้ "ประกอบหน้า" มาจาก session เท่านั้น ไม่ใช้ [role] param เลือก composition
 *     (แม้ RLS จะคืน 0 แถวก็ไม่ปล่อยให้ param กำหนดว่าจะประกอบ dashboard ชุดไหน)
 *   - ไม่มี env DB → 503 degraded (ไม่ crash)
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ role: string }> }
) {
  const requestId = newRequestId();
  const { role: roleParam } = await ctx.params;

  if (!isRoleCode(roleParam)) {
    return NextResponse.json(
      { error: "invalid_role", message: "บทบาทไม่ถูกต้อง" },
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

  try {
    const db = await createClient();
    // M3: บทบาทมาจาก session เท่านั้น (ไม่ส่ง param เข้า resolveViewer)
    const viewer = await resolveViewer(db);

    // ไม่มี session จริง → 401 (ไม่ให้ param ประกอบ dashboard เอง)
    if (!viewer.hasSession) {
      return NextResponse.json(
        { error: "unauthorized", message: "ต้องเข้าสู่ระบบก่อนดู dashboard" },
        { status: 401 }
      );
    }
    // ล็อกอินแล้วแต่ไม่มีบทบาทพนักงานผูกอยู่ → 403
    if (!viewer.role) {
      return NextResponse.json(
        { error: "forbidden", message: "บัญชีนี้ไม่มีบทบาทพนักงานสำหรับดู dashboard" },
        { status: 403 }
      );
    }

    const effectiveRole = viewer.role;
    const view = dashboardViewForRole(effectiveRole);

    let data;
    if (view === "exec") {
      data = await getExecDashboard(db);
    } else if (view === "lead") {
      data = await getLeadDashboard(
        db,
        effectiveRole === "sales_lead" ? "sales_lead" : "acc_lead"
      );
    } else {
      data = await getMemberDashboard(
        db,
        effectiveRole === "sales" ? "sales" : "accountant"
      );
    }

    return NextResponse.json(
      {
        role: effectiveRole,
        from_session: viewer.fromSession,
        data,
      },
      { status: 200 }
    );
  } catch (e) {
    logServerError("dashboard", requestId, e);
    return serverErrorResponse(requestId);
  }
}
