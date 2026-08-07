/**
 * Statement extractor — AI แยกรายการสเตทเมนต์ธนาคาร (ขาเข้า/ขาออก) ด้วย OpenAI
 *   สำหรับฟีเจอร์ "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (Phase 1)
 *
 * รับไฟล์ PDF/รูป (ส่งตรงเข้า OpenAI file/image input) หรือข้อความที่แปลงจาก Excel/CSV แล้ว
 *   → คืนลิสต์ธุรกรรม { date, description, counterparty_name, direction, amount }
 *
 * ★ ใช้ config เดียวกับ bill-extract: EXTRACT_MODEL (gpt-5-mini), isReasoningModel,
 *   max_completion_tokens, timeout, repairJsonNumbers, extractJson
 * ★ วิธีตัดสิน in/out: ดูคอลัมน์ ฝาก/ถอน (deposit/withdrawal) หรือเครื่องหมาย +/− ในสเตทเมนต์
 * ★ วันที่: แปลง พ.ศ.→ค.ศ. ให้ถูก · เดือนตัดตามเวลาไทยทำที่ statement-analyze (bkkMonthKey)
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY / อ่านไม่ได้ → คืน [] (ให้ผู้ใช้คีย์เอง/ลองใหม่)
 * ★ PDPA: ไม่ log เนื้อสเตทเมนต์/ชื่อ/ยอด — log แค่ error สั้น ๆ ไม่มีข้อมูลอ่อนไหว
 */

import type { StatementTxn, TxnDirection } from "@/lib/accounting/statement-analyze";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/** โมเดลอ่านสเตทเมนต์ (PDF/ตารางยาว) — ใช้ตัวเดียวกับอ่านไฟล์บิลอัปเอง */
const EXTRACT_MODEL = process.env.OPENAI_EXTRACT_MODEL || "gpt-5-mini";

/** timeout — reasoning model + สเตทเมนต์หลายหน้า/หลายรายการ ช้ากว่าปกติ */
const EXTRACT_TIMEOUT_MS = 110_000;

/** cap จำนวนรายการต่อไฟล์ (กัน output ระเบิด/ค่าใช้จ่ายพุ่ง) */
const MAX_TXNS = 2000;

/** โมเดลตระกูล reasoning (gpt-5 หรือ o-series) — ใช้ max_completion_tokens + ห้ามส่ง temperature */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
};

const SYSTEM_PROMPT =
  "คุณเป็นผู้ช่วยบัญชีที่อ่าน 'สเตทเมนต์ธนาคาร' (bank statement / รายการเดินบัญชี) แล้วสกัดทุกธุรกรรมออกมาเป็น JSON. " +
  "ตอบเป็น JSON เท่านั้น รูปแบบ {\"transactions\":[ {date, description, counterparty_name, direction, amount}, ... ]}. " +
  "กฎการอ่าน 'ทิศทางเงิน' (direction) สำคัญที่สุด: " +
  "direction='in' = เงินเข้า/ฝาก/รับโอน/เครดิต (อยู่คอลัมน์ 'ฝาก'/'เงินเข้า'/'Deposit'/'Credit' หรือเครื่องหมาย +). " +
  "direction='out' = เงินออก/ถอน/จ่ายโอน/เดบิต (อยู่คอลัมน์ 'ถอน'/'เงินออก'/'Withdrawal'/'Debit' หรือเครื่องหมาย −). " +
  "ถ้าสเตทเมนต์มีคอลัมน์ยอดคงเหลือ (Balance) ห้ามเอามาเป็น amount — amount คือ 'ยอดของธุรกรรมนั้น' เท่านั้น. " +
  "amount = จำนวนเงินของธุรกรรม เป็นเลขบวกเสมอ (ไม่ใส่เครื่องหมายลบ — ทิศทางอยู่ที่ direction แล้ว). " +
  "date รูปแบบ 'YYYY-MM-DD' (ค.ศ.). ปีในสเตทเมนต์อาจเป็น พ.ศ.: ถ้าปี >= 2500 (เช่น 2569) ให้ลบ 543 เป็น ค.ศ. (2569→2026). " +
  "ปีที่เป็น ค.ศ. อยู่แล้ว (เช่น 2026) ห้ามลบ 543. บางสเตทเมนต์มีแต่วัน/เดือน ให้เดาปีจากบริบทหัวสเตทเมนต์. " +
  "counterparty_name = ชื่อ 'คู่ค้า/อีกฝ่าย' ของธุรกรรม (คนที่โอนเข้ามา หรือผู้รับโอน/ร้านค้า) เท่าที่อ่านได้จากรายละเอียด " +
  "(เช่น 'โอนเงินจาก นายสมชาย ใจดี' → counterparty_name='นายสมชาย ใจดี'). อ่านชื่อไม่ได้/ไม่มี ให้ counterparty_name=null. " +
  "description = คำอธิบายรายการ/ช่องบันทึกช่วยจำ (memo) ตามที่เห็น. อ่านไม่ออกช่องไหน ให้เป็น null. " +
  "★ ตัวเลขทุกช่องเป็นเลขล้วน ห้ามมีลูกน้ำคั่นหลักพัน (12500.00 ไม่ใช่ 12,500.00). " +
  "สกัด 'ทุกแถวธุรกรรม' ตามลำดับที่ปรากฏ ห้ามข้าม ห้ามรวมยอด. ถ้าแถวไหนไม่ใช่ธุรกรรม (หัวตาราง/ยอดยกมา/สรุป) ให้ข้าม.";

