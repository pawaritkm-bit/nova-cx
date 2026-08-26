/**
 * Platform report extractor — AI แยกรายการรายงานสรุปยอดขาย/settlement จากแพลตฟอร์มขายของ
 *   (Shopee/Lazada/TikTok Shop/เดลิเวอรี่ ฯลฯ) ด้วย OpenAI — สำหรับข้อ C
 *   "แยกค่าใช้จ่ายต่างๆของแพลตฟอร์ม และยอดขายออกจากกัน ให้เหลือกำไรจริง"
 *
 * รับข้อความที่แปลงจาก Excel/CSV แล้ว (ดู statement-parse.ts::excelBufferToRows/csvBufferToRows —
 *   ใช้ตัวเดียวกัน ไม่มีอะไรเฉพาะสเตทเมนต์ธนาคาร) หรือไฟล์ PDF/รูป (ส่งตรงเข้า OpenAI)
 *   → คืนลิสต์รายการ { date, order_no, description, category, direction, amount }
 *
 * ★ สถาปัตยกรรมเดียวกับ statement-extract.ts ทั้งหมด (chunking + bounded concurrency + timeout สองระดับ
 *   + แยก "อ่านแล้วไม่มีรายการ" ออกจาก "เรียก AI ไม่สำเร็จ") — ต่างกันแค่ schema/prompt เพราะโดเมนคนละแบบ
 *   (บัตรผ่านสเตทเมนต์เป็นเงินเข้า-ออก ส่วนรายงานแพลตฟอร์มเป็นยอดขาย-ค่าธรรมเนียมหลายประเภท)
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY / อ่านไม่ได้ → คืน [] (ให้ผู้ใช้ลองใหม่)
 * ★ PDPA: ไม่ log เนื้อรายงาน/เลขคำสั่งซื้อ/ยอด — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */

import { classifyDocSource } from "@/lib/accounting/doc-source";
import { downscaleImageIfLarge } from "@/lib/accounting/image-prep";
import { extractPdfMaybeSplit } from "@/lib/accounting/pdf-split";
import { extractJson } from "@/lib/accounting/statement-extract";
import type { PlatformCategory, PlatformLineDirection, PlatformReportLine } from "@/lib/accounting/platform-report-analyze";
import { extractJsonWithClaude } from "@/lib/ai/claude-extract";
import { extractJsonWithGemini } from "@/lib/ai/gemini-extract";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/** โมเดลอ่านรายงาน (PDF/ตารางยาว) — ใช้ตัวเดียวกับอ่านสเตทเมนต์/บิล */
const EXTRACT_MODEL = process.env.ACCT_DIGITAL_MODEL || process.env.OPENAI_EXTRACT_MODEL || "gpt-5-mini";
const ECONOMY_MODEL = process.env.ACCT_ECONOMY_MODEL || "gemini-2.5-flash-lite";

/** timeout — เรียกครั้งเดียวจบ (PDF/รูป, ไม่ chunk) */
const EXTRACT_TIMEOUT_MS = 110_000;
/** timeout ต่อ "ชุด" เมื่อยิง AI หลายชุดพร้อมกัน (เหตุผลเดียวกับ statement-extract.ts) */
const CHUNK_EXTRACT_TIMEOUT_MS = 45_000;

/** cap จำนวนรายการต่อการเรียก AI 1 ครั้ง (ทำงานต่อ "ชุด" ไม่ใช่ต่อไฟล์) */
const MAX_LINES = 2000;

/** โมเดลตระกูล reasoning (gpt-5 หรือ o-series) — ใช้ max_completion_tokens + ห้ามส่ง temperature */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
};

const CATEGORY_VALUES: PlatformCategory[] = [
  "sales",
  "commission_fee",
  "payment_fee",
  "shipping_fee",
  "ads_fee",
  "penalty",
  "refund",
  "other",
];

