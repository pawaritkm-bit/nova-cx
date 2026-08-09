import { describe, it, expect } from "vitest";
import { buildFormalStatements } from "@/lib/accounting/formal-statements";
import { buildStatements } from "@/lib/accounting/statements";
import type { CombinedJournalLines } from "@/lib/accounting/statement-inputs";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { defaultFlowAccountSync } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";

/**
 * formal-statements.ts — เฟส 4 ส่วน M4 (docs/06-accounting-features-roadmap.md, หมวด 0.3)
 *   ★ เทสต์ที่สำคัญที่สุดของเฟสนี้: พิสูจน์ว่าบั๊ก correctness ของ "งบแสดงฐานะการเงิน" (0.3) ถูกแก้จริง —
 *     ไม่ว่าผู้ใช้จะตั้ง `from` หรือไม่ตั้ง balanceSheet ต้องเท่ากันเป๊ะ (สะสมตั้งแต่ยอดยกมาแรกสุดถึง `to`)
 */

let seq = 0;
function mkLine(p: Partial<BillEntryLine> = {}): BillEntryLine {
  seq += 1;
  return {
    id: `l${seq}`,
    entryId: p.entryId ?? "e",
    lineNo: p.lineNo ?? 1,
    vatType: p.vatType ?? "novat",
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
    tenantId: p.tenantId ?? "t1",
    attachmentId: null,
    customerId: p.customerId ?? "c1",
    customerName: null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: p.entryType ?? "purchase",
    docDate: p.docDate ?? "2026-01-01",
    docNo: p.docNo ?? null,
    counterpartyName: p.counterpartyName ?? null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    paymentMethod: p.paymentMethod ?? "cash",
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: null,
    status: p.status ?? "confirmed",
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    flowaccountSync: defaultFlowAccountSync(),
    lines: p.lines ?? [],
  };
}

const EMPTY_COMBINED: CombinedJournalLines = {
  manualJournalLines: [],
  paymentJournalLines: [],
  noteJournalLines: [],
};

