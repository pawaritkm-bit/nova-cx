/**
 * auto-read.ts — orchestrator อ่านไฟล์ sale OA อัตโนมัติ แล้ว save ผลกลับ OneDrive
 *   ★ ทำงานเฉพาะเมื่อ env ACCT_AUTO_READ === 'on' (default ปิด — deploy แบบ dormant จนกว่าจะเทสต์ของจริง)
 *   ★ best-effort ทั้งหมด: ไม่ throw · ล้มเหลว → เงียบ (ไฟล์ยังอยู่ OneDrive/Supabase ให้นักบัญชีอ่านมือได้)
 *
 * flow (เฉพาะ path LINE — กระดาษที่เซลสแกนไม่ผ่านทางนี้):
 *   [ติดรหัส? → ดึงรหัสจากแชท → ลองปลด] → [gpt-5-mini จัดประเภท] → [อ่าน: digital→gpt-5-mini / scan→Sonnet5] → [save CSV → OneDrive]
 * ★ PDPA: ไม่ log รหัส/เนื้อไฟล์/ยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDocSource } from "@/lib/accounting/doc-source";
import { saveRawCsvToOneDrive, saveResultCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { isPdfEncrypted, readPdfPlainText, unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { extractPlatformReportFromFile, extractPlatformReportFromText, extractPlatformReportFromTextChunks } from "@/lib/accounting/platform-report-extract";
import { extractStatementFromFile, extractStatementFromText, extractStatementFromTextChunks } from "@/lib/accounting/statement-extract";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";
import { buildStatementSummaryCsv } from "@/lib/accounting/statement-summary-csv";
import { excelBufferToRows, csvBufferToRows } from "@/lib/accounting/statement-parse";
import { lockedNoteFileName, buildLockedNoteContent } from "@/lib/accounting/locked-note";
import { sanitizeDocName, shopNameFromFilename } from "@/lib/accounting/doc-naming";
import { classifyDocTypeFromImage, classifyDocTypeFromText } from "@/lib/ai/classify-doc";
import { decryptField } from "@/lib/crypto/field";
import { isOneDriveEnabled, renameOneDriveFile } from "@/lib/storage/onedrive";
import { resolveSaleFolder, type MirrorGroupContext } from "@/lib/line/onedrive-mirror";

const MAX_PASSWORD_CANDIDATES = 40;

/** เครื่องหมาย "อ่านแล้ว" นำหน้าชื่อไฟล์ต้นฉบับใน OneDrive (ให้นักบัญชีเห็นทันทีว่าระบบอ่านแล้ว) */
const READ_MARK = "✅ ";

/** ติด ✅ ที่ไฟล์ต้นฉบับใน OneDrive = "อ่านแล้ว" (best-effort · กันติดซ้ำ) */
async function markSourceRead(folderParts: string[], fileName: string): Promise<void> {
  if (!fileName || fileName.startsWith(READ_MARK)) return;
  try {
    await renameOneDriveFile({ folderParts, fileName, newName: READ_MARK + fileName });
  } catch {
    /* best-effort — ผลอ่านถูก save แล้ว การติดธงพลาดไม่ใช่เรื่องคอขาดบาดตาย */
  }
}

