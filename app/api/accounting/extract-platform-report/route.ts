import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { classifyUpload } from "@/lib/accounting/upload";
import {
  extractPlatformReportFromFile,
  extractPlatformReportFromTextChunks,
} from "@/lib/accounting/platform-report-extract";
import { excelBufferToRows, csvBufferToRows } from "@/lib/accounting/statement-parse";
import { mimeFromPath } from "@/lib/line/bill-extract-worker";
import {
  summarizePlatformReport,
  summarizePlatformReportByMonth,
  type PlatformReportLine,
} from "@/lib/accounting/platform-report-analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// สถาปัตยกรรม timeout/chunking เดียวกับ extract-statement (ดูคอมเมนต์ที่นั่น) — ไฟล์ Excel/CSV ใหญ่
// แบ่งเป็นหลายชุดยิง AI พร้อมกัน (concurrency 8) worst case 3 รอบ × 45s ยังมี margin เหลือจาก 240s
export const maxDuration = 240;

const BILLS_BUCKET = "bills";
const PLATFORM_REPORT_PREFIX = "platform-report";

/**
 * POST /api/accounting/extract-platform-report  { path, customerId? }
 *   อ่านไฟล์รายงานแพลตฟอร์มที่เพิ่งอัปเข้า Storage → AI แยกยอดขาย/ค่าธรรมเนียมแต่ละประเภท
 *   → สรุปกำไรสุทธิ + รายเดือน → คืนผล on-the-fly (ไม่ persist เหมือนฟีเจอร์สเตทเมนต์)
 *
 * ความปลอดภัย: ต้องมีสิทธิ์บัญชี (admin/นักบัญชี) + path ต้องอยู่ใต้ `{tenant}/platform-report/` + สโคปลูกค้า
 * degrade: อ่านไม่ได้/ไม่มี key → { ok:true, lines:[] } (ผู้ใช้ลองใหม่/คีย์เอง)
 * ★ PDPA: ไม่ log path/เนื้อรายงาน/เลขคำสั่งซื้อ/ยอด
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

    // ★ path ต้องอยู่ใต้โฟลเดอร์ platform-report ของ tenant นี้เท่านั้น (กันชี้ไฟล์ข้าม tenant/ที่อื่น)
    if (!path.startsWith(`${access.tenantId}/${PLATFORM_REPORT_PREFIX}/`)) {
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

    // แยกด้วยชนิดไฟล์: รูป/PDF → ส่งตรงเข้า OpenAI ครั้งเดียว · Excel/CSV → แบ่งเป็นชุดแล้วยิง AI หลายชุด
    let lines: PlatformReportLine[] = [];
    let meta: {
      totalRows: number;
      includedRows: number;
      truncated: boolean;
      chunkCount: number;
      failedChunks: number;
    } | null = null;

    if (kind === "image" || kind === "pdf") {
      lines = await extractPlatformReportFromFile(buf, mime);
    } else if (kind === "excel" || kind === "csv") {
      const parsed = kind === "excel" ? await excelBufferToRows(buf) : csvBufferToRows(buf);
      const extracted = await extractPlatformReportFromTextChunks(parsed.chunks);
      lines = extracted.lines;
      meta = {
        totalRows: parsed.totalRows,
        includedRows: parsed.includedRows,
        truncated: parsed.truncated,
        chunkCount: extracted.chunkCount,
        failedChunks: extracted.failedChunks,
      };
    } else {
      return NextResponse.json({ ok: false, error: "unsupported" }, { status: 415 });
    }

    const summary = summarizePlatformReport(lines);
    const monthly = summarizePlatformReportByMonth(lines);

    return NextResponse.json({
      ok: true,
      count: lines.length,
      lines,
      summary,
      monthly,
      meta,
    });
  } catch {
    // ไม่ให้ล้ม flow — คืน 200 ว่าง (ผู้ใช้ลองใหม่ได้)
    return NextResponse.json(
      { ok: true, count: 0, lines: [], summary: null, monthly: [], meta: null },
      { status: 200 }
    );
  }
}
