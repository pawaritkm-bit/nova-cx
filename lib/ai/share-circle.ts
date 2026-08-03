/**
 * Share-circle extractor — สกัด "ตารางวงแชร์รายเดือน" จากลิสต์ที่ท้าวแชร์ส่งเข้ากลุ่มไลน์
 *   (รูป + คำพิม) → คืน entry ระดับ "วง/เดือน" ให้นักบัญชีตรวจ/แก้ก่อนลงบัญชี
 *
 * ★ ตรงกับ model ใหม่ (share_circle_entries): 1 วง = 1 object มีคอลัมน์ G/H/I/J/K
 *   ไม่มีรายชื่อสมาชิก/มือรายคน (ไฟล์จริงเก็บแค่ "จำนวนสมาชิก" เป็นตัวเลข)
 *
 * ★ มิเรอร์ config ของ bill-extract.ts — ใช้ OPENAI_EXTRACT_MODEL || 'gpt-5-mini' (reasoning):
 *     max_completion_tokens (ไม่ใช่ temperature) + timeout + repairJsonNumbers + extractJson
 * ★ degrade ปลอดภัย: ไม่มี OPENAI_API_KEY / ไม่มี input / parse ไม่ได้ → คืน [] (ให้คนคีย์เอง)
 * ★ PDPA: ไม่ log เนื้อวง/ชื่อ/ตัวเลข — log แค่ error สั้น ๆ
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

/** ซ่อม JSON: ตัดลูกน้ำคั่นหลักพันในตัวเลข (5,000 → 5000) — เฉพาะ comma ที่มีเลขประกบสองข้าง */
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

// ---------------------------------------------------------------------
// types
// ---------------------------------------------------------------------

/** ผลสกัด 1 วง (ระดับวง/เดือน) — ช่องไม่ชัด = null */
export type ParsedShareCircleEntry = {
  circle_name: string;
  /** รอบเปีย (รายเดือน / ราย 10 วัน / ราย 15 วัน) */
  round_note: string | null;
  member_count: number | null;
  principal_per_head: number | null;
  /** (G) รายได้ท้าว */
  tao_income: number | null;
  /** (H) ค่าบริหารจัดการ */
  mgmt_fee: number | null;
  /** (I) ค่าดำเนินการ/วง */
  operation_fee: number | null;
  /** (J) ดอกเบี้ยรับ */
  interest_income: number | null;
  /** (K) ค่าใช้จ่าย/ต้นทุน */
  expense: number | null;
};

/** รูปภาพ 1 รูป (base64 ล้วน ไม่มี prefix data:) */
export type ShareCircleImage = { base64: string; mime: string };

export type ShareCircleExtractInput = {
  /** ข้อความลิสต์วงแชร์ (จากไลน์) */
  text?: string;
  /** รูปลิสต์ (หลายรูปได้) */
  images?: ShareCircleImage[];
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

/** normalize 1 วงดิบ → ParsedShareCircleEntry (คืน null ถ้าไม่มีเนื้อหาจริง) */
export function normalizeCircle(raw: unknown): ParsedShareCircleEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = asStrOrNull(o.circle_name, 200);

  const tao = asNumOrNull(o.tao_income);
  const mgmt = asNumOrNull(o.mgmt_fee);
  const oper = asNumOrNull(o.operation_fee);
  const interest = asNumOrNull(o.interest_income);
  const expense = asNumOrNull(o.expense);
  const member = asIntOrNull(o.member_count);
  const principal = asNumOrNull(o.principal_per_head);

  // ไม่มีชื่อวง + ไม่มีตัวเลขใดเลย = ไม่มีเนื้อหาจริง → ทิ้ง (ให้คนคีย์เอง)
  if (
    !name &&
    tao === null &&
    mgmt === null &&
    oper === null &&
    interest === null &&
    expense === null &&
    member === null &&
    principal === null
  ) {
    return null;
  }

  return {
    circle_name: name ?? "วงแชร์ (ไม่ระบุชื่อ)",
    round_note: asStrOrNull(o.round_note, 200),
    member_count: member,
    principal_per_head: principal,
    tao_income: tao,
    mgmt_fee: mgmt,
    operation_fee: oper,
    interest_income: interest,
    expense,
  };
}

/** แปลงผลดิบจากโมเดล → รายการวง (กรองวงว่าง + cap กันเยอะผิดปกติ) */
export function normalizeShareCircles(
  raw: Record<string, unknown> | null
): ParsedShareCircleEntry[] {
  if (!raw) return [];
  const arr = Array.isArray(raw.circles) ? raw.circles : [];
  return arr
    .map(normalizeCircle)
    .filter((c): c is ParsedShareCircleEntry => c !== null)
    .slice(0, 200);
}