// ยอดยกมา: เงินสด 5000 (Dr) / ทุนเรือนหุ้น 5000 (Cr) — สมดุล
const opening: OpeningBalance[] = [
  { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
  { id: "o2", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: -5000, note: null },
];

// รายการก่อน "from" (ม.ค.) — ซื้อสินค้าเงินสด 1000: Dr 5010=1000 / Cr 1010=1000 (กระทบเงินสด)
const janEntry = mkEntry({
  id: "jan1",
  entryType: "purchase",
  paymentMethod: "cash",
  docDate: "2026-01-15",
  lines: [mkLine({ accountCode: "5010", amount: 1000 })],
});

// รายการในงวดที่เลือกจริง (มี.ค.) — ขายเชื่อ 2000: Dr 1140=2000 / Cr 4010=2000
const marEntry = mkEntry({
  id: "mar1",
  entryType: "sale",
  paymentMethod: "credit",
  docDate: "2026-03-20",
  lines: [mkLine({ accountCode: "4010", amount: 2000 })],
});

const entries: BillEntry[] = [janEntry, marEntry];

describe("buildFormalStatements — 0.3: balanceSheet ถูกต้องไม่ว่าจะตั้ง from หรือไม่", () => {
  it("★★★ ตั้ง from≠'' → balanceSheet เท่ากับตอน from='' เป๊ะ (พิสูจน์บั๊ก 0.3 ถูกแก้จริง)", () => {
    const withFrom = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    const withoutFrom = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "",
      to: "2026-03",
      includeDraft: true,
    });
    expect(withFrom.balanceSheet).toEqual(withoutFrom.balanceSheet);
  });

  it("balanceSheet สะสมรวมผลกระทบของรายการก่อน from ด้วย (ไม่ขาดหายไปเงียบ ๆ)", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    const bs = s.balanceSheet;
    // เงินสด: 5000 (ยกมา) - 1000 (ซื้อ ม.ค.) = 4000 — ★ ถ้าบั๊กยังอยู่ ตัวเลขนี้จะยังเป็น 5000 (ขาดผลของ ม.ค.)
    const cash = bs.assets.find((a) => a.code === "1010");
    expect(cash?.amount).toBe(4000);
    // ลูกหนี้การค้า (มี.ค.) = 2000
    const ar = bs.assets.find((a) => a.code === "1140");
    expect(ar?.amount).toBe(2000);
    expect(bs.totalAssets).toBe(6000);
    // งบสมดุล: สินทรัพย์ 6000 = ทุน 5000 + กำไรสะสม (รายได้2000-ค่าใช้จ่าย1000) 1000
    expect(bs.totalEquityWithProfit).toBe(6000);
    expect(bs.balanced).toBe(true);
  });

  it("ไม่ตั้งงวดเลย (from=to='') → ผลลัพธ์เหมือนเรียก buildStatements() ตรง ๆ ครั้งเดียว (regression-safe)", () => {
    const period = { from: "", to: "", includeDraft: true };
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, period);
    const direct = buildStatements(entries, opening, {}, []);
    expect(s.flow.journal).toEqual(direct.journal);
    expect(s.flow.ledger).toEqual(direct.ledger);
    expect(s.flow.trialBalance).toEqual(direct.trialBalance);
    expect(s.flow.incomeStatement).toEqual(direct.incomeStatement);
    expect(s.balanceSheet).toEqual(direct.balanceSheet);
  });

  it("flow.incomeStatement สะท้อนเฉพาะงวดที่เลือกจริง (from-to) — เป็น flow statement ปกติ", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    // เฉพาะรายการมี.ค. (ขาย 2000) — รายการ ม.ค. (ซื้อ 1000) ไม่รวมในรอบ flow
    expect(s.flow.incomeStatement.totalRevenue).toBe(2000);
    expect(s.flow.incomeStatement.totalExpense).toBe(0);
    expect(s.flow.incomeStatement.netProfit).toBe(2000);
  });

  it("★ รอบ cumulative ไม่ปนเข้ารอบ flow — flow.incomeStatement ไม่เปลี่ยนไม่ว่าจะเรียกกี่รอบ", () => {
    const period = { from: "2026-03", to: "2026-03", includeDraft: true };
    const s1 = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, period);
    const s2 = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, period);
    expect(s1.flow.incomeStatement).toEqual(s2.flow.incomeStatement);
    expect(s1.flow.incomeStatement.totalExpense).toBe(0); // ไม่มีค่าใช้จ่ายของ ม.ค. ปนเข้ามา
  });

  it("flow.journal ไม่รวมรายการก่อน from (ตัดตาม period จริง)", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    expect(s.flow.journal.lines.some((l) => l.entryId === "jan1")).toBe(false);
    expect(s.flow.journal.lines.some((l) => l.entryId === "mar1")).toBe(true);
  });

  it("combinedLines (manual JE/payment/note) ถูกรวมเข้าทั้ง 2 รอบ ผ่าน flattenCombinedJournalLines เดิม", () => {
    const combined: CombinedJournalLines = {
      manualJournalLines: [
        {
          entryId: "je1",
          date: "2026-03-25",
          docNo: "JV-001",
          accountCode: "5370",
          accountName: "ค่าเสื่อมราคา-อาคาร",
          debit: 300,
          credit: 0,
          side: "debit",
          customerId: "c1",
          counterparty: null,
        },
        {
          entryId: "je1",
          date: "2026-03-25",
          docNo: "JV-001",
          accountCode: "1615.1",
          accountName: "ค่าเสื่อมสะสม-อาคาร",
          debit: 0,
          credit: 300,
          side: "credit",
          customerId: "c1",
          counterparty: null,
        },
      ],
      paymentJournalLines: [],
      noteJournalLines: [],
    };
    const s = buildFormalStatements(entries, combined, combined, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    // manual JE เข้ารอบ flow ด้วย (ผ่าน ledger/trialBalance)
    expect(s.flow.ledger.byCode.get("5370")?.balance).toBe(300);
    // และเข้ารอบ cumulative ด้วย (ผ่าน balanceSheet — ค่าเสื่อมสะสมเป็นสินทรัพย์หักลบ)
    const accDep = s.balanceSheet.assets.find((a) => a.code === "1615.1");
    expect(accDep?.amount).toBe(-300);
  });
});

