/**
 * classify-finance-doc.ts — จัดประเภทเอกสารการเงินจาก "เนื้อไฟล์" (content-based)
 *   คืนประเภท + โฟลเดอร์ย่อยที่ควรเก็บ + ข้อความ/ผล parse ที่ดึงได้ (reuse ต่อในขั้น summarize)
 *
 * ★ ใช้ที่เดียวเป็น "แหล่งความจริง" ของทั้ง 2 ฝั่ง:
 *   - attachments worker: เอา subFolder ไปวางไฟล์ต้นฉบับในโฟลเดอร์ย่อยให้ถูกชนิด
 *   - auto-read: เอา type/text/det/platform ที่ได้ ไป summarize ต่อ (ไม่ต้องอ่านซ้ำ/จัดประเภทซ้ำ)
 *
 * การจัดประเภท (ตามลำดับ ถูก→แพง):
 *   1) parser สเตทเมนต์ deterministic reconcile ผ่าน → statement (ฟรี ชัวร์ 100%)
 *   2) parser แพลตฟอร์ม (Excel/CSV) ได้ตัวเลข → platform (ฟรี)
 *   3) AI จัดประเภทจาก text/ภาพ → statement | platform | other (fallback)
 *   4) PDF ติดรหัสปลดไม่ได้ (ยังไม่มีรหัส) → locked=true, ถือเป็น statement (เอกสารติดรหัส
 *      ในบริบทนี้แทบทั้งหมดคือสเตทเมนต์) เพื่อวางไฟล์+โน้ตในโฟลเดอร์ "สเตทเมนต์"
 *
 * ★ PDPA: ไม่ log รหัส/เนื้อไฟล์/ยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDocSource } from "@/lib/accounting/doc-source";
import { isPdfEncrypted, readPdfPlainText, unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { parseStatementDeterministic, type DeterministicParseResult } from "@/lib/accounting/statement-deterministic";
import { excelBufferToRows, csvBufferToRows } from "@/lib/accounting/statement-parse";
import { detectPlatformFromName, parsePlatformFile } from "@/lib/accounting/platform/parse";
import { classifyDocTypeFromImage, classifyDocTypeFromText } from "@/lib/ai/classify-doc";
import { decryptField } from "@/lib/crypto/field";

const MAX_PASSWORD_CANDIDATES = 40;

export type FinanceDocType = "statement" | "platform" | "other";

/** ชื่อโฟลเดอร์ย่อยตามชนิดเอกสาร (ในโฟลเดอร์ลูกค้า/กลุ่ม) */
export const TYPE_SUBFOLDER: Record<FinanceDocType, string> = {
  statement: "สเตทเมนต์",
  platform: "รายงานแพลตฟอร์ม",
  other: "บิลอื่นๆ",
};

type PlatformExtract = Awaited<ReturnType<typeof parsePlatformFile>>;

export type FinanceClassification = {
  type: FinanceDocType;
  /** โฟลเดอร์ย่อยที่ควรเก็บไฟล์ (สเตทเมนต์ / รายงานแพลตฟอร์ม / บิลอื่นๆ) */
  subFolder: string;
  /** PDF ติดรหัส + ยังปลดไม่ได้ (ไม่มีรหัสในแชท) — auto-read ต้องวางโน้ตให้นักบัญชีพิมพ์รหัส */
  locked: boolean;
  text: string | null;
  chunks: string[] | null;
  source: "excel_csv" | "digital_pdf" | "scan_or_image" | "unknown";
  /** ผล parser สเตทเมนต์ deterministic (reuse ต่อใน summarize) · null = ไม่มี text */
  det: DeterministicParseResult | null;
  /** ผล parse แพลตฟอร์ม deterministic (reuse) · null = ไม่ใช่ Excel/CSV หรืออ่านไม่ได้ */
  platform: PlatformExtract | null;
  /** รหัสที่ปลดสำเร็จ (ถ้าเป็น PDF ติดรหัส) — ไว้ log/อ้างอิงภายใน ไม่ save */
  unlockedPassword: string | null;
};

/** ดึงข้อความล่าสุดในแชทกลุ่มนี้ (decrypt) → รายการรหัสผู้สมัคร (ข้อความเต็ม + token) */
export async function gatherChatPasswords(db: SupabaseClient, chatGroupId: string): Promise<string[]> {
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
      add(text);
      for (const tok of text.split(/\s+/)) add(tok);
    }
  } catch {
    /* best-effort */
  }
  return out.slice(0, MAX_PASSWORD_CANDIDATES);
}

