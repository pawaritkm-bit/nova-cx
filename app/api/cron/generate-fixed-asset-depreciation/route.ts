import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateDueDepreciation } from "@/lib/accounting/fixed-assets";
import { todayIsoThai } from "@/lib/accounting/recurring-journal";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { newRequestId, logServerError, isValidCronAuth } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/cron/generate-fixed-asset-depreciation
 *   ค่าเสื่อมราคาทรัพย์สินถาวรอัตโนมัติ (เฟส 7 ส่วน V, docs/06 หมวด 0.4) — Vercel Cron รายวัน
 *   สแกนทุกทรัพย์สินที่ `status='active'` และ `next_dep_date <= วันนี้` ของ "ทุก tenant" (service-role
 *   ไม่ผูก tenant เดียว — mirror `generate-recurring-je`/`extract-bills`) → claim (atomic RPC) +
 *   สร้างรายการค่าเสื่อมเป็น draft เสมอ (0.3 ห้าม auto-confirm)
 *
 * ความปลอดภัย (fail-closed): ไม่ตั้ง CRON_SECRET → ปิด endpoint (503, ไม่รัน) · auth ผิด → 401
 * ★ error ภายใน (ทรัพย์สินใบใดใบหนึ่งพัง/DB blip) → catch แล้วคืน 200 เสมอ (กัน Vercel Cron retry
 *   เป็น error loop) — generateDueDepreciation เองก็ครอบ try/catch ต่อทรัพย์สินอยู่แล้ว
 * ★ today = todayIsoThai() (server เท่านั้น) — ไม่มีทางรับจาก client/query param
 */

/** สแกนทุก tenant ที่มีทรัพย์สิน active ถึงกำหนดวันนี้ → generate ทีละ tenant (cron ไม่ผูก tenant เดียว) */
async function generateForAllTenants(
  db: SupabaseClient,
  today: string
): Promise<{ tenants: number; scanned: number; generated: number; failed: number; skipped: number }> {
  const { data, error } = await db
    .from("fixed_assets")
    .select("tenant_id")
    .eq("status", "active")
    .is("deleted_at", null)
    .lte("next_dep_date", today)
    .limit(5000);
  if (error) return { tenants: 0, scanned: 0, generated: 0, failed: 0, skipped: 0 };

  const tenantIds = [
    ...new Set(((data ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id).filter(Boolean)),
  ];

  let scanned = 0;
  let generated = 0;
  let failed = 0;
  let skipped = 0;
  for (const tenantId of tenantIds) {
    const chart = await listChartOfAccounts(db, tenantId);
    const chartByCode = buildChartByCode(chart);
    const r = await generateDueDepreciation(db, tenantId, today, chartByCode);
    scanned += r.scanned;
    generated += r.generated;
    failed += r.failed;
    skipped += r.skipped;
  }
  return { tenants: tenantIds.length, scanned, generated, failed, skipped };
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

  try {
    const db = createServiceRoleClient();
    const today = todayIsoThai();
    const result = await generateForAllTenants(db, today);
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  } catch (e) {
    logServerError("cron/generate-fixed-asset-depreciation", requestId, e);
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
