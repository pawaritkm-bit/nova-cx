/**
 * Share-circle extractor — สกัด "วงแชร์" จากลิสต์ที่ท้าวแชร์ส่งเข้ากลุ่มไลน์ (ข้อความ/รูป)
 *   สำหรับหน้า /chat-audit/share-circles — สร้างตารางร่างให้นักบัญชีตรวจ/แก้ก่อนบันทึกเป็นวง + มือ
 *
 * รูปแบบมือทั่วไป: "ลำดับ.ยอดส่ง🌸ดอก ❤️ชื่อ" (บางวงมีแค่ "ลำดับ.ดอก🔥ชื่อ")
 *   มือ 1 มักเป็น "ท้าว" (เจ้าของวง)
 *
 * ★ มิเรอร์ extractBillsData ใน lib/ai/bill-extract.ts — ใช้ gpt-5-mini (reasoning):
 *     max_completion_tokens (ไม่ใช่ max_tokens) + ไม่ส่ง temperature
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY / parse ไม่ได้ → คืน null (ให้คนคีย์เอง)
 * ★ PDPA: ไม่ log เนื้อวง/ชื่อสมาชิก/ตัวเลข — log แค่ error สั้น ๆ
 */

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/** โมเดลสกัด — default gpt-5-mini (reasoning) · override ด้วย env OPENAI_EXTRACT_MODEL */
const MODEL = process.env.OPENAI_EXTRACT_MODEL || "gpt-5-mini";

/** timeout (reasoning model ช้ากว่า — ให้เวลามากขึ้น) */
const REQUEST_TIMEOUT_MS = 110_000;

/** โมเดลตระกูล reasoning (gpt-5 หรือ o-series) — ใช้ max_completion_tokens + ห้ามส่ง temperature */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
};

// ---------------------------------------------------------------------
// helper: ดึง JSON + ซ่อมลูกน้ำหลักพัน (copy จาก bill-extract.ts — duplicate โดยตั้งใจ)
// ---------------------------------------------------------------------

/**
 * ซ่อม JSON ที่โมเดลชอบพลาด: ลูกน้ำคั่นหลักพันในตัวเลข (เช่น 5,000 → 5000)
 *   ตัดเฉพาะ comma ที่ "มีเลขประกบทั้งสองข้าง" — comma โครงสร้าง JSON ไม่โดนแตะ
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

/** ดึง JSON object ก้อนแรกที่สมดุลจากข้อความ (เผื่อโมเดลห่อ ```json หรือมีข้อความปน) */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  // (1) วิธีเร็ว: { แรก → } สุดท้าย
  const lastEnd = text.lastIndexOf("}");
  if (lastEnd > start) {
    const p = tryParse(text.slice(start, lastEnd + 1));
    if (p) return p;
  }

  // (2) brace-matching — คืน object แรกที่ปิดสมดุล (ข้าม string/escape)
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
 * ตัวกันพลาดวันที่ (deterministic): ปี พ.ศ. (≥ 2500) → ลบ 543 เป็น ค.ศ.
 *   เช่น 2569-04-15 → 2026-04-15 · ปีที่เป็น ค.ศ. อยู่แล้วไม่แตะ · รูปแบบอื่นคืนตามเดิม
 */
function fixBuddhistYear(d: string | null): string | null {
  if (!d) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const y = parseInt(m[1], 10);
  return y >= 2500 ? `${y - 543}-${m[2]}-${m[3]}` : d;
}

// ---------------------------------------------------------------------
// types
// ---------------------------------------------------------------------

/** 1 มือ (สมาชิก) ในวง — ช่องไม่ชัด = null */
export type ParsedHand = {
  hand_no: number;
  member_name: string;
  /** ยอดส่ง/งวด (เลขก่อน 🌸) · null = ไม่ชัด */
  send_amount: number | null;
  /** ดอก/เปีย (เลขหลัง 🌸 หรือหลังลำดับ) · null = ไม่ชัด */
  bid_amount: number | null;
  /** true = เป็นท้าว (เจ้าของวง) — มักเป็นมือ 1 */
  is_organizer: boolean;
};

/** ผลสกัดวงแชร์ 1 วง (หัววง + มือทั้งหมด) */
export type ParsedShareCircle = {
  name: string;
  /** ต้น (เงินต้น/มือ) · null = ไม่ระบุ */
  principal: number | null;
  /** จำนวนมือ · null = ไม่ระบุ */
  num_hands: number | null;
  /** ค่าดูแล/มือ · null = ไม่ระบุ */
  fee_per_hand: number | null;
  /** รอบ (ข้อความ เช่น "รายเดือน ทุกวันที่ 15") · null = ไม่ระบุ */
  period_note: string | null;
  /** วันเริ่มวง YYYY-MM-DD (ค.ศ.) · null = ไม่ระบุ */
  start_date: string | null;
  hands: ParsedHand[];
};

