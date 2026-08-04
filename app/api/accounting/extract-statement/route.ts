import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { classifyUpload } from "@/lib/accounting/upload";
import {
  extractStatementFromFile,
  extractStatementFromText,
} from "@/lib/accounting/statement-extract";
import { excelBufferToText, csvBufferToText } from "@/lib/accounting/statement-parse";
import { mimeFromPath } from "@/lib/line/bill-extract-worker";
import {
  summarizeByMonth,
  findRepeatCounterparties,
  type StatementTxn,
} from "@/lib/accounting/statement-analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ★ AI อ่านสเตทเมนต์ (gpt-5-mini reasoning + หลายร้อยรายการ) ช้า — ให้ headroom 120s
export const maxDuration = 120;

const BILLS_BUCKET = "bills";
const STATEMENT_PREFIX = "statement";

/**
 * POST /api/accounting/extract-statement  { path, customerId? }
 *   อ่านไฟล์สเตทเมนต์ที่เพิ่งอัปเข้า Storage → AI แยกธุรกรรมขาเข้า/ขาออก
 *   → สรุปรายเดือน + จับคู่คนโอนซ้ำ → คืนผล on-the-fly (Phase 1 ไม่ persist)
 *
 * ความปลอดภัย: ต้องมีสิทธิ์บัญชี (admin/นักบัญชี) + path ต้องอยู่ใต้ `{tenant}/statement/` + สโคปลูกค้า
 * degrade: อ่านไม่ได้/ไม่มี key → { ok:true, transactions:[] } (ผู้ใช้ลองใหม่/คีย์เอง)
 * ★ PDPA: ไม่ log path/เนื้อสเตทเมนต์/ชื่อ/ยอด
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
      path?: unknown;
      customerId?: unknown;
      fileName?: unknown;
    };
    const path = typeof body.path === "string" ? body.path : "";
    const customerId = typeof body.customerId === "string" && body.customerId ? body.customerId : null;
    const fileName = typeof body.fileName === "string" ? body.fileName : "";

    // ★ path ต้องอยู่ใต้โฟลเดอร์ statement ของ tenant นี้เท่านั้น (กันชี้ไฟล์ข้าม tenant/ที่อื่น)
    if (!path.startsWith(`${access.tenantId}/${STATEMENT_PREFIX}/`)) {
      return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });
    }
    // สโคปลูกค้า (admin/lead ผ่าน) — accountant ต้องอยู่ในความดูแล
    if (customerId && !customerInScope(access, customerId)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    // ดาวน์โหลดไฟล์จาก Storage
    const { data: blob, error: dlErr } = await service.storage.from(BILLS_BUCKET).download(path);
    if (dlErr || !blob) {
      return NextResponse.json({ ok: false, error: "download_failed" }, { status: 404 });
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const mime = mimeFromPath(path);
    const kind = classifyUpload(mime, fileName || path);

    // แยกด้วยชนิดไฟล์: รูป/PDF → ส่งตรงเข้า OpenAI · Excel/CSV → แปลงเป็นข้อความก่อน
    let txns: StatementTxn[] = [];
    if (kind === "image" || kind === "pdf") {
      txns = await extractStatementFromFile(buf, mime);
    } else if (kind === "excel") {
      const text = await excelBufferToText(buf);
      txns = await extractStatementFromText(text);
    } else if (kind === "csv") {
      txns = await extractStatementFromText(csvBufferToText(buf));
    } else {
      return NextResponse.json({ ok: false, error: "unsupported" }, { status: 415 });
    }

    const monthly = summarizeByMonth(txns);
    const repeats = findRepeatCounterparties(txns);

    return NextResponse.json({
      ok: true,
      count: txns.length,
      transactions: txns,
      monthly,
      repeats,
    });
  } catch {
    // ไม่ให้ล้ม flow — คืน 200 ว่าง (ผู้ใช้ลองใหม่ได้)
    return NextResponse.json({ ok: true, count: 0, transactions: [], monthly: [], repeats: [] }, { status: 200 });
  }
}
