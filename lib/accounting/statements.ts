/**
 * Facade รวม engine ออกงบการเงิน — เรียกครั้งเดียวได้ครบทุกรายงาน
 *   buildStatements(entries, openingBalances) → { journal, ledger, trialBalance, incomeStatement, balanceSheet }
 *
 * ★ pure (ไม่แตะ DB) — ใช้ทั้งหน้า reports (server component) และ export route
 */
import { buildJournalEntries, type JournalResult } from "@/lib/accounting/journal";
import { buildLedger, type Ledger } from "@/lib/accounting/ledger";
import { buildTrialBalance, type TrialBalance } from "@/lib/accounting/trial-balance";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  type IncomeStatement,
  type BalanceSheet,
} from "@/lib/accounting/financial-statements";
import type { BillEntry } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";

export type Statements = {
  journal: JournalResult;
  ledger: Ledger;
  trialBalance: TrialBalance;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
};

export function buildStatements(
  entries: BillEntry[],
  openingBalances: Pick<OpeningBalance, "accountCode" | "accountName" | "openingBalance">[] = []
): Statements {
  const journal = buildJournalEntries(entries);
  const ledger = buildLedger(journal.lines, openingBalances);
  const trialBalance = buildTrialBalance(ledger);
  const incomeStatement = buildIncomeStatement(trialBalance);
  const balanceSheet = buildBalanceSheet(trialBalance);
  return { journal, ledger, trialBalance, incomeStatement, balanceSheet };
}

/** รหัสรายงานที่ export ได้ (single sheet) หรือ 'all' = ทุกงบในไฟล์เดียว */
export type ReportKey = "journal" | "ledger" | "trial" | "income" | "balance" | "all";

export function asReportKey(v: unknown): ReportKey {
  return v === "journal" ||
    v === "ledger" ||
    v === "trial" ||
    v === "income" ||
    v === "balance"
    ? v
    : "all";
}
