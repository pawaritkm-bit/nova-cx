import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { processPendingAttachments } from "@/lib/line/attachments";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/process-attachments
 *   Bill Attachment Worker — Vercel Cron ดึงรูปบิลจาก LINE → เก็บขึ้น storage
 *   (Supabase Storage default / Drive) — เฟส 1: เฉพาะ attachment_type='image'
 *   ยังไม่ส่งต่อ NOVA Sales/ยังไม่อ่านบิล
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503, ไม่รัน worker)
 *   มี secret แต่ auth ผิด → 401
 * degrade: ไม่มี service-role env → skip · storage backend ยังไม่พร้อม → worker คืน {disabled:true}
 *   (inert — ไม่มีผลข้างเคียง)
 */
async function handle(request: NextRequest) {
  const requestId = newRequestId();

  // --- auth: CRON_SECRET (fail-closed) ---
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
    return NextResponse.json(
      { status: "skipped", reason: "no service-role env" },
      { status: 200 }
    );
  }

  try {
    const db = createServiceRoleClient();
    const summary = await processPendingAttachments(db, { limit: 20 });
    return NextResponse.json({ status: "ok", ...summary }, { status: 200 });
  } catch (e) {
    logServerError("cron/process-attachments", requestId, e);
    // คืน 200 กัน Vercel Cron retry เป็น error loop + ให้ monitor เห็นสถานะ
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
