/**
 * บัญชีแยกประเภทแบบ "1 บัญชี = 1 ชุด" (per-account statement) — ตามรูปแบบมาตรฐานสำนักงาน
 *   จัดรูปแต่ละบัญชีจาก LedgerAccount ให้เป็น: หัว → B/F(ยอดยกมา) → รายการ → C/F(ยอดยกไป) → รวม Dr/Cr
 *
 * ★ pure: reuse ตัวเลขจาก buildLedger เดิมทั้งหมด (ไม่คำนวณยอดใหม่ — แค่จัดรูป + นับจำนวนรายการ)
 * ★ บัญชีที่ไม่มีเคลื่อนไหวแต่มียอดยกมา → ได้แค่ B/F=C/F (rows = [bf, cf])
 */
import type { Ledger, LedgerAccount } from "@/lib/accounting/ledger";

/** 1 แถวในชุดบัญชีแยกประเภท: ยอดยกมา (bf) · รายการ (txn) · ยอดยกไป (cf) */
export type LedgerStatementRow =
  | { kind: "bf"; label: string; balance: number }
  | {
      kind: "txn";
      entryId: string;
      date: string | null;
      docNo: string | null;
      description: string | null;
      debit: number;
      credit: number;
      /** ยอดคงเหลือสะสม (debit-positive) หลังรายการนี้ */
      balance: number;
    }
  | { kind: "cf"; label: string; balance: number };

/** สรุปท้ายบัญชี: Dr = <จำนวน> <ยอดเดบิตรวม> · Cr = <จำนวน> <ยอดเครดิตรวม> */
export type LedgerStatementTotals = {
  debitCount: number;
  debitAmount: number;
  creditCount: number;
  creditAmount: number;
};

/** ชุดบัญชีแยกประเภทของ 1 บัญชี */
export type LedgerStatement = {
  code: string;
  name: string;
  category: string;
  digit: string;
  normalSide: "debit" | "credit";
  /** ยอดยกมา (debit-positive) */
  opening: number;
  /** ยอดยกไป = ยอดคงเหลือปลายงวด (debit-positive) */
  closing: number;
  /** มีรายการเคลื่อนไหวไหม (ถ้าไม่มี → โชว์แค่ B/F=C/F) */
  hasMovement: boolean;
  rows: LedgerStatementRow[];
  totals: LedgerStatementTotals;
};

/** จัดรูป 1 บัญชี → ชุด statement (B/F → รายการ → C/F + รวม Dr/Cr) */
export function buildLedgerStatement(a: LedgerAccount): LedgerStatement {
  const rows: LedgerStatementRow[] = [];

  // B/F: ยอดยกมา (คงเหลือ = opening)
  rows.push({ kind: "bf", label: "ยอดยกมา", balance: a.opening });

  // รายการ (เรียงวันที่มาแล้วจาก buildLedger) + นับจำนวนฝั่ง Dr/Cr
  let debitCount = 0;
  let creditCount = 0;
  for (const t of a.txns) {
    if (t.debit > 0) debitCount += 1;
    if (t.credit > 0) creditCount += 1;
    rows.push({
      kind: "txn",
      entryId: t.entryId,
      date: t.date,
      docNo: t.docNo,
      description: t.description ?? null,
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,
    });
  }

  // C/F: ยอดยกไป (คงเหลือปลายงวด)
  rows.push({ kind: "cf", label: "ยอดยกไป", balance: a.balance });

  return {
    code: a.code,
    name: a.name,
    category: a.category,
    digit: a.digit,
    normalSide: a.normalSide,
    opening: a.opening,
    closing: a.balance,
    hasMovement: a.txns.length > 0,
    rows,
    // ยอดรวมใช้ค่าที่ buildLedger สรุปไว้แล้ว (ไม่คำนวณซ้ำ)
    totals: {
      debitCount,
      debitAmount: a.totalDebit,
      creditCount,
      creditAmount: a.totalCredit,
    },
  };
}

/** จัดรูปทุกบัญชีในบัญชีแยกประเภท (เรียงตามรหัสบัญชีตาม ledger) */
export function buildLedgerStatements(ledger: Ledger): LedgerStatement[] {
  return ledger.accounts.map(buildLedgerStatement);
}
