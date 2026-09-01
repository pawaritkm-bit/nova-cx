import { NextResponse, type NextRequest } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { classifyUpload } from "@/lib/accounting/upload";
import {
  extractStatementFromFile,
  extractStatementFromText,
  extractStatementFromTextChunks,
} from "@/lib/accounting/statement-extract";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";
import { autoImportReconciledStatement } from "@/lib/accounting/bank-reconciliation";
import { isPdfEncrypted, readPdfPlainText, unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { excelBufferToRows, csvBufferToRows } from "@/lib/accounting/statement-parse";
import { mimeFromPath } from "@/lib/line/bill-extract-worker";
import {
  summarizeByMonth,
  findRepeatCounterparties,
  type StatementTxn,
} from "@/lib/accounting/statement-analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ★★★ 2026-08-12 (แก้บั๊ก A) — ไฟล์ Excel/CSV ใหญ่ตอนนี้แบ่งเป็นหลายชุดยิง AI พร้อมกัน (concurrency 8,
//   ดู MAX_CONCURRENT_CHUNKS ใน statement-extract.ts) แทนที่จะเรียกครั้งเดียวจบ — เพิ่ม headroom จาก 120s
//   เป็น 240s (worst case ไฟล์ใหญ่สุด 24 ชุด÷8 = 3 รอบ × timeout ต่อชุด 45s = 135s ยังมี margin เหลือมาก)
export const maxDuration = 300; // เพดาน Vercel Pro — รับ ~8 ชิ้น (~190MB) ต่อไฟล์

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
      password?: unknown;
    };
    const path = typeof body.path === "string" ? body.path : "";
    const customerId = typeof body.customerId === "string" && body.customerId ? body.customerId : null;
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const password = typeof body.password === "string" ? body.password.trim() : "";

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

    // แยกด้วยชนิดไฟล์: รูป/PDF → ส่งตรงเข้า OpenAI ครั้งเดียว · Excel/CSV → แบ่งเป็นชุดแล้วยิง AI หลายชุด (แก้บั๊ก A)
    let txns: StatementTxn[] = [];
    // ชื่อแบงก์/เจ้าของบัญชีจาก deterministic parser (ใช้เลือก/สร้างบัญชีเงินฝากตอนเซฟเข้ากระทบยอด)
    let detBank: string | null = null;
    let detAcctName: string | null = null;
    let meta: {
      totalRows: number;
      includedRows: number;
      truncated: boolean;
      chunkCount: number;
      failedChunks: number;
    } | null = null;

    if (kind === "pdf") {
      // ★ ลองอ่านด้วยโค้ด deterministic ก่อน (ฟรี) — ดึง text จาก PDF · ติดรหัสใช้รหัสที่กรอก
      let text: string | null = null;
      if (await isPdfEncrypted(buf)) {
        if (!password) {
          return NextResponse.json(
            { ok: false, error: "password_required", message: "ไฟล์นี้ติดรหัส กรุณากรอกรหัสผ่าน PDF แล้วกดอ่านอีกครั้ง" },
            { status: 200 }
          );
        }
        const unlocked = await unlockPdfToText(buf, [password]);
        if (!unlocked) {
          return NextResponse.json(
            { ok: false, error: "bad_password", message: "รหัสผ่าน PDF ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่" },
            { status: 200 }
          );
        }
        text = unlocked.text;
      } else {
        text = await readPdfPlainText(buf);
      }
      if (text) {
        const det = parseStatementDeterministic(text);
        detBank = det.bank;
        detAcctName = det.accountName;
        // reconcile ผ่าน = อ่านด้วยโค้ด (ฟรี) · ไม่ผ่าน = fallback AI บน text
        txns = det.fullyReconciled && det.transactions.length > 0 ? det.transactions : await extractStatementFromText(text);
      } else {
        // PDF ไม่มี text (สแกน/รูปเป็น PDF) → AI OCR
        txns = await extractStatementFromFile(buf, mime);
      }
    } else if (kind === "image") {
      txns = await extractStatementFromFile(buf, mime); // สแกน/รูป → AI OCR
    } else if (kind === "excel" || kind === "csv") {
      const parsed = kind === "excel" ? await excelBufferToRows(buf) : csvBufferToRows(buf);
      // ★ ลอง deterministic บน text ก่อน (บางแบงก์ส่ง Excel ที่มีคอลัมน์ยอดคงเหลือ)
      const det = parseStatementDeterministic(parsed.chunks.join("\n"));
      detBank = det.bank;
      detAcctName = det.accountName;
      if (det.fullyReconciled && det.transactions.length > 0) {
        txns = det.transactions;
        meta = { totalRows: parsed.totalRows, includedRows: parsed.includedRows, truncated: parsed.truncated, chunkCount: 0, failedChunks: 0 };
      } else {
        const extracted = await extractStatementFromTextChunks(parsed.chunks);
        txns = extracted.txns;
        meta = {
          totalRows: parsed.totalRows,
          includedRows: parsed.includedRows,
          truncated: parsed.truncated,
          chunkCount: extracted.chunkCount,
          failedChunks: extracted.failedChunks,
        };
      }
    } else {
      return NextResponse.json({ ok: false, error: "unsupported" }, { status: 415 });
    }

    const monthly = summarizeByMonth(txns);
    const repeats = findRepeatCounterparties(txns);

    // ★ 2026-09-01 — อ่านเสร็จเซฟเข้า "กระทบยอดธนาคาร" อัตโนมัติ (best-effort · dedup ด้วยชื่อไฟล์
    //   ใน autoImportReconciledStatement → อัปไฟล์เดิมซ้ำไม่เกิดรายการซ้ำ) — ต้องรู้ลูกค้าเท่านั้นถึงเซฟ
    let recon: { imported: boolean; lineCount?: number; reason?: string } | null = null;
    if (customerId && txns.length > 0) {
      try {
        recon = await autoImportReconciledStatement(service, {
          tenantId: access.tenantId,
          customerId,
          bank: detBank,
          accountName: detAcctName,
          transactions: txns,
          sourceFileName: (fileName || path.split("/").pop() || "").slice(0, 200) || null,
        });
      } catch {
        recon = { imported: false, reason: "error" }; // เงียบ — ผลอ่านยังใช้ได้ตามปกติ
      }
    }

    return NextResponse.json({
      ok: true,
      count: txns.length,
      transactions: txns,
      monthly,
      repeats,
      meta,
      recon,
    });
  } catch {
    // ไม่ให้ล้ม flow — คืน 200 ว่าง (ผู้ใช้ลองใหม่ได้)
    return NextResponse.json({ ok: true, count: 0, transactions: [], monthly: [], repeats: [], meta: null }, { status: 200 });
  }
}
