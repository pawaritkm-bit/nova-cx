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
 *   - [role] ใช้เลือก "ชุดข้อมูลที่ประกอบ" เท่านั้น; ข้อมูลจริงยังจำกัดตาม auth เสมอ
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
    // บทบาทจริงจาก session ถ้ามี; ไม่มีก็ใช้ param (ชั่วคราว) — data ยังบังคับด้วย view
    const viewer = await resolveViewer(db, roleParam);
    const effectiveRole = viewer.role ?? roleParam;
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
