import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { runScheduling } from "@/lib/scheduling/engine";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_JOB_NAME = "scan-invitations";

/**
 * POST/GET /api/cron/scan-invitations
 *   Scheduling scan (E5) — Vercel Cron เรียกรายวัน:
 *     สแกนลูกค้า active → eligibility (A ราย 3 เดือน / B ต้นเดือน) →
 *     สร้าง survey_invitation idempotent + enqueue job_queue(notification)
 *   ตัว scan ไม่ส่ง LINE เอง — notification worker (process-notifications) ส่งต่อ
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint ทันที (503, ไม่รัน scan)
 *   มี secret แต่ auth ผิด → 401
 * degrade: ไม่มี service-role env → skip (200)
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

  const timestamp = new Date().toISOString();

  try {
    const db = createServiceRoleClient();
    const summary = await runScheduling({ db });

    // cron_health: อัปเดต last_run (บทเรียน cron เงียบ) — best-effort ไม่ให้ล้ม
    await db
      .from("cron_health")
      .upsert(
        {
          job_name: CRON_JOB_NAME,
          last_run_at: timestamp,
          status: summary.skippedAll ? "failed" : "ok",
        },
        { onConflict: "job_name" }
      );

    return NextResponse.json({ status: "ok", timestamp, ...summary }, { status: 200 });
  } catch (e) {
    logServerError("cron/scan-invitations", requestId, e);
    // best-effort mark cron_health failed
    try {
      const db = createServiceRoleClient();
      await db
        .from("cron_health")
        .upsert(
          { job_name: CRON_JOB_NAME, last_run_at: timestamp, status: "failed" },
          { onConflict: "job_name" }
        );
    } catch {
      /* ignore — health update ล้มไม่ควรบดบัง error หลัก */
    }
    // คืน 200 (กัน Vercel Cron retry loop) + สถานะ error ให้ monitor เห็น
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
