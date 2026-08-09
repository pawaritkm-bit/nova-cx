/**
 * ตัวกรองบิลสำหรับออกงบการเงิน (pure) — กรองตามช่วงงวด (doc_date) + รวมร่างหรือไม่
 *
 * ★ pure (ไม่แตะ DB) — unit test ได้
 * ★ ช่วงงวดเป็นราย "เดือน" (YYYY-MM): from = ตั้งแต่ต้นเดือน · to = ถึงสิ้นเดือน (รวม)
 *   - บิลที่ยังไม่ลงวันที่ (docDate=null) จะถูกตัดออกเมื่อมีการเลือกช่วงงวด (จัดลงงวดไม่ได้)
 */
import type { BillEntry } from "@/lib/accounting/queries";
import type { ManualJournalEntry } from "@/lib/accounting/manual-journal";
import type { BillPayment } from "@/lib/accounting/bill-payments";
import type { CreditDebitNote } from "@/lib/accounting/credit-debit-notes";

export type ReportPeriod = {
  /** YYYY-MM (ต้นช่วง) — ว่าง = ไม่จำกัดต้นช่วง */
  from?: string;
  /** YYYY-MM (ปลายช่วง) — ว่าง = ไม่จำกัดปลายช่วง */
  to?: string;
  /** true = รวมบิลร่าง (draft) ด้วย · false = เฉพาะยืนยันแล้ว (confirmed) */
  includeDraft: boolean;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** validate YYYY-MM (คืน "" ถ้าไม่ถูก) */
export function validMonth(v: string | null | undefined): string {
  return v && MONTH_RE.test(v) ? v : "";
}

/** เดือนถัดไปของ YYYY-MM (สำหรับขอบปลายช่วงแบบ exclusive) */
function nextMonth(m: string): string {
  const [y, mm] = m.split("-").map(Number);
  const ny = mm === 12 ? y + 1 : y;
  const nm = mm === 12 ? 1 : mm + 1;
  return `${ny.toString().padStart(4, "0")}-${nm.toString().padStart(2, "0")}`;
}

/** กรองบิลตามงวด + สถานะ */
export function filterEntriesForReport(entries: BillEntry[], period: ReportPeriod): BillEntry[] {
  const from = validMonth(period.from);
  const to = validMonth(period.to);
  const startBound = from ? `${from}-01` : "";
  const endBound = to ? `${nextMonth(to)}-01` : ""; // exclusive
  const hasPeriod = !!(startBound || endBound);

  return entries.filter((e) => {
    if (!period.includeDraft && e.status !== "confirmed") return false;
    if (!hasPeriod) return true;
    // มีช่วงงวด → ต้องมีวันที่ และอยู่ในช่วง
    const d = e.docDate;
    if (!d) return false;
    if (startBound && d < startBound) return false;
    if (endBound && d >= endBound) return false;
    return true;
  });
}

/**
 * กรอง manual JE ตามงวด + สถานะ — semantics เดียวกับ filterEntriesForReport เดิม (เฟส 1 ส่วน C)
 *   ★ manual JE ไม่มี status='draft'|'confirmed' ปนกับ EntryStatus ของบิล แต่ค่าตรงกัน (draft/confirmed)
 *     จึงใช้ includeDraft เกณฑ์เดียวกัน (false = เฉพาะ confirmed)
 */
export function filterManualEntriesForReport(
  entries: ManualJournalEntry[],
  period: ReportPeriod
): ManualJournalEntry[] {
  const from = validMonth(period.from);
  const to = validMonth(period.to);
  const startBound = from ? `${from}-01` : "";
  const endBound = to ? `${nextMonth(to)}-01` : ""; // exclusive
  const hasPeriod = !!(startBound || endBound);

  return entries.filter((e) => {
    if (!period.includeDraft && e.status !== "confirmed") return false;
    if (!hasPeriod) return true;
    const d = e.docDate;
    if (!d) return false;
    if (startBound && d < startBound) return false;
    if (endBound && d >= endBound) return false;
    return true;
  });
}

/**
 * กรองการรับ/จ่ายเงิน (bill_payments) ตามงวด — semantics เดียวกับ filterEntriesForReport เดิม
 *   ★ เฟส 2 ส่วน E — กรองตาม pay_date เท่านั้น (ไม่มี includeDraft — bill_payments ไม่มีสถานะ
 *     draft/confirmed ตาม 0.2 บันทึกแล้วถือว่าเงินเข้า/ออกจริงเสมอ)
 */
export function filterBillPaymentsForReport(
  payments: BillPayment[],
  period: Pick<ReportPeriod, "from" | "to">
): BillPayment[] {
  const from = validMonth(period.from);
  const to = validMonth(period.to);
  const startBound = from ? `${from}-01` : "";
  const endBound = to ? `${nextMonth(to)}-01` : ""; // exclusive
  const hasPeriod = !!(startBound || endBound);
  if (!hasPeriod) return payments;

  return payments.filter((p) => {
    const d = p.payDate;
    if (!d) return false;
    if (startBound && d < startBound) return false;
    if (endBound && d >= endBound) return false;
    return true;
  });
}

/**
 * กรอง CN/DN (credit_debit_notes) ตามงวด — เฟส 3 ส่วน J (0.6/J7)
 *   ★ mirror filterBillPaymentsForReport แต่กรอง status='confirmed' ด้วยเสมอ (ต่างจาก bill_payments —
 *     CN/DN มีสถานะ draft/confirmed ตาม 0.4 ส่วน draft ไม่ควรเข้ารายงาน/สมุดรายวันเลย)
 */
export function filterCreditDebitNotesForReport(
  notes: CreditDebitNote[],
  period: Pick<ReportPeriod, "from" | "to">
): CreditDebitNote[] {
  const from = validMonth(period.from);
  const to = validMonth(period.to);
  const startBound = from ? `${from}-01` : "";
  const endBound = to ? `${nextMonth(to)}-01` : ""; // exclusive
  const hasPeriod = !!(startBound || endBound);

  return notes.filter((n) => {
    if (n.status !== "confirmed") return false;
    if (!hasPeriod) return true;
    const d = n.docDate;
    if (!d) return false;
    if (startBound && d < startBound) return false;
    if (endBound && d >= endBound) return false;
    return true;
  });
}

/** ป้ายงวดอ่านง่าย (เช่น "ก.ค. 2569", "ม.ค.–มี.ค. 2569", "ทุกงวด") */
export function periodLabel(from: string, to: string): string {
  const f = validMonth(from);
  const t = validMonth(to);
  if (!f && !t) return "ทุกงวด";
  const fmt = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    const names = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    return `${names[mm]} ${y + 543}`;
  };
  if (f && t) return f === t ? fmt(f) : `${fmt(f)} – ${fmt(t)}`;
  if (f) return `ตั้งแต่ ${fmt(f)}`;
  return `ถึง ${fmt(t)}`;
}
