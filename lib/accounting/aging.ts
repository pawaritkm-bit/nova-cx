/**
 * ลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ (AR/AP Aging) — pure ทั้งไฟล์ (ไม่แตะ DB)
 *
 * บริบท: เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md, 0.9/0.10) — เฉพาะบิลเชื่อ
 *   (payment_method='credit') ที่ยืนยันแล้วและยังค้างชำระเท่านั้นที่เข้ารายงาน (reuse
 *   isCreditEligibleForPayment/billOutstanding จาก bill-payments.ts — ไม่มีสูตรคู่ขนาน)
 *
 * ★ 6 กลุ่มอายุหนี้ (0.9): ไม่ระบุกำหนด (no_due_date) · ยังไม่ครบกำหนด (current) · 1-30 · 31-60 ·
 *   61-90 · เกิน 90 วัน (over_90) — คำนวณจาก (asOfDate − due_date) เป็นวัน เทียบวันที่ตั้งรายงาน
 * ★ กลุ่มก้อนของรายงาน (0.10): ตาม bill_entries.counterparty_name เดิม (ไม่สร้างตารางคู่ค้าใหม่)
 * ★ บิลที่จ่ายครบแล้ว (outstanding ≤ EPSILON) ไม่แสดงในรายงาน (ตรงเจตนา "ค้างชำระ" เท่านั้น)
 * ★ pure ล้วน · PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข
 */
import type { BillEntry } from "@/lib/accounting/queries";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import {
  billNetTotal,
  billOutstanding,
  isCreditEligibleForPayment,
  type BillPayment,
} from "@/lib/accounting/bill-payments";

/** 6 กลุ่มอายุหนี้ (0.9) */
export type AgingBucketKey = "no_due_date" | "current" | "1_30" | "31_60" | "61_90" | "over_90";

/** ป้ายภาษาไทยของแต่ละกลุ่ม */
export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  no_due_date: "ไม่ระบุกำหนด",
  current: "ยังไม่ครบกำหนด",
  "1_30": "1-30 วัน",
  "31_60": "31-60 วัน",
  "61_90": "61-90 วัน",
  over_90: "เกิน 90 วัน",
};

/** ลำดับการแสดงผล 6 กลุ่ม */
export const AGING_BUCKET_ORDER: AgingBucketKey[] = [
  "no_due_date",
  "current",
  "1_30",
  "31_60",
  "61_90",
  "over_90",
];

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** แปลง 'YYYY-MM-DD' → epoch ms เที่ยงคืน UTC (กัน timezone shift) · null ถ้ารูปแบบผิด */
function parseISODate(s: string): number | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * จัดกลุ่มอายุหนี้ของ 1 บิล ตามวันครบกำหนดชำระ เทียบกับวันที่ตั้งรายงาน (0.9)
 *   - dueDate = null → 'no_due_date' (ไม่ปัดเป็น "ยังไม่ครบกำหนด" — จะทำให้เข้าใจผิดว่าไม่ค้างนาน)
 *   - days = asOfDate − dueDate (วัน) : days ≤ 0 → 'current' (ยังไม่ถึง/ถึงกำหนดพอดี)
 *     1-30 → '1_30' · 31-60 → '31_60' · 61-90 → '61_90' · > 90 → 'over_90'
 */
export function ageBucket(dueDate: string | null, asOfDate: string): AgingBucketKey {
  if (!dueDate) return "no_due_date";
  const d = parseISODate(dueDate);
  const a = parseISODate(asOfDate);
  if (d === null || a === null) return "no_due_date"; // รูปแบบวันที่พัง — ไม่ควรเกิดจากข้อมูลจริง (defensive)
  const days = Math.round((a - d) / MS_PER_DAY);
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "over_90";
}

function zeroBuckets(): Record<AgingBucketKey, number> {
  return { no_due_date: 0, current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 };
}

/** รายละเอียดต่อบิล 1 ใบ ภายในกลุ่มคู่ค้า (สำหรับ UI แสดง/ขยายดูรายบิล) */
export type AgingBillDetail = {
  entryId: string;
  docNo: string | null;
  docDate: string | null;
  dueDate: string | null;
  bucket: AgingBucketKey;
  netTotal: number;
  outstanding: number;
};

/** 1 แถวของรายงาน = 1 คู่ค้า (counterpartyName) — ยอดค้างชำระแยกตามกลุ่มอายุหนี้ */
export type AgingRow = {
  counterpartyName: string;
  buckets: Record<AgingBucketKey, number>;
  total: number;
  bills: AgingBillDetail[];
};

