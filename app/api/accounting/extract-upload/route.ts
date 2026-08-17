import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { extractUploadedEntry } from "@/lib/line/bill-extract-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ★ AI อ่านบิล (gpt-5-mini reasoning + PDF หลายบิล) ช้า — ให้ headroom 120s
export const maxDuration = 300; // เพดาน Vercel Pro — รองรับบิล PDF รวมหลายใบไฟล์ใหญ่ (split หลายชิ้น)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/accounting/extract-upload  { entryId }
 *   AI อ่านไฟล์ที่นักบัญชีอัปเอง (รูป/PDF) แล้วลงบัญชีให้ (เติมหัว+บรรทัด) นักบัญชีแค่ตรวจ
 *   — client เรียกทันทีหลังอัปไฟล์เสร็จ ก่อนเข้าหน้าตรวจ/แก้บิล
 *
 * ความปลอดภัย: ต้องมีสิทธิ์บัญชี (admin/นักบัญชี) + ลูกค้าของ entry ต้องอยู่ในสโคป
 * degrade: อ่านไม่ได้/ไม่ใช่รูป-PDF/ไม่มี key → { ok:true, extracted:false } (คง draft ว่างให้คีย์เอง)
 * ★ PDPA: ไม่ log entryId/เนื้อบิล
 */
export async function POST(request: NextRequest) {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { entryId?: unknown };
    const entryId = typeof body.entryId === "string" ? body.entryId : "";
    if (!UUID_RE.test(entryId)) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    // สโคป: ลูกค้าของ entry ต้องอยู่ในความดูแล (admin/lead ผ่าน)
    const { data: e } = await service
      .from("bill_entries")
      .select("customer_id")
      .eq("id", entryId)
      .eq("tenant_id", access.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!e) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (!customerInScope(access, (e as { customer_id: string | null }).customer_id)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const r = await extractUploadedEntry(service, access.tenantId, entryId);
    return NextResponse.json({ ok: true, extracted: r.extracted, count: r.count });
  } catch {
    // ไม่ให้ล้มทั้ง flow อัปไฟล์ — คืน 200 extracted:false (หน้าแก้ยังเปิดให้คีย์เองได้)
    return NextResponse.json({ ok: true, extracted: false }, { status: 200 });
  }
}
