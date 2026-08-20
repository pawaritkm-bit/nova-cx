import { NextResponse, type NextRequest } from "next/server";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/retry-locked
 *   อ่านสเตทเมนต์ที่ "ติดรหัส" ซ้ำ หลังนักบัญชีพิมพ์รหัสในไฟล์โน้ต (OneDrive)
 *   — ค้นโน้ต → ปลด → อ่าน → save สรุป → ติด ✅ → ลบโน้ต (ดู retry-locked-read.ts)
 *
 * ความปลอดภัย (fail-closed): ไม่มี CRON_SECRET → 503 · auth ผิด → 401
 * degrade: OneDrive ไม่พร้อม → worker คืน {disabled:true} (inert)
 */
async function handle(request: NextRequest) {
  const requestId = newRequestId();

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron_disabled", reason: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!isValidCronAuth(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ★ gate ร่วมกับฟีเจอร์อ่านอัตโนมัติ — ปิดอยู่ = ไม่รัน
  if (process.env.ACCT_AUTO_READ !== "on") {
    return NextResponse.json({ status: "skipped", reason: "ACCT_AUTO_READ off" }, { status: 200 });
  }

  try {
    // ★ dynamic import: กัน dep หนัก crash ตอน cold-start ของ route (แบบเดียวกับ process-attachments)
    const { retryLockedStatements } = await import("@/lib/accounting/retry-locked-read");
    const { createServiceRoleClient } = await import("@/lib/supabase/server");
    // ส่ง service client → retry-locked ลอง "รหัสจากแชทกลุ่ม" ด้วย (ลูกค้ามักพิมพ์รหัสในแชท)
    const db = createServiceRoleClient();
    const summary = await retryLockedStatements(db);
    return NextResponse.json({ status: "ok", ...summary }, { status: 200 });
  } catch (e) {
    logServerError("cron/retry-locked", requestId, e);
    return NextResponse.json({ status: "error", request_id: requestId }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