export type AgingReport = {
  ar: AgingRow[];
  ap: AgingRow[];
  totalsByBucket: { ar: Record<AgingBucketKey, number>; ap: Record<AgingBucketKey, number> };
};

/**
 * สร้างรายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ จากบิลทั้งชุด + ประวัติการรับ/จ่ายเงินต่อบิล
 *   - กรองเฉพาะบิลที่ eligible (0.1: ซื้อ/ขาย + payment_method='credit' + confirmed) และยังค้างชำระ
 *     (outstanding > EPSILON) เท่านั้น — บิลที่จ่ายครบแล้วไม่ปนอยู่ในผลลัพธ์
 *   - กลุ่มแถวตาม counterpartyName (0.10) แยก 2 ฝั่ง: sale → ar (ลูกหนี้) · purchase → ap (เจ้าหนี้)
 *   @param paymentsByEntry ประวัติการรับ/จ่ายเงินต่อบิล (จาก listBillPaymentsForEntries) — ไม่รวมรายการ
 *     ที่ถูกยกเลิกแล้ว (caller ต้อง query เฉพาะ deleted_at is null มาก่อน)
 *   @param asOfDate วันที่ตั้งรายงาน (YYYY-MM-DD)
 *   @param netAdjustmentByEntry ผลรวมสัญญาณของ CN/DN "confirmed" ต่อบิล (เฟส 3 ส่วน J, 0.6 —
 *     จาก credit-debit-notes.ts::netAdjustmentByEntry) default = Map ว่าง (backward-compat ระดับ compile
 *     — พฤติกรรมเดิมเป๊ะเมื่อไม่มี CN/DN)
 *
 *   ★ เฟส 10b (0.5, bonus correctness fix) — ส่ง `asOfDate` เข้า `billOutstanding` ด้วย (เดิมไม่ส่ง — bug):
 *     หัก payment เฉพาะที่ `payDate ≤ asOfDate` เท่านั้น กัน payment วันที่ในอนาคต/ตั้งรายงานย้อนหลังไปหักยอด
 *     ที่ยังไม่เกิดขึ้นจริง ณ วันตั้งรายงาน — สถานการณ์ปกติทั่วไป (payment ทุกแถว `payDate ≤ asOfDate` เสมอ)
 *     ผลลัพธ์**ไม่เปลี่ยนแม้แต่บาทเดียว** (regression-safe)
 */
export function buildAgingReport(
  entries: BillEntry[],
  paymentsByEntry: Map<string, Pick<BillPayment, "amount" | "payDate">[]>,
  asOfDate: string,
  netAdjustmentByEntry: Map<string, number> = new Map()
): AgingReport {
  const arRows = new Map<string, AgingRow>();
  const apRows = new Map<string, AgingRow>();
  const totalsAr = zeroBuckets();
  const totalsAp = zeroBuckets();

  for (const e of entries) {
    if (!isCreditEligibleForPayment(e)) continue;

    const payments = paymentsByEntry.get(e.id) ?? [];
    const outstanding = billOutstanding(e, payments, netAdjustmentByEntry.get(e.id) ?? 0, asOfDate);
    if (!(outstanding > EPSILON)) continue; // จ่ายครบแล้ว (หรือค่าผิดปกติ ≤ 0) — ไม่แสดง

    const bucket = ageBucket(e.dueDate, asOfDate);
    const counterpartyName = (e.counterpartyName ?? "").trim() || "(ไม่ระบุชื่อคู่ค้า)";
    const isAr = e.entryType === "sale";
    const rows = isAr ? arRows : apRows;
    const totals = isAr ? totalsAr : totalsAp;

    let row = rows.get(counterpartyName);
    if (!row) {
      row = { counterpartyName, buckets: zeroBuckets(), total: 0, bills: [] };
      rows.set(counterpartyName, row);
    }
    row.buckets[bucket] = round2(row.buckets[bucket] + outstanding);
    row.total = round2(row.total + outstanding);
    row.bills.push({
      entryId: e.id,
      docNo: e.docNo,
      docDate: e.docDate,
      dueDate: e.dueDate,
      bucket,
      netTotal: billNetTotal(e),
      outstanding,
    });
    totals[bucket] = round2(totals[bucket] + outstanding);
  }

  const byNameThai = (a: AgingRow, b: AgingRow) => a.counterpartyName.localeCompare(b.counterpartyName, "th");
  return {
    ar: [...arRows.values()].sort(byNameThai),
    ap: [...apRows.values()].sort(byNameThai),
    totalsByBucket: { ar: totalsAr, ap: totalsAp },
  };
}
