import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { buildHealthPayload } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * - ok:       ตั้ง env ครบ + query ตาราง cron_health ได้
 * - degraded: ยังไม่ตั้ง env / ต่อ DB ไม่ได้ / ยังไม่ apply migration (ไม่ crash)
 *
 * หมายเหตุ: หลัง 0013 role anon ถูก revoke สิทธิ์ตาราง → ใช้ service-role เช็ค
 *           connectivity ถ้ามี (แม่นกว่า); ไม่มีก็ fallback client ปกติ
 */
export async function GET() {
  const timestamp = new Date().toISOString();
  const env = getSupabaseEnv();

  if (!env) {
    return NextResponse.json(
      buildHealthPayload({ timestamp, hasEnv: false }),
      { status: 200 }
    );
  }

  let dbOk = false;
  let dbError: string | null = null;
  try {
    const supabase = env.serviceRoleKey
      ? createServiceRoleClient()
      : await createClient();
    const { error } = await supabase.from("cron_health").select("id").limit(1);
    if (error) {
      dbError = error.message; // ต่อได้แต่ query ไม่ผ่าน (เช่น ยัง apply migration ไม่ครบ)
      dbOk = false;
    } else {
      dbOk = true;
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : "unknown error";
    dbOk = false;
  }

  return NextResponse.json(
    buildHealthPayload({ timestamp, hasEnv: true, dbOk, dbError }),
    { status: 200 }
  );
}