/**
 * ★★★ [แก้บั๊กรอบตรวจโค้ด — 2026] เทสต์นี้พิสูจน์บั๊กที่ reviewer พบจริง: caller เดิมโหลด combinedLines
 *   (manual JE/bill_payments/CN-DN) ครั้งเดียวด้วย period ของรอบ flow แล้วส่งชุดเดียวกันเข้าทั้ง 2 รอบ —
 *   ทำให้ 3 แหล่งข้อมูลนี้ที่เกิด "ก่อน from" หายไปจาก balanceSheet/openingCash เงียบ ๆ — จำลอง caller ที่
 *   แก้ถูกต้องแล้ว: `flowCombinedLines` = โหลดด้วย period ของ flow (ไม่มีรายการก่อน from) ส่วน
 *   `cumulativeCombinedLines` = โหลดด้วย {from:"", to} (มีรายการก่อน from ครบ) — ยืนยันว่า balanceSheet/
 *   openingCash/cashFlow รวมผลกระทบของรายการก่อน from ถูกต้องแล้วทั้ง 3 แหล่งข้อมูล
 */
describe("buildFormalStatements — 0.3/0.9 [แก้บั๊กแล้ว] manual JE/bill_payments/CN-DN ที่เกิดก่อน from ต้องไม่หายจากงบสะสม", () => {
  const periodMar = { from: "2026-03", to: "2026-03", includeDraft: true };
  const periodNoFrom = { from: "", to: "2026-03", includeDraft: true };

  it("manual JE ก่อน from (ม.ค.) — balanceSheet/openingCash ของรอบ from='2026-03' ต้องเท่ากับตอน from='' เป๊ะ", () => {
    // manual JE ซื้ออุปกรณ์สำนักงานเงินสด ลงวันที่ 2026-01-12 (ก่อน from=มี.ค.): Dr 1640=800 / Cr 1010=800
    const janManualLine = [
      {
        entryId: "je-jan-equip",
        date: "2026-01-12",
        docNo: "PV-J1",
        accountCode: "1640",
        accountName: "อุปกรณ์สำนักงาน",
        debit: 800,
        credit: 0,
        side: "debit" as const,
        customerId: "c1",
        counterparty: null,
      },
      {
        entryId: "je-jan-equip",
        date: "2026-01-12",
        docNo: "PV-J1",
        accountCode: "1010",
        accountName: "เงินสด",
        debit: 0,
        credit: 800,
        side: "credit" as const,
        customerId: "c1",
        counterparty: null,
      },
    ];
    // ★ จำลอง caller ที่แก้ถูกต้องแล้ว: flowCombinedLines โหลดด้วย period ของ flow (ไม่มี JE ม.ค. — อยู่นอกช่วง)
    const flowCombined: CombinedJournalLines = { manualJournalLines: [], paymentJournalLines: [], noteJournalLines: [] };
    // cumulativeCombinedLines โหลดด้วย {from:"", to} (มี JE ม.ค. ครบ — เกิดก่อน "to" จึงเข้ามาด้วย)
    const cumulativeCombined: CombinedJournalLines = { manualJournalLines: janManualLine, paymentJournalLines: [], noteJournalLines: [] };

    const withFrom = buildFormalStatements(entries, flowCombined, cumulativeCombined, opening, {}, periodMar);
    const withoutFrom = buildFormalStatements(entries, cumulativeCombined, cumulativeCombined, opening, {}, periodNoFrom);

    expect(withFrom.balanceSheet).toEqual(withoutFrom.balanceSheet);
    const cash = withFrom.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    const equip = withFrom.balanceSheet.assets.find((a) => a.code === "1640")?.amount ?? 0;
    // เงินสด: 5000(ยกมา) - 800(JE ม.ค.) - 1000(ซื้อเงินสด ม.ค. จาก janEntry เดิมของไฟล์นี้) = 3200
    expect(cash).toBe(3200);
    expect(equip).toBe(800);
    // openingCash (O3) ของรอบมี.ค. ต้องรวมผลของ JE ม.ค. ด้วย (สะสม ณ สิ้น ก.พ.)
    expect(withFrom.cashFlow.openingCash).toBe(3200);
    // flow round ไม่ปนรายการ ม.ค. เลย (ยังคงเป็น flow statement ปกติ)
    expect(withFrom.flow.ledger.byCode.get("1640")).toBeUndefined();
  });

  it("bill_payments ก่อน from (ม.ค.) — balanceSheet/openingCash ต้องรวมผลของรายการรับเงินก่อน from ด้วย", () => {
    // รับชำระหนี้ลูกหนี้การค้าด้วยเงินสด 400 ลงวันที่ 2026-01-18 (ก่อน from=มี.ค.): Dr 1010=400 / Cr 1140=400
    const janPaymentLine = [
      {
        entryId: "pay-jan",
        date: "2026-01-18",
        docNo: "RV-P1",
        accountCode: "1010",
        accountName: "เงินสด",
        debit: 400,
        credit: 0,
        side: "debit" as const,
        customerId: "c1",
        counterparty: null,
      },
      {
        entryId: "pay-jan",
        date: "2026-01-18",
        docNo: "RV-P1",
        accountCode: "1140",
        accountName: "ลูกหนี้การค้า",
        debit: 0,
        credit: 400,
        side: "credit" as const,
        customerId: "c1",
        counterparty: null,
      },
    ];
    const flowCombined: CombinedJournalLines = { manualJournalLines: [], paymentJournalLines: [], noteJournalLines: [] };
    const cumulativeCombined: CombinedJournalLines = { manualJournalLines: [], paymentJournalLines: janPaymentLine, noteJournalLines: [] };

    const withFrom = buildFormalStatements(entries, flowCombined, cumulativeCombined, opening, {}, periodMar);
    const withoutFrom = buildFormalStatements(entries, cumulativeCombined, cumulativeCombined, opening, {}, periodNoFrom);

    expect(withFrom.balanceSheet).toEqual(withoutFrom.balanceSheet);
    const cash = withFrom.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    const ar = withFrom.balanceSheet.assets.find((a) => a.code === "1140")?.amount ?? 0;
    // เงินสด: 5000(ยกมา) - 1000(ซื้อเงินสด ม.ค.) + 400(รับชำระ ม.ค.) = 4400
    expect(cash).toBe(4400);
    // ลูกหนี้การค้า: 2000(ขายเชื่อ มี.ค.) - 400(รับชำระ ม.ค. ล่วงหน้าลด AR) = 1600
    expect(ar).toBe(1600);
    expect(withFrom.cashFlow.openingCash).toBe(4400);
  });

  it("credit/debit note ก่อน from (ม.ค.) — balanceSheet ต้องรวมผลของ CN/DN ก่อน from ด้วย (ไม่กระทบเงินสด)", () => {
    // CN ลดยอดขาย (contra ลูกหนี้การค้า) 150 ลงวันที่ 2026-01-22 (ก่อน from=มี.ค.): Dr 4010=150 / Cr 1140=150
    const janNoteLine = [
      {
        entryId: "cn-jan",
        date: "2026-01-22",
        docNo: "CN-001",
        accountCode: "4010",
        accountName: "รายได้จากการขาย",
        debit: 150,
        credit: 0,
        side: "debit" as const,
        customerId: "c1",
        counterparty: null,
      },
      {
        entryId: "cn-jan",
        date: "2026-01-22",
        docNo: "CN-001",
        accountCode: "1140",
        accountName: "ลูกหนี้การค้า",
        debit: 0,
        credit: 150,
        side: "credit" as const,
        customerId: "c1",
        counterparty: null,
      },
    ];
    const flowCombined: CombinedJournalLines = { manualJournalLines: [], paymentJournalLines: [], noteJournalLines: [] };
    const cumulativeCombined: CombinedJournalLines = { manualJournalLines: [], paymentJournalLines: [], noteJournalLines: janNoteLine };

    const withFrom = buildFormalStatements(entries, flowCombined, cumulativeCombined, opening, {}, periodMar);
    const withoutFrom = buildFormalStatements(entries, cumulativeCombined, cumulativeCombined, opening, {}, periodNoFrom);

    expect(withFrom.balanceSheet).toEqual(withoutFrom.balanceSheet);
    const ar = withFrom.balanceSheet.assets.find((a) => a.code === "1140")?.amount ?? 0;
    // ลูกหนี้การค้า: 2000(ขายเชื่อ มี.ค.) - 150(CN ม.ค. ลด AR) = 1850
    expect(ar).toBe(1850);
    // ไม่กระทบเงินสดเลย — openingCash เท่าเดิม (ไม่มีรายการกระทบเงินสดก่อน from)
    const cash = withFrom.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    expect(cash).toBe(4000); // 5000(ยกมา) - 1000(ซื้อเงินสด ม.ค.) — เหมือนเดิมไม่เปลี่ยน
    expect(withFrom.cashFlow.openingCash).toBe(4000);
  });
});