const FILE_USER_PROMPT =
  "อ่านสเตทเมนต์ในเอกสารนี้ แล้วสกัดทุกธุรกรรมเป็น JSON {\"transactions\":[...]} ตามกฎ. " +
  "จำไว้: direction ต้องถูก (เข้า=in / ออก=out), amount เป็นเลขบวกของธุรกรรม (ไม่ใช่ยอดคงเหลือ), ไม่มีลูกน้ำคั่นพัน.";

const TEXT_USER_PROMPT =
  "ด้านล่างคือข้อมูลสเตทเมนต์ธนาคารที่ถูกแปลงเป็นข้อความ/ตาราง (มาจากไฟล์ Excel/CSV). " +
  "อ่านแล้วสกัดทุกธุรกรรมเป็น JSON {\"transactions\":[...]} ตามกฎ. " +
  "จำไว้: direction ต้องถูก (เข้า=in / ออก=out), amount เป็นเลขบวกของธุรกรรม (ไม่ใช่ยอดคงเหลือ), ไม่มีลูกน้ำคั่นพัน.\n\n";

/** ซ่อม JSON: ลูกน้ำคั่นหลักพันในตัวเลข (2,500.00 → 2500.00) — เหมือน bill-extract */
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

/** ดึง JSON object ก้อนแรกที่สมดุลจากข้อความ (เผื่อโมเดลห่อ ```json / มีข้อความปน) */
export function extractJson(text: string): Record<string, unknown> | null {
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

/** map ค่าทิศทางดิบ (in/out/deposit/credit/…) → 'in'|'out'|null */
function toDirection(v: unknown, amountSign?: number): TxnDirection | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["in", "deposit", "credit", "cr", "เข้า", "ฝาก", "รับ"].includes(s)) return "in";
  if (["out", "withdrawal", "withdraw", "debit", "dr", "ออก", "ถอน", "จ่าย"].includes(s)) return "out";
  // fallback: เดาจากเครื่องหมายจำนวนเงิน (ถ้าโมเดลใส่ค่าติดลบมา)
  if (typeof amountSign === "number") {
    if (amountSign > 0) return "in";
    if (amountSign < 0) return "out";
  }
  return null;
}

/**
 * normalize ผลดิบจากโมเดล → StatementTxn[] (แยกออกมาให้ทดสอบ logic ได้โดยไม่ยิง API)
 *   - รับได้ทั้ง { transactions:[...] } และ array ตรง ๆ
 *   - ข้ามแถวที่ไม่มีทั้งวันที่ ยอด และชื่อ (แถวขยะ)
 */
export function normalizeStatementExtraction(raw: Record<string, unknown> | unknown[] | null): StatementTxn[] {
  if (!raw) return [];
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { transactions?: unknown }).transactions)
      ? ((raw as { transactions: unknown[] }).transactions)
      : Array.isArray((raw as { rows?: unknown }).rows)
        ? ((raw as { rows: unknown[] }).rows)
        : [];

  const out: StatementTxn[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    // เผื่อโมเดลใส่ยอดติดลบเพื่อบอกทิศทาง → เก็บ sign ไว้ช่วยเดา direction
    const rawAmountNum =
      typeof o.amount === "number"
        ? o.amount
        : typeof o.amount === "string"
          ? Number((o.amount as string).replace(/,/g, "").trim())
          : NaN;

    const date = fixBuddhistYear(toText(o.date));
    const description = toText(o.description ?? o.memo ?? o.detail);
    const counterparty = toText(o.counterparty_name ?? o.counterparty ?? o.name);
    const amount = toAmount(o.amount);
    const direction = toDirection(o.direction, Number.isFinite(rawAmountNum) ? rawAmountNum : undefined);

    // ข้ามแถวว่างจริง (ไม่มีวันที่ ไม่มียอด ไม่มีชื่อ) — น่าจะเป็นหัว/สรุป
    if (!date && amount === null && !counterparty) continue;

    out.push({ date, description, counterparty_name: counterparty, direction, amount });
    if (out.length >= MAX_TXNS) break;
  }
  return out;
}

/** เรียก OpenAI ด้วย message content ที่ประกอบไว้แล้ว → คืน StatementTxn[] */
async function callExtract(userContent: unknown): Promise<StatementTxn[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

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
    reqBody.max_completion_tokens = 32000; // สเตทเมนต์ยาว หลายร้อยรายการ + reasoning tokens
  } else {
    reqBody.temperature = 0;
    reqBody.max_tokens = 16000;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[statement-extract] openai http ${res.status}`);
      return [];
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return [];
    return normalizeStatementExtraction(extractJson(content));
  } catch {
    console.warn("[statement-extract] extract error");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * สกัดธุรกรรมจากไฟล์ PDF/รูป (ส่งตรงเข้า OpenAI file/image input)
 *   @returns StatementTxn[] · [] เมื่อ error/timeout/ไม่มี key
 */
export async function extractStatementFromFile(fileData: Buffer, mime: string): Promise<StatementTxn[]> {
  const isPdf = (mime || "").toLowerCase().includes("pdf");
  const dataUrl = `data:${mime || "image/jpeg"};base64,${fileData.toString("base64")}`;
  const filePart = isPdf
    ? { type: "file", file: { filename: "statement.pdf", file_data: dataUrl } }
    : { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
  return callExtract([{ type: "text", text: FILE_USER_PROMPT }, filePart]);
}

/**
 * สกัดธุรกรรมจากข้อความ (แปลงมาจาก Excel/CSV แล้ว)
 *   @returns StatementTxn[] · [] เมื่อ error/timeout/ไม่มี key/ข้อความว่าง
 */
export async function extractStatementFromText(text: string): Promise<StatementTxn[]> {
  const t = (text ?? "").trim();
  if (!t) return [];
  return callExtract(TEXT_USER_PROMPT + t);
}
