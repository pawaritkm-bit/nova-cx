/**
 * Bill data extractor — สกัดข้อมูลบิล/ใบกำกับจากรูปด้วย OpenAI vision (★ high-confidence only)
 *   สำหรับหน้า "ลงบันทึกบัญชี ภาษีซื้อ/ขาย" — สร้าง draft ให้คนตรวจ/แก้ก่อนยืนยัน
 *
 * ★ กฎหลัก "high-confidence only" (เหมือน keep-if-unsure ของ bill-classify):
 *   - ทุก field ให้โมเดลระบุ confidence · ช่องไหน confidence < FIELD_THRESHOLD (0.8)
 *     → คืน null (เว้นว่าง) ให้คนคีย์ · โดยเฉพาะ "ตัวเลข" (amount/vat) ถ้าไม่ชัด/
 *     เขียนมือ/เบลอ = null · เว้นว่างดีกว่าเดาผิด (ตัวเลขภาษีผิด = ยื่นผิด)
 *   - WHT (หัก ณ ที่จ่าย): อ่าน "เฉพาะที่บิลแสดงชัด" (high-confidence) → wht_rate/wht_amount
 *     ไม่แสดง/ไม่ชัด = null (worker แนะนำอัตราจากประเภทบัญชีให้แทน — เป็นค่าแนะนำ ไม่ล็อก)
 *
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY → คืน null (worker ข้ามการสกัด)
 * ★ PDPA: ไม่ log เนื้อบิล/ผลละเอียด — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */

import {
  type ChartAccount,
  type ChartByCode,
  buildChartByCode,
} from "@/lib/accounting/chart-of-accounts";
import { downscaleImageIfLarge } from "@/lib/accounting/image-prep";
import { extractPdfMaybeSplit } from "@/lib/accounting/pdf-split";
import { isValidThaiTaxIdChecksum, taxIdDigits } from "@/lib/accounting/tax-id";
import { logAiUsage, reserveAiCall } from "@/lib/ai/usage-budget";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * โมเดลสำหรับ "อ่านไฟล์อัปเอง" (extractBillsData — PDF/หลายบิล/ตารางแน่น) — default gpt-4.1
 *   ทดสอบจริง: gpt-4.1 อ่านยอดเงิน/หลายบิลในตารางแม่น (gpt-4o-mini อ่านคอลัมน์ผิด/มั่ว)
 *   ★ บิลไลน์ (รูปใบเดียว) ยังใช้ OPENAI_MODEL/gpt-4o-mini (ประหยัด · ปริมาณมาก) — ดู extractBillData
 *   ★ override ได้ด้วย env OPENAI_EXTRACT_MODEL
 */
const EXTRACT_MODEL = process.env.OPENAI_EXTRACT_MODEL || "gpt-5-mini";

/** timeout ของการอ่านไฟล์อัป (reasoning model ช้ากว่า — ให้เวลามากขึ้น) */
const EXTRACT_TIMEOUT_MS = 110_000;

/** โมเดลตระกูล reasoning (gpt-5 หรือ o-series) — ต้องใช้ max_completion_tokens + ห้ามส่ง temperature */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/** โมเดล vision ของ Gemini (fallback เมื่อไม่มี OPENAI_API_KEY) — paid tier ไม่เทรนข้อมูล */
const GEMINI_VISION_MODEL = process.env.ACCT_VISION_MODEL || "gemini-3.6-flash";
/** โมเดล Claude ที่ใช้ตรวจทาน (cross-check) เฉพาะบิลยาก */
const CLAUDE_VERIFY_MODEL = process.env.ACCT_VERIFY_MODEL || "claude-sonnet-5";
/** เปิด/ปิด escalation (ตั้ง ACCT_ESCALATE=off เพื่อกลับไปอ่าน flash อย่างเดียว) */
const ESCALATE_ON = process.env.ACCT_ESCALATE !== "off";

/**
 * เรียก Gemini vision → คืน "เนื้อ JSON" (string) หรือ null
 *   ★ ใช้ schema/prompt เดียวกับ OpenAI (buildSystemPrompt) → ผ่าน normalizeExtraction เดิมได้เลย
 */
