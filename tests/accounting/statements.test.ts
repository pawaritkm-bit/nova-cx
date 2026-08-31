import { describe, it, expect } from "vitest";
import { buildJournalEntries } from "@/lib/accounting/journal";
import { buildLedger } from "@/lib/accounting/ledger";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import {
  buildIncomeStatement,
  buildBalanceSheet,
} from "@/lib/accounting/financial-statements";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";
import { buildStatements } from "@/lib/accounting/statements";
import { toJournalLines, type ManualJournalEntry } from "@/lib/accounting/manual-journal";
import { toJournalLines as toNoteJournalLines, type CreditDebitNote } from "@/lib/accounting/credit-debit-notes";

/**
 * เทสต์ engine ออกงบการเงิน (pure) — เน้น "พิสูจน์สมดุล double-entry" ด้วยตัวเลขที่คำนวณมือแล้ว:
 *   - ทุก journal: เดบิตรวม = เครดิตรวม
 *   - งบทดลอง: เดบิตเคลื่อนไหวรวม = เครดิตเคลื่อนไหวรวม + ยอดปลายงวดสองฝั่งเท่ากัน (เมื่อยกมาสมดุล)
 *   - งบดุล: สินทรัพย์ = หนี้สิน + ทุน + กำไรสุทธิ
 */

// ---- factory ----
let seq = 0;
function mkLine(p: Partial<BillEntryLine> = {}): BillEntryLine {
  seq += 1;
  return {
    id: `l${seq}`,
    entryId: p.entryId ?? "e",
    lineNo: p.lineNo ?? 1,
    vatType: p.vatType ?? "vat",
    description: p.description ?? null,
    accountCode: p.accountCode ?? null,
    accountName: p.accountName ?? null,
    amount: p.amount ?? 0,
    vatAmount: p.vatAmount ?? 0,
    whtRate: p.whtRate ?? 0,
    whtAmount: p.whtAmount ?? 0,
    aiFilled: p.aiFilled ?? false,
    aiLowConfidence: p.aiLowConfidence ?? false,
  };
}

function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id,
    tenantId: p.tenantId ?? "t",
    attachmentId: null,
    customerId: p.customerId ?? "c1",
    customerName: p.customerName ?? null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: p.entryType ?? "purchase",
    docDate: p.docDate ?? "2026-07-01",
    docNo: p.docNo ?? null,
    counterpartyName: p.counterpartyName ?? null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: p.whtForm ?? null,
    paymentMethod: p.paymentMethod ?? null,
    paymentBankAccountId: p.paymentBankAccountId ?? null,
    paymentBankAccountCode: p.paymentBankAccountCode ?? null,
    dueDate: p.dueDate ?? null,
    status: p.status ?? "confirmed",
    source: p.source ?? "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    lines: p.lines ?? [],
  };
}

const sumDebit = (ls: { debit: number }[]) => Math.round(ls.reduce((s, l) => s + l.debit, 0) * 100) / 100;
const sumCredit = (ls: { credit: number }[]) => Math.round(ls.reduce((s, l) => s + l.credit, 0) * 100) / 100;

// ===================================================================
// A. สมุดรายวัน (Journal)
// ===================================================================
describe("journal — ซื้อ เงินสด มี VAT + หัก ณ ที่จ่าย", () => {
  const entry = mkEntry({
    id: "e1",
    entryType: "purchase",
    paymentMethod: "cash",
    docNo: "PV-001",
    lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtRate: 3, whtAmount: 30 })],
  });
  const r = buildJournalEntries([entry]);

  it("สมดุล: เดบิตรวม = เครดิตรวม = 1070", () => {
    expect(r.totalDebit).toBe(1070);
    expect(r.totalCredit).toBe(1070);
    expect(sumDebit(r.lines)).toBe(sumCredit(r.lines));
  });

  it("ตั้งบัญชีถูกต้อง (Dr 5010=1000, Dr 1154=70, Cr 2910=30, Cr 1010=1040)", () => {
    const find = (code: string) => r.lines.find((l) => l.accountCode === code);
    expect(find("5010")?.debit).toBe(1000);
    expect(find("1154")?.debit).toBe(70); // ภาษีซื้อ
    expect(find("2910")?.credit).toBe(30); // หัก ณ ที่จ่าย ค้างจ่าย
    expect(find("1010")?.credit).toBe(1040); // เงินสด = 1000+70-30
  });
});

