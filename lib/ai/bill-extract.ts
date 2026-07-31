/**
 * Bill data extractor — สกัดข้อมูลบิล/ใบกำกับจากรูปด้วย OpenAI vision (★ high-confidence only)
 *   สำหรับหน้า "ลงบันทึกบัญชี ภาษีซื้อ/ขาย" — สร้าง draft ให้คนตรวจ/แก้ก่อนยืนยัน
 *
 * ★ กฎหลัก "high-confidence only" (เหมือน keep-if-unsure ของ bill-classify):
 *   - ทุก field ให้โมเดลระบุ confidence · ช่องไหน confidence < FIELD_THRESHOLD (0.8)
 *     → คืน null (เว้นว่าง) ให้คนคีย์ · โดยเฉพาะ "ตัวเลข" (amount/vat) ถ้าไม่ชัด/
 *     เขียนมือ/เบลอ = null · เว้นว่างดีกว่าเดาผิด (ตัวเลขภาษีผิด = ยื่นผิด)
 *   - ไม่ให้ AI คำนวณ WHT (หัก ณ ที่จ่าย) — ปล่อย auto-calc/คนใส่
 *     (AI มักไม่รู้ประเภทค่าใช้จ่าย → เดาอัตราผิด)
 *
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY → คืน null (worker ข้ามการสกัด)
 * ★ PDPA: ไม่ log เนื้อบิล/ผลละเอียด — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */

import { CHART_BY_CODE, searchChartNonBank } from "@/lib/accounting/chart-of-accounts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;

/** เกณฑ์ความมั่นใจขั้นต่ำต่อ field — ต่ำกว่านี้ = เว้น null ให้คนคีย์ */
const FIELD_THRESHOLD = 0.8;

/**
 * เกณฑ์ความมั่นใจขั้นต่ำของ "บัญชีที่ AI แนะนำ" (account_code)
 *   ต่ำกว่านี้ = null ให้นักบัญชีเลือกเอง · ไม่เดามั่ว (ผิดบัญชี = ผิดหมวดรายงาน)
 */
const ACCOUNT_THRESHOLD = 0.7;

/** รายการบัญชี non-bank (รหัส=ชื่อ) ใส่ใน prompt ให้โมเดลเลือก — สร้างครั้งเดียวตอนโหลด */
const CHART_PROMPT_LIST = searchChartNonBank("")
  .map((a) => `${a.code}=${a.name}`)
  .join(", ");

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
   *   ★ ชื่อบัญชีให้ worker เติมจากผัง (CHART_BY_CODE) — ไม่เชื่อชื่อจากโมเดล
   */
  account_code: string | null;
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