async function geminiExtractContent(
  system: string,
  user: string,
  imageData: Buffer,
  mime: string,
  maxTokens: number,
  timeoutMs: number,
  modelOverride?: string
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = modelOverride || GEMINI_VISION_MODEL;
  if (!reserveAiCall("bill_extract", model)) return null;
  const m = (mime || "").toLowerCase();
  const media = m.includes("pdf") ? "application/pdf" : m.startsWith("image/") ? mime : "image/jpeg";
  const reqBody = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: media, data: imageData.toString("base64") } }, { text: `${system}\n\n${user}` }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: maxTokens },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // ลองสูงสุด 4 ครั้ง — retry+backoff เฉพาะ error ชั่วคราว (429 rate limit / 5xx overloaded)
  const MAX = 2;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: reqBody });
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        const willRetry = transient && attempt < MAX - 1;
        console.warn(`[bill-extract] gemini http ${res.status}${willRetry ? " (retry)" : ""}`);
        if (willRetry) { clearTimeout(timer); await delay(2000 * (attempt + 1) + Math.floor(Math.random() * 500)); continue; }
        return null;
      }
      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      logAiUsage("bill_extract", "gemini", model, {
        promptTokens: body.usageMetadata?.promptTokenCount,
        outputTokens: body.usageMetadata?.candidatesTokenCount,
        totalTokens: body.usageMetadata?.totalTokenCount,
      });
      return body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch {
      console.warn("[bill-extract] gemini error");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * เรียก Claude (Anthropic) vision → คืน "เนื้อ JSON" (string) หรือ null
 *   ★ ใช้ system/user prompt + schema เดียวกับ Gemini/OpenAI → ผ่าน normalizeExtraction เดิมได้เลย
 *   ★ ใช้เป็น "ตัวตรวจทาน" เฉพาะบิลยาก (escalation) เพื่อคุมต้นทุน · best-effort → null เมื่อ error/ไม่มี key
 *   ★ PDPA: ไม่ log เนื้อบิล/ยอด
 */
async function claudeExtractContent(
  system: string,
  user: string,
  imageData: Buffer,
  mime: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const m = (mime || "").toLowerCase();
  const isPdf = m.includes("pdf");
  const media = m.startsWith("image/") ? mime : "image/jpeg";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageData.toString("base64") } }
    : { type: "image", source: { type: "base64", media_type: media, data: imageData.toString("base64") } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: CLAUDE_VERIFY_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: "user", content: [block, { type: "text", text: user }] }],
      }),
    });
    if (!res.ok) { console.warn(`[bill-extract] claude http ${res.status}`); return null; }
    const body = (await res.json()) as { content?: { text?: string }[] };
    return body.content?.[0]?.text ?? null;
  } catch {
    console.warn("[bill-extract] claude error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * เรียก vision extract — เลือก provider อัตโนมัติ: OPENAI ก่อน (ถ้ามี key) · ไม่มี → Gemini
 *   คืน "เนื้อ JSON" (string) หรือ null · ★ ทำให้สกัดบิลทำงานได้แม้ไม่มี OPENAI_API_KEY (ใช้ Gemini แทน)
 */
async function runBillVision(
  system: string,
  user: string,
  imageData: Buffer,
  mime: string,
  openaiModel: string,
  maxTokens: number
): Promise<string | null> {
  // ★ Gemini ก่อน (ถ้ามี key) — เลิกพึ่ง GPT ทั้งใน local และ prod
  if (process.env.GEMINI_API_KEY) {
    return geminiExtractContent(system, user, imageData, mime, maxTokens, EXTRACT_TIMEOUT_MS);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const isPdf = (mime || "").toLowerCase().includes("pdf");
    const dataUrl = `data:${mime || "image/jpeg"};base64,${imageData.toString("base64")}`;
    const filePart = isPdf
      ? { type: "file", file: { filename: "bill.pdf", file_data: dataUrl } }
      : { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
    const reasoning = isReasoningModel(openaiModel);
    const reqBody: Record<string, unknown> = {
      model: openaiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text: user }, filePart] },
      ],
    };
    if (reasoning) reqBody.max_completion_tokens = maxTokens * 2;
    else { reqBody.temperature = 0; reqBody.max_tokens = maxTokens; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), reasoning ? EXTRACT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[bill-extract] openai http ${res.status}`);
        return null;
      }
      const body = (await res.json()) as ChatCompletionResponse;
      return body.choices?.[0]?.message?.content ?? null;
    } catch {
      console.warn("[bill-extract] openai error");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  // ไม่มี OPENAI key → Gemini (paid tier)
  return geminiExtractContent(system, user, imageData, mime, maxTokens, EXTRACT_TIMEOUT_MS);
}

/** เกณฑ์ความมั่นใจ "สูง" ต่อ field — >= นี้ = มั่นใจ (ไม่ mark เดา) */
const FIELD_THRESHOLD = 0.8;

/**
 * ★ เกณฑ์ขั้นต่ำที่จะ "เดาเติม" (proactive fill) — โหมดเติมเชิงรุก
 *   confidence อยู่ในช่วง [GUESS_THRESHOLD, FIELD_THRESHOLD) = เติมค่า แต่ mark ว่า "เดา" (low-confidence)
 *   ต่ำกว่า GUESS_THRESHOLD = ยังเว้น null (ต่ำเกินจะเดา) · ค่าผิดปกติ (ติดลบ/ไม่ใช่เลข) = null เสมอ
 */
const GUESS_THRESHOLD = 0.3;

/**
 * เกณฑ์ความมั่นใจขั้นต่ำของ "บัญชีที่ AI แนะนำ" (account_code)
 *   ต่ำกว่านี้ = null ให้นักบัญชีเลือกเอง · ไม่เดามั่ว (ผิดบัญชี = ผิดหมวดรายงาน)
 */
const ACCOUNT_THRESHOLD = 0.7;

/**
 * เกณฑ์ความมั่นใจของ vat_type ที่ AI ติ๊ก — ต่ำกว่านี้ = novat (ไม่เคลม VAT ถ้าไม่ชัดว่าเป็นใบกำกับภาษี)
 *   ★ เป็น binary + นักบัญชีแก้ได้ (ไม่ล็อก) → เกณฑ์ต่ำกว่าตัวเลขได้
 */
const VAT_TYPE_THRESHOLD = 0.6;

/** vat_type ที่รู้จัก */
const VAT_TYPES = new Set(["vat", "novat"]);

/** 1 บรรทัดรายการที่สกัดได้ (ค่าที่ AI ไม่มั่นใจ = null) */
export type ExtractedLine = {
  vat_type: "vat" | "novat";
  description: string | null;
  /** มูลค่าก่อน VAT · null = AI ไม่มั่นใจ ให้คนคีย์ */
  amount: number | null;
  /** ภาษีมูลค่าเพิ่ม · null = AI ไม่มั่นใจ ให้คนคีย์ */
  vat_amount: number | null;
  /**
   * รหัสบัญชีจากผังกลาง (non-bank) ที่ AI แนะนำ · null = ไม่มั่นใจ/นอกผัง (ให้คนเลือก)
   *   ★ ชื่อบัญชีให้ worker เติมจากผังของ tenant (chartByCode) — ไม่เชื่อชื่อจากโมเดล
   */
  account_code: string | null;
  /**
   * อัตราหัก ณ ที่จ่าย % ที่ "บิลแสดงไว้ชัด" · null = บิลไม่ได้แสดง/ไม่ชัด
   *   ★ null = ให้ worker แนะนำอัตราจากประเภทบัญชีแทน (ไม่เดาตัวเลขจากรูป)
   */
  wht_rate: number | null;
  /**
   * ยอดเงินหัก ณ ที่จ่าย ที่ "บิลแสดงไว้ชัด" · null = บิลไม่ได้แสดง/ไม่ชัด
   *   ★ null = ให้ worker auto-คำนวณจาก amount*rate แทน (ถ้ามีฐาน)
   */
  wht_amount: number | null;
  /**
   * ★ true = บรรทัดนี้มีช่อง "เดาเติม" (amount/vat_amount/account_code ที่เติมแบบ confidence < high-threshold)
   *   → ให้ UI ติดป้าย "AI เดา — ตรวจ" ก่อนยืนยัน · false = เติมด้วยความมั่นใจสูง หรือไม่ได้เติมช่องเสี่ยง
   */
  low_confidence: boolean;
};

/**
 * ผลสกัดบิล 1 ใบ (field ที่ไม่มั่นใจ = null)
 *   ★ ไม่ให้ AI ตัดสิน purchase/sale เอง — สกัด "ทั้งผู้ขายและผู้ซื้อ" แยกกัน
 *     (worker จะจับคู่ลูกค้าเราว่าอยู่ฝั่งไหนแล้วค่อยตัดสิน entry_type)
 */
export type ExtractedBill = {
  doc_date: string | null;            // YYYY-MM-DD
  doc_no: string | null;
  /** ผู้ขาย/ผู้ออกเอกสาร */
  seller_name: string | null;
  seller_tax_id: string | null;
  /** ผู้ซื้อ/ลูกค้าในเอกสาร */
  buyer_name: string | null;
  buyer_tax_id: string | null;
  lines: ExtractedLine[];
  /** ความมั่นใจรวม 0..1 */
  overall_confidence: number;
};

/** field พร้อม confidence ที่โมเดลตอบกลับ (รูปดิบก่อน gating) */
type ConfField = { value?: unknown; confidence?: unknown };

type RawExtract = {
  doc_date?: ConfField;
  doc_no?: ConfField;
  seller_name?: ConfField;
  seller_tax_id?: ConfField;
  buyer_name?: ConfField;
  buyer_tax_id?: ConfField;
  lines?: unknown;
  overall_confidence?: unknown;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
};

/** system prompt สำหรับสกัดบิล — ไม่ฝังผังบัญชีอีกต่อไป (account_code เติมด้วย Learning-map ใน worker) */
function buildSystemPrompt(): string {
  return (
  "คุณเป็นผู้ช่วยบัญชีที่อ่านรูปบิล/ใบเสร็จ/ใบกำกับภาษี แล้วสกัดข้อมูลเพื่อลงบันทึกภาษีซื้อ/ขาย. " +
  "ตอบเป็น JSON เท่านั้น ตามรูปแบบที่กำหนด. " +
  "ทุก field ที่เป็นค่าเดี่ยว ให้ตอบเป็น object {value, confidence} โดย confidence = ความมั่นใจ 0..1. " +
  "กฎสำคัญที่สุด: ถ้าไม่มั่นใจ อ่านไม่ชัด เบลอ เขียนมือ หรือไม่เห็นในรูป ให้ตั้ง value=null และ confidence ต่ำ " +
  "— ห้ามเดา โดยเฉพาะ 'ตัวเลข' (มูลค่า/ภาษี) ถ้าไม่ชัดให้ value=null เสมอ (เว้นว่างดีกว่าใส่เลขผิด). " +
  "ภาษีหัก ณ ที่จ่าย (WHT): ถ้าบิล 'แสดงไว้ชัดเจน' (มีบรรทัดหัก ณ ที่จ่าย/ระบุอัตรา % หรือยอดเงินที่หัก) " +
  "ให้อ่านมาใส่ wht_rate (อัตรา % เช่น 3) และ/หรือ wht_amount (ยอดเงินที่หัก) พร้อม confidence. " +
  "ถ้าบิลไม่ได้แสดงหัก ณ ที่จ่าย หรือไม่ชัด ให้ value=null ทั้งคู่ — ห้ามคำนวณเอง ห้ามเดา. " +
  "อย่าตัดสินว่าเป็นบิลซื้อหรือขาย — แค่สกัด 'ทั้งสองฝั่ง' ให้ครบ: " +
  "seller_name/seller_tax_id = ชื่อและเลขภาษีของ 'ผู้ขาย/ผู้ออกใบกำกับ' (มักอยู่หัวบิล), " +
  "buyer_name/buyer_tax_id = ชื่อและเลขภาษีของ 'ผู้ซื้อ/ลูกค้า' (มักอยู่ช่อง 'ลูกค้า/ผู้ซื้อ'). " +
  "ฝั่งไหนไม่เห็น/ไม่ชัดให้ value=null. " +
  "★ doc_no = 'เลขที่เอกสาร/เลขที่ใบกำกับภาษี' (ป้าย No./เลขที่/Invoice No./Tax Invoice No. มักอยู่มุมขวาบนของบิล) " +
  "— อ่านมาให้ครบทุกตัวอักษร/ตัวเลข/ขีด ห้ามข้าม (แต่ถ้าอ่านไม่ออกจริง ๆ ให้ value=null). " +
  "doc_date รูปแบบ YYYY-MM-DD (ค.ศ.). ★ ปีในบิลอาจเป็น พ.ศ. หรือ ค.ศ. ให้แปลงเป็น ค.ศ. อย่างถูกต้อง: " +
  "(1) ปี 4 หลักและ ≥ 2500 (เช่น 2569) = พ.ศ. → ลบ 543 (2569→2026). " +
  "(2) ปี 4 หลักและ < 2500 (เช่น 2026, 2025) = เป็น ค.ศ. อยู่แล้ว → ใช้เลย ★ห้ามลบ 543★ (2026 = 2026 ไม่ใช่ 2023). " +
  "(3) ปี 2 หลัก (เช่น 69) = พ.ศ. ย่อ → 2500+เลข แล้วลบ 543 (69→2569→2026). " +
  "★ ปี ค.ศ. ที่ถูกต้องต้องอยู่ราว 2024-2027 (ยุคปัจจุบัน) — ถ้าแปลงแล้วได้ปีนอกช่วงนี้มาก แสดงว่าพลาด ให้ทบทวนใหม่. " +
  "เลขประจำตัวผู้เสียภาษีเป็นเลข 13 หลัก. " +
  "lines = รายการในบิล แต่ละรายการ {vat_type:{value,confidence}, description:{value,confidence}, amount:{value,confidence}, vat_amount:{value,confidence}, wht_rate:{value,confidence}, wht_amount:{value,confidence}} " +
  "vat_type.value='vat' เฉพาะเมื่อ 'มั่นใจ' ว่าบิลเป็นใบกำกับภาษี/มีบรรทัดภาษีมูลค่าเพิ่ม (VAT) 7% ชัดเจน หรือแยกยอดก่อน+VAT ให้เห็น. " +
  "value='novat' ถ้าเป็นบิลเงินสด/บิลเขียนมือ/ใบเสร็จธรรมดาที่ไม่มี VAT/ไม่ใช่ใบกำกับภาษี. ไม่แน่ใจให้ confidence ต่ำ (จะให้คนตรวจ). " +
  "บิลที่มีทั้งของมี VAT และไม่มี VAT ให้แยกเป็นหลาย line. " +
  "★ amount = 'ยอดฐานก่อน VAT' (ราคาไม่รวมภาษีมูลค่าเพิ่ม) ของบรรทัดนั้น — อ่านจากคอลัมน์ 'จำนวนเงิน'/'AMOUNT' (ขวาสุด = จำนวน×หน่วยละ). " +
  "ห้ามเอา 'จำนวน/QUANTITY' (เช่น 100, 120) หรือ 'หน่วยละ/UNIT PRICE' (เช่น 710) มาใส่เป็น amount เด็ดขาด. " +
  "★★ บิลมี 2 แบบ ต้องแยกให้ถูก: " +
  "(1) VAT นอก = ยอดในบรรทัดเป็น 'ฐานก่อน VAT' อยู่แล้ว → ใช้เป็น amount ได้เลย. " +
  "(2) VAT ใน (ราคารวม VAT แล้ว) = ยอดในบรรทัด 'รวม VAT แล้ว' → ต้องถอด VAT ก่อน: " +
  "ดูสรุปท้ายบิล ถ้ามี 'ราคาไม่รวมภาษีมูลค่าเพิ่ม'/'มูลค่าก่อนภาษี' ให้ใช้เป็น amount และ 'ภาษีมูลค่าเพิ่ม' เป็น vat_amount; " +
  "ถ้าไม่มีสรุปแยก ให้คำนวณ amount = ยอดรวม÷1.07 และ vat_amount = ยอดรวม − amount. " +
  "สังเกตบิล VAT ใน จากคำว่า 'ราคารวมภาษี'/'ราคาไม่รวมภาษีมูลค่าเพิ่ม' ในสรุป. " +
  "vat_amount = ภาษีมูลค่าเพิ่มของรายการ (บิล VAT นอก ที่ไม่แสดง VAT แยกต่อบรรทัด → vat_amount=null ระบบคำนวณ 7% เอง). " +
  "ถ้าบิลมียอดเดียวรวม ๆ ให้ทำเป็น 1 line. overall_confidence = ความมั่นใจรวมทั้งใบ 0..1."
  // ★ ไม่ให้ AI เดา 'รหัสบัญชี' อีกต่อไป (เดิมแม่นแค่ ~35% แต่ต้องยัดผังบัญชีทั้งชุดเข้าทุก prompt = เปลือง token/ใบ)
  //   → account_code เติมด้วย Learning-map (คู่ค้า→บัญชีที่นักบัญชีเคยลง) ใน worker + นักบัญชีเลือกเอง (ดู account-learning.ts)
  );
}

const USER_PROMPT =
  "อ่านบิลในเอกสารนี้แล้วสกัดข้อมูลเป็น JSON ตามรูปแบบ. จำไว้: ช่องไหนไม่มั่นใจโดยเฉพาะตัวเลข ให้ value=null ห้ามเดา. ★ ตัวเลขทุกช่องเป็นตัวเลขล้วน ห้ามมีลูกน้ำคั่นหลักพัน (เช่น 2500.00 ไม่ใช่ 2,500.00). ถ้าเอกสารมีหลายบิล ให้สกัด 'บิลแรก' เท่านั้น.";

/** prompt สำหรับเอกสารที่ "อาจมีหลายบิล" (ไฟล์อัปเอง/PDF รวมหลายใบ) — คืน {bills:[...]} */
const MULTI_USER_PROMPT =
  "เอกสารนี้อาจมี 'หลายบิล/หลายใบ' ในไฟล์เดียว. สกัด 'ทุกบิล' เป็น JSON รูปแบบ {\"bills\":[ <bill1>, <bill2>, ... ]} " +
  "โดยแต่ละ <bill> มี field ครบตามที่ระบุ (doc_date, doc_no, seller_name, seller_tax_id, buyer_name, buyer_tax_id, lines[], overall_confidence) " +
  "แต่ละ field เป็น {value, confidence}. ถ้ามีบิลเดียวก็ใส่ bills 1 element. " +
  "แต่ละบิลเป็นเอกสารแยกกัน (คนละเลขที่/คนละยอด) — อย่ารวมยอดข้ามบิล. " +
  "จำไว้: ช่องไหนไม่มั่นใจโดยเฉพาะตัวเลข value=null ห้ามเดา. ★ ตัวเลขห้ามมีลูกน้ำคั่นหลักพัน (2500.00 ไม่ใช่ 2,500.00).";

/**
 * ดึง JSON object ก้อนแรกจากข้อความ (เผื่อโมเดลห่อ ```json, มีข้อความปน,
 *   หรือคืน "หลายก้อน" — เช่น PDF ที่มีหลายบิล → เอาก้อนแรกที่สมดุล)
 *   1) ลองเร็ว: { แรก → } สุดท้าย (พอสำหรับก้อนเดียว)
 *   2) ถ้าพัง (หลายก้อน/ข้อความห้อยท้าย) → นับวงเล็บหา "object แรกที่สมดุล" (ข้าม string/escape)
 */
