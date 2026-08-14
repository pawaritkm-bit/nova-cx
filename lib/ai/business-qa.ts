/**
 * AI chatbot ตอบคำถามจากข้อมูลธุรกิจของลูกค้า (wishlist backlog ข้อ 3) — provider-agnostic + testable
 *
 * บริบท: ให้ "นักบัญชี" (ผู้ใช้งานที่ล็อกอินอยู่แล้ว มี session จริง) ถามคำถามภาษาธรรมชาติเกี่ยวกับข้อมูล
 *   บัญชีของลูกค้า 1 รายที่ตัวเองกำลังดูอยู่ (ไม่ใช่ลูกค้าถามเอง — ระบบยังไม่มีช่องทางให้ลูกค้าล็อกอินดู
 *   ข้อมูลบัญชีตัวเองเลย มีแค่ LINE survey) — ดู docs/06-accounting-features-roadmap.md
 *
 * ★★★ ออกแบบให้ "ไม่มีข้อมูลลูกค้าหลุดไป OpenAI เลยแม้แต่บาทเดียว/ชื่อเดียว":
 *   AI ถูกใช้แค่ "จำแนกเจตนาคำถาม" (classify) จากข้อความที่นักบัญชีพิมพ์เองเท่านั้น (redact PII ป้องกัน
 *   ซ้อนอีกชั้นเผื่อพิมพ์เลขภาษี/เบอร์ลูกค้าปนมาในคำถาม) — คำตอบสุดท้ายสร้างจาก "โค้ด/เทมเพลตล้วน ๆ"
 *   โดยดึงเลข/ชื่อจาก DB ตรง ๆ ไม่เคยส่งกลับเข้า AI อีกครั้ง (ต่างจาก analyzeFeedback ที่ส่งข้อมูลลูกค้า
 *   redact แล้วเข้า AI เพื่อสรุป — ที่นี่ AI ไม่เห็นข้อมูลการเงินเลยสักตัวเลข)
 * ★ รองรับคำถามในขอบเขตจำกัด (v1): ยอดขาย/ยอดซื้อรายเดือน, ลูกหนี้/เจ้าหนี้ค้างชำระ (aging),
 *   จำนวนบิลรอระบุประเภท — นอกเหนือจากนี้ตอบว่ายังไม่รองรับ (ไม่เดา/ไม่แต่งตัวเลข)
 * ★ ทุก query กรอง tenant_id + customer_id (จาก session — ผู้เรียกชั้น action ต้อง assertCustomerInScope
 *   ก่อนเสมอ) — ไฟล์นี้ไม่ตรวจสิทธิ์เอง (data layer ปกติของ codebase นี้)
 * ★ PDPA: ไม่ log คำถาม/คำตอบ/ตัวเลข/ชื่อลูกค้าเลย
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider, JsonSchemaSpec } from "./provider";
import { getAIProvider } from "./provider";
import { redactChatText, hasResidualChatPii } from "./chat-redact";
import { listEntries, summarizeEntries, type EntryType } from "@/lib/accounting/queries";
import { listBillPaymentsForEntries } from "@/lib/accounting/bill-payments";
import { listNotesForEntries, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { buildAgingReport, type AgingReport } from "@/lib/accounting/aging";
import { todayIsoThai } from "@/lib/accounting/recurring-journal";
import { taxMonthLabel } from "@/lib/accounting/tax-month";
import { formatMoney } from "@/lib/accounting/calc";

type DB = SupabaseClient;

/** เพดานความยาวคำถาม (กันพิมพ์ยาวเวอร์/ทดสอบยิง payload ใหญ่) */
export const QUESTION_MAX = 500;

/** เจตนาคำถามที่รองรับ (v1) — นอกเหนือจากนี้ = unknown เสมอ */
export const QA_INTENTS = ["sales_month", "purchase_month", "ar_aging", "ap_aging", "unspecified_count", "unknown"] as const;
export type QaIntent = (typeof QA_INTENTS)[number];

