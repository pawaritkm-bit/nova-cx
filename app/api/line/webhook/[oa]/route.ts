import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, getLineChannelSecret, type LineOa } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { newRequestId, logServerError } from "@/lib/http";
import { verifyLineSignature } from "@/lib/line/signature";
import { parseWebhookBody, resolveOaTenantId, trimLineEvent } from "@/lib/line/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/line/webhook/[oa]   (oa = care | sale)
 *   1) verify x-line-signature (HMAC-SHA256 ด้วย channel secret ของ OA นั้น) → ไม่ผ่าน 401
 *   2) enqueue แต่ละ event ลง job_queue(line_event) แล้ว return 200 ทันที
 *      (ไม่ประมวลผลหนัก inline — worker line_event ทำภายหลัง)
 *
 * degrade: ไม่มี channel secret / Supabase env → 503 (webhook ยังไม่พร้อมใช้)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ oa: string }> }
) {
  const requestId = newRequestId();
  const { oa: oaParam } = await params;

  // ตรวจว่า oa ถูกต้อง (care|sale)
  if (oaParam !== "care" && oaParam !== "sale") {
    return NextResponse.json({ error: "unknown_oa" }, { status: 404 });
  }
  const oa: LineOa = oaParam;

  // ต้องมี channel secret ถึงจะ verify ได้
  const channelSecret = getLineChannelSecret(oa);
  if (!channelSecret) {
    return NextResponse.json(
      { error: "service_unavailable", message: `ยังไม่ได้ตั้งค่า channel secret ของ OA ${oa}` },
      { status: 503 }
    );
  }

  // อ่าน body ดิบ (ต้องเป็น bytes เดียวกับที่ LINE เซ็น)
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  // --- verify signature ---
  if (!verifyLineSignature(channelSecret, rawBody, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    // signature ผ่านแล้ว แต่ persist ไม่ได้ — ตอบ 200 กัน LINE retry ถล่ม
    // (log ไว้ให้ตามได้; ไม่มี DB ก็ enqueue ไม่ได้)
    logServerError("line/webhook", requestId, "no service-role env; events dropped");
    return NextResponse.json({ status: "ok", enqueued: 0 }, { status: 200 });
  }

  try {
    const body = parseWebhookBody(rawBody);
    const events = body.events ?? [];
    if (events.length === 0) {
      // event ว่าง (เช่น verify ตอนตั้ง webhook) — ตอบ 200
      return NextResponse.json({ status: "ok", enqueued: 0 }, { status: 200 });
    }

    const db = createServiceRoleClient();
    // destination = bot user id ของ OA ที่ควรรับ webhook นี้ → ใช้เป็น channel_ref หา tenant
    const tenantId = await resolveOaTenantId(db, oa, body.destination);
    if (!tenantId) {
      logServerError("line/webhook", requestId, "no tenant resolved; events dropped");
      return NextResponse.json({ status: "ok", enqueued: 0 }, { status: 200 });
    }

    // enqueue 1 job ต่อ 1 event (worker ประมวลผลภายหลัง)
    // M2: trim PII — เก็บเฉพาะ field ที่ worker ใช้ (ตัด message.text ฯลฯ) ไม่เก็บ event ดิบ
    const jobs = events.map((event) => ({
      tenant_id: tenantId,
      queue: "line_event",
      payload: { oa, event: trimLineEvent(event) },
    }));
    await db.from("job_queue").insert(jobs);

    return NextResponse.json(
      { status: "ok", enqueued: jobs.length },
      { status: 200 }
    );
  } catch (e) {
    logServerError("line/webhook", requestId, e);
    // ตอบ 200 กัน LINE retry loop (worker/monitor จับ error จาก log/queue)
    return NextResponse.json(
      { status: "error", request_id: requestId },
      { status: 200 }
    );
  }
}