/**
 * ซ่อม JSON ที่โมเดลชอบพลาด: ลูกน้ำคั่นหลักพันในตัวเลข (เช่น 2,500.00 → 2500.00)
 *   ★ ตัดเฉพาะ comma ที่ "มีเลขประกบทั้งสองข้าง" — comma โครงสร้าง JSON (value ตามด้วย ,\n / },{
 *     / ],[) มีช่องว่าง/วงเล็บประกบ ไม่โดนแตะ · เลขในสตริง "1,000" อาจโดน (ยอมรับได้ ไม่ critical)
 */
function repairJsonNumbers(s: string): string {
  return s.replace(/(?<=\d),(?=\d)/g, "");
}

function tryParse(slice: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(repairJsonNumbers(slice));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  // (1) วิธีเร็ว: { แรก → } สุดท้าย
  const lastEnd = text.lastIndexOf("}");
  if (lastEnd > start) {
    const p = tryParse(text.slice(start, lastEnd + 1));
    if (p) return p;
  }

  // (2) brace-matching — คืน object แรกที่ปิดสมดุล (กันหลาย object/ข้อความปน/ตัดท้าย)
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

/** clamp confidence เป็นช่วง 0..1 (ค่าเพี้ยน/ไม่ใช่เลข = 0) */
function clampConfidence(raw: unknown): number {
  let c = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(c)) c = 0;
  if (c < 0) c = 0;
  if (c > 1) c = 1;
  return c;
}

