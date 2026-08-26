/**
 * Bill image classifier — คัดกรองรูปด้วย OpenAI vision ก่อนเก็บ (เฟส 1 ฝั่ง CX)
 *   เก็บเฉพาะ "เอกสารการเงิน" (สลิปโอน/บิลเขียนมือ/บิลเงินสด/บิลซื้อ/บิลขาย)
 *   ทิ้งรูปอื่น (เซลฟี่/อาหาร/สินค้า/มีม/สติกเกอร์/สกรีนช็อตแชต/รูปทั่วไป)
 *
 * ⚠️ กฎความปลอดภัยหลัก "keep-if-unsure" (บังคับในโค้ด — กันลบบิลจริงหาย):
 *   - keep=false ได้เฉพาะเมื่อ AI ตอบ kind='other' + confidence สูง (>= KEEP_THRESHOLD)
 *   - confidence ต่ำ / parse ไม่ได้ / kind ไม่รู้จัก → keep=true (เก็บไว้ก่อน)
 *   - error / timeout / ไม่มี key → คืน null (ให้ caller ถือว่า keep เช่นกัน)
 *
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY → คืน null (ข้ามการคัด เก็บทุกรูป)
 * ★ PDPA: ไม่ log เนื้อรูป/ผลละเอียด — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */

import { extractJsonWithGemini } from "@/lib/ai/gemini-extract";
import { prepareImageForClassification } from "@/lib/accounting/image-prep";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 30_000;

/** เกณฑ์ความมั่นใจขั้นต่ำที่จะ "กล้าทิ้ง" — ต่ำกว่านี้ = เก็บไว้ก่อน (keep-if-unsure) */
const KEEP_THRESHOLD = 0.7;

/** ชนิดเอกสารการเงินที่รู้จัก (นอกเหนือจากนี้ + 'other' ถือว่าไม่รู้จัก → keep) */
const FINANCIAL_KINDS = new Set(["slip", "handwritten", "cash", "purchase", "sale"]);

export type BillClassifyResult = {
  /** true = เก็บ (เอกสารการเงิน หรือ ไม่มั่นใจ) · false = ทิ้ง (มั่นใจว่าไม่ใช่) */
  keep: boolean;
  /** ชนิด: slip/handwritten/cash/purchase/sale/other */
  kind: string;
  /** ความมั่นใจ 0..1 */
  confidence: number;
};

const SYSTEM_PROMPT =
  "คุณเป็นตัวคัดกรองรูปภาพของระบบบัญชี หน้าที่คือดูรูปแล้วบอกว่าเป็น 'เอกสารการเงิน' หรือไม่. " +
  "เอกสารการเงินที่ต้องเก็บ: สลิปโอนเงิน (slip), บิล/ใบเสร็จเขียนมือ (handwritten), บิลเงินสด (cash), " +
  "บิลซื้อ/ใบกำกับซื้อ (purchase), บิลขาย/ใบเสร็จ/ใบกำกับ/invoice (sale) — ทั้งแบบพิมพ์และเขียนมือ. " +
  "รูปที่ไม่ใช่เอกสารการเงินให้ kind='other' เช่น เซลฟี่/รูปคน, รูปสินค้า/อาหาร, มีม/สติกเกอร์, สกรีนช็อตแชต, รูปวิวทั่วไป. " +
  "สำคัญมาก: ถ้าไม่แน่ใจ หรือก้ำกึ่ง ให้เลือกทางที่ 'เก็บไว้ก่อน' (keep=true) เสมอ — ยอมเก็บเกินดีกว่าทิ้งบิลจริงหาย. " +
  "ตอบเป็น JSON เท่านั้น: {\"kind\": <slip|handwritten|cash|purchase|sale|other>, \"keep\": <true|false>, \"confidence\": <0..1>}. " +
  "ให้ keep=false เฉพาะเมื่อมั่นใจสูงจริง ๆ ว่าเป็น other (ไม่ใช่เอกสารการเงิน).";

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
};

/** ดึง JSON object ก้อนแรกจากข้อความ (เผื่อโมเดลห่อด้วย ```json หรือมีข้อความปน) */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * แปลงผลดิบจากโมเดลเป็น BillClassifyResult พร้อมบังคับ keep-if-unsure
 *   (แยกออกมาให้เทสต์ตรง logic ได้)
 */
