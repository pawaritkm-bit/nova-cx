/**
 * C. งบทดลอง (Trial Balance) — สรุปต่อบัญชี + จัดกลุ่มหมวด + รวมท้าย
 *
 * ★ pure function (ไม่แตะ DB) — unit test ได้เต็ม
 * ★ คอลัมน์ต่อบัญชี: opening (ยกมา) · debit/credit (เคลื่อนไหวงวด) · balance (ยอดปลายงวด, debit-positive)
 *   - รวมเคลื่อนไหว: Σdebit = Σcredit เสมอ (สมุดรายวันสมดุลทุกบิล) → assert ได้แน่นอน
 *   - ยอดปลายงวดแยกฝั่ง: balanceDebit/balanceCredit — Σ ทั้งสองเท่ากันเมื่อ "ยอดยกมาสมดุล"
 *     (ถ้ายอดยกมาไม่สมดุล balanced=false → ให้ UI เตือน)
 */
import { CATEGORY_BY_DIGIT } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import type { Ledger } from "@/lib/accounting/ledger";

export type TrialBalanceRow = {
  code: string;
  name: string;
  category: string;
  digit: string;
  opening: number;
  debit: number; // เดบิตเคลื่อนไหวงวด
  credit: number; // เครดิตเคลื่อนไหวงวด
  /** ยอดปลายงวด (debit-positive) */
  balance: number;
};

export type TrialBalanceGroup = {
  digit: string;
  category: string;
  rows: TrialBalanceRow[];
  opening: number;
  debit: number;
  credit: number;
  balanceDebit: number;
  balanceCredit: number;
};

export type TrialBalance = {
  groups: TrialBalanceGroup[];
  rows: TrialBalanceRow[];
  totalOpening: number;
  totalDebit: number;
  totalCredit: number;
  totalBalanceDebit: number;
  totalBalanceCredit: number;
  /** เดบิตเคลื่อนไหวรวม = เครดิตเคลื่อนไหวรวม (สมุดรายวันสมดุล) */
  movementBalanced: boolean;
  /** ยอดปลายงวดฝั่งเดบิตรวม = ฝั่งเครดิตรวม (ยอดยกมาสมดุล) */
  balanced: boolean;
};

/** สร้างงบทดลองจากบัญชีแยกประเภท */
export function buildTrialBalance(ledger: Ledger): TrialBalance {
  // เก็บเฉพาะบัญชีที่มีความเคลื่อนไหวหรือมียอดยกมา (ตัดบัญชีศูนย์ล้วนออก)
  const rows: TrialBalanceRow[] = ledger.accounts
    .filter(
      (a) =>
        Math.abs(a.opening) >= EPSILON ||
        Math.abs(a.totalDebit) >= EPSILON ||
        Math.abs(a.totalCredit) >= EPSILON ||
        Math.abs(a.balance) >= EPSILON
    )
    .map((a) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      digit: a.digit,
      opening: a.opening,
      debit: a.totalDebit,
      credit: a.totalCredit,
      balance: a.balance,
    }));

  const byDigit = new Map<string, TrialBalanceRow[]>();
  for (const r of rows) {
    const arr = byDigit.get(r.digit) ?? [];
    arr.push(r);
    byDigit.set(r.digit, arr);
  }

  const groups: TrialBalanceGroup[] = [];
  for (const d of ["1", "2", "3", "4", "5", "6"]) {
    const grpRows = byDigit.get(d);
    if (!grpRows || grpRows.length === 0) continue;
    const g: TrialBalanceGroup = {
      digit: d,
      category: CATEGORY_BY_DIGIT[d] ?? "อื่น ๆ",
      rows: grpRows,
      opening: 0,
      debit: 0,
      credit: 0,
      balanceDebit: 0,
      balanceCredit: 0,
    };
    for (const r of grpRows) {
      g.opening = round2(g.opening + r.opening);
      g.debit = round2(g.debit + r.debit);
      g.credit = round2(g.credit + r.credit);
      if (r.balance >= 0) g.balanceDebit = round2(g.balanceDebit + r.balance);
      else g.balanceCredit = round2(g.balanceCredit - r.balance);
    }
    groups.push(g);
  }

  let totalOpening = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalBalanceDebit = 0;
  let totalBalanceCredit = 0;
  for (const g of groups) {
    totalOpening = round2(totalOpening + g.opening);
    totalDebit = round2(totalDebit + g.debit);
    totalCredit = round2(totalCredit + g.credit);
    totalBalanceDebit = round2(totalBalanceDebit + g.balanceDebit);
    totalBalanceCredit = round2(totalBalanceCredit + g.balanceCredit);
  }

  return {
    groups,
    rows,
    totalOpening,
    totalDebit,
    totalCredit,
    totalBalanceDebit,
    totalBalanceCredit,
    movementBalanced: Math.abs(totalDebit - totalCredit) < EPSILON,
    balanced: Math.abs(totalBalanceDebit - totalBalanceCredit) < EPSILON,
  };
}
