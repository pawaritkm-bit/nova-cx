import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { reExtractIncompleteEntries } from "@/lib/line/bill-extract-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/debug/reextract-once — ★ ชั่วคราว (ถอดออกภายหลัง)
 *   ปุ่ม debug: แอดมิน (Supabase session) กดในเบราว์เซอร์ → รัน re-extract 10 ใบ
 *   คืนผล { scanned, updated, stillEmpty } เพื่อดูว่า worker ทำงานได้จริงไหม
 *   (เลี่ยงปัญหา CRON_SECRET เป็น Sensitive อ่านกลับไม่ได้ — วินิจฉัยว่า cron ไม่ยิง
 *    หรือสกัดแล้วได้ null) · admin-only + คืน error message ให้เห็นสาเหตุ
 */
export async function GET() {
  try {
    const authed = await createClient();
    const admin = await resolveAdminContext(authed);
    if (!admin.isAdmin) {
      return NextResponse.json({ error: "forbidden", isAdmin: false }, { status: 403 });
    }
    const service = createServiceRoleClient();
    const result = await reExtractIncompleteEntries(service, { limit: 10 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 }
    );
  }
}
