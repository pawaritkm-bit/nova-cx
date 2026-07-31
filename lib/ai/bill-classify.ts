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

/**
 * จำแนกรูปว่าเป็นเอกสารการเงินหรือไม่ (OpenAI vision)
 *   @returns ผลการคัด · null เมื่อ error/timeout/ไม่มี key (caller ถือว่า keep)
 */
export async function classifyBillImage(
  data: Buffer,
  mime: string
): Promise<BillClassifyResult | null> {
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
