import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { extractShareCirclesFromLine } from "@/lib/line/share-circle-extract-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ★ AI อ่านลิสต์วงแชร์ (gpt-5-mini reasoning + หลายรูป) ช้า — ให้ headroom 120s
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * POST /api/accounting/extract-share-circle  { customerId, month }
 *   อ่านลิสต์วงแชร์ (รูป + คำพิม) จากกลุ่มไลน์ของลูกค้า(ท้าว) ของเดือนที่เลือก
 *   → AI สกัดเป็นตารางวง → เขียนลง share_circle_entries (source='ai')
 *
 * ความปลอดภัย: ต้องมีสิทธิ์บัญชี (admin/นักบัญชี) + ลูกค้าต้องอยู่ในสโคป
 * ★ PDPA: ไม่ log customerId/month/เนื้อข้อความ
 */
export async function POST(request: NextRequest) {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      customerId?: unknown;
      month?: unknown;
    };
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const month = typeof body.month === "string" ? body.month : "";
    if (!UUID_RE.test(customerId) || !MONTH_RE.test(month)) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    // สโคป: ลูกค้าต้องอยู่ในความดูแล (admin/lead ผ่าน)
    if (!customerInScope(access, customerId)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const r = await extractShareCirclesFromLine(service, access.tenantId, customerId, month);
    return NextResponse.json({ ok: true, extracted: r.extracted, count: r.count });
  } catch {
    // ไม่ให้ล้ม flow — คืน 200 extracted:false (นักบัญชีคีย์เองได้)
    return NextResponse.json({ ok: true, extracted: false, count: 0 }, { status: 200 });
  }
}
