import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { submitAppeal, EvalAuthError } from "@/lib/evaluation/review";
import { newRequestId, logServerError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/appeal
 *   นักบัญชียื่นอุทธรณ์ผลประเมินของตัวเอง
 *   ★ guard: resolve viewer จาก session → submitAppeal บังคับว่าเป็นเจ้าของ eval เท่านั้น
 *   body: { tenantId, evaluationId, reason }
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const evaluationId = typeof body.evaluationId === "string" ? body.evaluationId : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!evaluationId) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }

    const cookieDb = await createClient();
    const viewer = await resolveEvalViewer(cookieDb);
    if (!viewer.role || !viewer.employeeId || !viewer.tenantId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // ★ tenant จาก session เท่านั้น
    if (typeof body.tenantId === "string" && body.tenantId && body.tenantId !== viewer.tenantId) {
      return NextResponse.json({ error: "tenant_mismatch" }, { status: 403 });
    }
    const tenantId = viewer.tenantId;

    const serviceDb = createServiceRoleClient();
    const result = await submitAppeal(serviceDb, viewer, {
      tenantId,
      evaluationId,
      reason,
    });
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  } catch (e) {
    if (e instanceof EvalAuthError) {
      return NextResponse.json({ error: "forbidden", message: e.message }, { status: 403 });
    }
    logServerError("evaluations/appeal", requestId, e);
    return NextResponse.json({ error: "server_error", request_id: requestId }, { status: 500 });
  }
}