export function normalizeClassification(raw: Record<string, unknown> | null): BillClassifyResult {
  // parse ไม่ได้ → เก็บไว้ก่อน
  if (!raw) return { keep: true, kind: "other", confidence: 0 };

  const kindRaw = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";

  let confidence = typeof raw.confidence === "number" ? raw.confidence : NaN;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  // เอกสารการเงินที่รู้จัก → เก็บเสมอ
  if (FINANCIAL_KINDS.has(kindRaw)) {
    return { keep: true, kind: kindRaw, confidence };
  }

  // นอกเหนือจากนั้น เก็บลง kind='other' เสมอ · ทิ้งได้เฉพาะเมื่อ:
  //   โมเดลตอบ kind='other' ตรง ๆ (ไม่ใช่ค่าแปลกที่ parse ไม่ตรง) + มั่นใจสูง (>= KEEP_THRESHOLD)
  //   ★ ตัดสินจาก kind+confidence เท่านั้น — ไม่พึ่ง flag `keep` ของโมเดล (ตอบไม่นิ่ง:
  //     มัน classify เป็น other conf สูง แต่ดัน keep=true → ไม่เคยลบเลย)
  //   keep-if-unsure: kind แปลก/parse ไม่ตรง 'other' / confidence ต่ำกว่าเกณฑ์ = เก็บไว้ก่อน
  const explicitOther = kindRaw === "other";
  const keep = explicitOther && confidence >= KEEP_THRESHOLD ? false : true;
  return { keep, kind: "other", confidence };
}

// =====================================================================
// แยก "ลิสต์วงแชร์" ออกจาก "บิลจริง" — ใช้เฉพาะลูกค้า is_share_circle (ท้าวแชร์)
//   กลุ่มท้าวแชร์อาจส่งทั้ง "ลิสต์วงแชร์" (ให้โมดูลวงแชร์อ่าน) และ "บิลจริง" ปนกัน
//   → ต้องแยกด้วยเนื้อหา ไม่ใช่ข้ามทุกใบ (บิลจริงต้องไม่หาย)
//   ★ keep-if-unsure (ขั้วกลับ): tag เป็น share_list=true เฉพาะเมื่อมั่นใจสูงว่าเป็นลิสต์วง
//     ไม่ชัด/ก้ำกึ่ง/เป็นบิลจริง/error/ไม่มี key → false (ปล่อยให้สร้างบิลตามปกติ = บิลไม่หาย)
// =====================================================================

/** เกณฑ์มั่นใจขั้นต่ำที่จะ "กล้าตัดสินว่าเป็นลิสต์วงแชร์" (ต่ำกว่านี้ = ถือเป็นบิล) */
const SHARE_LIST_THRESHOLD = 0.7;

export type ShareCircleClassifyResult = {
  /** true = เป็น "ลิสต์วงแชร์" (ไม่ใช่บิล) · false = เป็นบิลจริง/ไม่ชัด (ให้สร้างบิลตามปกติ) */
  isShareList: boolean;
  /** ความมั่นใจ 0..1 */
  confidence: number;
};

const SHARE_SYSTEM_PROMPT =
  "คุณเป็นตัวช่วยแยกประเภทรูปในกลุ่มไลน์ของ 'ท้าวแชร์' (คนจัดวงแชร์เล่นแชร์). " +
  "ดูรูปแล้วบอกว่าเป็น 'ลิสต์วงแชร์' หรือ 'เอกสารการเงิน/บิลจริง'. " +
  "ลิสต์วงแชร์ (share_list=true): เป็นรายการวง/มือของวงแชร์ เช่น ชื่อวง + ลำดับมือ (1. 2. 3.) + " +
  "ยอดส่ง/ดอก (เปีย) + ชื่อสมาชิก มักมีอิโมจิ 🌸❤️🔥 คั่นตัวเลข/ชื่อ " +
  "— ★ ไม่มีเลขประจำตัวผู้เสียภาษี ไม่ใช่ใบกำกับภาษี/ใบเสร็จ/สลิปโอนเงิน. " +
  "เอกสารการเงิน/บิลจริง (share_list=false): ใบกำกับภาษี/ใบเสร็จ/บิลซื้อขาย/สลิปโอนเงิน/" +
  "บิลค่าใช้จ่าย (มีชื่อร้าน/ยอดเงินรวม/เลขที่เอกสาร/วันที่ บางทีมีเลขผู้เสียภาษี 13 หลัก). " +
  "★ สำคัญมาก (keep-if-unsure): ถ้าไม่แน่ใจ ก้ำกึ่ง หรือดูเป็นบิลจริง ให้ตอบ share_list=false เสมอ " +
  "— ยอมให้เป็นบิลดีกว่าทำบิลจริงหาย. ตอบ share_list=true เฉพาะเมื่อมั่นใจสูงว่าเป็นลิสต์วงแชร์. " +
  'ตอบเป็น JSON เท่านั้น: {"share_list": <true|false>, "confidence": <0..1>}.';

