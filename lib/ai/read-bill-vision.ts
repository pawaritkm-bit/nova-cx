/**
 * read-bill-vision.ts — อ่าน "บิล/ใบเสร็จ" จากรูป (พิมพ์/เขียนมือ) แบบมีโครงสร้าง
 *   สถาปัตยกรรม "สอง AI":
 *     🅰 ตัวอ่าน  = Gemini Flash (paid tier — ไม่เทรนข้อมูล) ถูก+เก่งลายมือไทย
 *     🅱 ตัวตรวจ = Claude — เรียก "เฉพาะใบที่ไม่ชัวร์" (ยอดไม่ตรง/มั่นใจต่ำ) เพื่อคุมต้นทุน
 *   คืนข้อมูลบิล + flags จุดที่ต้องให้นักบัญชีตรวจ (สองตัวอ่านไม่ตรงกัน / ยอดรวมไม่ตรงกับผลรวมรายการ)
 *
 * ★ best-effort: ไม่มี key / error / อ่านไม่ออก → null (caller ตกไป path เดิม)
 * ★ PDPA: ใช้ Gemini paid tier เท่านั้น (free tier เทรนข้อมูล) · ไม่ log เนื้อบิล/ยอด
 */

const GEMINI_MODEL = process.env.ACCT_VISION_MODEL || "gemini-3.6-flash";
const CLAUDE_MODEL = process.env.ACCT_VERIFY_MODEL || "claude-sonnet-5";
const TIMEOUT_MS = 60000;

export type BillLine = {
  qty: number | null;
  description: string | null;
  unitPrice: number | null;
  amount: number | null;
};

export type BillVisionResult = {
  /** เดาประเภทจากภาพ (ซื้อ/ขาย ตัดสินจริงตอน match กับชื่อลูกค้า downstream) */
  docType: "purchase" | "sale" | "unspecified";
  seller: string | null;
  buyer: string | null;
  sellerTaxId: string | null;
  docNo: string | null;
  /** ISO ค.ศ. YYYY-MM-DD */
  docDate: string | null;
  /** ใบกำกับภาษีเต็มรูป (มีเลขผู้เสียภาษีผู้ขาย + คำว่าใบกำกับภาษี) → หักภาษีซื้อได้ */
  isTaxInvoice: boolean;
  /** เป็นบิลเขียนมือไหม (เพื่อชูตรวจ + เสนอใบรับรองแทนใบเสร็จ) */
  handwritten: boolean;
  lines: BillLine[];
  vatTotal: number | null;
  grandTotal: number | null;
  /** 0–1 ความมั่นใจของตัวอ่าน */
  confidence: number;
};

export type BillReadOutcome = {
  result: BillVisionResult;
  /** จุดที่นักบัญชีควรตรวจ (สองตัวอ่านไม่ตรง / ยอดรวมไม่ตรงผลรวมรายการ) */
  flags: string[];
  /** ตัวอ่านที่ใช้: gemini · gemini+claude (ensemble เมื่อไม่ชัวร์) */
  readers: string;
};

const PROMPT =
  "นี่คือรูปบิล/ใบเสร็จ/ใบกำกับภาษีของไทย อ่านให้ละเอียดแล้วตอบเป็น JSON เท่านั้น (ไม่มีข้อความอื่น) ตาม schema:\n" +
  '{"docType":"purchase|sale|unspecified","seller":str|null,"buyer":str|null,"sellerTaxId":str|null,"docNo":str|null,"docDate":"YYYY-MM-DD"|null,"isTaxInvoice":bool,"handwritten":bool,"lines":[{"qty":num|null,"description":str|null,"unitPrice":num|null,"amount":num|null}],"vatTotal":num|null,"grandTotal":num|null,"confidence":0..1}\n' +
  "กติกา: ตัวเลขใส่เฉพาะตัวเลข (ไม่มีลูกน้ำ/บาท) · อ่านไม่ออก/ไม่มีให้ใส่ null ห้ามเดา · " +
  "docDate แปลงเป็น ค.ศ. รูปแบบ YYYY-MM-DD (ปี พ.ศ. ให้ลบ 543 เช่น 20/8/69 = 20/8/2569 → 2026-08-20) · " +
  "isTaxInvoice=true เมื่อมีคำว่า 'ใบกำกับภาษี' และมีเลขประจำตัวผู้เสียภาษีของผู้ขาย · " +
  "handwritten=true ถ้าเนื้อหาหลักเขียนด้วยลายมือ · confidence สะท้อนความชัดของภาพ";

function stripJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ฿]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalize(raw: Record<string, unknown>): BillVisionResult {
  const linesRaw = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : [];
  const dt = raw.docType;
  return {
    docType: dt === "purchase" || dt === "sale" ? dt : "unspecified",
    seller: (raw.seller as string) || null,
    buyer: (raw.buyer as string) || null,
    sellerTaxId: (raw.sellerTaxId as string) || null,
    docNo: (raw.docNo as string) || null,
    docDate: typeof raw.docDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.docDate) ? raw.docDate : null,
    isTaxInvoice: raw.isTaxInvoice === true,
    handwritten: raw.handwritten === true,
    lines: linesRaw.map((l) => ({
      qty: toNum(l.qty),
      description: (l.description as string) || null,
      unitPrice: toNum(l.unitPrice),
      amount: toNum(l.amount),
    })),
    vatTotal: toNum(raw.vatTotal),
    grandTotal: toNum(raw.grandTotal),
    confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
  };
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    return await p(c.signal);
  } finally {
    clearTimeout(t);
  }
}