// ---------------------------------------------------------------------
// normalize (แยกออกมาให้เทสต์ตรง logic ได้ โดยไม่ต้องยิง API)
// ---------------------------------------------------------------------

/** แปลงค่าเป็นเลข ≥ 0 (null/NaN/ติดลบ → null) */
function asNumOrNull(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** แปลงค่าเป็นจำนวนเต็ม ≥ 0 (null/NaN/ติดลบ → null) */
function asIntOrNull(v: unknown): number | null {
  const n = asNumOrNull(v);
  return n === null ? null : Math.round(n);
}

/** ตัด/trim string (ว่าง → null) จำกัดความยาวกัน payload เพี้ยน */
function asStrOrNull(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

/** date YYYY-MM-DD (ผิดรูป → null) */
function asDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** normalize 1 มือดิบ → ParsedHand (คืน null ถ้าไม่มี hand_no ที่ใช้ได้) */
function normalizeHand(raw: unknown): ParsedHand | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const handNo = asIntOrNull(o.hand_no);
  if (handNo === null || handNo <= 0) return null; // มือที่ไม่มีลำดับ = ทิ้ง
  return {
    hand_no: handNo,
    member_name: asStrOrNull(o.member_name) ?? "",
    send_amount: asNumOrNull(o.send_amount),
    bid_amount: asNumOrNull(o.bid_amount),
    is_organizer: o.is_organizer === true,
  };
}

/**
 * แปลงผลดิบจากโมเดล → ParsedShareCircle
 *   คืน null เมื่อ parse ไม่ได้ / ไม่มีชื่อวงและไม่มีมือเลย (ให้คนคีย์เอง)
 */
export function normalizeShareCircle(
  raw: Record<string, unknown> | null
): ParsedShareCircle | null {
  if (!raw) return null;

  const handsRaw = Array.isArray(raw.hands) ? raw.hands : [];
  const hands = handsRaw
    .map(normalizeHand)
    .filter((h): h is ParsedHand => h !== null)
    .sort((a, b) => a.hand_no - b.hand_no)
    .slice(0, 500); // cap กันวงใหญ่ผิดปกติ

  const name = asStrOrNull(raw.name, 200);
  // ไม่มีชื่อวง + ไม่มีมือ = ไม่มีเนื้อหาจริง → ให้คนคีย์เอง
  if (!name && hands.length === 0) return null;

  return {
    name: name ?? "วงแชร์ (ไม่ระบุชื่อ)",
    principal: asNumOrNull(raw.principal),
    num_hands: asIntOrNull(raw.num_hands),
    fee_per_hand: asNumOrNull(raw.fee_per_hand),
    period_note: asStrOrNull(raw.period_note, 300),
    start_date: fixBuddhistYear(asDateOrNull(raw.start_date)),
    hands,
  };
}

// ---------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT =
  "คุณเป็นผู้ช่วยที่อ่าน 'ลิสต์วงแชร์' ที่ท้าวแชร์ (เจ้ามือ) ส่งเข้ากลุ่มไลน์ แล้วสกัดเป็นตารางเพื่อให้นักบัญชีตรวจ. " +
  "ตอบเป็น JSON เท่านั้น ตามรูปแบบที่กำหนด ห้ามมีข้อความอื่นนอก JSON. " +
  "รูปแบบผลลัพธ์: " +
  '{"name":str, "principal":num|null, "num_hands":int|null, "fee_per_hand":num|null, ' +
  '"period_note":str|null, "start_date":"YYYY-MM-DD"|null, ' +
  '"hands":[{"hand_no":int, "member_name":str, "send_amount":num|null, "bid_amount":num|null, "is_organizer":bool}]}. ' +
  "ความหมายของแต่ละช่อง: " +
  "name = ชื่อวง (เช่น 'วงโปรเจค'), " +
  "principal = ต้น/เงินต้นของวง (เช่น 100000), " +
  "num_hands = จำนวนมือทั้งหมด (เช่นข้อความ 'ถึงมือ 21' → 21), " +
  "fee_per_hand = ค่าดูแลต่อมือ (เช่น 'ดูแล 500/มือ' → 500), " +
  "period_note = ข้อความรอบการส่ง (เช่น 'รายเดือน ทุกวันที่ 15'), " +
  "start_date = วันเริ่มวง/วันของมือแรก แปลงเป็น ค.ศ. รูปแบบ YYYY-MM-DD. " +
  "★ การแปลงปีให้เป็น ค.ศ.: (1) ปี 2 หลัก (เช่น 69) = พ.ศ. ย่อ → 2500+เลข แล้วลบ 543 (69→2569→2026). " +
  "(2) ปี 4 หลัก ≥ 2500 (เช่น 2569) = พ.ศ. → ลบ 543 (2569→2026). " +
  "(3) ปี 4 หลัก < 2500 (เช่น 2026) = ค.ศ. อยู่แล้ว ★ห้ามลบ 543★. " +
  "hands = รายชื่อมือทุกบรรทัด. รูปแบบมือทั่วไป: 'ลำดับ.ยอดส่ง🌸ดอก ❤️ชื่อ' " +
  "(บางวงมีแค่ 'ลำดับ.ดอก🔥ชื่อ' หรือ 'ลำดับ.ยอดส่ง❤️ชื่อ'). แต่ละมือ: " +
  "hand_no = เลขลำดับหน้าจุด, " +
  "member_name = ชื่อสมาชิก (ตัดอิโมจิ/สัญลักษณ์นำหน้าออก เอาเฉพาะชื่อ), " +
  "send_amount = ยอดส่ง (เลขที่อยู่ 'ก่อน' สัญลักษณ์ 🌸 — ถ้าไม่มี 🌸 ให้ใช้เลขแรกที่เป็นยอดส่ง), " +
  "bid_amount = ดอก/เปีย (เลขที่อยู่ 'หลัง' 🌸 หรือหลังลำดับในวงแบบดอกอย่างเดียว), " +
  "is_organizer = true ถ้ามือนั้นเป็น 'ท้าว' (มีคำว่า ท้าว/เจ้ามือ — มักเป็นมือ 1). " +
  "ช่องไหนไม่ชัด/ไม่มีในลิสต์ ให้ใส่ null (อย่าเดามั่ว โดยเฉพาะตัวเลข). " +
  "★ ตัวเลขทุกช่องเป็นตัวเลขล้วน ห้ามมีลูกน้ำคั่นหลักพัน (เช่น 5000 ไม่ใช่ 5,000).";

const USER_PROMPT =
  "อ่านลิสต์วงแชร์ต่อไปนี้แล้วสกัดเป็น JSON ตามรูปแบบ. เก็บมือให้ครบทุกบรรทัดตามลำดับ. " +
  "จำไว้: ช่องไหนไม่ชัดให้ null, ตัวเลขห้ามมีลูกน้ำหลักพัน.";

// ---------------------------------------------------------------------
// สกัดจริง
// ---------------------------------------------------------------------

export type ShareCircleInput = {
  /** ข้อความลิสต์วงแชร์ (วางจากไลน์) */
  text?: string;
  /** รูปภาพลิสต์ (base64 ล้วน ไม่มี prefix data:) */
  imageBase64?: string;
  /** MIME ของรูป (เช่น image/jpeg, application/pdf) */
  mime?: string;
};

/**
 * สกัดวงแชร์จากข้อความ และ/หรือ รูป → ParsedShareCircle
 *   ★ รับ text อย่างเดียว, รูปอย่างเดียว, หรือทั้งคู่ก็ได้
 *   ★ degrade: ไม่มี key / ไม่มี input / อ่านไม่ได้ → null
 */
export async function parseShareCircle(
  input: ShareCircleInput
): Promise<ParsedShareCircle | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // degrade: ไม่มี key → ข้ามการสกัด

  const text = typeof input.text === "string" ? input.text.trim() : "";
  const imageBase64 = typeof input.imageBase64 === "string" ? input.imageBase64 : "";
  if (!text && !imageBase64) return null; // ไม่มี input ให้อ่าน

  // ประกอบ content ของ user message: prompt + (ข้อความ) + (รูป/ไฟล์)
  const userContent: Record<string, unknown>[] = [{ type: "text", text: USER_PROMPT }];
  if (text) {
    userContent.push({ type: "text", text: `ลิสต์วงแชร์:\n${text}` });
  }
  if (imageBase64) {
    const mime = input.mime || "image/jpeg";
    const dataUrl = `data:${mime};base64,${imageBase64}`;
    const isPdf = mime.toLowerCase().includes("pdf");
    // รูป → image_url (detail=high อ่านเลขชัด) · PDF → file input
    userContent.push(
      isPdf
        ? { type: "file", file: { filename: "share-circle.pdf", file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
    );
  }

  const reasoning = isReasoningModel(MODEL);
  const reqBody: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  if (reasoning) {
    reqBody.max_completion_tokens = 16000; // เผื่อ reasoning tokens + มือเยอะ
  } else {
    reqBody.temperature = 0;
    reqBody.max_tokens = 8000;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[share-circle] openai http ${res.status}`);
      return null;
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalizeShareCircle(extractJson(content));
  } catch {
    console.warn("[share-circle] extract error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