/**
 * gate string field: คืน value ก็ต่อเมื่อ confidence >= threshold และ value เป็น string ไม่ว่าง
 *   ต่ำกว่าเกณฑ์/ว่าง/ไม่ใช่ string → null (ให้คนคีย์)
 *   ★ threshold ปรับได้: date/tax_id คงเกณฑ์สูง (FIELD_THRESHOLD), doc_no/ชื่อ/คำอธิบายเติมเชิงรุก (GUESS_THRESHOLD)
 */
function gateString(field: ConfField | undefined, threshold = FIELD_THRESHOLD): string | null {
  if (!field || typeof field !== "object") return null;
  if (clampConfidence(field.confidence) < threshold) return null;
  const v = field.value;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * ตัวกันพลาดวันที่ (deterministic): ถ้าโมเดลคืนปี พ.ศ. มา (ปี ≥ 2500) → ลบ 543 ให้เป็น ค.ศ.
 *   เช่น 2569-06-15 → 2026-06-15 · ปีที่เป็น ค.ศ. อยู่แล้ว (เช่น 2026) ไม่แตะ
 *   คืน null/รูปแบบอื่นตามเดิม (ไม่ยุ่ง)
 */
function fixBuddhistYear(d: string | null): string | null {
  if (!d) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const rawYear = parseInt(m[1], 10);
  const y = rawYear >= 2500 ? rawYear - 543 : rawYear;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const date = new Date(Date.UTC(y, month - 1, day));
  const valid = y >= 2000 && y <= new Date().getUTCFullYear() + 1 &&
    date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? `${String(y).padStart(4, "0")}-${m[2]}-${m[3]}` : null;
}

/**
 * gate number field (โหมดเดิม, เกณฑ์สูง): คืน value เฉพาะ confidence >= FIELD_THRESHOLD และเลข >= 0
 *   ใช้กับ WHT (หัก ณ ที่จ่าย) — ไม่ชัด = null (ให้ worker แนะนำจากบัญชีแทน) · ไม่เดาเติม
 */
function gateNumber(field: ConfField | undefined): number | null {
  if (!field || typeof field !== "object") return null;
  if (clampConfidence(field.confidence) < FIELD_THRESHOLD) return null;
  const v = field.value;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * ★ gate number แบบ "เดาเติม" (proactive): คืน { value, low }
 *   - ค่าผิดปกติ (ไม่ใช่เลข/ติดลบ) → { null, false } เสมอ (ไม่เติมค่ามั่ว)
 *   - confidence < GUESS_THRESHOLD → { null, false } (ต่ำเกินจะเดา — เว้นว่าง)
 *   - confidence อยู่ [GUESS_THRESHOLD, FIELD_THRESHOLD) → เติมค่า + low=true (เดา ต้องตรวจ)
 *   - confidence >= FIELD_THRESHOLD → เติมค่า + low=false (มั่นใจ)
 */
function gateNumberGuess(field: ConfField | undefined): { value: number | null; low: boolean } {
  if (!field || typeof field !== "object") return { value: null, low: false };
  const conf = clampConfidence(field.confidence);
  const v = field.value;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0) return { value: null, low: false }; // ค่าผิดปกติ = ทิ้งเสมอ
  if (conf < GUESS_THRESHOLD) return { value: null, low: false }; // ต่ำเกินจะเดา
  return { value: n, low: conf < FIELD_THRESHOLD };
}

/**
 * ★ gate account_code แบบ "เดาเติม" (proactive): คืน { value, low }
 *   - code ต้องอยู่ในผังกลาง "non-bank" จริง (นอกผัง/หมวดเงินฝากธนาคาร = ทิ้งเสมอ)
 *   - confidence < GUESS_THRESHOLD → ทิ้ง (ให้คนเลือก)
 *   - [GUESS_THRESHOLD, ACCOUNT_THRESHOLD) → เติม + low=true (เดา ต้องตรวจ)
 *   - >= ACCOUNT_THRESHOLD → เติม + low=false (มั่นใจ)
 *   รองรับทั้งรูป {value, confidence} และ string ตรง ๆ (string = ถือว่ามั่นใจ)
 *   @param chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — ไม่มี default (ผู้เรียกต้องส่งเสมอ)
 */
function gateAccountCodeGuess(raw: unknown, chartByCode: ChartByCode): { value: string | null; low: boolean } {
  let value: unknown = raw;
  let conf = 1; // string ตรง ๆ (ไม่มี confidence) → ถือว่ามั่นใจ แล้วค่อย validate ด้วยผัง
  if (raw && typeof raw === "object") {
    value = (raw as ConfField).value;
    conf = clampConfidence((raw as ConfField).confidence);
  }
  if (conf < GUESS_THRESHOLD) return { value: null, low: false };
  if (typeof value !== "string") return { value: null, low: false };
  const code = value.trim();
  if (!code) return { value: null, low: false };
  const acct = chartByCode[code];
  // ต้องมีในผัง + ไม่ใช่หมวดเงินฝากธนาคาร (bank = บัญชีต่อลูกค้า ห้าม AI เลือก)
  if (!acct || acct.bank) return { value: null, low: false };
  return { value: code, low: conf < ACCOUNT_THRESHOLD };
}

/** normalize 1 line ดิบ → ExtractedLine พร้อม gate ตัวเลขทุกช่อง */
function normalizeLine(raw: unknown, chartByCode: ChartByCode): ExtractedLine | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // vat_type: AI ติ๊กให้ "เฉพาะที่มั่นใจ" (confidence >= เกณฑ์) — ไม่มั่นใจ = novat
  //   (ปลอดภัยด้านภาษี: ไม่เคลม VAT ถ้าไม่ชัดว่าเป็นใบกำกับภาษี) · ไม่ล็อก นักบัญชีแก้ได้
  //   รองรับทั้ง {value,confidence} (ใหม่) และ string ตรง ๆ (เก่า = เชื่อ conf=1)
  let vatType: "vat" | "novat" = "novat";
  const vtField = o.vat_type as ConfField | undefined;
  const vtRaw =
    typeof o.vat_type === "string"
      ? o.vat_type
      : typeof vtField?.value === "string"
        ? String(vtField.value)
        : "";
  const vtConf = typeof o.vat_type === "string" ? 1 : clampConfidence(vtField?.confidence);
  const vtNorm = vtRaw.trim().toLowerCase();
  if (VAT_TYPES.has(vtNorm) && vtConf >= VAT_TYPE_THRESHOLD) {
    vatType = vtNorm as "vat" | "novat";
  }

  // ★ โหมดเติมเชิงรุก: amount/vat/account เติมแม้ conf ต่ำ (>= GUESS_THRESHOLD) แต่ mark "เดา"
  const amount = gateNumberGuess(o.amount as ConfField);
  const vatAmount = gateNumberGuess(o.vat_amount as ConfField);
  const account = gateAccountCodeGuess(o.account_code, chartByCode);
  // low_confidence ของบรรทัด = มีช่องเสี่ยง (amount/vat/บัญชี) ที่เติมแบบ "เดา" อย่างน้อย 1 ช่อง
  const lowConfidence = amount.low || vatAmount.low || account.low;

  let whtRate = gateNumber(o.wht_rate as ConfField);
  let whtAmount = gateNumber(o.wht_amount as ConfField);
  // อัตราเกิน 100% หรือยอดหักสูงกว่าฐานเป็นผลอ่านผิดแน่นอน — เว้นไว้ให้คนตรวจ
  const invalidWht = (whtRate != null && whtRate > 100) ||
    (whtAmount != null && amount.value != null && whtAmount > amount.value);
  if (invalidWht) { whtRate = null; whtAmount = null; }

  return {
    vat_type: vatType,
    // string เสี่ยงน้อยกว่าตัวเลข → เติมเชิงรุก (GUESS_THRESHOLD) แต่ไม่ mark เดา
    description: gateString(o.description as ConfField, GUESS_THRESHOLD),
    amount: amount.value,
    vat_amount: vatAmount.value,
    account_code: account.value,
    // ★ WHT: คงเกณฑ์สูง (FIELD_THRESHOLD) — ไม่ชัด = null (ให้ worker แนะนำจากบัญชี) ไม่เดาเติม
    wht_rate: whtRate,
    wht_amount: whtAmount,
    low_confidence: lowConfidence || invalidWht,
  };
}

