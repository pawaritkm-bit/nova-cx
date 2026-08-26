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

import { classifyDocSource } from "@/lib/accounting/doc-source";
import { downscaleImageIfLarge } from "@/lib/accounting/image-prep";
import { extractPdfMaybeSplit } from "@/lib/accounting/pdf-split";
import type { StatementTxn, TxnDirection } from "@/lib/accounting/statement-analyze";
import { extractJsonWithClaude } from "@/lib/ai/claude-extract";
import { extractJsonWithGemini } from "@/lib/ai/gemini-extract";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/** โมเดลอ่านสเตทเมนต์ (PDF/ตารางยาว) — ใช้ตัวเดียวกับอ่านไฟล์บิลอัปเอง */
const EXTRACT_MODEL = process.env.ACCT_DIGITAL_MODEL || process.env.OPENAI_EXTRACT_MODEL || "gpt-5-mini";

/** timeout — เรียกครั้งเดียวจบ (PDF/รูป, ไม่ chunk) — reasoning model + เอกสารหลายหน้า ช้ากว่าปกติ */
const EXTRACT_TIMEOUT_MS = 110_000;

/**
 * ★ 2026-08-12 — timeout ต่อ "ชุด" (chunk) เมื่อยิง AI หลายชุดพร้อมกัน — ชุดละ ~700 แถวเล็กกว่าสเตทเมนต์
 *   เต็มไฟล์มาก ไม่จำเป็นต้องรอนานเท่า EXTRACT_TIMEOUT_MS · ตั้งให้สั้นลงเพื่อคุม wall-clock รวมของไฟล์ใหญ่
 *   ที่ต้องยิงหลายรอบ (MAX_CHUNKS÷MAX_CONCURRENT_CHUNKS รอบ) ให้อยู่ใน maxDuration ของ route ได้จริง
 *   (พบจาก independent review — เดิมใช้ EXTRACT_TIMEOUT_MS 110s ต่อรอบ × สูงสุด 6 รอบ เสี่ยงเกิน maxDuration)
 */
const CHUNK_EXTRACT_TIMEOUT_MS = 45_000;

/** cap จำนวนรายการต่อการเรียก AI 1 ครั้ง (กัน output ระเบิด/ค่าใช้จ่ายพุ่ง) — ทำงานต่อ "ชุด" ไม่ใช่ต่อไฟล์
 *   ทั้งไฟล์เมื่อใช้ผ่าน extractStatementFromTextChunks (ชุดละ ~700 แถวไม่มีทางแตะเพดานนี้อยู่แล้ว) */
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
  "ตอบเป็น JSON เท่านั้น รูปแบบ {\"transactions\":[ {date, description, counterparty_name, counterparty_account_no, direction, amount}, ... ]}. " +
  "counterparty_account_no = เลขบัญชี/เลขที่บัตรของคู่ค้าฝั่งตรงข้าม ถ้าสเตทเมนต์แสดงไว้ (อาจเป็นเลขเต็มหรือเลขที่ปิดบัง " +
  "บางส่วนเช่น 'x-xxxx-x1234-x') เก็บตามที่เห็นเป๊ะ (รวมเครื่องหมาย x ถ้ามี ไม่ต้องถอดรหัส) อ่านไม่ได้/ไม่มี → null. " +
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
    const accountNo = toText(
      o.counterparty_account_no ?? o.account_no ?? o.account_number ?? o.accountNo
    );
    const amount = toAmount(o.amount);
    const direction = toDirection(o.direction, Number.isFinite(rawAmountNum) ? rawAmountNum : undefined);

    // ข้ามแถวว่างจริง (ไม่มีวันที่ ไม่มียอด ไม่มีชื่อ ไม่มีเลขบัญชี) — น่าจะเป็นหัว/สรุป
    if (!date && amount === null && !counterparty && !accountNo) continue;

    out.push({ date, description, counterparty_name: counterparty, counterparty_account_no: accountNo, direction, amount });
    if (out.length >= MAX_TXNS) break;
  }
  return out;
}

