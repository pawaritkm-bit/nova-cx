import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAIProvider } from "@/lib/ai/provider";
import { scanCaseEvaluations } from "@/lib/evaluation/enqueue";
import { processEvaluationJobs } from "@/lib/evaluation/worker";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/process-evaluations
 *   Evaluation Worker endpoint (Phase 4) — Vercel Cron เรียกเป็นระยะ:
 *     1) scan เคสที่ปิดแล้ว → enqueue job `evaluation` (idempotent)
 *     2) ประมวลผล job → สร้าง "ร่าง" ประเมินนักบัญชี (needs_review เสมอ)
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503)
 * degrade: ไม่มี service-role env → skip
 */
async function handle(request: NextRequest) {
  const requestId = newRequestId();

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "cron_disabled", reason: "CRON_SECRET not configured" },
      { status: 503 }
    );
  }
  const auth = request.headers.get("authorization");
  if (!isValidCronAuth(auth, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json({ status: "skipped", reason: "no service-role env" }, { status: 200 });
  }

  try {
    const db = createServiceRoleClient();
    const provider = getAIProvider();

    const scan = await scanCaseEvaluations({ db });
    const worker = await processEvaluationJobs({ db, provider });

    return NextResponse.json({ status: "ok", scan, worker }, { status: 200 });
  } catch (e) {
    logServerError("cron/process-evaluations", requestId, e);
    return NextResponse.json({ status: "error", request_id: requestId }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