/**
 * แปลงผลดิบจากโมเดล → ExtractedBill พร้อมบังคับ high-confidence gating
 *   (แยกออกมาให้เทสต์ตรง logic ได้ โดยไม่ต้องยิง API)
 *   คืน null เมื่อ parse ไม่ได้/ไม่มี line ที่ใช้ได้เลย (ให้ worker สร้าง draft ว่าง/ข้าม)
 *   @param chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — default {} เพื่อ backward-compat ระดับ
 *     compile เท่านั้น (caller จริง เช่น extractBillData ต้องส่งผังจริงของ tenant มาเสมอ ไม่งั้น
 *     account_code ทุกอันจะถูกปฏิเสธเพราะไม่มีรหัสในผังว่าง)
 */
export function normalizeExtraction(
  raw: Record<string, unknown> | null,
  chartByCode: ChartByCode = {}
): ExtractedBill | null {
  if (!raw) return null;
  const r = raw as RawExtract;

  const linesRaw = Array.isArray(r.lines) ? r.lines : [];
  const lines = linesRaw
    .map((l) => normalizeLine(l, chartByCode))
    .filter((l): l is ExtractedLine => l !== null);

  // ถ้าไม่มี line ใด ๆ ให้สร้าง 1 line ว่าง (vat) ไว้ให้คนคีย์ — ไม่ทิ้งทั้งใบ
  if (lines.length === 0) {
    lines.push({ vat_type: "vat", description: null, amount: null, vat_amount: null, account_code: null, wht_rate: null, wht_amount: null, low_confidence: false });
  }

  const gateExtractedTaxId = (field: ConfField | undefined): string | null => {
    const value = gateString(field);
    if (!value) return null;
    const digits = taxIdDigits(value);
    return isValidThaiTaxIdChecksum(digits) ? digits : null;
  };

  return {
    // ★ doc_date / tax_id (13 หลัก): คงเกณฑ์สูง — วันที่/เลขภาษีผิด = ยุ่ง (ไม่เดาเติม)
    doc_date: fixBuddhistYear(gateString(r.doc_date)),
    seller_tax_id: gateExtractedTaxId(r.seller_tax_id),
    buyer_tax_id: gateExtractedTaxId(r.buyer_tax_id),
    // ★ doc_no / ชื่อผู้ขาย-ผู้ซื้อ: เติมเชิงรุก (GUESS_THRESHOLD) — string เสี่ยงน้อยกว่าตัวเลข
    doc_no: gateString(r.doc_no, GUESS_THRESHOLD),
    seller_name: gateString(r.seller_name, GUESS_THRESHOLD),
    buyer_name: gateString(r.buyer_name, GUESS_THRESHOLD),
    lines,
    overall_confidence: clampConfidence(r.overall_confidence),
  };
}

