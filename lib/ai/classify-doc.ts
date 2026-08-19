/**
 * classify-doc.ts — จัดประเภทเอกสารบัญชีด้วย gpt-5-mini (ถูก) ก่อนเลือก extractor
 *   คืน 'statement' (สเตทเมนต์ธนาคาร) | 'platform' (รายงานแพลตฟอร์มขายของ) | 'other' (อื่น ๆ ข้ามไป)
 *
 * ★ ใช้ text snippet เป็นหลัก (digital/ปลดรหัสแล้ว/csv) — ถูกและเร็ว
 *   สแกน/รูป (ไม่มี text) ส่ง image เข้า gpt-5-mini vision ได้ (ถูกกว่า Sonnet สำหรับงานจัดประเภทหยาบ)
 * ★ degrade ปลอดภัย: ไม่มี key / เรียกไม่สำเร็จ → คืน 'other' (ให้ข้าม ไม่เดามั่ว)
 * ★ PDPA: ส่งแค่ snippet สั้น ๆ · ไม่ log เนื้อ
 */
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const CLASSIFY_MODEL = process.env.ACCT_DIGITAL_MODEL || "gpt-5-mini";
const CLASSIFY_TIMEOUT_MS = 30_000;
/** ตัด text ให้สั้น พอจัดประเภท (ไม่ต้องส่งทั้งไฟล์ — ประหยัด token) */
const SNIPPET_CHARS = 2500;

export type AccountingDocType = "statement" | "platform" | "other";

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

const SYSTEM =
  "คุณเป็นผู้ช่วยบัญชี หน้าที่คือ 'จัดประเภทเอกสาร' ที่ให้มา ตอบเป็นคำเดียวเท่านั้นจาก 3 ค่า: " +
  "'statement' = สเตทเมนต์ธนาคาร/รายการเดินบัญชี (มีวันที่ เงินเข้า-ออก ยอดคงเหลือ). " +
  "'platform' = รายงานสรุปยอดขาย/settlement จากแพลตฟอร์มขายของ (Shopee/Lazada/TikTok/Grab/LINE MAN ฯลฯ — มีเลขคำสั่งซื้อ ค่าคอมมิชชั่น ค่าส่ง). " +
  "'other' = อย่างอื่นที่ไม่ใช่สองแบบข้างบน. " +
  "ตอบแค่คำเดียว: statement | platform | other (ไม่มีคำอธิบาย ไม่มีเครื่องหมาย).";

function parseType(raw: string): AccountingDocType {
  const s = (raw || "").toLowerCase();
  if (s.includes("statement")) return "statement";
  if (s.includes("platform")) return "platform";
  return "other";
}

/** จัดประเภทจากข้อความ (digital/csv/ปลดรหัสแล้ว) — ถูกสุด */
export async function classifyDocTypeFromText(text: string): Promise<AccountingDocType> {
  const snippet = (text ?? "").trim().slice(0, SNIPPET_CHARS);
  if (!snippet) return "other";
  return callClassify([
    { role: "system", content: SYSTEM },
    { role: "user", content: `จัดประเภทเอกสารนี้:\n\n${snippet}` },
  ]);
}

/** จัดประเภทจากรูป/สแกน (vision) — ใช้ตอนไม่มี text layer */
export async function classifyDocTypeFromImage(data: Buffer, mime: string): Promise<AccountingDocType> {
  const dataUrl = `data:${mime || "image/jpeg"};base64,${data.toString("base64")}`;
  return callClassify([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: "จัดประเภทเอกสารในภาพนี้ ตอบคำเดียว" },
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
      ],
    },
  ]);
}

async function callClassify(messages: unknown[]): Promise<AccountingDocType> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "other";
  const model = CLASSIFY_MODEL;
  const body: Record<string, unknown> = { model, messages };
  if (isReasoningModel(model)) body.max_completion_tokens = 2000;
  else {
    body.temperature = 0;
    body.max_tokens = 10;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return "other";
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return parseType(json.choices?.[0]?.message?.content ?? "");
  } catch {
    console.warn("[classify-doc] error");
    return "other";
  } finally {
    clearTimeout(timer);
  }
}