const SYSTEM_PROMPT =
  "คุณเป็นผู้ช่วยบัญชีที่อ่านรูปบิล/ใบเสร็จ/ใบกำกับภาษี แล้วสกัดข้อมูลเพื่อลงบันทึกภาษีซื้อ/ขาย. " +
  "ตอบเป็น JSON เท่านั้น ตามรูปแบบที่กำหนด. " +
  "ทุก field ที่เป็นค่าเดี่ยว ให้ตอบเป็น object {value, confidence} โดย confidence = ความมั่นใจ 0..1. " +
  "กฎสำคัญที่สุด: ถ้าไม่มั่นใจ อ่านไม่ชัด เบลอ เขียนมือ หรือไม่เห็นในรูป ให้ตั้ง value=null และ confidence ต่ำ " +
  "— ห้ามเดา โดยเฉพาะ 'ตัวเลข' (มูลค่า/ภาษี) ถ้าไม่ชัดให้ value=null เสมอ (เว้นว่างดีกว่าใส่เลขผิด). " +
  "อย่าคำนวณภาษีหัก ณ ที่จ่าย (WHT) — ไม่ต้องส่งค่านั้น. " +
  "อย่าตัดสินว่าเป็นบิลซื้อหรือขาย — แค่สกัด 'ทั้งสองฝั่ง' ให้ครบ: " +
  "seller_name/seller_tax_id = ชื่อและเลขภาษีของ 'ผู้ขาย/ผู้ออกใบกำกับ' (มักอยู่หัวบิล), " +
  "buyer_name/buyer_tax_id = ชื่อและเลขภาษีของ 'ผู้ซื้อ/ลูกค้า' (มักอยู่ช่อง 'ลูกค้า/ผู้ซื้อ'). " +
  "ฝั่งไหนไม่เห็น/ไม่ชัดให้ value=null. " +
  "doc_date เป็นรูปแบบ YYYY-MM-DD (ค.ศ.) ถ้าเป็น พ.ศ. ให้ลบ 543. " +
  "เลขประจำตัวผู้เสียภาษีเป็นเลข 13 หลัก. " +
  "lines = รายการในบิล แต่ละรายการ {vat_type, description:{value,confidence}, amount:{value,confidence}, vat_amount:{value,confidence}, account_code:{value,confidence}} " +
  "โดย vat_type='vat' ถ้ารายการนั้นมี VAT 7%, 'novat' ถ้ายกเว้น/ไม่มี VAT. บิลที่มีทั้งของมี VAT และไม่มี VAT ให้แยกเป็นหลาย line. " +
  "amount = มูลค่าก่อน VAT (ฐานภาษี), vat_amount = ภาษีมูลค่าเพิ่มของรายการนั้น. " +
  "ถ้าบิลมียอดเดียวรวม ๆ ให้ทำเป็น 1 line. overall_confidence = ความมั่นใจรวมทั้งใบ 0..1. " +
  // ★ ให้ AI แนะนำ "รหัสบัญชี" ต่อบรรทัดจากผังกลางเท่านั้น (non-bank) — ไม่มั่นใจ = null
  "account_code = รหัสบัญชีที่เหมาะกับลักษณะรายการ เลือกจาก 'ผังบัญชี' ด้านล่างเท่านั้น " +
  "(เช่น ค่าน้ำมัน→5340, ซื้อสินค้า→5010, ค่าบริการ→5342, ค่าไฟฟ้า→5320). " +
  "ถ้าไม่มั่นใจว่าเข้าบัญชีไหน ให้ account_code value=null (ห้ามเดา — ให้นักบัญชีเลือกเอง). " +
  "ห้ามใช้รหัสนอกรายการนี้ และห้ามเลือกหมวดเงินฝากธนาคาร. " +
  "ผังบัญชี (รหัส=ชื่อ): " + CHART_PROMPT_LIST + ".";

const USER_PROMPT =
  "อ่านบิลในรูปนี้แล้วสกัดข้อมูลเป็น JSON ตามรูปแบบ. จำไว้: ช่องไหนไม่มั่นใจโดยเฉพาะตัวเลข ให้ value=null ห้ามเดา.";

/** ดึง JSON object ก้อนแรกจากข้อความ (เผื่อโมเดลห่อ ```json หรือมีข้อความปน) */
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
 */
function gateString(field: ConfField | undefined): string | null {
  if (!field || typeof field !== "object") return null;
  if (clampConfidence(field.confidence) < FIELD_THRESHOLD) return null;
  const v = field.value;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * gate number field: คืน value ก็ต่อเมื่อ confidence >= threshold และ value เป็นเลขจำกัด >= 0
 *   ★ ตัวเลขคือหัวใจ: ไม่มั่นใจ = null เสมอ (เว้นว่างให้คนคีย์)
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
 * gate account_code ที่ AI แนะนำ: คืน code เฉพาะเมื่อ
 *   - confidence >= ACCOUNT_THRESHOLD (ไม่มั่นใจ = null ให้คนเลือก)
 *   - code อยู่ในผังกลาง "non-bank" จริง (กันรหัสมั่ว/นอกผัง/หมวดเงินฝากธนาคาร)
 *   รองรับทั้งรูป {value, confidence} และ string ตรง ๆ (เผื่อโมเดลตอบต่างรูป)
 */
function gateAccountCode(raw: unknown): string | null {
  let value: unknown = raw;
  let conf = 1; // string ตรง ๆ (ไม่มี confidence) → ถือว่ามั่นใจ แล้วค่อย validate ด้วยผัง
  if (raw && typeof raw === "object") {
    value = (raw as ConfField).value;
    conf = clampConfidence((raw as ConfField).confidence);
  }
  if (conf < ACCOUNT_THRESHOLD) return null;
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!code) return null;
  const acct = CHART_BY_CODE[code];
  // ต้องมีในผัง + ไม่ใช่หมวดเงินฝากธนาคาร (bank = บัญชีต่อลูกค้า ห้าม AI เลือก)
  if (!acct || acct.bank) return null;
  return code;
}