const SYSTEM_PROMPT =
  "คุณเป็นผู้ช่วยบัญชีที่อ่าน 'รายงานสรุปยอดขาย/settlement report จากแพลตฟอร์มขายของ' " +
  "(เช่น Shopee, Lazada, TikTok Shop, Grab, LINE MAN, foodpanda และแพลตฟอร์มอื่น ๆ) แล้วสกัดทุกรายการออกมาเป็น JSON. " +
  "ตอบเป็น JSON เท่านั้น รูปแบบ {\"lines\":[ {date, order_no, description, category, direction, amount}, ... ]}. " +
  "category ต้องเป็นหนึ่งใน: " +
  "'sales' (ยอดขายสินค้า/รายรับจากออเดอร์นั้น), " +
  "'commission_fee' (ค่าคอมมิชชั่นที่แพลตฟอร์มหัก), " +
  "'payment_fee' (ค่าธรรมเนียมการรับเงิน/payment gateway/transaction fee), " +
  "'shipping_fee' (ค่าส่ง/ค่าขนส่งที่แพลตฟอร์มหักออกจากผู้ขาย), " +
  "'ads_fee' (ค่าโฆษณา/ค่าโปรโมทสินค้าบนแพลตฟอร์ม), " +
  "'penalty' (ค่าปรับ/เงินหักจากการทำผิดเงื่อนไขแพลตฟอร์ม), " +
  "'refund' (เงินคืนลูกค้า/ยกเลิกออเดอร์ที่กระทบยอดผู้ขาย), " +
  "'other' (รายการอื่นที่ไม่เข้าเงื่อนไขข้างต้น เช่นส่วนลดที่แพลตฟอร์มออกให้ฝ่ายเดียว/เงินปรับปรุงยอดอื่น ๆ). " +
  "direction ต้องเป็นหนึ่งใน 'credit'|'deduct': " +
  "'credit' = เงินที่ผู้ขายควรได้รับ/เพิ่มยอด (ปกติคือ category='sales' และเงินปรับปรุงเพิ่มอื่น ๆ). " +
  "'deduct' = เงินที่ถูกหักออกจากยอดที่ผู้ขายจะได้รับ (ค่าธรรมเนียมทุกประเภท ค่าปรับ เงินคืนลูกค้า). " +
  "amount = จำนวนเงินของรายการนั้น เป็นเลขบวกเสมอ (ห้ามใส่เครื่องหมายลบ — ทิศทางอยู่ที่ direction แล้ว) " +
  "ห้ามมีลูกน้ำคั่นหลักพัน (12500.00 ไม่ใช่ 12,500.00). " +
  "order_no = เลขที่คำสั่งซื้อ/เลขอ้างอิงรายการ ถ้ามี. อ่านไม่ได้/ไม่มี → null. " +
  "date รูปแบบ 'YYYY-MM-DD' (ค.ศ.). ปีในรายงานอาจเป็น พ.ศ.: ถ้าปี >= 2500 ให้ลบ 543 เป็น ค.ศ. " +
  "ปีที่เป็น ค.ศ. อยู่แล้วห้ามลบ 543. อ่านวันที่ไม่ได้ → null. " +
  "description = คำอธิบายรายการตามที่เห็น. อ่านไม่ออก → null. " +
  "สกัด 'ทุกแถวรายการ' ตามลำดับที่ปรากฏ ห้ามข้าม ห้ามรวมยอด. ถ้าแถวไม่ใช่รายการจริง (หัวตาราง/ยอดรวม/สรุปท้ายรายงาน) ให้ข้าม.";

const FILE_USER_PROMPT =
  "อ่านรายงานสรุปยอดขาย/settlement จากแพลตฟอร์มในเอกสารนี้ แล้วสกัดทุกรายการเป็น JSON {\"lines\":[...]} ตามกฎ. " +
  "จำไว้: category/direction ต้องถูก, amount เป็นเลขบวกของรายการนั้น, ไม่มีลูกน้ำคั่นพัน.";

const TEXT_USER_PROMPT =
  "ด้านล่างคือข้อมูลรายงานสรุปยอดขาย/settlement จากแพลตฟอร์มที่ถูกแปลงเป็นข้อความ/ตาราง (มาจากไฟล์ Excel/CSV). " +
  "อ่านแล้วสกัดทุกรายการเป็น JSON {\"lines\":[...]} ตามกฎ. " +
  "จำไว้: category/direction ต้องถูก, amount เป็นเลขบวกของรายการนั้น, ไม่มีลูกน้ำคั่นพัน.\n\n";

/** ปี พ.ศ.→ค.ศ. (กันพลาด deterministic) — ปี >= 2500 ให้ลบ 543 */
function fixBuddhistYear(d: string | null): string | null {
  if (!d) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const y = parseInt(m[1], 10);
  return y >= 2500 ? `${y - 543}-${m[2]}-${m[3]}` : d;
}

/** อ่านเลขจากค่า unknown (รองรับ string มีลูกน้ำ) → คืนค่าสัมบูรณ์ (บวก) หรือ null */
function toAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const a = Math.abs(n);
  return a > 0 ? a : null;
}

/** string ที่ trim แล้วไม่ว่าง หรือ null */
function toText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** map ค่า category ดิบ → ค่าที่รู้จัก หรือ null (ไม่เดา — ให้ normalize ชั้นวิเคราะห์ fallback เป็น 'other' เอง) */
function toCategory(v: unknown): PlatformCategory | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CATEGORY_VALUES as string[]).includes(s) ? (s as PlatformCategory) : null;
}