describe("journal — ขาย เชื่อ มี VAT + ถูกหัก ณ ที่จ่าย", () => {
  const entry = mkEntry({
    id: "e2",
    entryType: "sale",
    paymentMethod: "credit",
    lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140, whtRate: 3, whtAmount: 60 })],
  });
  const r = buildJournalEntries([entry]);

  it("สมดุล = 2140", () => {
    expect(r.totalDebit).toBe(2140);
    expect(r.totalCredit).toBe(2140);
  });

  it("ตั้งบัญชีถูกต้อง (Cr 4010=2000, Cr 2900=140, Dr 1216=60, Dr 1140=2080)", () => {
    const find = (code: string) => r.lines.find((l) => l.accountCode === code);
    expect(find("4010")?.credit).toBe(2000);
    expect(find("2900")?.credit).toBe(140); // ภาษีขาย
    expect(find("1216")?.debit).toBe(60); // ภาษีถูกหัก
    expect(find("1140")?.debit).toBe(2080); // ลูกหนี้ = 2000+140-60
  });
});

describe("journal — ซื้อ โอน บิลผสม VAT + noVAT ไม่มีหัก", () => {
  const entry = mkEntry({
    id: "e3",
    entryType: "purchase",
    paymentMethod: "transfer",
    paymentBankAccountCode: "1020",
    lines: [
      mkLine({ accountCode: "5320", amount: 500, vatAmount: 35, vatType: "vat" }),
      mkLine({ accountCode: "5325", amount: 300, vatAmount: 0, vatType: "novat" }),
    ],
  });
  const r = buildJournalEntries([entry]);

  it("สมดุล = 835", () => {
    expect(r.totalDebit).toBe(835);
    expect(r.totalCredit).toBe(835);
  });

  it("Cr เข้าบัญชีธนาคารที่เลือก (1020) = 800+35 = 835", () => {
    expect(r.lines.find((l) => l.accountCode === "1020")?.credit).toBe(835);
  });
});

describe("journal — บิลที่ตกหล่น (skipped) พร้อมเหตุผล", () => {
  it("unspecified → ตกหล่น", () => {
    const r = buildJournalEntries([mkEntry({ id: "u", entryType: "unspecified", paymentMethod: "cash" })]);
    expect(r.lines).toHaveLength(0);
    expect(r.skipped[0].reason).toContain("ยังไม่ระบุประเภท");
  });

  it("บรรทัดไม่เลือกบัญชี → ตกหล่น", () => {
    const r = buildJournalEntries([
      mkEntry({
        id: "m",
        entryType: "purchase",
        paymentMethod: "cash",
        lines: [mkLine({ accountCode: null, amount: 500 })],
      }),
    ]);
    expect(r.lines).toHaveLength(0);
    expect(r.skipped[0].reason).toContain("ยังไม่เลือกบัญชี");
  });

  it("★ โอนแต่ไม่ผูกบัญชีธนาคาร → ใช้ default 1020 (ไม่ตกหล่น)", () => {
    const r = buildJournalEntries([
      mkEntry({
        id: "b",
        entryType: "purchase",
        paymentMethod: "transfer",
        paymentBankAccountCode: null,
        lines: [mkLine({ accountCode: "5010", amount: 500, vatAmount: 35 })],
      }),
    ]);
    expect(r.skipped).toHaveLength(0);
    // Cr เข้าเงินฝากธนาคาร default 1020 = 500 + 35 = 535
    expect(r.lines.find((l) => l.accountCode === "1020")?.credit).toBe(535);
  });

  it("ไม่ระบุวิธีจ่าย → ถือเป็น 'เชื่อ' (ตั้งเจ้าหนี้) เข้าสมุด ไม่ตกหล่น", () => {
    const r = buildJournalEntries([
      mkEntry({
        id: "n",
        entryType: "purchase",
        paymentMethod: null,
        lines: [mkLine({ accountCode: "5010", amount: 500 })],
      }),
    ]);
    expect(r.skipped.length).toBe(0);
    // เครดิต = เจ้าหนี้การค้า (2010) เพราะ default เป็นเชื่อ
    expect(r.lines.some((l) => l.side === "credit" && l.accountCode === "2010")).toBe(true);
  });
});