// ---------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT =
  "คุณเป็นผู้ช่วยบัญชีที่อ่าน 'ลิสต์วงแชร์' ที่ท้าวแชร์ (เจ้ามือ) ส่งเข้ากลุ่มไลน์ (รูป/คำพิม) " +
  "แล้วสกัดเป็นตาราง 'ระดับวง' เพื่อให้นักบัญชีเอาไปคิดภาษี (ภาษีธุรกิจเฉพาะ ภธ.40 รายเดือน + ภงด.90 ปลายปี). " +
  "บริบท: ท้าวแชร์คือคนจัดวงแชร์ — แต่ละวงมีสมาชิกลงเงินหมุนเวียนกัน ท้าวได้รายได้จากการจัดวง " +
  "(เช่น เงินก้อนที่ท้าวเปียได้ / ค่าบริหาร / ดอกเบี้ย). " +
  "ตอบเป็น JSON เท่านั้น ตามรูปแบบที่กำหนด ห้ามมีข้อความอื่นนอก JSON. " +
  "รูปแบบผลลัพธ์: " +
  '{"circles":[{"circle_name":str, "round_note":str|null, "member_count":int|null, ' +
  '"principal_per_head":num|null, "tao_income":num|null, "mgmt_fee":num|null, ' +
  '"operation_fee":num|null, "interest_income":num|null, "expense":num|null}]}. ' +
  "ความหมายของแต่ละช่อง (1 วง = 1 object ในอาเรย์ circles): " +
  "circle_name = ชื่อวง (เช่น 'วงบิท', 'วงคริสต์มาส'), " +
  "round_note = รอบเปีย/รอบการส่ง เป็นข้อความ (เช่น 'รายเดือน', 'ราย 10 วัน', 'ราย 15 วัน'), " +
  "member_count = จำนวนสมาชิกในวง เป็นจำนวนเต็ม (เช่น 21) — ★ ไม่ต้องแยกรายชื่อสมาชิก เอาแค่จำนวน, " +
  "principal_per_head = เงินต้นแชร์ต่อคน (เช่น 100000), " +
  "tao_income = รายได้ท้าว = เงินก้อนที่ท้าวเปีย/ได้จากวงนี้ (คอลัมน์ G), " +
  "mgmt_fee = ค่าบริหารจัดการของท้าวแชร์ (คอลัมน์ H), " +
  "operation_fee = ค่าดำเนินการ/ค่าดูแลของวง (คอลัมน์ I — ส่วนมากเป็น 'ฟรีค่าดูแล' = 0), " +
  "interest_income = ดอกเบี้ยรับ (คอลัมน์ J), " +
  "expense = ค่าใช้จ่าย/ต้นทุนของวง (คอลัมน์ K). " +
  "★ ถ้าลิสต์มีหลายวง ให้แยกเป็นหลาย object ใน circles. " +
  "★ ช่องไหนไม่มี/ไม่ชัดในลิสต์ ให้ใส่ null (อย่าเดามั่ว โดยเฉพาะตัวเลข — เว้นว่างดีกว่าใส่ผิด). " +
  "★ ตัวเลขทุกช่องเป็นตัวเลขล้วน ห้ามมีลูกน้ำคั่นหลักพัน (เช่น 100000 ไม่ใช่ 100,000).";

const USER_PROMPT =
  "อ่านลิสต์วงแชร์ต่อไปนี้ (ข้อความและ/หรือรูป) แล้วสกัดเป็น JSON ตามรูปแบบ. " +
  "แยกให้ครบทุกวง. จำไว้: ช่องไหนไม่ชัดให้ null, ตัวเลขห้ามมีลูกน้ำหลักพัน.";

// ---------------------------------------------------------------------
// สกัดจริง
// ---------------------------------------------------------------------

/**
 * สกัดวงแชร์จากข้อความ และ/หรือ รูป (หลายรูปได้) → รายการวง
 *   ★ degrade: ไม่มี key / ไม่มี input / อ่านไม่ได้ → [] (ให้คนคีย์เอง)
 */
export async function extractShareCircles(
  input: ShareCircleExtractInput
): Promise<ParsedShareCircleEntry[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return []; // degrade: ไม่มี key → ข้ามการสกัด

  const text = typeof input.text === "string" ? input.text.trim() : "";
  const images = Array.isArray(input.images) ? input.images.filter((i) => i && i.base64) : [];
  if (!text && images.length === 0) return []; // ไม่มี input ให้อ่าน

  // ประกอบ content ของ user message: prompt + (ข้อความ) + (รูปทั้งหมด)
  const userContent: Record<string, unknown>[] = [{ type: "text", text: USER_PROMPT }];
  if (text) {
    userContent.push({ type: "text", text: `ลิสต์วงแชร์ (ข้อความ):\n${text}` });
  }
  for (const img of images) {
    const mime = img.mime || "image/jpeg";
    const dataUrl = `data:${mime};base64,${img.base64}`;
    const isPdf = mime.toLowerCase().includes("pdf");
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
    reqBody.max_completion_tokens = 16000; // เผื่อ reasoning tokens + หลายวง
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
      return [];
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return [];
    return normalizeShareCircles(extractJson(content));
  } catch {
    console.warn("[share-circle] extract error");
    return [];
  } finally {
    clearTimeout(timer);
  }
}