/** map ค่า direction ดิบ (credit/deduct/in/out/…) → 'credit'|'deduct'|null */
function toDirection(v: unknown, category: PlatformCategory | null): PlatformLineDirection | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["credit", "in", "เข้า", "เพิ่ม"].includes(s)) return "credit";
  if (["deduct", "out", "ออก", "หัก", "debit"].includes(s)) return "deduct";
  // fallback: เดาจาก category เมื่อโมเดลลืมใส่ direction (sales → credit, อื่น ๆ → deduct)
  if (category === "sales") return "credit";
  if (category) return "deduct";
  return null;
}

/**
 * normalize ผลดิบจากโมเดล → PlatformReportLine[] (แยกออกมาให้ทดสอบ logic ได้โดยไม่ยิง API)
 *   - รับได้ทั้ง { lines:[...] } และ array ตรง ๆ
 *   - ข้ามแถวที่ไม่มีทั้งวันที่ ยอด และคำอธิบาย/เลขคำสั่งซื้อ (แถวขยะ)
 */
export function normalizePlatformExtraction(raw: Record<string, unknown> | unknown[] | null): PlatformReportLine[] {
  if (!raw) return [];
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { lines?: unknown }).lines)
      ? ((raw as { lines: unknown[] }).lines)
      : Array.isArray((raw as { transactions?: unknown }).transactions)
        ? ((raw as { transactions: unknown[] }).transactions)
        : [];

  const out: PlatformReportLine[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const date = fixBuddhistYear(toText(o.date));
    const order_no = toText(o.order_no ?? o.orderNo ?? o.order_id ?? o.reference);
    const description = toText(o.description ?? o.memo ?? o.detail);
    const category = toCategory(o.category ?? o.type);
    const amount = toAmount(o.amount);
    const direction = toDirection(o.direction, category);

    // ข้ามแถวว่างจริง (ไม่มีวันที่ ไม่มียอด ไม่มีคำอธิบาย ไม่มีเลขคำสั่งซื้อ) — น่าจะเป็นหัว/สรุป
    if (!date && amount === null && !description && !order_no) continue;

    out.push({ date, order_no, description, category, direction, amount });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** ผลจาก callExtract — แยก "อ่านแล้วไม่มีรายการ" ออกจาก "เรียก AI ไม่สำเร็จ" (เหมือน statement-extract.ts) */
type ExtractCallResult = { lines: PlatformReportLine[]; failed: boolean };

/** เรียก OpenAI ด้วย message content ที่ประกอบไว้แล้ว → คืน { lines, failed } */
async function callExtract(userContent: unknown, timeoutMs: number = EXTRACT_TIMEOUT_MS): Promise<ExtractCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { lines: [], failed: true };

  const model = EXTRACT_MODEL;
  const reasoning = isReasoningModel(model);
  const reqBody: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  if (reasoning) {
    reqBody.max_completion_tokens = 32000;
  } else {
    reqBody.temperature = 0;
    reqBody.max_tokens = 16000;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[platform-report-extract] openai http ${res.status}`);
      return { lines: [], failed: true };
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { lines: [], failed: true };
    const parsed = extractJson(content);
    if (parsed === null) {
      console.warn("[platform-report-extract] json parse failed");
      return { lines: [], failed: true };
    }
    return { lines: normalizePlatformExtraction(parsed), failed: false };
  } catch {
    console.warn("[platform-report-extract] extract error");
    return { lines: [], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * สกัดรายการจากไฟล์ PDF/รูป — PDF ใหญ่เกินเพดานจะถูกตัดเป็นชิ้นอ่านทีละชิ้นแล้วรวมผลอัตโนมัติ
 *   @returns PlatformReportLine[] · [] เมื่อ error/timeout/ไม่มี key
 */
export async function extractPlatformReportFromFile(fileData: Buffer, mime: string): Promise<PlatformReportLine[]> {
  return extractPdfMaybeSplit(fileData, mime, extractPlatformReportFromFileSingle);
}

/** เรียก AI ครั้งเดียว (ไฟล์/ชิ้นเดียว ≤เพดาน) */
async function extractPlatformReportFromFileSingle(fileData: Buffer, mime: string): Promise<PlatformReportLine[]> {
  const source = await classifyDocSource(mime, fileData);
  const prepped = await downscaleImageIfLarge(fileData, mime); // ย่อรูปสแกนใหญ่ (PDF ไม่แตะ)

  // ด่านแรก: โมเดลราคาประหยัด + quality gate
  const gem = await extractJsonWithGemini({
    source: "platform_report_extract_economy",
    model: ECONOMY_MODEL,
    system: SYSTEM_PROMPT,
    userPrompt: FILE_USER_PROMPT,
    fileData: prepped.data,
    mime: prepped.mime || mime,
  });
  const economyLines = normalizePlatformExtraction(gem);
  if (isUsablePlatformExtraction(economyLines)) return economyLines;

  // ด่านสองเฉพาะภาพสแกนยาก: Claude
  if (source === "scan_or_image") {
    const raw = await extractJsonWithClaude({
      source: "platform_report_extract_fallback",
      system: SYSTEM_PROMPT,
      userPrompt: FILE_USER_PROMPT,
      fileData: prepped.data,
      mime: prepped.mime || mime,
    });
    const claudeLines = normalizePlatformExtraction(raw);
    if (claudeLines.length > 0) return claudeLines;
  }

  // สุดท้าย: OpenAI (เฉพาะเมื่อยังตั้ง OPENAI_API_KEY — prod ปกติไม่ตั้ง = ข้าม)
  const isPdf = (mime || "").toLowerCase().includes("pdf");
  const dataUrl = `data:${prepped.mime || "image/jpeg"};base64,${prepped.data.toString("base64")}`;
  const filePart = isPdf
    ? { type: "file", file: { filename: "platform-report.pdf", file_data: dataUrl } }
    : { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
  const { lines } = await callExtract([{ type: "text", text: FILE_USER_PROMPT }, filePart]);
  return lines;
}

/**
 * สกัดรายการจากข้อความก้อนเดียว (แปลงมาจาก Excel/CSV แล้ว) — เรียกครั้งเดียวจบ (ไม่ chunk)
 *   @returns PlatformReportLine[] · [] เมื่อ error/timeout/ไม่มี key/ข้อความว่าง
 */
/** อ่านข้อความ: Gemini ก่อน (ถูก + ไม่พึ่ง OpenAI) · ล้ม → OpenAI เป็นทางเลือกสุดท้าย */
async function extractTextPreferGemini(userText: string, timeoutMs?: number): Promise<ExtractCallResult> {
  const gem = await extractJsonWithGemini({ source: "platform_report_extract_economy", model: ECONOMY_MODEL, system: SYSTEM_PROMPT, userPrompt: TEXT_USER_PROMPT, text: userText, timeoutMs });
  if (gem !== null) return { lines: normalizePlatformExtraction(gem), failed: false };
  return callExtract(TEXT_USER_PROMPT + userText, timeoutMs);
}

export function isUsablePlatformExtraction(lines: PlatformReportLine[]): boolean {
  if (lines.length === 0) return false;
  const complete = lines.filter((line) => Boolean(line.date) && line.amount !== null && Boolean(line.direction)).length;
  return complete / lines.length >= 0.75;
}

export async function extractPlatformReportFromText(text: string): Promise<PlatformReportLine[]> {
  const t = (text ?? "").trim();
  if (!t) return [];
  const { lines } = await extractTextPreferGemini(t);
  return lines;
}

/** จำนวนชุดที่ยิง AI พร้อมกันสูงสุด (เหตุผลเดียวกับ statement-extract.ts) */
const MAX_CONCURRENT_CHUNKS = 8;

/** รันงานแบบ concurrency-bounded (worker pool ง่าย ๆ) — คืนผลลัพธ์เรียงตามลำดับ input เดิม */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** ผลรวมจากการสกัดหลายชุด */
export type ChunkedPlatformExtractionResult = {
  lines: PlatformReportLine[];
  /** จำนวนชุดทั้งหมดที่พยายามอ่าน */
  chunkCount: number;
  /** จำนวนชุดที่อ่านไม่สำเร็จ (error/timeout/parse ไม่ได้ — ไม่ใช่ "ชุดนี้ไม่มีรายการจริง ๆ") */
  failedChunks: number;
};

/**
 * สกัดรายการจากข้อความที่แบ่งเป็นหลายชุดแล้ว (ดู `statement-parse.ts::excelBufferToRows/csvBufferToRows`
 *   — ใช้ตัวเดียวกันกับสเตทเมนต์ธนาคาร ไม่มีอะไรเฉพาะโดเมนนี้) — ยิง AI พร้อมกันสูงสุด MAX_CONCURRENT_CHUNKS
 *   ชุด แล้วรวมผลลัพธ์ + นับจำนวนชุดที่ล้มเหลวไว้รายงานผู้ใช้
 */
export async function extractPlatformReportFromTextChunks(chunks: string[]): Promise<ChunkedPlatformExtractionResult> {
  if (chunks.length === 0) return { lines: [], chunkCount: 0, failedChunks: 0 };
  const perChunk = await mapWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunkText) => {
    return extractTextPreferGemini(chunkText, CHUNK_EXTRACT_TIMEOUT_MS);
  });
  const lines = perChunk.flatMap((r) => r.lines);
  const failedChunks = perChunk.filter((r) => r.failed).length;
  return { lines, chunkCount: chunks.length, failedChunks };
}