// ===================================================================
// B–D. บัญชีแยกประเภท + งบทดลอง + งบการเงิน (สมุดบัญชี 1 ลูกค้า)
// ===================================================================
describe("full book — ledger + trial balance + งบการเงิน (คำนวณมือแล้ว)", () => {
  // ยอดยกมา (debit-positive): เงินสด 5000 (Dr) / ทุน 5000 (Cr) — สมดุล
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: -5000, note: null },
  ];

  const entries: BillEntry[] = [
    mkEntry({
      id: "p1",
      entryType: "purchase",
      paymentMethod: "cash",
      docDate: "2026-07-05",
      lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtAmount: 30 })],
    }),
    mkEntry({
      id: "s1",
      entryType: "sale",
      paymentMethod: "credit",
      docDate: "2026-07-10",
      lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140, whtAmount: 60 })],
    }),
  ];

  const journal = buildJournalEntries(entries);
  const ledger = buildLedger(journal.lines, opening);
  const tb = buildTrialBalance(ledger);
  const income = buildIncomeStatement(tb);
  const bs = buildBalanceSheet(tb);

  it("สมุดรายวันสมดุล", () => {
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.skipped).toHaveLength(0);
  });

  it("ledger: ยอดคงเหลือปลายงวดถูกต้อง (debit-positive)", () => {
    const bal = (code: string) => ledger.byCode.get(code)?.balance;
    expect(bal("1010")).toBe(3960); // 5000 - 1040
    expect(bal("5010")).toBe(1000);
    expect(bal("1154")).toBe(70);
    expect(bal("2910")).toBe(-30);
    expect(bal("4010")).toBe(-2000);
    expect(bal("2900")).toBe(-140);
    expect(bal("1216")).toBe(60);
    expect(bal("1140")).toBe(2080);
    expect(bal("3010")).toBe(-5000);
  });

  it("ledger: รายการเรียงตามวันที่ + ยอดสะสมถูก (1010)", () => {
    const cash = ledger.byCode.get("1010")!;
    expect(cash.txns).toHaveLength(1);
    expect(cash.txns[0].balance).toBe(3960);
  });

  it("งบทดลอง: เดบิตเคลื่อนไหวรวม = เครดิตเคลื่อนไหวรวม = 3210", () => {
    expect(tb.totalDebit).toBe(3210);
    expect(tb.totalCredit).toBe(3210);
    expect(tb.movementBalanced).toBe(true);
  });

  it("งบทดลอง: ยอดปลายงวดสองฝั่งเท่ากัน = 7170 (ยกมาสมดุล)", () => {
    expect(tb.totalBalanceDebit).toBe(7170);
    expect(tb.totalBalanceCredit).toBe(7170);
    expect(tb.balanced).toBe(true);
  });

  it("งบกำไรขาดทุน: รายได้ 2000 − ค่าใช้จ่าย 1000 = กำไรสุทธิ 1000", () => {
    expect(income.totalRevenue).toBe(2000);
    expect(income.totalExpense).toBe(1000);
    expect(income.netProfit).toBe(1000);
  });

  it("★ งบดุลสมดุล: สินทรัพย์ 6170 = หนี้สิน 170 + ทุน 5000 + กำไร 1000", () => {
    expect(bs.totalAssets).toBe(6170);
    expect(bs.totalLiabilities).toBe(170);
    expect(bs.totalEquity).toBe(5000);
    expect(bs.netProfit).toBe(1000);
    expect(bs.totalEquityWithProfit).toBe(6000);
    expect(bs.difference).toBe(0);
    expect(bs.balanced).toBe(true);
  });
});

