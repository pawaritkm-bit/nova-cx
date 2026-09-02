import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { processPendingAttachments } from "@/lib/line/attachments";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// ★ 2026-09-02 บั๊กที่ผู้ใช้เจอ ("บิลจากกลุ่ม LINE ไม่ไหลเข้าลูกค้า"): 60s ไม่พอ —
//   เก็บไฟล์ + AI อ่านบิล real-time ต่อท้ายรอบเดียว โดนตัดกลางคันเงียบ ๆ
export const maxDuration = 300;

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

    // ★ 2026-09-02 safety net: กวาดอ่านบิลค้างของ "กลุ่มรวมหลายบริษัท" (route_by_slip) ทุกรอบ —
    //   real-time ตอน store อาจโดนตัด (timeout/สะดุด) และ cron extract-bills แบบตามเวลาปิดถาวร
    //   → ไม่มีรอบเก็บตก บิลค้าง pending จนกว่าจะมีไฟล์ใหม่มากระตุ้น · sweep นี้ idempotent
    //   (คัดเฉพาะที่ยังไม่มี entry) และจำกัด 5 ใบ/กลุ่ม/รอบ คุมต้นทุน
    let sweep: { groups: number; created: number } = { groups: 0, created: 0 };
    try {
      const { data: routeGroups } = await db
        .from("chat_groups")
        .select("id")
        .eq("route_by_slip", true)
        .eq("is_active", true)
        .is("deleted_at", null)
        .limit(20);
      const { processBillExtraction } = await import("@/lib/line/bill-extract-worker");
      for (const g of (routeGroups ?? []) as { id: string }[]) {
        try {
          const r = await processBillExtraction(db, { chatGroupId: g.id, limit: 5 });
          sweep = { groups: sweep.groups + 1, created: sweep.created + r.created };
        } catch {
          // กลุ่มเดียวพลาด → ข้าม (best-effort)
        }
      }
    } catch {
      // sweep พลาดทั้งชุด → ไม่กระทบงานเก็บไฟล์หลัก
    }

    return NextResponse.json({ status: "ok", ...summary, routeSweep: sweep }, { status: 200 });
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