function done(type: FinanceDocType, rest: Omit<FinanceClassification, "type" | "subFolder">): FinanceClassification {
  return { type, subFolder: TYPE_SUBFOLDER[type], ...rest };
}

/**
 * ดึงข้อความ + จัดประเภทเอกสารการเงินจากเนื้อไฟล์ (เรียกครั้งเดียว ใช้ทั้ง routing + summarize)
 */
export async function extractAndClassify(params: {
  db: SupabaseClient;
  chatGroupId: string;
  fileName: string;
  originalName?: string | null;
  mime: string;
  data: Buffer;
}): Promise<FinanceClassification> {
  const mimeL = (params.mime || "").toLowerCase();
  const nameL = (params.fileName || "").toLowerCase();
  const isPdf = mimeL.includes("pdf") || nameL.endsWith(".pdf");
  const isExcel =
    mimeL.includes("spreadsheetml") || mimeL.includes("ms-excel") || mimeL.includes("excel") ||
    nameL.endsWith(".xlsx") || nameL.endsWith(".xls");
  const isCsv = mimeL.includes("csv") || nameL.endsWith(".csv");

  let text: string | null = null;
  let chunks: string[] | null = null;
  let source: FinanceClassification["source"] = "unknown";
  let locked = false;
  let unlockedPassword: string | null = null;

  // 1) ดึงข้อความตามชนิด (Excel/CSV/PDF) — PDF ติดรหัสลองปลดด้วยรหัสจากแชท
  if (isExcel) {
    try { const r = await excelBufferToRows(params.data); chunks = r.chunks; text = r.chunks.join("\n"); } catch { /* best-effort */ }
    source = "excel_csv";
  } else if (isCsv) {
    try { const r = csvBufferToRows(params.data); chunks = r.chunks; text = r.chunks.join("\n"); } catch { /* best-effort */ }
    source = "excel_csv";
  } else if (isPdf) {
    if (await isPdfEncrypted(params.data)) {
      const pws = await gatherChatPasswords(params.db, params.chatGroupId);
      const unlocked = await unlockPdfToText(params.data, pws);
      if (!unlocked) {
        // ปลดไม่ได้ (ยังไม่มีรหัส) → statement (โฟลเดอร์สเตทเมนต์) + locked ให้ auto-read วางโน้ต
        return done("statement", { locked: true, text: null, chunks: null, source: "digital_pdf", det: null, platform: null, unlockedPassword: null });
      }
      text = unlocked.text;
      unlockedPassword = unlocked.password;
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

  // 2) สเตทเมนต์ deterministic (reconcile ผ่าน = ชัวร์)
  let det: DeterministicParseResult | null = null;
  if (text) {
    det = parseStatementDeterministic(text);
    if (det.fullyReconciled) {
      return done("statement", { locked, text, chunks, source, det, platform: null, unlockedPassword });
    }
  }

  // 3) แพลตฟอร์ม deterministic (Excel/CSV) — ได้ตัวเลขยอดขาย/ค่าธรรมเนียม = รายงานแพลตฟอร์ม
  let platform: PlatformExtract | null = null;
  if (isExcel || isCsv) {
    try {
      const ab = params.data.buffer.slice(params.data.byteOffset, params.data.byteOffset + params.data.byteLength) as ArrayBuffer;
      const plat = detectPlatformFromName(params.originalName || params.fileName);
      platform = await parsePlatformFile(
        { name: params.originalName || params.fileName, ext: isCsv ? "csv" : "xlsx", buffer: ab },
        plat,
      );
      if (platform.figures.grossSales > 0 || platform.figures.platformFee > 0) {
        return done("platform", { locked, text, chunks, source, det, platform, unlockedPassword });
      }
    } catch {
      platform = null;
    }
  }

  // 4) fallback: AI จัดประเภท (text → text classify · สแกน/ภาพ → image classify)
  let aiType: FinanceDocType = "other";
  try {
    if (text) aiType = await classifyDocTypeFromText(text);
    else if (source === "scan_or_image") aiType = await classifyDocTypeFromImage(params.data, params.mime);
  } catch {
    aiType = "other";
  }
  return done(aiType, { locked, text, chunks, source, det, platform, unlockedPassword });
}
