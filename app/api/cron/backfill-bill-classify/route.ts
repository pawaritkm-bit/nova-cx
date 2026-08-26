import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { backfillClassify } from "@/lib/line/bill-backfill";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * ปิดถาวรตามนโยบายธุรกิจ: ห้าม AI ไล่อ่าน/จำแนกรูปย้อนหลัง
 * คง endpoint ไว้ให้ cron เก่าหรือ URL ที่ถูกเรียกอยู่ตอบแบบปลอดภัยโดยไม่แตะ AI
 */
const HISTORICAL_AI_DISABLED = true;

/**
 * POST/GET /api/cron/backfill-bill-classify
 *   Bill Classify Backfill Worker — Vercel Cron ทยอยคัดกรองรูปที่เก็บไปแล้ว
 *   (ก่อนมีระบบคัดกรอง) ด้วย AI vision → เก็บเฉพาะเอกสารการเงิน ลบรูปอื่นออกจาก bucket
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503) · auth ผิด → 401
 * degrade:
 *   - ไม่มี service-role env → skip
 *   - ไม่มี OPENAI_API_KEY → skip (ไม่คัด ไม่ลบ — keep ทุกรูปเหมือนเดิม)
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

  if (HISTORICAL_AI_DISABLED) {
    return NextResponse.json(
      { status: "skipped", reason: "historical_ai_disabled" },
      { status: 200 }
    );
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json(
      { status: "skipped", reason: "no service-role env" },
      { status: 200 }
    );
  }

  // degrade: ไม่มี OpenAI key → ไม่คัด ไม่ลบ (เก็บทุกรูปเหมือนเดิม)
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { status: "skipped", reason: "no openai key" },
      { status: 200 }
    );
  }

  try {
    const db = createServiceRoleClient();
    const summary = await backfillClassify(db, { limit: 20 });
    return NextResponse.json({ status: "ok", ...summary }, { status: 200 });
  } catch (e) {
    logServerError("cron/backfill-bill-classify", requestId, e);
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