describe("full book — ยอดยกมาไม่สมดุล → balanced=false (ให้ UI เตือน)", () => {
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    // ตั้งใจไม่ใส่ทุนคู่ → ยกมาไม่สมดุล
  ];
  const journal = buildJournalEntries([]);
  const ledger = buildLedger(journal.lines, opening);
  const tb = buildTrialBalance(ledger);
  const bs = buildBalanceSheet(tb);

  it("เคลื่อนไหวยังสมดุล (ไม่มีบิล) แต่ยอดปลายงวด/งบดุลไม่สมดุล", () => {
    expect(tb.movementBalanced).toBe(true);
    expect(tb.balanced).toBe(false);
    expect(bs.balanced).toBe(false);
    expect(bs.difference).not.toBe(0);
  });
});

// ===================================================================
// E. buildStatements() facade — manual JE (เฟส 1 ส่วน C) concat เข้า ledger/trial-balance/งบ
// ===================================================================
describe("buildStatements — manualJournalLines concat ก่อน buildLedger (ไม่กระทบ journal.lines/skipped ของบิล)", () => {
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: -5000, note: null },
  ];

  const billEntries: BillEntry[] = [
    mkEntry({
      id: "p1",
      entryType: "purchase",
      paymentMethod: "cash",
      docDate: "2026-07-05",
      lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtAmount: 30 })],
    }),
  ];

  // manual JE: ปรับปรุงค่าเสื่อมราคา (JV) — Dr 5370 ค่าเสื่อม 500 / Cr 1615.1 ค่าเสื่อมสะสม 500 (สมดุล)
  const manualEntry: ManualJournalEntry = {
    id: "je1",
    tenantId: "t",
    customerId: "c1",
    docType: "JV",
    docDate: "2026-07-20",
    docNo: "JV-001",
    memo: "ปรับปรุงค่าเสื่อมราคา",
    status: "confirmed",
    createdAt: "2026-07-20T00:00:00Z",
    confirmedAt: "2026-07-20T00:00:00Z",
    lines: [
      { id: "l1", lineNo: 1, accountCode: "5370", accountName: "ค่าเสื่อมราคา-อาคาร", description: null, debit: 500, credit: 0 },
      { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "ค่าเสื่อมสะสม-อาคาร", description: null, debit: 0, credit: 500 },
    ],
  };
  const manualLines = toJournalLines(manualEntry);

  it("ไม่ส่ง manualJournalLines (default []) → behavior เดิมทุกอย่าง (ไม่มี manual accounts ปน)", () => {
    const s = buildStatements(billEntries, opening);
    expect(s.ledger.byCode.get("5370")).toBeUndefined();
    expect(s.trialBalance.totalDebit).toBe(s.trialBalance.totalCredit);
  });

  it("ส่ง manualJournalLines → ปรากฏใน ledger ถูกต้อง (บัญชีค่าเสื่อม/ค่าเสื่อมสะสม)", () => {
    const s = buildStatements(billEntries, opening, {}, manualLines);
    expect(s.ledger.byCode.get("5370")?.balance).toBe(500);
    expect(s.ledger.byCode.get("1615.1")?.balance).toBe(-500);
  });

  it("★ งบทดลอง: manual JE รวมเข้าสมดุลรวมทั้งระบบ (เดบิตรวม = เครดิตรวม)", () => {
    const s = buildStatements(billEntries, opening, {}, manualLines);
    // เดิม (ไม่มี manual): 1070 (จากบิลซื้อ) — บวก manual 500/500 เข้าไปอีก
    expect(s.trialBalance.totalDebit).toBe(1070 + 500);
    expect(s.trialBalance.totalCredit).toBe(1070 + 500);
    expect(s.trialBalance.movementBalanced).toBe(true);
  });

  it("★ งบกำไรขาดทุน: ค่าเสื่อมราคาจาก manual JE รวมเป็นค่าใช้จ่ายด้วย", () => {
    const s = buildStatements(billEntries, opening, {}, manualLines);
    // ค่าใช้จ่ายเดิม 1000 (ซื้อ 5010) + ค่าเสื่อม manual 500 = 1500
    expect(s.incomeStatement.totalExpense).toBe(1500);
  });

  it("journal.lines/skipped ของ statements.journal ไม่รวม manual JE (ตามสเปก C3 — concat แค่ก่อน buildLedger)", () => {
    const s = buildStatements(billEntries, opening, {}, manualLines);
    expect(s.journal.lines.some((l) => l.accountCode === "5370")).toBe(false);
  });
});