/** ดึงข้อความล่าสุดในแชทกลุ่มนี้ (decrypt) → รวมเป็นรายการรหัสผู้สมัคร (ทั้งข้อความเต็ม + token) */
async function gatherChatPasswords(db: SupabaseClient, chatGroupId: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const v = s.trim();
    if (v && v.length <= 64 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  try {
    const { data } = await db
      .from("chat_messages")
      .select("content_enc")
      .eq("chat_group_id", chatGroupId)
      .eq("message_type", "text")
      .order("sent_at", { ascending: false })
      .limit(15);
    for (const row of (data as { content_enc: string | null }[] | null) ?? []) {
      if (!row.content_enc || out.length >= MAX_PASSWORD_CANDIDATES) continue;
      let text = "";
      try {
        text = decryptField(row.content_enc);
      } catch {
        continue;
      }
      add(text); // ข้อความเต็ม (เผื่อรหัสคือทั้งข้อความ)
      for (const tok of text.split(/\s+/)) add(tok); // แต่ละ token (เผื่อ "รหัส 12345")
    }
  } catch {
    /* best-effort */
  }
  return out.slice(0, MAX_PASSWORD_CANDIDATES);
}

/** map StatementTxn/PlatformReportLine → rows/headers สำหรับ CSV */
function statementCsv(txns: Record<string, unknown>[]) {
  return {
    headers: [
      { key: "date", label: "วันที่" },
      { key: "description", label: "รายละเอียด" },
      { key: "counterparty_name", label: "คู่ค้า" },
      { key: "direction", label: "ทิศทาง(in/out)" },
      { key: "amount", label: "จำนวนเงิน" },
    ],
    rows: txns,
  };
}
function platformCsv(lines: Record<string, unknown>[]) {
  return {
    headers: [
      { key: "date", label: "วันที่" },
      { key: "order_no", label: "เลขคำสั่งซื้อ" },
      { key: "description", label: "รายละเอียด" },
      { key: "category", label: "หมวด" },
      { key: "direction", label: "ทิศทาง" },
      { key: "amount", label: "จำนวนเงิน" },
    ],
    rows: lines,
  };
}

/**
 * อ่านไฟล์ sale OA อัตโนมัติ + save ผลกลับ OneDrive — เรียกจาก attachments worker (best-effort)
 */
export async function autoReadSaleAttachment(params: {
  db: SupabaseClient;
  chatGroupId: string;
  group: MirrorGroupContext;
  month: string;
  fileName: string;
  /** ชื่อไฟล์เดิมจากลูกค้า (มีชื่อร้าน/ไทย) — ใช้ตั้งชื่อเอกสารรายงานแพลตฟอร์ม */
  originalName?: string | null;
  mime: string;
  data: Buffer;
}): Promise<void> {
  try {
    if (process.env.ACCT_AUTO_READ !== "on") return; // gate: ปิดไว้จนกว่าจะเทสต์ของจริง
    const { group } = params;
    if (!group) return;
    if ((group.chat_channels?.oa_type || "") !== "sale") return;
    if (!isOneDriveEnabled()) return; // ต้องมี OneDrive ไว้เก็บผล

    const mimeL = (params.mime || "").toLowerCase();
    const nameL = (params.fileName || "").toLowerCase();
    const isPdf = mimeL.includes("pdf") || nameL.endsWith(".pdf");
    const isExcel =
      mimeL.includes("spreadsheetml") || mimeL.includes("ms-excel") || mimeL.includes("excel") ||
      nameL.endsWith(".xlsx") || nameL.endsWith(".xls");
    const isCsv = mimeL.includes("csv") || nameL.endsWith(".csv");

    const folder = await resolveSaleFolder(group);
    const base = params.fileName.replace(/\.[^.]+$/, "");
    const folderParts = [folder]; // เก็บในโฟลเดอร์ลูกค้าตรง ๆ (ไม่ซ้อนโฟลเดอร์เดือน)

    // 1) ดึง "ข้อความ" ของไฟล์ตามชนิด (Excel/CSV/PDF) + เก็บ chunks ไว้ให้ AI ถ้าต้องใช้ fallback
    let text: string | null = null;
    let chunks: string[] | null = null;
    let source: "excel_csv" | "digital_pdf" | "scan_or_image" | "unknown" = "unknown";

    if (isExcel) {
      try { const r = await excelBufferToRows(params.data); chunks = r.chunks; text = r.chunks.join("\n"); } catch { /* best-effort */ }
      source = "excel_csv";
    } else if (isCsv) {
      try { const r = csvBufferToRows(params.data); chunks = r.chunks; text = r.chunks.join("\n"); } catch { /* best-effort */ }
      source = "excel_csv";
    } else if (isPdf) {
      if (await isPdfEncrypted(params.data)) {
        // ติดรหัส → ลองรหัสจากแชท · ปลดไม่ได้ (ลูกค้าไม่ได้ส่งรหัส) → วางโน้ตเตือนให้นักบัญชีขอรหัส
        const pws = await gatherChatPasswords(params.db, params.chatGroupId);
        const unlocked = await unlockPdfToText(params.data, pws);
        if (!unlocked) {
          // วางไฟล์โน้ตให้นักบัญชีพิมพ์รหัส → cron `retry-locked` จะอ่านให้อัตโนมัติภายหลัง
          await saveRawCsvToOneDrive({
            folderParts,
            fileName: lockedNoteFileName(base),
            csv: buildLockedNoteContent(params.fileName),
          });
          return;
        }
        text = unlocked.text;
        source = "digital_pdf";
      } else {
        const src = await classifyDocSource(params.mime, params.data);
        source = src === "scan_or_image" ? "scan_or_image" : "digital_pdf";
        if (source === "digital_pdf") text = await readPdfPlainText(params.data);
      }
    } else {
      const src = await classifyDocSource(params.mime, params.data);
      source = src === "scan_or_image" ? "scan_or_image" : src === "digital_pdf" ? "digital_pdf" : "excel_csv";
    }

    // 2) ★ ทางหลัก: ลอง parser สเตทเมนต์ (deterministic) กับ text ใด ๆ ที่ได้มา
    //    reconcile ผ่าน = เป็นสเตทเมนต์ธนาคารจริง 100% → save สรุป (ฟรี/เร็ว ไม่ต้องพึ่ง AI จัดประเภท)
    if (text) {
      const det = parseStatementDeterministic(text);
      if (det.fullyReconciled) {
        const csv = buildStatementSummaryCsv(det.transactions, det.bank);
        // ชื่อเอกสาร = ชื่อบัญชีจริงจากหัวสเตทเมนต์ (fallback ชื่อไฟล์เดิมถ้าอ่านชื่อไม่ได้)
        const docBase = det.accountName ? sanitizeDocName(det.accountName) : base;
        await saveRawCsvToOneDrive({ folderParts, fileName: `${docBase} - สรุป.csv`, csv });
        await markSourceRead(folderParts, params.fileName); // ✅ อ่านแล้ว
        return;
      }
    }

    // 3) ไม่ใช่สเตทเมนต์ที่ reconcile ได้ → จัดประเภท statement/platform/other แล้วอ่านด้วย AI
    let docType: "statement" | "platform" | "other";
    if (text) docType = await classifyDocTypeFromText(text);
    else if (source === "scan_or_image") docType = await classifyDocTypeFromImage(params.data, params.mime);
    else docType = "other";
    if (docType === "other") return;

    // 4) อ่านด้วย AI ตามชนิด + save (chunks ถ้ามี = ไฟล์ Excel/CSV ยาว → ยิงเป็นชุด)
    if (docType === "statement") {
      const txns = chunks
        ? (await extractStatementFromTextChunks(chunks)).txns
        : text
          ? await extractStatementFromText(text)
          : await extractStatementFromFile(params.data, params.mime);
      const result = statementCsv(txns as unknown as Record<string, unknown>[]);
      if (result.rows.length === 0) return;
      await saveResultCsvToOneDrive({ folderParts, fileName: `${base}-ผลอ่าน-statement.csv`, headers: result.headers, rows: result.rows });
      await markSourceRead(folderParts, params.fileName); // ✅ อ่านแล้ว
      return;
    }

    // platform report (Shopee/Lazada/TikTok — มักเป็น Excel)
    const lines = chunks
      ? (await extractPlatformReportFromTextChunks(chunks)).lines
      : text
        ? await extractPlatformReportFromText(text)
        : await extractPlatformReportFromFile(params.data, params.mime);
    const result = platformCsv(lines as unknown as Record<string, unknown>[]);
    if (result.rows.length === 0) return;
    // ชื่อเอกสาร = ชื่อร้านจากชื่อไฟล์เดิม (เช่น "เจนเบเกอรี่ 1") · fallback ชื่อไฟล์เดิม
    const shop = shopNameFromFilename(params.originalName);
    const platBase = shop ? sanitizeDocName(shop) : base;
    await saveResultCsvToOneDrive({ folderParts, fileName: `${platBase} - ยอดขาย.csv`, headers: result.headers, rows: result.rows });
    await markSourceRead(folderParts, params.fileName); // ✅ อ่านแล้ว
  } catch {
    console.warn("[auto-read] failed");
  }
}