export type QaClassification = { intent: QaIntent; month: string | null };

export type QaAnswer = { ok: true; answer: string; intent: QaIntent } | { ok: false; message: string };

const QA_JSON_SCHEMA: JsonSchemaSpec = {
  name: "business_qa_intent",
  strict: true,
  schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: [...QA_INTENTS] },
      month: {
        type: ["string", "null"],
        description: "เดือนที่คำถามระบุ รูปแบบ YYYY-MM (ค.ศ.) — ไม่ได้ระบุเดือน/ปีชัดเจนในคำถาม ให้เป็น null",
      },
    },
    required: ["intent", "month"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT =
  "คุณเป็นตัวจำแนกเจตนาคำถามของนักบัญชีเกี่ยวกับข้อมูลบัญชีของลูกค้า 1 ราย ระบบตอบได้เฉพาะ 5 เรื่องนี้เท่านั้น: " +
  "sales_month = ถามยอดขาย/รายรับในเดือนหนึ่ง, purchase_month = ถามยอดซื้อ/รายจ่ายในเดือนหนึ่ง, " +
  "ar_aging = ถามลูกหนี้/ยอดค้างรับจากลูกค้า(ที่เราขายให้), ap_aging = ถามเจ้าหนี้/ยอดค้างจ่ายให้ผู้ขาย(ที่เราซื้อจาก), " +
  "unspecified_count = ถามจำนวนบิลที่ยังไม่ได้ระบุว่าซื้อหรือขาย(รอตรวจ). " +
  "ถ้าคำถามไม่ตรงกับ 5 เรื่องนี้เลย ให้ intent='unknown'. " +
  "ถ้าคำถามระบุเดือน/ปีชัดเจน (เช่น 'เดือนกรกฎาคม 2569', 'เดือนที่แล้ว' เทียบจากวันที่ปัจจุบันที่ให้ไว้) ให้แปลงเป็น month แบบ YYYY-MM (ค.ศ.) " +
  "ถ้าไม่ได้ระบุเดือนเลยให้ month=null. " +
  "ตอบเป็น JSON เท่านั้นตาม schema ที่กำหนด ห้ามเดา/แต่งตัวเลขใด ๆ (หน้าที่คุณคือจำแนกเจตนาเท่านั้น ไม่ใช่ตอบคำถาม).";

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
 * จำแนกเจตนาคำถาม — ส่งเฉพาะ "ข้อความคำถามที่ redact แล้ว" เข้า AI (ไม่มีข้อมูลลูกค้า/ตัวเลขการเงินใด ๆ)
 *   parse ไม่ได้/error/intent แปลกที่ไม่รู้จัก → คืน null (ผู้เรียก fallback เป็น "ยังไม่รองรับ")
 */
export async function classifyBusinessQuestion(
  provider: AIProvider,
  redactedQuestion: string
): Promise<QaClassification | null> {
  try {
    const todayIso = todayIsoThai();
    const raw = await provider.generateJson({
      system: SYSTEM_PROMPT,
      user: `วันนี้คือ ${todayIso} (ค.ศ.)\nคำถาม: ${redactedQuestion}`,
      jsonSchema: QA_JSON_SCHEMA,
    });
    const parsed = extractJson(raw);
    if (!parsed) return null;
    const intentRaw = typeof parsed.intent === "string" ? parsed.intent : "";
    if (!(QA_INTENTS as readonly string[]).includes(intentRaw)) return null;
    const monthRaw = typeof parsed.month === "string" ? parsed.month : null;
    // ★ ต้องเช็คขอบเขตเดือน 01-12 จริง (ไม่ใช่แค่ 2 หลัก) — mirror pattern เดียวกับ tax-month.ts
    //   กัน AI ตอบเดือนเพี้ยน (เช่น "2026-13") หลุดเข้า monthRange()/monthOf() ที่ queries.ts ซึ่งจะคืน
    //   null เงียบ ๆ (ไม่กรองเดือนเลย → ยอดรวมทุกเดือนปน) แต่ taxMonthLabel() ยังโชว์ป้ายเดือนผิดอยู่ดี
    const month = monthRaw && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthRaw) ? monthRaw : null;
    return { intent: intentRaw as QaIntent, month };
  } catch {
    return null;
  }
}

