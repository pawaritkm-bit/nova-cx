import { describe, it, expect } from "vitest";
import { buildJournalEntries } from "@/lib/accounting/journal";
import { buildLedger } from "@/lib/accounting/ledger";
import {
  buildLedgerStatement,
  buildLedgerStatements,
} from "@/lib/accounting/ledger-statement";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";

/**
 * เทสต์ buildLedgerStatement — พิสูจน์ว่าจัดรูป "1 บัญชี = 1 ชุด" ถูก:
 *   B/F(ยอดยกมา) → รายการ → C/F(ยอดยกไป) + รวม Dr/Cr (จำนวน+ยอด) ตรงกับ ledger เดิม
 *   บัญชีไม่เคลื่อนไหวแต่มียอดยกมา → โชว์แค่ B/F=C/F
 */

let seq = 0;
function mkLine(p: Partial<BillEntryLine> = {}): BillEntryLine {
  seq += 1;
  return {
    id: `l${seq}`, entryId: p.entryId ?? "e", lineNo: 1, vatType: "vat",
    description: null, accountCode: p.accountCode ?? null, accountName: null,
    amount: p.amount ?? 0, vatAmount: p.vatAmount ?? 0, whtRate: 0,
    whtAmount: p.whtAmount ?? 0, aiFilled: false,
  };
}
function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id, tenantId: "t", attachmentId: null, customerId: "c1", customerName: null,
    attachmentObjectPath: null, uploadPath: null, uploadName: null, uploadMime: null,
    entryType: p.entryType ?? "purchase", docDate: p.docDate ?? "2026-07-05", docNo: p.docNo ?? "PV-1",
    counterpartyName: p.counterpartyName ?? null, counterpartyTaxId: null, sellerName: null, sellerTaxId: null,
    buyerName: null, buyerTaxId: null, whtForm: null, paymentMethod: p.paymentMethod ?? "cash",
    paymentBankAccountId: null, paymentBankAccountCode: p.paymentBankAccountCode ?? null,
    status: "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null, lines: p.lines ?? [],
  };
}

describe("buildLedgerStatement — บัญชีมีเคลื่อนไหว (เงินสด 1010)", () => {
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "3010", accountName: "ทุน", openingBalance: -5000, note: null },
  ];
  const entries: BillEntry[] = [
    mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "cash", docDate: "2026-07-05", counterpartyName: "ร้าน ก",
      lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtAmount: 30 })] }),
    mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit", docDate: "2026-07-10",
      lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140, whtAmount: 60 })] }),
  ];
  const ledger = buildLedger(buildJournalEntries(entries).lines, opening);
  const cash = buildLedgerStatement(ledger.byCode.get("1010")!);

  it("B/F = ยอดยกมา (คงเหลือ = opening 5000)", () => {
    const bf = cash.rows[0];
    expect(bf.kind).toBe("bf");
    if (bf.kind === "bf") {
      expect(bf.label).toBe("ยอดยกมา");
      expect(bf.balance).toBe(5000);
    }
  });

  it("C/F = ยอดยกไป (คงเหลือปลายงวด = closing = 3960)", () => {
    const cf = cash.rows[cash.rows.length - 1];
    expect(cf.kind).toBe("cf");
    if (cf.kind === "cf") {
      expect(cf.label).toBe("ยอดยกไป");
      expect(cf.balance).toBe(3960);
    }
    expect(cash.closing).toBe(3960);
  });

  it("รายการอยู่ระหว่าง B/F กับ C/F + running balance ถูก + มีคำอธิบายคู่ค้า", () => {
    const txns = cash.rows.filter((r) => r.kind === "txn");
    expect(txns).toHaveLength(1); // เงินสดจ่ายบิลซื้อ 1 ครั้ง (ขายเป็นเชื่อ ไม่แตะเงินสด)
    const t = txns[0];
    if (t.kind === "txn") {
      expect(t.credit).toBe(1040); // 1000+70-30
      expect(t.balance).toBe(3960);
      expect(t.description).toBe("ร้าน ก");
    }
  });

  it("รวม Dr/Cr: จำนวน+ยอดตรงกับ ledger เดิม (เงินสดมีฝั่ง Cr 1 รายการ 1040)", () => {
    expect(cash.totals.creditCount).toBe(1);
    expect(cash.totals.creditAmount).toBe(1040);
    expect(cash.totals.debitCount).toBe(0);
    expect(cash.totals.debitAmount).toBe(0);
    // ยอดในสรุปต้องเท่ากับ totalDebit/totalCredit ของ ledger (ไม่คำนวณใหม่)
    const acc = ledger.byCode.get("1010")!;
    expect(cash.totals.debitAmount).toBe(acc.totalDebit);
    expect(cash.totals.creditAmount).toBe(acc.totalCredit);
  });
});

describe("buildLedgerStatement — บัญชีไม่เคลื่อนไหวแต่มียอดยกมา (โชว์แค่ B/F=C/F)", () => {
  // บัญชี 1500 มียอดยกมา 800 แต่ไม่มีบิลแตะ
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1500", accountName: "อุปกรณ์", openingBalance: 800, note: null },
  ];
  const ledger = buildLedger(buildJournalEntries([]).lines, opening);
  const st = buildLedgerStatement(ledger.byCode.get("1500")!);

  it("hasMovement=false + rows = [B/F, C/F] และยอดเท่ากัน", () => {
    expect(st.hasMovement).toBe(false);
    expect(st.rows).toHaveLength(2);
    expect(st.rows[0].kind).toBe("bf");
    expect(st.rows[1].kind).toBe("cf");
    const bf = st.rows[0];
    const cf = st.rows[1];
    if (bf.kind === "bf" && cf.kind === "cf") {
      expect(bf.balance).toBe(800);
      expect(cf.balance).toBe(800); // B/F = C/F
    }
    expect(st.totals.debitCount).toBe(0);
    expect(st.totals.creditCount).toBe(0);
    expect(st.totals.debitAmount).toBe(0);
    expect(st.totals.creditAmount).toBe(0);
  });
});

describe("buildLedgerStatements — ครอบทุกบัญชี เรียงตามรหัส", () => {
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "3010", accountName: "ทุน", openingBalance: -5000, note: null },
  ];
  const entries: BillEntry[] = [
    mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "cash",
      lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtAmount: 30 })] }),
  ];
  const ledger = buildLedger(buildJournalEntries(entries).lines, opening);
  const all = buildLedgerStatements(ledger);

  it("จำนวนบัญชี = ledger.accounts + เรียงรหัสจากน้อยไปมาก + ทุกชุดขึ้น B/F ลง C/F", () => {
    expect(all).toHaveLength(ledger.accounts.length);
    const codes = all.map((a) => a.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    for (const a of all) {
      expect(a.rows[0].kind).toBe("bf");
      expect(a.rows[a.rows.length - 1].kind).toBe("cf");
    }
  });
});
