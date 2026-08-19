/**
 * claude-extract.ts — อ่านเอกสาร (PDF สแกน / รูปถ่าย) ด้วย Claude (ACCT_SCAN_MODEL, default claude-sonnet-5)
 *   ★ ใช้เฉพาะ path "สแกน/รูป" (OCR) — vision ของ Claude แม่นกว่ากับภาพยาก/เอียง/เบลอ
 *   ★ ส่ง PDF เป็น document base64 block, รูปเป็น image block (native — ไม่ตัดเป็นรูปเอง)
 *   ★ degrade ปลอดภัย: ไม่มี ANTHROPIC_API_KEY / อ่านไม่ได้ / parse ไม่ได้ → คืน null (caller คืน [])
 *   ★ AI แกะรายการดิบเท่านั้น — โค้ดฝั่ง caller เป็นคนรวม/นับยอด (แม่นชัวร์)
 *   ★ PDPA: ไม่ log เนื้อไฟล์/base64/ยอด/ชื่อ — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */
import Anthropic from "@anthropic-ai/sdk";

/** โมเดลอ่านสแกน (vision) — ตั้งผ่าน env ปรับได้โดยไม่แก้โค้ด */
const SCAN_MODEL = process.env.ACCT_SCAN_MODEL || "claude-sonnet-5";
const CLAUDE_TIMEOUT_MS = 110_000;
/** เพดาน output — สเตทเมนต์ยาวหลายร้อยรายการ (ไฟล์ใหญ่ถูกตัด chunk มาก่อนแล้วที่ pdf-split) */
const MAX_OUTPUT_TOKENS = 16000;

type ImgMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
function imgMedia(mime: string): ImgMedia {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "image/png";
  if (m.includes("gif")) return "image/gif";
  if (m.includes("webp")) return "image/webp";
  return "image/jpeg";
}

/** ซ่อม JSON: ลูกน้ำคั่นหลักพันในตัวเลข (2,500.00 → 2500.00) — เหมือน *-extract อื่น */
function repairJsonNumbers(s: string): string {
  return s.replace(/(?<=\d),(?=\d)/g, "");
}
function tryParse(slice: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(repairJsonNumbers(slice));
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
/** ดึง JSON object ก้อนแรกที่สมดุลจากข้อความ (เผื่อโมเดลห่อ ```json / มีข้อความปน) */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const lastEnd = text.lastIndexOf("}");
  if (lastEnd > start) {
    const p = tryParse(text.slice(start, lastEnd + 1));
    if (p) return p;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return tryParse(text.slice(start, i + 1));
    }
  }
  return null;
}

/**
 * อ่านไฟล์ด้วย Claude → คืน JSON object ที่ parse แล้ว (เช่น {transactions:[...]} หรือ {lines:[...]})
 *   caller เป็นคน normalize เอง (ใช้ normalizeStatementExtraction / normalizePlatformExtraction เดิม)
 *   คืน null = ล้มเหลว (ไม่มี key / error / parse ไม่ได้) → caller ตัดสินใจ fallback หรือคืน []
 */
export async function extractJsonWithClaude(opts: {
  system: string;
  userPrompt: string;
  fileData: Buffer;
  mime: string;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const isPdf = (opts.mime || "").toLowerCase().includes("pdf");
  const b64 = opts.fileData.toString("base64");
  const fileBlock = isPdf
    ? {
        type: "document" as const,
        source: { type: "base64" as const, media_type: "application/pdf" as const, data: b64 },
      }
    : {
        type: "image" as const,
        source: { type: "base64" as const, media_type: imgMedia(opts.mime), data: b64 },
      };
  const content = [fileBlock, { type: "text" as const, text: opts.userPrompt }];

  const client = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? CLAUDE_TIMEOUT_MS });
  try {
    const msg = await client.messages.create({
      model: SCAN_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: opts.system,
      messages: [{ role: "user", content }],
    });
    const text = (msg.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (!text) return null;
    return extractJson(text);
  } catch {
    console.warn("[claude-extract] error");
    return null;
  }
}