// =========================================================================
// compute + format ต่อ intent (pure formatting, data layer มาตรฐานเดิมทั้งหมด — ไม่มีสูตรคู่ขนาน)
// =========================================================================

/** เดือนที่จะใช้จริง — ถ้า AI ไม่ระบุเดือนมา (month=null) ใช้เดือนปัจจุบัน (เวลาไทย) */
function resolveMonth(month: string | null): string {
  return month ?? todayIsoThai().slice(0, 7);
}

async function computeMonthSummary(
  db: DB,
  tenantId: string,
  customerId: string,
  entryType: EntryType,
  month: string
) {
  const { entries } = await listEntries(db, tenantId, { customerId, entryType, status: "confirmed", month });
  return summarizeEntries(entries)[entryType === "sale" ? "sale" : "purchase"];
}

function formatMonthAnswer(entryType: EntryType, month: string, s: { count: number; net: number }): string {
  const label = entryType === "sale" ? "ยอดขาย" : "ยอดซื้อ";
  if (s.count === 0) {
    return `เดือน ${taxMonthLabel(month)} ยังไม่มีบิล${entryType === "sale" ? "ขาย" : "ซื้อ"}ที่ยืนยันแล้วเลยครับ`;
  }
  return `${label}เดือน ${taxMonthLabel(month)} (บิลที่ยืนยันแล้ว ${s.count} รายการ) รวมสุทธิ ${formatMoney(s.net)} บาทครับ`;
}

async function computeAgingReport(db: DB, tenantId: string, customerId: string): Promise<AgingReport> {
  const { entries } = await listEntries(db, tenantId, { customerId });
  const entryIds = entries.map((e) => e.id);
  const [paymentsByEntry, notesByEntry] = await Promise.all([
    listBillPaymentsForEntries(db, tenantId, entryIds),
    listNotesForEntries(db, tenantId, entryIds),
  ]);
  const netAdjByEntry = netAdjustmentByEntry(notesByEntry);
  return buildAgingReport(entries, paymentsByEntry, todayIsoThai(), netAdjByEntry);
}

function formatAgingAnswer(side: "ar" | "ap", report: AgingReport): string {
  const rows = report[side];
  const totals = report.totalsByBucket[side];
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const label = side === "ar" ? "ลูกหนี้ค้างรับ" : "เจ้าหนี้ค้างจ่าย";
  if (rows.length === 0) {
    return `ตอนนี้ไม่มี${label}เลยครับ (ไม่มีบิลเชื่อที่ยังค้างชำระ)`;
  }
  const overdue = round2Sum(totals["1_30"] + totals["31_60"] + totals["61_90"] + totals.over_90);
  const top = [...rows].sort((a, b) => b.total - a.total).slice(0, 5);
  const lines = top.map((r) => `- ${r.counterpartyName}: ${formatMoney(r.total)} บาท`);
  const overdueNote = overdue > 0 ? ` (ในนั้นเกินกำหนดชำระแล้ว ${formatMoney(overdue)} บาท)` : "";
  return (
    `${label}รวมทั้งหมด ${formatMoney(total)} บาท จาก ${rows.length} ราย${overdueNote}\n` +
    `${rows.length > 5 ? "5 อันดับยอดสูงสุด:\n" : ""}${lines.join("\n")}`
  );
}

function round2Sum(n: number): number {
  return Math.round(n * 100) / 100;
}

async function computeUnspecifiedCount(db: DB, tenantId: string, customerId: string): Promise<number> {
  const { entries } = await listEntries(db, tenantId, { customerId, entryType: "unspecified" });
  return entries.length;
}

