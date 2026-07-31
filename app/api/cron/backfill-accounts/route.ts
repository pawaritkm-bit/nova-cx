import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { backfillEntryAccounts } from "@/lib/line/bill-extract-worker";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/backfill-accounts
 *   ★ cron "ชั่วคราว" สำหรับไล่เติมบัญชีที่ AI แนะนำให้ "บิลเก่า" ที่ยังไม่มี account_code
 *     (บิลใหม่ได้บัญชีตอนสกัดอยู่แล้ว — อันนี้ backfill ของเดิม ~534 ใบ)
 *   แยกจาก extract-bills (ไม่พึ่ง query string ?mode= เพื่อให้ Vercel Cron เรียกได้ชัวร์)
 *   รอบละ 10 ใบ (ยิง OpenAI vision อ่านรูปใหม่ — แพง) · maxDuration 60s พอดี 10 ใบ
 *   auth: CRON_SECRET (fail-closed) — Vercel Cron แนบ Bearer ให้เอง
 *   ★ ถอด route + cron entry นี้ออกได้เมื่อ backfill ครบ (drain แล้วเป็น no-op ราคาถูก)
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
  if (!isValidCronAuth(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json({ status: "skipped", reason: "no service-role env" }, { status: 200 });
  }

  try {
    const db = createServiceRoleClient();
    const accounts = await backfillEntryAccounts(db, { limit: 10 });
    return NextResponse.json({ status: "ok", accounts }, { status: 200 });
  } catch (e) {
    logServerError("cron/backfill-accounts", requestId, e);
    return NextResponse.json({ status: "error", request_id: requestId }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
