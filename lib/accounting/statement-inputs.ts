/**
 * รวม logic โหลด manual JE + bill_payments (confirmed) + credit/debit notes (confirmed) ของ entries
 * ชุดหนึ่ง แล้วแปลงเป็น JournalLine[] ผ่าน mapper เดิมทุกตัว — data layer (แตะ DB)
 *
 * บริบท: เฟส 4 ส่วน M (docs/06-accounting-features-roadmap.md, หมวด 0.13) — สกัดโค้ดที่คัดลอกซ้ำกัน
 *   เป๊ะมา 2 จุด (`reports/page.tsx`, `reports/export/route.ts` — ทั้งคู่โหลด manual JE + bill_payments +
 *   CN/DN ของลูกค้ารายเดียวกัน กรองงวดแบบเดียวกัน แล้ว concat เข้า `buildStatements()` ผ่านพารามิเตอร์
 *   `manualJournalLines` เดิม) ให้เหลือฟังก์ชันเดียว — ไม่เขียนสูตรคำนวณ/กรองใหม่แม้แต่บรรทัดเดียว
 *   (ใช้ `filterManualEntriesForReport`/`filterBillPaymentsForReport`/`filterCreditDebitNotesForReport`
 *   เดิมจาก report-filter.ts + mapper `toJournalLines` เดิมของ 3 ไฟล์ manual-journal/bill-payments/
 *   credit-debit-notes ตรง ๆ ทุกจุด)
 *
 * ★ customerId derive จาก entries[0]?.customerId — caller ทุกจุดปัจจุบัน (reports/*) โหลด `entries` ผ่าน
 *   `listEntries(service, tenantId, {customerId})` มาก่อนเสมอ (scope ลูกค้าเดียวต่อการเรียก 1 ครั้ง) จึง
 *   derive ได้ตรง ๆ โดยไม่ต้องเพิ่มพารามิเตอร์ customerId แยก — ★ ข้อจำกัด: ถ้า `entries` ว่างเปล่า (ลูกค้า
 *   รายนั้นยังไม่มีบิลเลยแม้แต่ใบเดียว แต่มี manual JE ค้างอยู่) ฟังก์ชันนี้จะไม่โหลด manual JE ให้ (ไม่มี
 *   customerId ให้ derive) — เป็นข้อจำกัดที่ยอมรับได้ตามที่ล็อก signature ไว้ในแผน (M2/0.13); ยังไม่เคยเกิด
 *   จริงในทางปฏิบัติเพราะ flow ปัจจุบันบังคับสร้างบิลอย่างน้อย 1 ใบก่อนถึงจะเข้าเมนูบัญชีได้
 * ★ ทุก query กรอง tenant_id (จาก session) เสมอ — ไม่เชื่อ client
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { BillEntry } from "@/lib/accounting/queries";
import type { JournalLine } from "@/lib/accounting/journal";
import { type ReportPeriod, filterManualEntriesForReport, filterBillPaymentsForReport, filterCreditDebitNotesForReport } from "@/lib/accounting/report-filter";
import { listManualEntries, toJournalLines as toManualJournalLines } from "@/lib/accounting/manual-journal";
import { listBillPaymentsForEntries, toJournalLines as toPaymentJournalLines } from "@/lib/accounting/bill-payments";
import { listNotesForEntries, toJournalLines as toNoteJournalLines } from "@/lib/accounting/credit-debit-notes";

type DB = SupabaseClient;

/** JournalLine[] ของ 3 แหล่งข้อมูลที่ไม่ใช่บิลตรง ๆ (manual JE / bill_payments / CN-DN) ของงวดที่กำหนด */
export type CombinedJournalLines = {
  manualJournalLines: JournalLine[];
  paymentJournalLines: JournalLine[];
  noteJournalLines: JournalLine[];
};

/**
 * โหลด + แปลงเป็น JournalLine[] ของ manual JE (confirmed ตาม includeDraft) + bill_payments (ทุกรายการ —
 * ไม่มีสถานะ draft/confirmed) + CN/DN (confirmed เท่านั้นเสมอ) ของ `entries` ชุดที่ระบุ ในงวด `period`
 *   (0.13 — สกัดจาก reports/page.tsx/reports/export/route.ts ที่ทำเหมือนกันเป๊ะ)
 */
export async function loadCombinedJournalLines(
  db: DB,
  tenantId: string,
  entries: BillEntry[],
  period: ReportPeriod,
  chartByCode: ChartByCode
): Promise<CombinedJournalLines> {
  const customerId = entries.find((e) => e.customerId)?.customerId ?? "";
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // manual JE (JV/PV/RV) ของลูกค้ารายนี้ — กรองงวด/สถานะเหมือนบิล
  const manualEntries = customerId ? await listManualEntries(db, tenantId, customerId) : [];
  const filteredManual = filterManualEntriesForReport(manualEntries, period);
  const manualJournalLines = filteredManual.flatMap(toManualJournalLines);

  // การรับ/จ่ายเงินแยกจากบิล (bill_payments) ของบิลเชื่อในชุด entries นี้ — กรองตามงวด (pay_date)
  const paymentsByEntry = await listBillPaymentsForEntries(db, tenantId, entries.map((e) => e.id));
  const allPayments = [...paymentsByEntry.values()].flat();
  const filteredPayments = filterBillPaymentsForReport(allPayments, { from: period.from, to: period.to });
  const paymentJournalLines = filteredPayments.flatMap((p) => {
    const paymentEntry = entryById.get(p.entryId);
    return paymentEntry ? toPaymentJournalLines(p, paymentEntry, chartByCode) : [];
  });

  // CN/DN "confirmed" ของบิลเชื่อในชุด entries นี้ — กรองตามงวด (doc_date)
  const notesByEntry = await listNotesForEntries(db, tenantId, entries.map((e) => e.id));
  const allNotes = [...notesByEntry.values()].flat();
  const filteredNotes = filterCreditDebitNotesForReport(allNotes, { from: period.from, to: period.to });
  const noteJournalLines = filteredNotes.flatMap((n) => {
    const noteEntry = entryById.get(n.entryId);
    const entryType = noteEntry?.entryType;
    if (!noteEntry || (entryType !== "sale" && entryType !== "purchase")) return [];
    return toNoteJournalLines(n, { ...noteEntry, entryType }, chartByCode);
  });

  return { manualJournalLines, paymentJournalLines, noteJournalLines };
}

/** รวม 3 แหล่งเป็น JournalLine[] เดียว (ลำดับ manual → payment → note — ตรงกับที่ reports/* concat กันมาเดิม) */
export function flattenCombinedJournalLines(combined: CombinedJournalLines): JournalLine[] {
  return [...combined.manualJournalLines, ...combined.paymentJournalLines, ...combined.noteJournalLines];
}