/** 🅰 อ่านด้วย Gemini Flash — คืน BillVisionResult · ไม่มี key/error/อ่านไม่ออก → null */
export async function readBillWithGemini(data: Buffer, mime: string): Promise<BillVisionResult | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const media = mime && mime.startsWith("image/") ? mime : "image/jpeg";
  try {
    const json = await withTimeout(async (signal) => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: media, data: data.toString("base64") } }, { text: PROMPT }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        }
      );
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      return (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    });
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;
    return normalize(JSON.parse(stripJson(text)) as Record<string, unknown>);
  } catch {
    console.warn("[read-bill-vision] gemini error");
    return null;
  }
}

/** 🅱 อ่านด้วย Claude — ไว้ cross-check เฉพาะใบไม่ชัวร์ · null เมื่อ error/ไม่มี key */
export async function readBillWithClaude(data: Buffer, mime: string): Promise<BillVisionResult | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const media = mime && mime.startsWith("image/") ? mime : "image/jpeg";
  try {
    const json = await withTimeout(async (signal) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: media, data: data.toString("base64") } },
            { type: "text", text: PROMPT },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(`claude ${res.status}`);
      return (await res.json()) as { content?: { text?: string }[] };
    });
    const text = json.content?.[0]?.text ?? "";
    if (!text) return null;
    return normalize(JSON.parse(stripJson(text)) as Record<string, unknown>);
  } catch {
    console.warn("[read-bill-vision] claude error");
    return null;
  }
}

/** ผลรวมรายการ (amount) — ไว้เทียบกับ grandTotal เพื่อ flag ยอดไม่ตรง */
function linesSum(r: BillVisionResult): number | null {
  const nums = r.lines.map((l) => l.amount).filter((a): a is number => a != null);
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((s, a) => s + a, 0) * 100) / 100;
}

/**
 * อ่านบิลแบบ ensemble คุมต้นทุน:
 *   1) Gemini อ่านก่อน (ถูก)
 *   2) เรียก Claude "เฉพาะเมื่อไม่ชัวร์": confidence ต่ำ หรือ ผลรวมรายการ ≠ ยอดรวม
 *   3) เทียบ 2 ตัว → จุดต่างกัน (ผู้ขาย/วันที่/ยอดรวม) = flag ให้นักบัญชีตรวจ
 */
export async function readBillEnsemble(data: Buffer, mime: string): Promise<BillReadOutcome | null> {
  const g = await readBillWithGemini(data, mime);
  if (!g) return null;

  const flags: string[] = [];
  const gSum = linesSum(g);
  const totalMismatch = gSum != null && g.grandTotal != null && Math.abs(gSum - g.grandTotal) >= 0.01;
  const lowConf = g.confidence < 0.75;

  // ตัดสินใจเรียก Claude cross-check เฉพาะเมื่อไม่ชัวร์ (คุมต้นทุน)
  if (!totalMismatch && !lowConf) {
    if (g.handwritten) flags.push("บิลเขียนมือ — ควรตรวจ");
    return { result: g, flags, readers: "gemini" };
  }

  const c = await readBillWithClaude(data, mime);
  if (!c) {
    if (totalMismatch) flags.push(`ผลรวมรายการ (${gSum}) ไม่ตรงยอดรวม (${g.grandTotal}) — ตรวจตัวเลข`);
    if (lowConf) flags.push("ภาพไม่ชัด/มั่นใจต่ำ — ตรวจทั้งใบ");
    return { result: g, flags, readers: "gemini" };
  }

  // เทียบช่องสำคัญ → ต่างกัน = flag
  const norm = (s: string | null) => (s || "").replace(/\s+/g, "").toLowerCase();
  if (norm(g.seller) !== norm(c.seller)) flags.push(`ชื่อผู้ขายอ่านต่างกัน (Gemini: ${g.seller ?? "-"} / Claude: ${c.seller ?? "-"})`);
  if (g.docDate !== c.docDate) flags.push(`วันที่อ่านต่างกัน (Gemini: ${g.docDate ?? "-"} / Claude: ${c.docDate ?? "-"})`);
  if (g.grandTotal !== c.grandTotal) flags.push(`ยอดรวมอ่านต่างกัน (Gemini: ${g.grandTotal ?? "-"} / Claude: ${c.grandTotal ?? "-"})`);
  if (totalMismatch) flags.push(`ผลรวมรายการไม่ตรงยอดรวม — ตรวจตัวเลขแต่ละบรรทัด`);

  // เลือกผลที่ "ยอดรวม = ผลรวมรายการ" เป็นหลัก ถ้ามี ไม่งั้นใช้ Gemini
  const cSum = linesSum(c);
  const cConsistent = cSum != null && c.grandTotal != null && Math.abs(cSum - c.grandTotal) < 0.01;
  const result = cConsistent && totalMismatch ? c : g;
  return { result, flags, readers: "gemini+claude" };
}
