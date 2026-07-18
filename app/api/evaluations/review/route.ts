import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { applyManagerReview, resolveAppeal, EvalAuthError } from "@/lib/evaluation/review";
import { isValidOverallScore } from "@/lib/chat-dashboard/eval-score";
import { newRequestId, logServerError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/review
 *   หัวหน้า confirm/edit/reject ผลประเมิน หรือ resolve คำอุทธรณ์
 *   ★ guard tier: resolve viewer จาก session (ห้ามเชื่อ client) → access.ts บังคับสิทธิ์
 *   body: { action: 'review'|'resolve_appeal', ...params }
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const cookieDb = await createClient();
    const viewer = await resolveEvalViewer(cookieDb);
    if (!viewer.role || !viewer.tenantId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // ★ tenant มาจาก session เท่านั้น (กันข้าม tenant) — ถ้า client ส่ง tenantId มาต้องตรงกัน
    if (typeof body.tenantId === "string" && body.tenantId && body.tenantId !== viewer.tenantId) {
      return NextResponse.json({ error: "tenant_mismatch" }, { status: 403 });
    }
    const tenantId = viewer.tenantId;

    const serviceDb = createServiceRoleClient();
    const kind = body.action;

    if (kind === "resolve_appeal") {
      const decision = body.decision === "accepted" ? "accepted" : "rejected";
      const result = await resolveAppeal(serviceDb, viewer, {
        tenantId,
        appealId: String(body.appealId ?? ""),
        decision,
        managerResponse: typeof body.managerResponse === "string" ? body.managerResponse : null,
        adjustedOverall: typeof body.adjustedOverall === "number" ? body.adjustedOverall : null,
        adjustedDimensionScores:
          body.adjustedDimensionScores && typeof body.adjustedDimensionScores === "object"
            ? (body.adjustedDimensionScores as Record<string, number>)
            : null,
      });
      return NextResponse.json({ status: "ok", ...result }, { status: 200 });
    }

    // default: manager review (confirm/edit/reject)
    const action =
      body.reviewAction === "confirm" || body.reviewAction === "edit" || body.reviewAction === "reject"
        ? body.reviewAction
        : null;
    if (!action) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    // ★ H1: action='edit' ต้องมี adjustedOverall เป็น "ตัวเลขจริง" ในช่วง 0–100
    //   (กันฝั่ง client ส่งช่องว่าง/coerce เป็น 0 → คะแนนพนักงานกลายเป็น 0 เงียบ ๆ)
    const adjustedOverall = isValidOverallScore(body.adjustedOverall) ? body.adjustedOverall : null;
    if (action === "edit" && adjustedOverall === null) {
      return NextResponse.json({ error: "invalid_score", message: "คะแนนรวมต้องเป็นตัวเลข 0–100" }, { status: 400 });
    }

    const result = await applyManagerReview(serviceDb, viewer, {
      tenantId,
      evaluationId: String(body.evaluationId ?? ""),
      action,
      adjustedDimensionScores:
        body.adjustedDimensionScores && typeof body.adjustedDimensionScores === "object"
          ? (body.adjustedDimensionScores as Record<string, number>)
          : null,
      adjustedOverall,
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  } catch (e) {
    if (e instanceof EvalAuthError) {
      return NextResponse.json({ error: "forbidden", message: e.message }, { status: 403 });
    }
    logServerError("evaluations/review", requestId, e);
    return NextResponse.json(
      { error: "server_error", request_id: requestId },
      { status: 500 }
    );
  }
}