// ===================================================================
// F. buildStatements() + noteJournalLines (เฟส 3 ส่วน J, 0.7 — CN/DN concat เข้างบเดียวกับ manual JE)
// ===================================================================
describe("buildStatements — noteJournalLines (CN/DN) concat เข้า buildLedger แล้วงบทดลองยังสมดุล", () => {
  const opening: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: -5000, note: null },
  ];

  // บิลขายเชื่อ 2000+140(vat) = 2140 → ตั้ง AR (1140) ไว้
  const billEntries: BillEntry[] = [
    mkEntry({
      id: "s1",
      entryType: "sale",
      paymentMethod: "credit",
      docDate: "2026-07-10",
      lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140 })],
    }),
  ];

  // ใบลดหนี้ (credit_note) ลดยอดขาย 500 + vat 35 = 535 — กลับทิศทั้งหมดของบิลขายปกติ (0.5)
  const note: CreditDebitNote = {
    id: "cn1",
    tenantId: "t",
    entryId: "s1",
    customerId: "c1",
    docType: "credit_note",
    docDate: "2026-07-20",
    docNo: "CN-001",
    reason: "สินค้าชำรุด",
    status: "confirmed",
    createdAt: "2026-07-20T00:00:00Z",
    confirmedAt: "2026-07-20T00:00:00Z",
    lines: [{ lineNo: 1, description: null, accountCode: "4010", accountName: "ขายสินค้า", amount: 500, vatAmount: 35 }],
  };
  const noteLines = toNoteJournalLines(
    note,
    { entryType: "sale", docNo: "INV-001", customerId: "c1", counterpartyName: "ลูกค้า A" },
    {}
  );

  it("ไม่ส่ง noteJournalLines (default []) → behavior เดิม (ไม่มี CN ปน)", () => {
    const s = buildStatements(billEntries, opening);
    expect(s.ledger.byCode.get("1140")?.balance).toBe(2140);
  });

  it("ส่ง noteJournalLines → AR (1140) ลดลงตามยอด CN, บัญชีขาย/VAT ขายลดลงตรงกัน", () => {
    const s = buildStatements(billEntries, opening, {}, noteLines);
    expect(s.ledger.byCode.get("1140")?.balance).toBe(2140 - 535); // ลูกหนี้ลดลงตามยอด CN
    expect(s.ledger.byCode.get("4010")?.balance).toBe(-2000 + 500); // รายได้ลดลง (เดบิตเข้าไปหักเครดิตเดิม)
    expect(s.ledger.byCode.get("2900")?.balance).toBe(-140 + 35); // ภาษีขายลดลง
  });

  it("★ งบทดลอง: CN รวมเข้าสมดุลรวมทั้งระบบ (เดบิตรวม = เครดิตรวม)", () => {
    const s = buildStatements(billEntries, opening, {}, noteLines);
    expect(s.trialBalance.totalDebit).toBe(s.trialBalance.totalCredit);
    expect(s.trialBalance.movementBalanced).toBe(true);
  });

  it("journal.lines ของ statements.journal ไม่รวม CN (concat แค่ก่อน buildLedger เหมือน manual JE)", () => {
    const s = buildStatements(billEntries, opening, {}, noteLines);
    expect(s.journal.lines.some((l) => l.entryId === "cn1")).toBe(false);
  });
});