/**
 * สกัดข้อมูลบิลจากรูป (OpenAI vision, detail=high สำหรับตัวเลข, temperature 0)
 *   @param chart ผังบัญชีของ tenant (สำหรับ prompt + validate account_code) — default [] เพื่อ
 *     backward-compat ระดับ compile เท่านั้น (caller จริงต้องส่งผังจริงของ tenant มาเสมอ)
 *   @returns ExtractedBill (ช่องไม่มั่นใจ = null) · null เมื่อ error/timeout/ไม่มี key
 */
/** ผลรวมยอดทุกบรรทัด (ฐาน + VAT) — ใช้เทียบว่าตัวอ่านแต่ละตัวเห็นยอดตรงกันไหม */
function billTotal(b: ExtractedBill): number {
  return Math.round(b.lines.reduce((s, l) => s + (l.amount ?? 0) + (l.vat_amount ?? 0), 0) * 100) / 100;
}

/** คะแนนคุณภาพการอ่าน (สูง = ดี): มั่นใจสูง · เดาน้อย · อ่านตัวเลข/ช่องสำคัญได้ครบ */
function billScore(b: ExtractedBill): number {
  const low = b.lines.filter((l) => l.low_confidence).length;
  const nullAmt = b.lines.filter((l) => l.amount == null).length;
  return b.overall_confidence - 0.1 * low - 0.15 * nullAmt - (b.seller_name ? 0 : 0.05) - (b.doc_date ? 0 : 0.05);
}

