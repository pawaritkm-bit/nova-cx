import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BILLS_BUCKET = "bills";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** จับ "รูป" ทั้ง .jpg และ _jpg (naming เก่า) — ตรงกับ IMG_EXT_RE ของโต๊ะทำงาน */
const IMG_EXT_RE = /[._](png|jpe?g|webp|gif|heic)($|\?)/i;

/**
 * GET /api/accounting/bill-thumb?entry=<id>&w=<px> — รูปย่อของบิล (perf 2026-09-01)
 *
 * ทำไมต้องมี: รายการบิล/การ์ดจับคู่เคยฝัง signed URL ของ "สแกนเต็ม" (~0.3-1MB/ใบ ×50 ใบ)
 *   → เลื่อนหน้าอืด. endpoint นี้ให้ storage ย่อรูปฝั่ง server (transform) เหลือ ~10-30KB
 *   + Cache-Control ให้เบราว์เซอร์จำ — เลื่อน/กลับเข้าหน้าเดิมไม่โหลดซ้ำ
 *
 * ความปลอดภัย: session ต้องมีสิทธิ์บัญชี + บิลอยู่ในสโคปลูกค้าของผู้เรียก (แบบเดียวกับหน้าบิล)
 * degrade: ย่อไม่ได้ (ไฟล์แปลก) → ส่งไฟล์เต็มแทน · ไม่ใช่รูป/ไม่พบ → 404
 * ★ PDPA: ไม่ log path/ชื่อ
 */
export async function GET(request: NextRequest) {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) return NextResponse.json({ ok: false }, { status: 401 });

    const entryId = request.nextUrl.searchParams.get("entry") ?? "";
    if (!UUID_RE.test(entryId)) return NextResponse.json({ ok: false }, { status: 400 });
    const wRaw = Number(request.nextUrl.searchParams.get("w") ?? 360);
    const width = Math.min(1400, Math.max(120, Number.isFinite(wRaw) ? Math.round(wRaw) : 360));

    const { data: e } = await service
      .from("bill_entries")
      .select("customer_id, upload_path, upload_mime, attachment_id")
      .eq("id", entryId)
      .eq("tenant_id", access.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!e) return NextResponse.json({ ok: false }, { status: 404 });
    const entry = e as { customer_id: string | null; upload_path: string | null; upload_mime: string | null; attachment_id: string | null };
    if (!customerInScope(access, entry.customer_id)) return NextResponse.json({ ok: false }, { status: 403 });

    // path: ไฟล์แนบไลน์ (message_attachments) มาก่อน — ตรงกับ entryPath ของโต๊ะทำงาน
    let path: string | null = null;
    if (entry.attachment_id) {
      const { data: att } = await service
        .from("message_attachments")
        .select("drive_file_id")
        .eq("id", entry.attachment_id)
        .eq("tenant_id", access.tenantId)
        .maybeSingle();
      path = (att as { drive_file_id: string | null } | null)?.drive_file_id ?? null;
    }
    if (!path) path = entry.upload_path;
    if (!path) return NextResponse.json({ ok: false }, { status: 404 });
    const isImage = (entry.upload_mime ?? "").startsWith("image/") || IMG_EXT_RE.test(path);
    if (!isImage) return NextResponse.json({ ok: false }, { status: 404 });

    // ย่อฝั่ง storage ผ่าน render endpoint ตรง ๆ (Accept: webp → ได้ webp เล็กกว่า PNG ~5-10 เท่า
    //   download({transform}) ของ supabase-js ไม่ส่ง Accept เลยได้ PNG กลับมา — ทดสอบจริง 2026-09-01)
    //   พลาด (codec แปลก/transform ล่ม) → ส่งไฟล์เต็ม (ช้ากว่าแต่ไม่พังหน้า)
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    let body: ArrayBuffer | null = null;
    let contentType = "image/webp";
    try {
      const r = await fetch(
        `${base}/storage/v1/render/image/authenticated/${BILLS_BUCKET}/${path}?width=${width}&quality=62`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "image/webp,image/*" } }
      );
      if (r.ok) {
        body = await r.arrayBuffer();
        contentType = r.headers.get("content-type") ?? "image/webp";
      }
    } catch {
      body = null;
    }
    if (!body) {
      const { data } = await service.storage.from(BILLS_BUCKET).download(path);
      if (!data) return NextResponse.json({ ok: false }, { status: 404 });
      body = await data.arrayBuffer();
      contentType = data.type || "image/png";
    }

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        // private (ไฟล์ลูกค้า) + จำ 1 ชม. — เลื่อนกลับมา/เปิดซ้ำไม่ดาวน์โหลดใหม่
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
}
