/**
 * gemini-extract.ts — อ่านเอกสาร (PDF/รูป/ข้อความ) ด้วย Gemini → คืน JSON object ที่ parse แล้ว
 *   ★ interface เดียวกับ claude-extract.ts (drop-in) — caller normalize เองด้วยตัว normalize เดิม
 *   ★ ใช้แทน gpt-5-mini ในงานอ่านสเตทเมนต์/รายงานแพลตฟอร์ม (ถูกกว่า + ไม่พึ่ง OpenAI)
 *   ★ รองรับทั้งไฟล์ (fileData+mime: PDF/รูป) และข้อความ (text: จาก Excel/CSV)
 *   ★ degrade ปลอดภัย: ไม่มี GEMINI_API_KEY / error / parse ไม่ได้ → null (caller fallback/คืน [])
 *   ★ retry+backoff เฉพาะ error ชั่วคราว (429 rate limit / 5xx) — เหมือน bill-extract
 *   ★ PDPA: ไม่ log เนื้อไฟล์/base64/ยอด/ชื่อ — log แค่ error สั้น ๆ
 */

import { logAiUsage, reserveAiCall } from "@/lib/ai/usage-budget";

/** โมเดลอ่านของ Gemini — ใช้ตัวเดียวกับ vision หลัก (ตั้งผ่าน env) */
const GEMINI_MODEL = process.env.ACCT_VISION_MODEL || "gemini-3.6-flash";
const GEMINI_TIMEOUT_MS = 110_000;
/** เพดาน output — สเตทเมนต์ยาวหลายร้อยรายการ (ไฟล์ใหญ่ถูกตัด chunk มาก่อนแล้ว) */
const MAX_OUTPUT_TOKENS = 12000;

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** เรียก Gemini → คืน "ข้อความดิบ" ที่โมเดลตอบ (raw) หรือ null · แกนกลางที่ทั้ง JSON/text ใช้ร่วมกัน */
async function callGeminiRaw(opts: {
  system: string;
  userPrompt: string;
  fileData?: Buffer;
  mime?: string;
  text?: string;
  maxOutputTokens?: number;
  model?: string;
  timeoutMs?: number;
  jsonMode?: boolean;
  source?: string;
}): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const combined = `${opts.system}\n\n${opts.userPrompt}${opts.text ? `\n\n${opts.text}` : ""}`;
  const parts: Record<string, unknown>[] = [];
  if (opts.fileData) {
    const m = (opts.mime || "").toLowerCase();
    const media = m.includes("pdf") ? "application/pdf" : m.startsWith("image/") ? (opts.mime as string) : "image/jpeg";
    parts.push({ inline_data: { mime_type: media, data: opts.fileData.toString("base64") } });
  }
  parts.push({ text: combined });

  const model = opts.model || GEMINI_MODEL;
  const source = opts.source || "document_extract";
  if (!reserveAiCall(source, model)) return null;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  };
  // งาน OCR/สกัดข้อมูลไม่ต้องใช้ reasoning ยาว ๆ — ปิด thinking ของ Gemini 2.5
  // เพื่อตัด output/thinking tokens โดยไม่กระทบข้อความที่โมเดลต้องคืน
  if (/gemini-2\.5-flash(?:-lite)?$/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (opts.jsonMode) generationConfig.responseMimeType = "application/json";
  const reqBody = JSON.stringify({ contents: [{ parts }], generationConfig });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;

  const MAX = 2;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: reqBody });
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        const willRetry = transient && attempt < MAX - 1;
        console.warn(`[gemini-extract] http ${res.status}${willRetry ? " (retry)" : ""}`);
        if (willRetry) { clearTimeout(timer); await delay(2000 * (attempt + 1) + Math.floor(Math.random() * 500)); continue; }
        return null;
      }
      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
      };
      await logAiUsage(source, "gemini", model, {
        promptTokens: body.usageMetadata?.promptTokenCount,
        outputTokens: body.usageMetadata?.candidatesTokenCount,
        thinkingTokens: body.usageMetadata?.thoughtsTokenCount,
        totalTokens: body.usageMetadata?.totalTokenCount,
      });
      return body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch {
      console.warn("[gemini-extract] error");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * เรียก Gemini → คืน "ข้อความล้วน" (เช่น จัดประเภทตอบคำเดียว) หรือ null
 *   ใช้กับงานจัดประเภท (classify) ที่ไม่ต้องการ JSON
 */
export async function generateTextWithGemini(opts: {
  system: string;
  userPrompt: string;
  fileData?: Buffer;
  mime?: string;
  text?: string;
  maxOutputTokens?: number;
  model?: string;
  timeoutMs?: number;
  source?: string;
}): Promise<string | null> {
  return callGeminiRaw({ ...opts, maxOutputTokens: opts.maxOutputTokens ?? 2000, jsonMode: false });
}

/**
 * อ่านเอกสารด้วย Gemini → JSON object ที่ parse แล้ว (เช่น {transactions:[...]} / {lines:[...]})
 *   ส่ง fileData+mime (PDF/รูป) หรือ text (Excel/CSV) อย่างใดอย่างหนึ่ง
 *   คืน null = ล้มเหลว → caller ตัดสินใจ fallback หรือคืน []
 */
export async function extractJsonWithGemini(opts: {
  system: string;
  userPrompt: string;
  fileData?: Buffer;
  mime?: string;
  text?: string;
  maxOutputTokens?: number;
  model?: string;
  timeoutMs?: number;
  source?: string;
}): Promise<Record<string, unknown> | null> {
  const text = await callGeminiRaw({ ...opts, jsonMode: true });
  return text ? extractJson(text) : null;
}