/**
 * แปลงผลดิบ → ShareCircleClassifyResult พร้อมบังคับ keep-if-unsure (แยกให้เทสต์ได้)
 *   isShareList=true เฉพาะเมื่อ share_list===true และ confidence >= เกณฑ์ · นอกนั้น false
 */
export function normalizeShareCircleClassification(
  raw: Record<string, unknown> | null
): ShareCircleClassifyResult {
  if (!raw) return { isShareList: false, confidence: 0 };
  let confidence = typeof raw.confidence === "number" ? raw.confidence : NaN;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  const isShareList = raw.share_list === true && confidence >= SHARE_LIST_THRESHOLD;
  return { isShareList, confidence };
}

/**
 * จำแนกรูปว่าเป็น "ลิสต์วงแชร์" หรือ "บิลจริง" (OpenAI vision) — ใช้เฉพาะลูกค้าท้าวแชร์
 *   @returns ผล · null เมื่อ error/timeout/ไม่มี key (caller ถือว่าเป็นบิล = ไม่ข้าม)
 */
export async function classifyShareCircleImage(
  data: Buffer,
  mime: string
): Promise<ShareCircleClassifyResult | null> {
  // Gemini vision ก่อน (ถูก + ไม่พึ่ง OpenAI) · ล้ม/ไม่มี key → OpenAI
  const prepared = await prepareImageForClassification(data, mime);
  const gem = await extractJsonWithGemini({
    system: SHARE_SYSTEM_PROMPT,
    userPrompt: "รูปนี้เป็น 'ลิสต์วงแชร์' หรือ 'บิลจริง'? ตอบ JSON ตามรูปแบบ",
    fileData: prepared.data,
    mime: prepared.mime,
    maxOutputTokens: 160,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (gem !== null) return normalizeShareCircleClassification(gem);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // degrade: ไม่มี key → caller ถือว่าเป็นบิล (ไม่ข้าม)

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const dataUrl = `data:${mime || "image/jpeg"};base64,${data.toString("base64")}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 100,
        messages: [
          { role: "system", content: SHARE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "รูปนี้เป็น 'ลิสต์วงแชร์' หรือ 'บิลจริง'? ตอบ JSON ตามรูปแบบ" },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[bill-classify] share openai http ${res.status}`);
      return null; // error → caller ถือว่าเป็นบิล (ไม่ข้าม → บิลไม่หาย)
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalizeShareCircleClassification(extractJson(content));
  } catch {
    console.warn("[bill-classify] share classify error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * จำแนกรูปว่าเป็นเอกสารการเงินหรือไม่ (OpenAI vision)
 *   @returns ผลการคัด · null เมื่อ error/timeout/ไม่มี key (caller ถือว่า keep)
 */
export async function classifyBillImage(
  data: Buffer,
  mime: string
): Promise<BillClassifyResult | null> {
  // Gemini vision ก่อน (ถูก + ไม่พึ่ง OpenAI) · ล้ม/ไม่มี key → OpenAI
  const prepared = await prepareImageForClassification(data, mime);
  const gem = await extractJsonWithGemini({
    system: SYSTEM_PROMPT,
    userPrompt: "รูปนี้เป็นเอกสารการเงินหรือไม่? ตอบ JSON ตามรูปแบบที่กำหนด",
    fileData: prepared.data,
    mime: prepared.mime,
    maxOutputTokens: 160,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (gem !== null) return normalizeClassification(gem);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // degrade: ไม่มี key → ข้ามการคัด (caller เก็บทุกรูป)

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const dataUrl = `data:${mime || "image/jpeg"};base64,${data.toString("base64")}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 100,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "รูปนี้เป็นเอกสารการเงินหรือไม่? ตอบ JSON ตามรูปแบบที่กำหนด" },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[bill-classify] openai http ${res.status}`);
      return null; // error → keep (caller)
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    return normalizeClassification(extractJson(content));
  } catch {
    // timeout / network / abort → คืน null ให้ caller เก็บไว้ก่อน (keep-if-unsure)
    console.warn("[bill-classify] classify error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
