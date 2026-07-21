import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAIProvider } from "@/lib/ai/provider";
import { processAiAnalysisJobs } from "@/lib/ai/worker";
import { processChatAnalysisJobs } from "@/lib/ai/chat-worker";
import { processOfficeInboundJobs } from "@/lib/ai/office-worker";
import { scanChatAnalysis } from "@/lib/ai/chat-scan";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/process-ai
 *   AI Analysis Worker endpoint — Vercel Cron เรียกเป็นระยะเพื่อดึง job `ai_analysis`
 *   ประมวลผล (redact→AI→validate→guardrail→บันทึก+เปิดเคส) เป็น batch
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint ทันที (503, ไม่รัน worker)
 *   มี secret แต่ auth ผิด → 401
 * degrade: ไม่มี service-role env → skip; ไม่มี OPENAI_API_KEY → skip (job คง pending)
 */
async function handle(request: NextRequest) {
  const requestId = newRequestId();

  // --- auth: CRON_SECRET (fail-closed) ---
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // ไม่ตั้ง secret → ปิด endpoint ไม่ให้รัน worker โดยไม่มีการยืนยันตัวตน
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
    return NextResponse.json(
      { status: "skipped", reason: "no service-role env" },
      { status: 200 }
    );
  }

  try {
    const db = createServiceRoleClient();
    const provider = getAIProvider();

    // 1) survey AI worker (เดิม — ไม่แตะ)
    const summary = await processAiAnalysisJobs({ db, provider });

    // 2) chat (Phase 2 + Phase A) — additive: scan enqueue + chat worker (กลุ่ม) + office worker (1-1)
    //    scan แยก route: group/room → chat_analysis, 1-1 → office_inbound
    //    isolate ไว้: chat พังต้องไม่ทำให้ survey worker ล้ม (คืนผลแยกใน chat.error)
    let chatScan;
    let chatWorker;
    let officeWorker;
    try {
      chatScan = await scanChatAnalysis({ db });
      chatWorker = await processChatAnalysisJobs({ db, provider });
      officeWorker = await processOfficeInboundJobs({ db, provider });
    } catch (chatErr) {
      logServerError("cron/process-ai:chat", requestId, chatErr);
      return NextResponse.json(
        { status: "ok", ...summary, chat: { error: true, request_id: requestId } },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        status: "ok",
        ...summary,
        chat: { scan: chatScan, worker: chatWorker, office: officeWorker },
      },
      { status: 200 }
    );
  } catch (e) {
    logServerError("cron/process-ai", requestId, e);
    // คืน 200 (Vercel Cron ไม่ retry แบบ error loop) + สถานะ error ให้ monitor เห็น
    return NextResponse.json(
      { status: "error", request_id: requestId },
      { status: 200 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