describe("buildFormalStatements — O3: cashFlow ผูกกับ formal-statements (0.9)", () => {
  it("★★★ closingCash ของ cashFlow ตรงกับยอดเงินสด-เทียบเท่าใน balanceSheet เป๊ะ (reconciliation end-to-end)", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    const cashInBalance = s.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    expect(cashInBalance).toBe(4000); // 5000 (ยกมา) - 1000 (ซื้อเงินสด ม.ค.)
    expect(s.cashFlow.closingCash).toBe(cashInBalance);
    expect(s.cashFlow.reconciled).toBe(true);
  });

  it("openingCash คำนวณจากรอบ cumulative ณ สิ้นเดือนก่อนหน้า from (0.9) — ไม่ใช่ยอดยกมาดิบเฉย ๆ", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "2026-03",
      to: "2026-03",
      includeDraft: true,
    });
    // ณ สิ้นเดือนกุมภาพันธ์ (ก่อน from=มี.ค.) เงินสดสะสม = 5000 (ยกมา) - 1000 (ซื้อเงินสด ม.ค.) = 4000
    expect(s.cashFlow.openingCash).toBe(4000);
    // งวดมี.ค.ไม่มีรายการกระทบเงินสดเลย (ขายเชื่อ ไม่ใช่เงินสด) → netChange = 0
    expect(s.cashFlow.netChange).toBe(0);
    expect(s.cashFlow.closingCash).toBe(4000);
  });

  it("ไม่ตั้ง from เลย (from='') → openingCash = ยอดยกมาดิบของบัญชีกลุ่มเงินสด (ไม่มี 'เดือนก่อนหน้า' ให้คำนวณ)", () => {
    const s = buildFormalStatements(entries, EMPTY_COMBINED, EMPTY_COMBINED, opening, {}, {
      from: "",
      to: "2026-03",
      includeDraft: true,
    });
    expect(s.cashFlow.openingCash).toBe(5000);
    // รวมทั้งรายการซื้อเงินสด ม.ค. (-1000) เข้ารอบ flow ด้วย (ครอบคลุมทั้งประวัติจนถึง to)
    expect(s.cashFlow.totalOperating).toBe(-1000);
    expect(s.cashFlow.closingCash).toBe(4000);
    const cashInBalance = s.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    expect(s.cashFlow.closingCash).toBe(cashInBalance);
    expect(s.cashFlow.reconciled).toBe(true);
  });

  it("CN/DN และการโอนภายในกลุ่มเงินสดที่ผสมเข้ามาผ่าน combinedLines ก็ยังคง reconciled=true เสมอ", () => {
    const combined: CombinedJournalLines = {
      manualJournalLines: [
        // ฝากเงินสดเข้าธนาคาร (intra-pool) — ไม่ควรกระทบ CF เลย
        {
          entryId: "je-deposit",
          date: "2026-03-10",
          docNo: "JV-002",
          accountCode: "1020",
          accountName: "เงินฝากธนาคาร #1",
          debit: 500,
          credit: 0,
          side: "debit",
          customerId: "c1",
          counterparty: null,
        },
        {
          entryId: "je-deposit",
          date: "2026-03-10",
          docNo: "JV-002",
          accountCode: "1010",
          accountName: "เงินสด",
          debit: 0,
          credit: 500,
          side: "credit",
          customerId: "c1",
          counterparty: null,
        },
      ],
      paymentJournalLines: [],
      noteJournalLines: [],
    };
    const chart = [
      { code: "1010", name: "เงินสด", category: "สินทรัพย์" },
      { code: "1020", name: "เงินฝากธนาคาร #1", category: "สินทรัพย์", bank: true as const },
    ];
    const s = buildFormalStatements(
      entries,
      combined,
      combined,
      opening,
      {},
      { from: "2026-03", to: "2026-03", includeDraft: true },
      chart
    );
    const allCfLines = [...s.cashFlow.operating, ...s.cashFlow.investing, ...s.cashFlow.financing];
    expect(allCfLines.some((l) => l.entryId === "je-deposit")).toBe(false);
    expect(s.cashFlow.netChange).toBe(0); // ฝากธนาคารไม่กระทบยอดเงินสด+เทียบเท่ารวม
    expect(s.cashFlow.reconciled).toBe(true);
  });
});
