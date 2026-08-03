/**
 * D. งบการเงิน — งบกำไรขาดทุน + งบแสดงฐานะการเงิน จากงบทดลอง
 *
 * ★ pure function (ไม่แตะ DB) — unit test ได้เต็ม
 * ★ แปลงยอด debit-positive (balance) → ยอดที่แสดงในงบ (ค่าบวกตามธรรมชาติของหมวด):
 *     รายได้ (หมวด 4, เครดิตปกติ)      → amount = −balance
 *     ค่าใช้จ่าย (หมวด 5,6, เดบิตปกติ)  → amount =  balance
 *     สินทรัพย์ (หมวด 1, เดบิตปกติ)     → amount =  balance
 *     หนี้สิน (หมวด 2, เครดิตปกติ)      → amount = −balance
 *     ทุน (หมวด 3, เครดิตปกติ)         → amount = −balance
 *
 * ★ พิสูจน์งบดุลสมดุล (เมื่อยอดยกมาสมดุล):
 *     Σ balance ทุกบัญชี = 0
 *     ⇒ A − L − E − R + X = 0  ⇒  A = L + E + (R − X) = L + E + กำไรสุทธิ  ✓
 *   (A=สินทรัพย์, L=หนี้สิน, E=ทุน, R=รายได้, X=ค่าใช้จ่าย)
 */
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import type { TrialBalance, TrialBalanceRow } from "@/lib/accounting/trial-balance";

/** 1 บรรทัดในงบ (ยอดบวกตามธรรมชาติของหมวด) */
export type StatementLine = {
  code: string;
  name: string;
  amount: number;
};

export type IncomeStatement = {
  revenues: StatementLine[];
  expenses: StatementLine[];
  totalRevenue: number;
  totalExpense: number;
  /** กำไร(ขาดทุน)สุทธิ = รายได้ − ค่าใช้จ่าย */
  netProfit: number;
};

export type BalanceSheet = {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** กำไร(ขาดทุน)สุทธิของงวด (นำไปรวมในส่วนของผู้ถือหุ้น) */
  netProfit: number;
  /** ทุน + กำไรสะสมของงวด */
  totalEquityWithProfit: number;
  /** สินทรัพย์ − (หนี้สิน + ทุน + กำไรสุทธิ) — ควร = 0 */
  difference: number;
  /** งบดุลสมดุลไหม (|difference| < epsilon) */
  balanced: boolean;
};

function toLines(rows: TrialBalanceRow[], sign: 1 | -1): StatementLine[] {
  return rows.map((r) => ({ code: r.code, name: r.name, amount: round2(sign * r.balance) }));
}

function sum(lines: StatementLine[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}

/** งบกำไรขาดทุน: รายได้ (หมวด 4) − ค่าใช้จ่าย (หมวด 5,6) */
export function buildIncomeStatement(tb: TrialBalance): IncomeStatement {
  const revenues = toLines(
    tb.rows.filter((r) => r.digit === "4"),
    -1
  );
  const expenses = toLines(
    tb.rows.filter((r) => r.digit === "5" || r.digit === "6"),
    1
  );
  const totalRevenue = sum(revenues);
  const totalExpense = sum(expenses);
  return {
    revenues,
    expenses,
    totalRevenue,
    totalExpense,
    netProfit: round2(totalRevenue - totalExpense),
  };
}

/** งบแสดงฐานะการเงิน: สินทรัพย์ = หนี้สิน + ทุน + กำไรสะสมของงวด */
export function buildBalanceSheet(tb: TrialBalance): BalanceSheet {
  const income = buildIncomeStatement(tb);

  const assets = toLines(
    tb.rows.filter((r) => r.digit === "1"),
    1
  );
  const liabilities = toLines(
    tb.rows.filter((r) => r.digit === "2"),
    -1
  );
  const equity = toLines(
    tb.rows.filter((r) => r.digit === "3"),
    -1
  );

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity);
  const netProfit = income.netProfit;
  const totalEquityWithProfit = round2(totalEquity + netProfit);
  const difference = round2(totalAssets - (totalLiabilities + totalEquityWithProfit));

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netProfit,
    totalEquityWithProfit,
    difference,
    balanced: Math.abs(difference) < EPSILON,
  };
}