/** บิล "ยาก" ที่ควร escalate ให้ Pro + Claude ช่วยอ่าน (คุมต้นทุน — เรียกเฉพาะเคสนี้) */
function needsEscalation(b: ExtractedBill): boolean {
  // ★ คุมต้นทุน: escalate เฉพาะบิลที่ "ไม่มั่นใจมากจริง ๆ" (conf < 0.5) เท่านั้น
  //   (เดิม conf<0.75 / มี null / low_conf ใด ๆ → บิลเกือบทุกใบ escalate = จ่ายแพง)
  //   บิลทั่วไปที่ flash อ่านได้ระดับหนึ่ง → ใช้ flash พอ (นักบัญชีตรวจอยู่แล้ว)
  return b.overall_confidence < 0.5;
}

/** parse เนื้อ JSON → ExtractedBill (ผ่าน gating + VAT sanity เดิม) · null เมื่ออ่านไม่ได้ */
function parseBill(content: string | null, chartByCode: ChartByCode): ExtractedBill | null {
  if (!content) return null;
  const bill = normalizeExtraction(extractJson(content), chartByCode);
  return bill ? flagVatInconsistency(bill) : null;
}

export async function extractBillData(
  imageData: Buffer,
  mime: string,
  chart: ChartAccount[] = []
): Promise<ExtractedBill | null> {
  // ★ บิลไลน์ (รูปใบเดียว) — OpenAI ก่อน (ถ้ามี key) · ไม่มี → Gemini flash (paid tier)
  const model = process.env.OPENAI_LINE_BILL_MODEL || EXTRACT_MODEL;
  // ★ ย่อรูปใหญ่ก่อน (รูปสแกน/ถ่ายบิลหลาย MB) — กัน Gemini 400 (payload/ขนาดเกิน) · PDF ไม่แตะ
  const prepped = await downscaleImageIfLarge(imageData, mime);
  const system = buildSystemPrompt();
  const chartByCode = buildChartByCode(chart);

  // 1) อ่านเร็ว: flash (หรือ OpenAI ถ้ามี key)
  const first = parseBill(
    await runBillVision(system, USER_PROMPT, prepped.data, prepped.mime, model, 2200),
    chartByCode
  );
  if (!first) return null;

  // 2) บิลง่าย / ปิด escalation → คืนผลเร็ว (จ่ายแค่ค่าอ่าน flash 1 ครั้ง)
  if (!ESCALATE_ON || !needsEscalation(first)) return first;

  // 3) บิลยาก → ตรวจซ้ำด้วย "Claude อย่างเดียว" (คุมต้นทุน — ตัด Gemini Pro preview ที่แพงออก)
  const claudeContent = await claudeExtractContent(system, USER_PROMPT, prepped.data, prepped.mime, 2600, EXTRACT_TIMEOUT_MS);
  const candidates = [first, parseBill(claudeContent, chartByCode)]
    .filter((b): b is ExtractedBill => !!b);

  // 4) เลือกใบที่ "คะแนนอ่านดีสุด"
  candidates.sort((a, b) => billScore(b) - billScore(a));
  const best = candidates[0];
  if (candidates.length < 2) return best; // Pro/Claude ล้มทั้งคู่ → คืน best เท่าที่มี

  // 5) ตัวอ่านเห็น "ยอดรวม" ไม่ตรงกัน (เกิน ±2% หรือ ±1 บาท) → ยกธงทั้งใบให้นักบัญชีตรวจ
  const totals = candidates.map(billTotal);
  const spread = Math.max(...totals) - Math.min(...totals);
  const disagree = spread > Math.max(1, Math.max(...totals) * 0.02);
  if (!disagree) return best;
  return {
    ...best,
    overall_confidence: Math.min(best.overall_confidence, 0.5),
    lines: best.lines.map((l) => ({ ...l, low_confidence: true })),
  };
}