/** normalize 1 line ดิบ → ExtractedLine พร้อม gate ตัวเลขทุกช่อง */
function normalizeLine(raw: unknown): ExtractedLine | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // vat_type: อ่านตรง ๆ (ค่า string) — default 'vat' ถ้าไม่ระบุ/ไม่รู้จัก
  let vatType: "vat" | "novat" = "vat";
  const vtRaw =
    typeof o.vat_type === "string"
      ? o.vat_type
      : typeof (o.vat_type as ConfField)?.value === "string"
        ? String((o.vat_type as ConfField).value)
        : "";
  if (VAT_TYPES.has(vtRaw.trim().toLowerCase())) {
    vatType = vtRaw.trim().toLowerCase() as "vat" | "novat";
  }

  return {
    vat_type: vatType,
    description: gateString(o.description as ConfField),
    amount: gateNumber(o.amount as ConfField),
    vat_amount: gateNumber(o.vat_amount as ConfField),
    account_code: gateAccountCode(o.account_code),
  };
}

/**
 * แปลงผลดิบจากโมเดล → ExtractedBill พร้อมบังคับ high-confidence gating
 *   (แยกออกมาให้เทสต์ตรง logic ได้ โดยไม่ต้องยิง API)
 *   คืน null เมื่อ parse ไม่ได้/ไม่มี line ที่ใช้ได้เลย (ให้ worker สร้าง draft ว่าง/ข้าม)
 */
export function normalizeExtraction(raw: Record<string, unknown> | null): ExtractedBill | null {
  if (!raw) return null;
  const r = raw as RawExtract;

  const linesRaw = Array.isArray(r.lines) ? r.lines : [];
  const lines = linesRaw
    .map(normalizeLine)
    .filter((l): l is ExtractedLine => l !== null);

  // ถ้าไม่มี line ใด ๆ ให้สร้าง 1 line ว่าง (vat) ไว้ให้คนคีย์ — ไม่ทิ้งทั้งใบ
  if (lines.length === 0) {
    lines.push({ vat_type: "vat", description: null, amount: null, vat_amount: null, account_code: null });
  }

  return {
    doc_date: gateString(r.doc_date),
    doc_no: gateString(r.doc_no),
    seller_name: gateString(r.seller_name),
    seller_tax_id: gateString(r.seller_tax_id),
    buyer_name: gateString(r.buyer_name),
    buyer_tax_id: gateString(r.buyer_tax_id),
    lines,
    overall_confidence: clampConfidence(r.overall_confidence),
  };
}

/**
 * สกัดข้อมูลบิลจากรูป (OpenAI vision, detail=high สำหรับตัวเลข, temperature 0)
 *   @returns ExtractedBill (ช่องไม่มั่นใจ = null) · null เมื่อ error/timeout/ไม่มี key
 */
export async function extractBillData(
  imageData: Buffer,
  mime: string
): Promise<ExtractedBill | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // degrade: ไม่มี key → ข้ามการสกัด

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const dataUrl = `data:${mime || "image/jpeg"};base64,${imageData.toString("base64")}`;

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
        max_tokens: 1500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              // detail=high — ต้องอ่านตัวเลขให้ชัด (ต่างจาก classify ที่ใช้ low)
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[bill-extract] openai http ${res.status}`);
      return null;
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    return normalizeExtraction(extractJson(content));
  } catch {
    console.warn("[bill-extract] extract error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
