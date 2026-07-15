import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { newRequestId, logServerError } from "@/lib/http";
import { processLineEventJobs } from "@/lib/line/events";
import { processNotificationJobs, processReminders } from "@/lib/line/notify";
import { getLineClient } from "@/lib/line/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/process-notifications
 *   LINE worker endpoint — Vercel Cron เรียกเป็นระยะ:
 *     1) process line_event  (follow/unfollow → line_users)
 *     2) process notification (ส่งแบบประเมิน/เตือนทาง LINE + log + retry)
 *     3) scan reminders       (เตือนอัตโนมัติ 1 ครั้ง/1 วัน → enqueue reminder)
 *
 * ความปลอดภัย: ต้องมี CRON_SECRET (Authorization: Bearer <CRON_SECRET>)
 * degrade: ไม่มี service-role env → skip; ไม่มี LINE credential → job คง pending (deferred)
 */
async function handle(request: NextRequest) {
  const requestId = newRequestId();

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
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

    const events = await processLineEventJobs({ db, getClient: getLineClient });
    const notifications = await processNotificationJobs({ db });
    const reminders = await processReminders({ db });

    return NextResponse.json(
      { status: "ok", events, notifications, reminders },
      { status: 200 }
    );
  } catch (e) {
    logServerError("cron/process-notifications", requestId, e);
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
