import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateDueReminders } from "@/lib/accounting/payroll-filing-reminders";
import { todayIsoThai } from "@/lib/accounting/recurring-journal";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/generate-payroll-filing-reminders
 *   แจ้งเตือนวันครบกำหนดยื่น ภ.ง.ด.1/สปส.1-10 — Vercel Cron รายวัน (เฟส 9b กลุ่ม BG, docs/06 หมวด 0.6/T171)
 *   mirror โครง app/api/cron/generate-recurring-je/route.ts ทั้งหมด (auth/error-handling ส่วนที่ reuse ได้
 *   จริงและปลอดภัย — ปลายทางผลลัพธ์ต่างกัน: ที่นี่แค่เขียน log กันแจ้งเตือนซ้ำ ไม่มีการสร้าง JE/ส่งข้อความออก)
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503, ไม่รัน) · auth ผิด → 401
 * ★ error ภายใน (DB blip) → catch แล้วคืน 200 เสมอ (กัน Vercel Cron retry เป็น error loop) —
 *   generateDueReminders เองก็ครอบ error ต่อแถวไว้แล้ว (insert ล้มเหลว/ชน unique ไม่ทำให้แถวอื่นพังตาม)
 * ★ today = todayIsoThai() (server เท่านั้น) — ไม่มีทางรับจาก client/query param
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
    const today = todayIsoThai();
    const result = await generateDueReminders(db, today);
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  } catch (e) {
    logServerError("cron/generate-payroll-filing-reminders", requestId, e);
    // คืน 200 กัน Vercel Cron retry เป็น error loop + ให้ monitor เห็นสถานะ
    return NextResponse.json({ status: "error", request_id: requestId }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
