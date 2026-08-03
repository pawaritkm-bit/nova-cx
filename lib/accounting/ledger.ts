/**
 * B. บัญชีแยกประเภท (Ledger) — รวมยอดต่อบัญชี จากสมุดรายวัน + ยอดยกมา
 *
 * ★ pure function (ไม่แตะ DB) — unit test ได้เต็ม
 * ★ ใช้ระบบ "เดบิตเป็นบวก" (debit-positive) ภายในทั้งหมด:
 *     signedBalance = opening + Σdebit − Σcredit
 *     ยอดยกมา (opening) เก็บแบบ debit-positive อยู่แล้ว (ค่าบวก=ยอดเดบิต / ค่าลบ=ยอดเครดิต)
 *     — ตรงกับที่หน้า "ยอดยกมา" อธิบายว่า "ยอดติดลบ = ยอดฝั่งเครดิต"
 * ★ normal balance (ด้านปกติของบัญชี) ตามเลขหลักแรก: 1,5,6 = เดบิต · 2,3,4 = เครดิต
 */
import {
  CHART_BY_CODE,
  categoryDigitOf,
  CATEGORY_BY_DIGIT,
} from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import type { JournalLine } from "@/lib/accounting/journal";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";

/** 1 รายการเคลื่อนไหวในบัญชีแยกประเภท (พร้อมยอดคงเหลือสะสม — debit-positive) */
export type LedgerTxn = {
  entryId: string;
  date: string | null;
  docNo: string | null;
  debit: number;
  credit: number;
  /** ยอดคงเหลือสะสม (debit-positive) หลังรายการนี้ */
  balance: number;
};

/** สรุปต่อบัญชี */
export type LedgerAccount = {
  code: string;
  name: string;
  category: string;
  /** เลขหมวด (1..6) */
  digit: string;
  /** ด้านปกติของบัญชี */
  normalSide: "debit" | "credit";
  /** ยอดยกมา (debit-positive: บวก=เดบิต / ลบ=เครดิต) */
  opening: number;
  totalDebit: number;
  totalCredit: number;
  /** ยอดคงเหลือปลายงวด (debit-positive) = opening + totalDebit − totalCredit */
  balance: number;
  txns: LedgerTxn[];
};

export type Ledger = {
  accounts: LedgerAccount[];
  byCode: Map<string, LedgerAccount>;
};

/** ด้านปกติของบัญชีตามเลขหมวด (1,5,6 = เดบิต · 2,3,4 = เครดิต) */
export function normalSideOf(code: string): "debit" | "credit" {
  const d = categoryDigitOf(code);
  return d === "1" || d === "5" || d === "6" ? "debit" : "credit";
}

/** ชื่อหมวดของบัญชี (ผังกลางก่อน → หมวดตามเลขหลักแรก) */
function categoryOf(code: string): string {
  return CHART_BY_CODE[code]?.category ?? CATEGORY_BY_DIGIT[categoryDigitOf(code)] ?? "อื่น ๆ";
}

/** คีย์เรียงตามวันที่ (null = ท้ายสุด) */
function dateKey(d: string | null): string {
  return d ?? "9999-99-99";
}

/**
 * รวมสมุดรายวัน + ยอดยกมา → บัญชีแยกประเภทต่อบัญชี
 *   - openingBalances: ยอดยกมาของลูกค้า (debit-positive)
 *   - รายการในแต่ละบัญชีเรียงตามวันที่ (สำหรับพิมพ์บัญชีแยกประเภท)
 */
export function buildLedger(
  journalLines: JournalLine[],
  openingBalances: Pick<OpeningBalance, "accountCode" | "accountName" | "openingBalance">[] = []
): Ledger {
  const map = new Map<string, LedgerAccount>();

  const ensure = (code: string, name?: string | null): LedgerAccount => {
    let a = map.get(code);
    if (!a) {
      a = {
        code,
        name: CHART_BY_CODE[code]?.name ?? (name && name.trim() ? name.trim() : code),
        category: categoryOf(code),
        digit: categoryDigitOf(code),
        normalSide: normalSideOf(code),
        opening: 0,
        totalDebit: 0,
        totalCredit: 0,
        balance: 0,
        txns: [],
      };
      map.set(code, a);
    } else if (a.name === code && name && name.trim() && !CHART_BY_CODE[code]) {
      // เติมชื่อถ้าก่อนหน้ายังไม่มีชื่อจริง
      a.name = name.trim();
    }
    return a;
  };

  // ยอดยกมา
  for (const ob of openingBalances) {
    const code = (ob.accountCode ?? "").trim();
    if (!code) continue;
    const a = ensure(code, ob.accountName);
    a.opening = round2(a.opening + (Number.isFinite(ob.openingBalance) ? ob.openingBalance : 0));
  }

  // เตรียมบัญชีจากสมุดรายวัน
  for (const jl of journalLines) ensure(jl.accountCode, jl.accountName);

  // เริ่มยอดคงเหลือสะสมจากยอดยกมา
  for (const a of map.values()) a.balance = a.opening;

  // เดินรายการตามวันที่ (stable sort) → สะสมยอด + เก็บ txn
  const sorted = [...journalLines].sort((x, y) => dateKey(x.date).localeCompare(dateKey(y.date)));
  for (const jl of sorted) {
    const a = map.get(jl.accountCode);
    if (!a) continue;
    a.totalDebit = round2(a.totalDebit + jl.debit);
    a.totalCredit = round2(a.totalCredit + jl.credit);
    a.balance = round2(a.balance + jl.debit - jl.credit);
    a.txns.push({
      entryId: jl.entryId,
      date: jl.date,
      docNo: jl.docNo,
      debit: jl.debit,
      credit: jl.credit,
      balance: a.balance,
    });
  }

  const accounts = [...map.values()].sort((x, y) =>
    x.code.localeCompare(y.code, undefined, { numeric: true })
  );
  return { accounts, byCode: map };
}
