import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { processPendingAttachments } from "@/lib/line/attachments";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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
    // diagnostic ชั่วคราว (ปลอดภัย: บอกแค่ true/false + ความยาว ไม่โชว์ค่า/คีย์)
    let diag: Record<string, unknown> | undefined;
    if ((summary as { disabled?: boolean }).disabled) {
      const raw = process.env.GOOGLE_DRIVE_SA_JSON;
      const folder = process.env.GDRIVE_ROOT_FOLDER_ID;
      let parseOk = false, hasEmail = false, hasKey = false, hasEscapedNL = false, firstChar = "";
      if (raw) {
        firstChar = raw.trim().slice(0, 1);
        hasEscapedNL = raw.includes("\\n");
        try {
          const p = JSON.parse(raw) as { client_email?: string; private_key?: string };
          parseOk = true; hasEmail = !!p.client_email; hasKey = !!p.private_key;
        } catch { parseOk = false; }
      }
      diag = {
        saPresent: !!raw, saLen: raw ? raw.length : 0, saFirstChar: firstChar,
        folderPresent: !!folder, folderLen: folder ? folder.length : 0,
        parseOk, hasClientEmail: hasEmail, hasPrivateKey: hasKey, hasEscapedNewline: hasEscapedNL,
      };
    }
    return NextResponse.json({ status: "ok", ...summary, ...(diag ? { _diag: diag } : {}) }, { status: 200 });
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
