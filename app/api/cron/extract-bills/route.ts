import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  processBillExtraction,
  redecideExistingEntries,
  backfillEntryAccounts,
  reExtractIncompleteEntries,
} from "@/lib/line/bill-extract-worker";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST/GET /api/cron/extract-bills
 *   Bill Extract Worker — Vercel Cron: AI สกัดข้อมูลบิลที่เก็บแล้ว → สร้าง draft
 *   ในตาราง bill_entries/bill_entry_lines (หน้า "ลงบันทึกบัญชี ภาษีซื้อ/ขาย")
 *
 * query param ?mode=
 *   'both' (default) : สกัดบิลใหม่ + ตัดสินฝั่งซื้อ/ขายใหม่ให้ entry เดิมที่ยัง unspecified
 *   'extract'        : สกัดบิลใหม่อย่างเดียว
 *   'redecide'       : ตัดสินฝั่งใหม่อย่างเดียว (ไม่เรียก AI — ใช้ seller/buyer ที่เก็บไว้
 *                      + tax_id/ชื่อลูกค้าล่าสุด เผื่อ NOVA Sales เพิ่งส่งเลขภาษีมา)
 *   'accounts'       : backfill บัญชีให้บิลเดิม (ยิง AI ใหม่จากรูป เอาเฉพาะ account_code
 *                      มาเติมบรรทัดที่ยังว่าง — ไม่แตะยอด/ไม่รวมใน 'both' เพราะมีค่า AI)
 *   'reextract'      : สกัดใหม่ให้บิล "ว่าง/ไม่ครบจริง" (ยิง AI ใหม่จากรูป อัปเดตในที่เดิม —
 *                      เฉพาะ entry ที่ยังไม่มีใครคีย์ · ไม่รวมใน 'both' เพราะมีค่า AI)
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503, ไม่รัน worker)
 *   มี secret แต่ auth ผิด → 401
 * degrade: ไม่มี service-role env → skip · ไม่มี OpenAI key → worker ยังสร้าง draft ว่างได้
 *   (extractBillData คืน null)
 */

/** re-decide ข้ามทุก tenant ที่มี entry unspecified (service-role cron ไม่ผูก tenant เดียว) */
async function redecideAllTenants(
  db: SupabaseClient,
  limitPerTenant = 100
): Promise<{ tenants: number; scanned: number; updated: number }> {
  // หา tenant_id ที่ยังมี draft unspecified (มีชื่อคู่ค้า + ผูกลูกค้าแล้ว)
  const { data, error } = await db
    .from("bill_entries")
    .select("tenant_id")
    .eq("entry_type", "unspecified")
    .eq("status", "draft")
    .is("deleted_at", null)
    .not("customer_id", "is", null)
    .limit(5000);
  if (error) return { tenants: 0, scanned: 0, updated: 0 };

  const tenantIds = [
    ...new Set(((data ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id).filter(Boolean)),
  ];
  let scanned = 0;
  let updated = 0;
  for (const tid of tenantIds) {
    const r = await redecideExistingEntries(db, tid, { limit: limitPerTenant });
    scanned += r.scanned;
    updated += r.updated;
  }
  return { tenants: tenantIds.length, scanned, updated };
}

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

  const modeRaw = (request.nextUrl.searchParams.get("mode") || "both").toLowerCase();
  const mode =
    modeRaw === "extract" ||
    modeRaw === "redecide" ||
    modeRaw === "accounts" ||
    modeRaw === "reextract"
      ? modeRaw
      : "both";

  try {
    const db = createServiceRoleClient();
    const result: Record<string, unknown> = { status: "ok", mode };
    if (mode === "extract" || mode === "both") {
      result.extract = await processBillExtraction(db, { limit: 15 });
    }
    if (mode === "redecide" || mode === "both") {
      result.redecide = await redecideAllTenants(db);
    }
    // backfill บัญชีบิลเดิม — เฉพาะ mode=accounts (ไม่รวมใน both เพราะยิง AI ราคาแพง)
    if (mode === "accounts") {
      result.accounts = await backfillEntryAccounts(db, { limit: 10 });
    }
    // สกัดใหม่บิลว่าง/ไม่ครบ — เฉพาะ mode=reextract (ไม่รวมใน both เพราะยิง AI ราคาแพง)
    if (mode === "reextract") {
      result.reextract = await reExtractIncompleteEntries(db, { limit: 10 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    logServerError("cron/extract-bills", requestId, e);
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