/** ผลจาก callExtract — แยก "อ่านแล้วไม่มีธุรกรรม" ออกจาก "เรียก AI ไม่สำเร็จ" (แก้บั๊ก D) */
type ExtractCallResult = { txns: StatementTxn[]; failed: boolean };

/** เรียก OpenAI ด้วย message content ที่ประกอบไว้แล้ว → คืน { txns, failed }
 *   @param timeoutMs default = EXTRACT_TIMEOUT_MS (เรียกครั้งเดียวจบ) — ทางเรียกแบบ chunk ส่ง
 *   CHUNK_EXTRACT_TIMEOUT_MS สั้นกว่าเข้ามาแทน (ดูคอมเมนต์เหนือ const ทั้งสองตัว) */
async function callExtract(userContent: unknown, timeoutMs: number = EXTRACT_TIMEOUT_MS): Promise<ExtractCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { txns: [], failed: true };

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[statement-extract] openai http ${res.status}`);
      return { txns: [], failed: true };
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { txns: [], failed: true };
    const parsed = extractJson(content);
    // ★ แก้บั๊ก D — parse ไม่ได้ (เช่น output ถูกตัดกลางคันเพราะ token หมด) ต้องถือเป็น "ล้มเหลว" ไม่ใช่
    //   "อ่านแล้วไม่มีธุรกรรม" (เดิมทั้งสองกรณีคืน [] เหมือนกันหมด แยกไม่ออกจากภายนอกเลย)
    if (parsed === null) {
      console.warn("[statement-extract] json parse failed");
      return { txns: [], failed: true };
    }
    return { txns: normalizeStatementExtraction(parsed), failed: false };
  } catch {
    console.warn("[statement-extract] extract error");
    return { txns: [], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * สกัดธุรกรรมจากไฟล์ PDF/รูป — PDF ใหญ่เกินเพดานจะถูกตัดเป็นชิ้นอ่านทีละชิ้นแล้วรวมผลอัตโนมัติ
 *   @returns StatementTxn[] · [] เมื่อ error/timeout/ไม่มี key
 */
export async function extractStatementFromFile(fileData: Buffer, mime: string): Promise<StatementTxn[]> {
  return extractPdfMaybeSplit(fileData, mime, extractStatementFromFileSingle);
}

/** โมเดลชื่อธนาคารที่รู้จัก — normalize คำตอบ AI ให้เป็นป้ายสั้น ๆ สม่ำเสมอ */
const BANK_ALIASES: { re: RegExp; label: string }[] = [
  { re: /kasikorn|kbank|กสิกร/i, label: "กสิกรไทย" },
  { re: /siam commercial|scb|ไทยพาณิชย์/i, label: "ไทยพาณิชย์" },
  { re: /bangkok bank|bbl|กรุงเทพ/i, label: "กรุงเทพ" },
  { re: /krung ?thai|ktb|กรุงไทย/i, label: "กรุงไทย" },
  { re: /krungsri|ayudhya|กรุงศรี/i, label: "กรุงศรีอยุธยา" },
  { re: /\bttb\b|tmb|thanachart|ทหารไทย|ธนชาต/i, label: "ทหารไทยธนชาต" },
  { re: /government savings|gsb|ออมสิน/i, label: "ออมสิน" },
  { re: /kiatnakin|kkp|เกียรตินาคิน/i, label: "เกียรตินาคินภัทร" },
  { re: /uob|ยูโอบี/i, label: "ยูโอบี" },
  { re: /cimb|ซีไอเอ็มบี/i, label: "ซีไอเอ็มบี" },
  { re: /baac|เพื่อการเกษตร|ธ\.?ก\.?ส/i, label: "ธ.ก.ส." },
  { re: /islamic|อิสลาม/i, label: "อิสลามแห่งประเทศไทย" },
  { re: /ghb|อาคารสงเคราะห์/i, label: "อาคารสงเคราะห์" },
];

/** map ชื่อธนาคารดิบ → ป้ายมาตรฐาน (ไม่รู้จัก = คืนค่าที่อ่านได้ ตัดคำว่า "ธนาคาร/bank" ออก) */
export function normalizeBankName(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || /^(null|unknown|ไม่ทราบ|ไม่ระบุ|n\/?a|-)$/i.test(s)) return null;
  for (const a of BANK_ALIASES) if (a.re.test(s)) return a.label;
  const cleaned = s.replace(/ธนาคาร|bank|จำกัด|มหาชน|\(.*?\)|public company limited/gi, "").trim();
  return cleaned.slice(0, 40) || null;
}

/** prompt สั้น ๆ ถามชื่อธนาคารจากรูป/ไฟล์สเตทเมนต์ */
const BANK_SYSTEM_PROMPT =
  "คุณดู 'สเตทเมนต์ธนาคาร' แล้วบอกว่าเป็นของธนาคารอะไร. ตอบ JSON เท่านั้น {\"bank\": \"<ชื่อธนาคารภาษาไทยแบบสั้น เช่น กสิกรไทย/ไทยพาณิชย์/กรุงเทพ/กรุงไทย/กรุงศรีอยุธยา/ทหารไทยธนชาต/ออมสิน/เกียรตินาคินภัทร>\"}. " +
  "ดูจากโลโก้/หัวกระดาษ/ชื่อธนาคารบนเอกสาร. ถ้าไม่เห็นชื่อธนาคารชัดเจน ให้ bank=null (ห้ามเดามั่ว).";

/**
 * เดา "ชื่อธนาคาร" จากรูป/ไฟล์สเตทเมนต์ (สำหรับแยกชีตตามธนาคารในไฟล์สรุป) — best-effort
 *   ★ 1 vision call (Gemini ก่อน · ถูก) · อ่านไม่ได้/ไม่มี key/ไม่ชัด → null (ลงชีต "ไม่ระบุธนาคาร")
 *   ★ PDPA: ไม่ log เนื้อ — คืนแค่ป้ายธนาคาร
 */
export async function detectStatementBank(fileData: Buffer, mime: string): Promise<string | null> {
  try {
    const prepped = await downscaleImageIfLarge(fileData, mime);
    const raw = await extractJsonWithGemini({
      source: "statement_extract",
      system: BANK_SYSTEM_PROMPT,
      userPrompt: "ธนาคารอะไร ตอบ JSON {bank}.",
      fileData: prepped.data,
      mime: prepped.mime || mime,
    });
    const bank = raw && typeof raw === "object" ? (raw as { bank?: unknown }).bank : null;
    return normalizeBankName(typeof bank === "string" ? bank : null);
  } catch {
    return null;
  }
}

/** เรียก AI ครั้งเดียว (ไฟล์/ชิ้นเดียว ≤เพดาน) — ตัวจริงที่ extractStatementFromFile / split เรียก */
async function extractStatementFromFileSingle(fileData: Buffer, mime: string): Promise<StatementTxn[]> {
  const source = await classifyDocSource(mime, fileData);
  const prepped = await downscaleImageIfLarge(fileData, mime); // ย่อรูปสแกนใหญ่ (PDF ไม่แตะ)

  // สแกน/รูป (OCR) → Claude Sonnet 5 (vision แม่นกับภาพยาก/เอียง/เบลอ) ก่อน
  if (source === "scan_or_image") {
    const raw = await extractJsonWithClaude({
      system: SYSTEM_PROMPT,
      userPrompt: FILE_USER_PROMPT,
      fileData: prepped.data,
      mime: prepped.mime || mime,
    });
    if (raw !== null) return normalizeStatementExtraction(raw);
    // Claude ล่ม/ไม่มี key → ลอง Gemini ต่อด้านล่าง
  }

  // digital_pdf หรือ fallback จากสแกน → Gemini (ถูก + ไม่พึ่ง OpenAI) · ★ deterministic ลองไปก่อนแล้วที่ classify-finance-doc
  const gem = await extractJsonWithGemini({
    source: "statement_extract",
    system: SYSTEM_PROMPT,
    userPrompt: FILE_USER_PROMPT,
    fileData: prepped.data,
    mime: prepped.mime || mime,
  });
  if (gem !== null) return normalizeStatementExtraction(gem);

  // สุดท้าย: OpenAI (เฉพาะเมื่อยังตั้ง OPENAI_API_KEY ไว้ — prod ปกติไม่ตั้ง = ข้าม) กันงานตกเป็นทางเลือกสุดท้าย
  const isPdf = (mime || "").toLowerCase().includes("pdf");
  const dataUrl = `data:${prepped.mime || "image/jpeg"};base64,${prepped.data.toString("base64")}`;
  const filePart = isPdf
    ? { type: "file", file: { filename: "statement.pdf", file_data: dataUrl } }
    : { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
  const { txns } = await callExtract([{ type: "text", text: FILE_USER_PROMPT }, filePart]);
  return txns;
}

/**
 * สกัดธุรกรรมจากข้อความก้อนเดียว (แปลงมาจาก Excel/CSV แล้ว) — เรียกครั้งเดียวจบ (ไม่ chunk)
 *   @returns StatementTxn[] · [] เมื่อ error/timeout/ไม่มี key/ข้อความว่าง
 */
export async function extractStatementFromText(text: string): Promise<StatementTxn[]> {
  const t = (text ?? "").trim();
  if (!t) return [];
  // Gemini อ่านก่อน (ถูก + ไม่พึ่ง OpenAI) · ล้ม → OpenAI เป็นทางเลือกสุดท้าย (ถ้าตั้ง key)
  const gem = await extractJsonWithGemini({ source: "statement_extract", system: SYSTEM_PROMPT, userPrompt: TEXT_USER_PROMPT, text: t });
  if (gem !== null) return normalizeStatementExtraction(gem);
  const { txns } = await callExtract(TEXT_USER_PROMPT + t);
  return txns;
}

/**
 * จำนวนชุดที่ยิง AI พร้อมกันสูงสุด (กัน rate limit ฝั่ง OpenAI + คุม wall-clock รวมให้อยู่ใน maxDuration)
 *   ★ 2026-08-12 (พบจาก independent review) — ที่ 4 เดิม + MAX_CHUNKS=24 ต้องรอ 6 รอบ ซึ่งเสี่ยงเกิน
 *   maxDuration ของ route ถ้าแต่ละรอบใช้เวลานาน ปรับเป็น 8 (24÷8 = 3 รอบ) ร่วมกับลด timeout ต่อชุดลง
 *   (CHUNK_EXTRACT_TIMEOUT_MS) — worst case = 3 รอบ × 45s = 135s ยังมี headroom เหลือจาก maxDuration
 */
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

/** ผลรวมจากการสกัดหลายชุด (แก้บั๊ก A — ไฟล์ใหญ่แบ่งเป็นชุดแทนที่จะยิง AI ครั้งเดียวจบ) */
export type ChunkedExtractionResult = {
  txns: StatementTxn[];
  /** จำนวนชุดทั้งหมดที่พยายามอ่าน */
  chunkCount: number;
  /** จำนวนชุดที่อ่านไม่สำเร็จ (error/timeout/parse ไม่ได้ — ไม่ใช่ "ชุดนี้ไม่มีธุรกรรมจริง ๆ") */
  failedChunks: number;
};

/**
 * สกัดธุรกรรมจากข้อความที่แบ่งเป็นหลายชุดแล้ว (ดู `statement-parse.ts::excelBufferToRows/csvBufferToRows`)
 *   — ยิง AI พร้อมกันสูงสุด MAX_CONCURRENT_CHUNKS ชุด (ไม่ทำทีละชุดเรียงลำดับ กันรวมเวลาเกิน maxDuration
 *   ของ serverless function) แล้วรวมผลลัพธ์ + นับจำนวนชุดที่ล้มเหลวไว้รายงานผู้ใช้ (แก้บั๊ก D)
 */
export async function extractStatementFromTextChunks(chunks: string[]): Promise<ChunkedExtractionResult> {
  if (chunks.length === 0) return { txns: [], chunkCount: 0, failedChunks: 0 };
  const perChunk = await mapWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunkText) => {
    return callExtract(TEXT_USER_PROMPT + chunkText, CHUNK_EXTRACT_TIMEOUT_MS);
  });
  const txns = perChunk.flatMap((r) => r.txns);
  const failedChunks = perChunk.filter((r) => r.failed).length;
  return { txns, chunkCount: chunks.length, failedChunks };
}
