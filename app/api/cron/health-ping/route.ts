import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST/GET /api/cron/health-ping
 * โครง cron last-run alert (E12): Vercel Cron เรียกทุกวัน → อัปเดต cron_health.last_run_at
 * ทีม monitor แจ้งเตือนได้เมื่อ last_run_at ค้าง (บทเรียน: cron เงียบ)
 *
 * ความปลอดภัย: ต้องมี CRON_SECRET (Vercel Cron ส่ง `Authorization: Bearer <CRON_SECRET>`)
 */
async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const timestamp = new Date().toISOString();
  const env = getSupabaseEnv();

  // ยังไม่ตั้ง env/service role → ไม่ล้ม แค่รายงานว่า skip
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json(
      { status: "skipped", reason: "no service-role env", timestamp },
      { status: 200 }
    );
  }

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase
      .from("cron_health")
      .update({ last_run_at: timestamp, status: "ok" })
      .eq("job_name", "health-ping");

    if (error) {
      // ยังไม่มีแถว health-ping ก็ลอง insert (idempotent-ish)
      await supabase
        .from("cron_health")
        .upsert(
          { job_name: "health-ping", last_run_at: timestamp, status: "ok" },
          { onConflict: "job_name" }
        );
    }
    return NextResponse.json({ status: "ok", timestamp }, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        message: e instanceof Error ? e.message : "unknown error",
        timestamp,
      },
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