function formatUnspecifiedAnswer(count: number): string {
  if (count === 0) return "ตอนนี้ไม่มีบิลที่รอระบุประเภทเลยครับ (ตรวจครบหมดแล้ว)";
  return `มีบิลที่ยังรอระบุว่าซื้อหรือขาย ${count} รายการครับ ลองเข้าไปที่แท็บ "รอระบุประเภท" ได้เลย`;
}

const UNKNOWN_ANSWER =
  "ขออภัยครับ ตอนนี้ระบบยังตอบคำถามนี้ไม่ได้ — ลองถามเกี่ยวกับ ยอดขาย/ยอดซื้อรายเดือน, ลูกหนี้/เจ้าหนี้ค้างชำระ, " +
  "หรือจำนวนบิลรอระบุประเภท ดูได้ครับ";

/**
 * ตอบคำถามธุรกิจของลูกค้า 1 ราย — orchestrate: validate → redact → classify (AI) → compute (DB) →
 *   format (เทมเพลต, ไม่ผ่าน AI ซ้ำ) ★ ผู้เรียก (server action) ต้อง assertCustomerInScope(customerId)
 *   ก่อนเรียกฟังก์ชันนี้เสมอ (0.13 — ไฟล์นี้ไม่ตรวจสิทธิ์เอง)
 */
export async function answerBusinessQuestion(
  db: DB,
  tenantId: string,
  customerId: string,
  questionRaw: unknown
): Promise<QaAnswer> {
  const question = typeof questionRaw === "string" ? questionRaw.trim().slice(0, QUESTION_MAX) : "";
  if (!question) return { ok: false, message: "กรุณาพิมพ์คำถาม" };

  const provider = getAIProvider();
  if (!provider) {
    return { ok: false, message: "ยังไม่ได้ตั้งค่า AI (OPENAI_API_KEY) — กรุณาติดต่อผู้ดูแลระบบ" };
  }

  // ★ ป้องกันซ้อน — คำถามที่พิมพ์เองไม่ควรมี PII แต่เผื่อพิมพ์เลขภาษี/เบอร์ลูกค้าปนมา
  const redacted = redactChatText(question);
  if (hasResidualChatPii(redacted)) {
    return { ok: false, message: "คำถามมีข้อมูลส่วนบุคคลที่ดูเหมือนเลขภาษี/เบอร์โทร/บัญชี — กรุณาถามแบบทั่วไปโดยไม่ระบุตัวเลขเหล่านี้" };
  }

  const classification = await classifyBusinessQuestion(provider, redacted);
  if (!classification || classification.intent === "unknown") {
    return { ok: false, message: UNKNOWN_ANSWER };
  }

  const { intent, month } = classification;
  switch (intent) {
    case "sales_month": {
      const m = resolveMonth(month);
      const s = await computeMonthSummary(db, tenantId, customerId, "sale", m);
      return { ok: true, intent, answer: formatMonthAnswer("sale", m, s) };
    }
    case "purchase_month": {
      const m = resolveMonth(month);
      const s = await computeMonthSummary(db, tenantId, customerId, "purchase", m);
      return { ok: true, intent, answer: formatMonthAnswer("purchase", m, s) };
    }
    case "ar_aging": {
      const report = await computeAgingReport(db, tenantId, customerId);
      return { ok: true, intent, answer: formatAgingAnswer("ar", report) };
    }
    case "ap_aging": {
      const report = await computeAgingReport(db, tenantId, customerId);
      return { ok: true, intent, answer: formatAgingAnswer("ap", report) };
    }
    case "unspecified_count": {
      const count = await computeUnspecifiedCount(db, tenantId, customerId);
      return { ok: true, intent, answer: formatUnspecifiedAnswer(count) };
    }
    default:
      return { ok: false, message: UNKNOWN_ANSWER };
  }
}
