/**
 * รูปแบบเลขที่เอกสารขาย/จัดซื้อ (Quotation/PO/Billing Note) — pure ทั้งไฟล์ (เฟส 3 ส่วน K, 0.10/0.12)
 *
 * ★ ไฟล์นี้ไม่แตะ DB/engine บัญชีเลย (ไม่ import journal/ledger/statements/journal-books/payment.ts)
 * ★ asymmetry กับ CN/DN (0.13): CN/DN (`credit_debit_notes.doc_no`) เป็น free text เพราะสำนักงานบัญชี
 *   มีเลขชุดเดิมของตัวเองอยู่แล้ว (เหมือนใบกำกับภาษี/บิลที่คีย์เข้าระบบภายหลัง) ส่วนเอกสารกลุ่มนี้
 *   NOVA-CX เป็นผู้ออกเลขที่ใหม่เองครั้งแรก (ไม่มีเลขเดิมจากที่อื่นมาก่อน) จึงต้อง auto-generate
 *   แบบ atomic ผ่าน RPC `issue_sales_document` (migration 0070)
 */

export type SalesDocType = "quotation" | "purchase_order" | "billing_note";

/** ป้ายภาษาไทย */
export const DOC_TYPE_LABELS: Record<SalesDocType, string> = {
  quotation: "ใบเสนอราคา",
  purchase_order: "ใบสั่งซื้อ",
  billing_note: "ใบวางบิล",
};

/** prefix เลขที่เอกสาร (0.12) — คงที่ ห้ามเปลี่ยนภายหลัง (จะทำให้เลขที่เก่าอ่านไม่ตรง pattern) */
export const DOC_TYPE_PREFIX: Record<SalesDocType, string> = {
  quotation: "QT",
  purchase_order: "PO",
  billing_note: "BN",
};

/** cast ค่าใด ๆ → SalesDocType | null */
export function asSalesDocType(v: unknown): SalesDocType | null {
  return v === "quotation" || v === "purchase_order" || v === "billing_note" ? v : null;
}

/**
 * ปี พ.ศ. ปัจจุบัน (เวลาไทย) — ใช้ตอน "ออกเอกสาร" จริงเท่านั้น (0.12)
 *   ★ ไม่ใช้ doc_date ที่แก้ backdate ได้ — กันเลขสับสนถ้ามีคนตั้งใจ backdate
 *   @param now เวลาอ้างอิง (default = ตอนนี้) — รับพารามิเตอร์ไว้เพื่อทดสอบได้ง่าย (mock เวลา)
 */
export function beYearNowThai(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value ?? now.getFullYear());
  return y + 543;
}

/**
 * จัดรูปเลขที่เอกสาร: "{prefix}-{beYear}-{seq:04d}" (0.12)
 *   ★ ไม่ครอบตัด seq ที่เกิน 4 หลัก — แสดงตามจริง (เช่น seq=10000 → "...-10000" ไม่ตัดเหลือ "0000")
 */
export function formatSalesDocNo(prefix: string, beYear: number, seq: number): string {
  const n = Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : 0;
  const seqStr = String(n).padStart(4, "0");
  return `${prefix}-${beYear}-${seqStr}`;
}