/**
 * ตรวจความสมเหตุผลของ VAT ต่อบรรทัด — safety net จับเคส AI อ่านคอลัมน์สลับ/ยอดเพี้ยน
 *   ที่ยังรอดจาก confidence gate: บรรทัด vat_type='vat' ที่มีทั้งฐานและ VAT
 *   แต่ VAT ≠ ~7% ของฐาน (เผื่อปัดเศษ) → mark low_confidence ให้นักบัญชีตรวจ
 *   ★ ไม่แก้ตัวเลข (เว้นการตัดสินให้คน) — แค่ยกธง "ตรวจก่อนยืนยัน"
 */
const VAT_RATE = 0.07;
export function flagVatInconsistency(bill: ExtractedBill): ExtractedBill {
  return {
    ...bill,
    lines: bill.lines.map((l) => {
      if (l.vat_type !== "vat" || l.low_confidence) return l;
      if (l.amount === null || l.amount <= 0 || l.vat_amount === null || l.vat_amount <= 0) return l;
      const expected = l.amount * VAT_RATE;
      const tolerance = Math.max(1, l.amount * 0.02); // ±2% ของฐาน หรือ ±1 บาท (อันไหนมากกว่า)
      return Math.abs(l.vat_amount - expected) > tolerance ? { ...l, low_confidence: true } : l;
    }),
  };
}

/** บิลนี้ "มีเนื้อหาจริง" ไหม (กันสร้าง entry เปล่าจาก element ขยะ) */
function billHasContent(b: ExtractedBill): boolean {
  return (
    !!b.doc_no ||
    !!b.doc_date ||
    !!b.seller_name ||
    !!b.buyer_name ||
    b.lines.some((l) => (l.amount ?? 0) > 0 || (l.vat_amount ?? 0) > 0)
  );
}

/**
 * สกัด "ทุกบิล" จากเอกสาร (ไฟล์อัปเอง/PDF ที่รวมหลายใบ) → คืน ExtractedBill[]
 *   ★ รองรับ PDF (file input) เหมือน extractBillData
 *   ★ โมเดลคืน {bills:[...]}; ถ้าคืน object เดี่ยว (บิลเดียว) ก็ห่อเป็น 1 element
 *   ★ กรอง element ที่ว่างจริง (ไม่มีเลข/ชื่อ/เลขที่) ออก · cap 30 บิล/ไฟล์
 *   ★ degrade: ไม่มี key / อ่านไม่ได้ → คืน []
 *   @param chart ผังบัญชีของ tenant (สำหรับ prompt + validate account_code) — default [] เพื่อ
 *     backward-compat ระดับ compile เท่านั้น (caller จริงต้องส่งผังจริงของ tenant มาเสมอ)
 */
export async function extractBillsData(
  imageData: Buffer,
  mime: string,
  chart: ChartAccount[] = []
): Promise<ExtractedBill[]> {
  // PDF ใหญ่เกินเพดาน → ตัดเป็นชิ้นอ่านทีละชิ้นแล้วรวมบิลอัตโนมัติ (chart ผูกผ่าน closure)
  return extractPdfMaybeSplit(imageData, mime, (data, m) => extractBillsDataSingle(data, m, chart));
}

/** เรียก AI ครั้งเดียว (ไฟล์/ชิ้นเดียว ≤เพดาน) — ตัวจริงที่ extractBillsData / split เรียก */
async function extractBillsDataSingle(
  imageData: Buffer,
  mime: string,
  chart: ChartAccount[] = []
): Promise<ExtractedBill[]> {
  // ไม่มีทั้ง OpenAI และ Gemini key → ข้าม
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) return [];

  const prepped = await downscaleImageIfLarge(imageData, mime); // ย่อรูปสแกน/ถ่ายบิลใหญ่ (PDF ไม่แตะ)
  const content = await runBillVision(buildSystemPrompt(), MULTI_USER_PROMPT, prepped.data, prepped.mime, EXTRACT_MODEL, 5000);
  if (!content) return [];

  const obj = extractJson(content);
  if (!obj) return [];
  const rawBills = Array.isArray((obj as { bills?: unknown }).bills)
    ? ((obj as { bills: unknown[] }).bills)
    : [obj]; // เผื่อโมเดลคืน object เดี่ยว
  const chartByCode = buildChartByCode(chart);
  return rawBills
    .map((b) => normalizeExtraction(b as Record<string, unknown>, chartByCode))
    .filter((b): b is ExtractedBill => b !== null && billHasContent(b))
    .map(flagVatInconsistency)
    .slice(0, 30);
}
