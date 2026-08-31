import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { buildFormalStatements } from "@/lib/accounting/formal-statements";
import { buildStatements } from "@/lib/accounting/statements";
import {
  resolveComparePeriod,
  quarterRangeOf,
  type ComparePeriodMode,
} from "@/lib/accounting/comparative-period";
import { mergeCompareLines, sumCompareLines } from "@/lib/accounting/statement-compare";
import { aggregateCashFlowLines } from "@/lib/accounting/cash-flow";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { customerInScope, type AccountingAccess } from "@/lib/accounting/access";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/**
 * phase4-e2e.test.ts — เทสต์ E2E ระดับ unit (จำลอง flow เต็มของ 17 manual-integration-test-steps ใน
 *   docs/06-accounting-features-roadmap.md หมวด "4) แนวทางการทดสอบ" ท้ายเฟส 4 — เพราะไม่มี browser/live
 *   server ให้ทดสอบจริง) โดยเรียกฟังก์ชันจริงเป๊ะตามที่ production caller เรียก (page.tsx/print/export):
 *     listEntries → filterEntriesForReport (ทำ inline) → loadCombinedJournalLines(service, tenantId,
 *     entries, period, chartByCode) × 2 (flow period + cumulative period {from:"",to}) →
 *     buildFormalStatements(entries, flowCombined, cumulativeCombined, opening, chartByCode, period,
 *     chart) — ผ่าน fake Supabase client (mock DB) เดียวกับที่ statement-inputs.test.ts ใช้
 *
 * ★★★ [แก้แล้ว] เดิมพบบั๊กจริงระหว่างเขียนเทสต์นี้ (ดู describe "0.3 REGRESSION" ด้านล่าง) — caller ทุกจุด
 *   เรียก loadCombinedJournalLines() ครั้งเดียวด้วย period ของรอบ flow แล้วส่ง combinedLines ชุดเดียวกันเข้า
 *   buildFormalStatements() ทั้งรอบ flow และ cumulative ทำให้ manual JE/bill_payments/CN-DN ที่เกิด "ก่อน
 *   from" หายไปจากงบสะสมเงียบ ๆ — แก้แล้วโดยให้ caller โหลด combinedLines 2 ชุด (flow period + cumulative
 *   period {from:"",to}) แล้วส่งแยกกันเข้า buildFormalStatements() (signature ใหม่รับ 2 พารามิเตอร์)
 */

const chartByCode = buildChartByCode(TEST_CHART);

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
    entryType: p.entryType ?? "sale",
    docDate: p.docDate ?? "2026-01-01",
    docNo: p.docNo ?? "DOC-1",
    counterpartyName: p.counterpartyName ?? "คู่ค้า",
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
    lines: p.lines ?? [],
  };
}

type Row = Record<string, unknown>;

/**
 * fake in-memory Supabase client ที่ loadCombinedJournalLines ต้องใช้ครบ (manual JE/bill_payments/CN-DN)
 *   ★ copy pattern จาก statement-inputs.test.ts (filter จริงตาม eq/in) — ใช้ db เดียวกันเรียกซ้ำได้
 *     หลายครั้งด้วย period ต่างกัน (จำลองที่ page.tsx เรียก loadCombinedJournalLines 2 ครั้งตอนมีโหมดเทียบ)
 */
function makeFakeDb(seed: {
  manualHeads?: Row[];
  manualLines?: Row[];
  payments?: Row[];
  bankAccounts?: Record<string, Row>;
  notes?: Row[];
  noteLines?: Row[];
}): SupabaseClient {
  const manualHeads = seed.manualHeads ?? [];
  const manualLines = seed.manualLines ?? [];
  const payments = seed.payments ?? [];
  const bankAccounts = seed.bankAccounts ?? {};
  const notes = seed.notes ?? [];
  const noteLines = seed.noteLines ?? [];

  type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };
  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "is", val: v });
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (table === "manual_journal_entries") data = manualHeads.filter((r) => matchRow(r, filters));
      else if (table === "manual_journal_entry_lines") data = manualLines.filter((r) => matchRow(r, filters));
      else if (table === "bill_payments") data = payments.filter((r) => matchRow(r, filters));
      else if (table === "customer_bank_accounts") {
        const idsFilter = filters.find((f) => f.col === "id" && f.op === "in");
        const ids = (idsFilter?.val as string[]) ?? [];
        data = ids.map((id) => bankAccounts[id] ?? { id, account_code: null });
      } else if (table === "credit_debit_notes") data = notes.filter((r) => matchRow(r, filters));
      else if (table === "credit_debit_note_lines") data = noteLines.filter((r) => matchRow(r, filters));
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

const EMPTY_DB = makeFakeDb({});

// ยอดยกมา: เงินสด 5000 (Dr) / ทุนเรือนหุ้น 5000 (Cr) — สมดุล
const opening: OpeningBalance[] = [
  { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
  { id: "o2", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: -5000, note: null },
];

/**
 * mirror สิ่งที่ production callers ทำจริงทุกจุด (page.tsx/print/page.tsx/export/route.ts หลังแก้บั๊ก) —
 *   โหลด loadCombinedJournalLines() 2 ครั้ง: รอบ flow (period จริง) + รอบ cumulative (ตัด from ทิ้ง
 *   {from:"", to}) แล้วส่งทั้ง 2 ชุดเข้า buildFormalStatements() ตาม signature ใหม่
 */
async function loadBothCombined(
  db: SupabaseClient,
  entries: BillEntry[],
  period: { from: string; to: string; includeDraft: boolean }
) {
  const cumulativePeriod = { ...period, from: "" };
  const [flow, cumulative] = await Promise.all([
    loadCombinedJournalLines(db, "t1", entries, period, chartByCode),
    loadCombinedJournalLines(db, "t1", entries, cumulativePeriod, chartByCode),
  ]);
  return { flow, cumulative };
}

// ==========================================================================
// Step 17 (regression): ไม่มี manual JE/bill_payments/CN-DN เลย — ตัวเลขต้องเหมือนคำนวณจากบิลตรง ๆ
// ==========================================================================
describe("Step 17 — regression: ลูกค้าไม่มี manual JE/bill_payments/CN-DN เลย (บิลปกติล้วน)", () => {
  it("ตัวเลขทุกงบต้องเหมือนกับที่คำนวณจากบิลตรง ๆ ผ่าน buildStatements()", async () => {
    const entries: BillEntry[] = [
      mkEntry({
        id: "s1",
        entryType: "sale",
        paymentMethod: "cash",
        docDate: "2026-03-05",
        lines: [mkLine({ accountCode: "4010", amount: 3000 })],
      }),
    ];
    const period = { from: "2026-03", to: "2026-03", includeDraft: true };
    const { flow, cumulative } = await loadBothCombined(EMPTY_DB, entries, period);
    const formal = buildFormalStatements(entries, flow, cumulative, opening, chartByCode, period, TEST_CHART);
    const direct = buildStatements(entries, opening, chartByCode, []);
    expect(formal.flow.incomeStatement).toEqual(direct.incomeStatement);
    expect(formal.balanceSheet).toEqual(direct.balanceSheet);
    expect(formal.cashFlow.closingCash).toBe(
      formal.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0
    );
    expect(formal.cashFlow.reconciled).toBe(true);
  });
});

// ==========================================================================
// Step 3: ตั้ง `from` กลางปี → งบแสดงฐานะการเงินต้องรวมผลกระทบตั้งแต่ต้นปี (0.3 — ผ่านบิลเพียวๆ ไม่มี manual JE)
// ==========================================================================
describe("Step 3 — 0.3 ผ่านบิลอย่างเดียว (ไม่มี manual JE/payment/note) — ทำงานถูกต้องแล้ว", () => {
  it("from=มิ.ย. (กลางปี, มีบิลตั้งแต่ ม.ค.) → balanceSheet รวมผลกระทบเดือน 1-5 ด้วย", async () => {
    const entries: BillEntry[] = [
      mkEntry({
        id: "jan1",
        entryType: "purchase",
        paymentMethod: "cash",
        docDate: "2026-01-10",
        lines: [mkLine({ accountCode: "5010", amount: 800 })],
      }),
      mkEntry({
        id: "jun1",
        entryType: "sale",
        paymentMethod: "credit",
        docDate: "2026-06-15",
        lines: [mkLine({ accountCode: "4010", amount: 1500 })],
      }),
    ];
    const period = { from: "2026-06", to: "2026-06", includeDraft: true };
    const { flow, cumulative } = await loadBothCombined(EMPTY_DB, entries, period);
    const formal = buildFormalStatements(entries, flow, cumulative, opening, chartByCode, period, TEST_CHART);
    const cash = formal.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    // เงินสด: 5000 (ยกมา) - 800 (ซื้อเงินสด ม.ค.) = 4200 — ถ้าบั๊ก 0.3 ยังอยู่จะขาดผลของ ม.ค. (ได้ 5000)
    expect(cash).toBe(4200);
  });
});

// ==========================================================================
// ★★★ 0.3 REGRESSION [แก้แล้ว] — manual JE/bill_payments/CN-DN ที่เกิด "ก่อน from" เคยหายไปจากงบแสดงฐานะ
//   การเงินสะสม เพราะ production callers (page.tsx/print/page.tsx/export/route.ts) เคยเรียก
//   loadCombinedJournalLines(service, tenantId, entries, period, chartByCode) แค่ครั้งเดียวด้วย `period` =
//   งวด flow ที่ผู้ใช้เลือกเท่านั้น (ไม่ใช่ทั้งประวัติ) แล้วส่ง `combined` ก้อนเดียวกันนี้เข้า
//   buildFormalStatements ซึ่งใช้ journalLines ชุดเดียวกันนี้ทั้งรอบ "flow" และรอบ "cumulative" —
//   ผลคือ manual JE/bill_payments/CN-DN ที่วันที่อยู่ "ก่อน from" ไม่ถูกโหลดมาเลยตั้งแต่ต้น จึงไม่มีทาง
//   เข้ารอบ cumulative ได้ — แก้แล้วโดยให้ caller โหลด loadCombinedJournalLines() 2 ครั้ง (flow period +
//   cumulative period {from:"",to}) แล้วส่งแยกกันเข้า buildFormalStatements(entries, flowCombined,
//   cumulativeCombined, ...) — ดู loadBothCombined() ด้านบน (mirror caller จริงหลังแก้)
// ==========================================================================
describe("★★★ [แก้บั๊กแล้ว] 0.3 reintroduced — manual JE ก่อน `from` ต้องรวมเข้างบแสดงฐานะการเงินสะสมถูกต้อง", () => {
  // manual JE วันที่ 2026-01-20 (ก่อน from=มี.ค.): Dr เจ้าหนี้อื่นๆ(2015) 500 / Cr เงินสด(1010) 500
  // (จ่ายชำระหนี้อื่นด้วยเงินสด — ลดทั้งเงินสดและหนี้สินพร้อมกัน)
  const manualHeadRow: Row = {
    id: "je-jan",
    tenant_id: "t1",
    customer_id: "c1",
    doc_type: "PV",
    doc_date: "2026-01-20",
    doc_no: "PV-001",
    memo: "จ่ายชำระหนี้อื่น",
    status: "confirmed",
    created_at: "2026-01-20T00:00:00Z",
    confirmed_at: "2026-01-20T00:00:00Z",
  };
  const manualLineRows: Row[] = [
    { id: "l1", entry_id: "je-jan", tenant_id: "t1", line_no: 1, account_code: "2015", account_name: "เจ้าหนี้อื่น ๆ", description: null, debit: 500, credit: 0 },
    { id: "l2", entry_id: "je-jan", tenant_id: "t1", line_no: 2, account_code: "1010", account_name: "เงินสด", description: null, debit: 0, credit: 500 },
  ];

  // 1 บิลในเดือนมี.ค. (จำเป็นเพื่อให้ loadCombinedJournalLines derive customerId ได้ — ข้อจำกัดที่ล็อกไว้)
  const entries: BillEntry[] = [
    mkEntry({
      id: "mar1",
      entryType: "sale",
      paymentMethod: "credit",
      docDate: "2026-03-10",
      lines: [mkLine({ accountCode: "4010", amount: 100 })],
    }),
  ];
  const openingWithLiability: OpeningBalance[] = [
    { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
    { id: "o2", accountCode: "2015", accountName: "เจ้าหนี้อื่น ๆ", openingBalance: -5000, note: null },
    { id: "o3", accountCode: "3010", accountName: "ทุนเรือนหุ้น", openingBalance: 0, note: null },
  ];
  const period = { from: "2026-03", to: "2026-03", includeDraft: true };

  it("[ยังคงพิสูจน์บั๊กเดิมได้] ถ้า caller ยังใช้ pattern เดิมผิดพลาด (ส่ง combinedLines ที่โหลดด้วย period ของ flow ซ้ำเป็นทั้ง flow และ cumulative) → เงินสดผิด", async () => {
    const db = makeFakeDb({ manualHeads: [manualHeadRow], manualLines: manualLineRows });
    // ★ pattern เดิมที่เคยเป็นบั๊ก: โหลด loadCombinedJournalLines ครั้งเดียวด้วย period ของ flow แล้วส่ง
    //   ก้อนเดียวกันนี้เข้าทั้ง flowCombinedLines และ cumulativeCombinedLines — ยังคงพิสูจน์บั๊กได้จริงถ้ามีคน
    //   เขียน caller ผิดแบบนี้อีก (regression guard)
    const combinedProd = await loadCombinedJournalLines(db, "t1", entries, period, chartByCode);
    // manual JE เดือน ม.ค. ถูกกรองทิ้งไปแล้วตั้งแต่ loadCombinedJournalLines (period=มี.ค.เท่านั้น)
    expect(combinedProd.manualJournalLines).toHaveLength(0);

    const formalWrong = buildFormalStatements(entries, combinedProd, combinedProd, openingWithLiability, chartByCode, period, TEST_CHART);
    const cashWrong = formalWrong.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    const liabilityWrong = formalWrong.balanceSheet.liabilities.find((a) => a.code === "2015")?.amount ?? 0;
    // ยังคงผิดถ้า caller ป้อน cumulativeCombinedLines ที่ขาดข้อมูลก่อน from เข้ามา (ไม่รวมผล JE ม.ค.)
    expect(cashWrong).toBe(5000);
    expect(liabilityWrong).toBe(5000);
  });

  it("★★★ [ทางแก้ที่ถูกต้อง — production ทำแบบนี้จริง] loadBothCombined (flow + cumulative {from:'',to} แยกกัน) → ผลลัพธ์ถูกต้อง", async () => {
    const db = makeFakeDb({ manualHeads: [manualHeadRow], manualLines: manualLineRows });
    const { flow, cumulative } = await loadBothCombined(db, entries, period);
    expect(flow.manualJournalLines).toHaveLength(0); // รอบ flow (มี.ค.เท่านั้น) ไม่มี JE ม.ค. — ถูกต้อง (ปกติ)
    expect(cumulative.manualJournalLines.length).toBeGreaterThan(0); // รอบ cumulative โหลด JE ม.ค. มาด้วยแล้ว

    const formalFixed = buildFormalStatements(entries, flow, cumulative, openingWithLiability, chartByCode, period, TEST_CHART);
    const cashFixed = formalFixed.balanceSheet.assets.find((a) => a.code === "1010")?.amount ?? 0;
    const liabilityFixed = formalFixed.balanceSheet.liabilities.find((a) => a.code === "2015")?.amount ?? 0;
    // ★ ค่าที่ถูกต้องตามหลักบัญชี (งบแสดงฐานะการเงินสะสมถึงสิ้น มี.ค. ต้องรวมผลของ JE ม.ค. ด้วย):
    //   เงินสด = 5000 (ยกมา) - 500 (JE ม.ค.) = 4500
    //   เจ้าหนี้อื่นๆ (แสดงเป็นค่าบวกตามธรรมชาติหนี้สิน) = 5000 (ยกมา) - 500 (Dr ลดหนี้สิน) = 4500
    expect(cashFixed).toBe(4500);
    expect(liabilityFixed).toBe(4500);
    // flow.ledger ไม่ปนรายการ JE ม.ค. เลย (ยังคงเป็น flow statement ปกติของงวดมี.ค.เท่านั้น — ไม่ใช่สะสม)
    const flowLiabilityTxns = formalFixed.flow.ledger.byCode.get("2015")?.txns ?? [];
    expect(flowLiabilityTxns.some((t) => t.entryId === "je-jan")).toBe(false);
  });
});

// ==========================================================================
// Steps 4-7: โหมดเทียบงวด — งวดก่อนหน้า(เดือน)/ไตรมาสก่อนหน้า/ปีก่อน/กำหนดเอง ผ่าน pipeline เต็ม
// ==========================================================================
describe("Steps 4-7 — โหมดเทียบงวดผ่าน pipeline เต็ม (loadCombinedJournalLines + buildFormalStatements ทั้ง 2 งวด)", () => {
  // มี.ค. ขาย 3000 / ก.พ. ขาย 2000 / ไตรมาสก่อน (ม.ค.-มี.ค. ปีก่อน) ขายรวม 900 / มี.ค.ปีก่อน ขาย 300
  const entries: BillEntry[] = [
    mkEntry({ id: "feb", entryType: "sale", paymentMethod: "cash", docDate: "2026-02-10", lines: [mkLine({ accountCode: "4010", amount: 2000 })] }),
    mkEntry({ id: "mar", entryType: "sale", paymentMethod: "cash", docDate: "2026-03-10", lines: [mkLine({ accountCode: "4010", amount: 3000 })] }),
    mkEntry({ id: "q1a", entryType: "sale", paymentMethod: "cash", docDate: "2025-01-05", lines: [mkLine({ accountCode: "4010", amount: 300 })] }),
    mkEntry({ id: "q1b", entryType: "sale", paymentMethod: "cash", docDate: "2025-02-05", lines: [mkLine({ accountCode: "4010", amount: 300 })] }),
    mkEntry({ id: "q1c", entryType: "sale", paymentMethod: "cash", docDate: "2025-03-05", lines: [mkLine({ accountCode: "4010", amount: 300 })] }),
    mkEntry({ id: "marLastYear", entryType: "sale", paymentMethod: "cash", docDate: "2025-03-20", lines: [mkLine({ accountCode: "4010", amount: 999 })] }),
    mkEntry({ id: "dec2025", entryType: "sale", paymentMethod: "cash", docDate: "2025-12-15", lines: [mkLine({ accountCode: "4010", amount: 111 })] }),
  ];

  async function buildBoth(currentRange: { from: string; to: string }, mode: ComparePeriodMode, custom?: { from?: string; to?: string }) {
    const period = { from: currentRange.from, to: currentRange.to, includeDraft: true };
    const compareRange = resolveComparePeriod(currentRange, mode, custom);
    const { flow: flowCurrent, cumulative: cumulativeCurrent } = await loadBothCombined(EMPTY_DB, entries, period);
    const current = buildFormalStatements(entries, flowCurrent, cumulativeCurrent, opening, chartByCode, period, TEST_CHART);
    let compare = null as ReturnType<typeof buildFormalStatements> | null;
    if (compareRange) {
      const comparePeriodFull = { from: compareRange.from, to: compareRange.to, includeDraft: true };
      const { flow: flowCompare, cumulative: cumulativeCompare } = await loadBothCombined(EMPTY_DB, entries, comparePeriodFull);
      compare = buildFormalStatements(entries, flowCompare, cumulativeCompare, opening, chartByCode, comparePeriodFull, TEST_CHART);
    }
    return { current, compare, compareRange };
  }

  it("Step 4: prev_period (เดือนเดียว) — มี.ค. เทียบ ก.พ. ถูกต้อง", async () => {
    const { current, compare, compareRange } = await buildBoth({ from: "2026-03", to: "2026-03" }, "prev_period");
    expect(compareRange).toEqual({ from: "2026-02", to: "2026-02" });
    expect(current.flow.incomeStatement.totalRevenue).toBe(3000);
    expect(compare!.flow.incomeStatement.totalRevenue).toBe(2000);
  });

  it("Step 5: ปุ่มลัดไตรมาส (Q1 2026) + prev_period → ต้องได้ไตรมาสก่อนหน้าเต็ม (Q4 2025) ไม่ใช่แค่ 1 เดือน", async () => {
    const q1 = quarterRangeOf(2026, 1); // 2026-01..03
    const { compareRange } = await buildBoth(q1, "prev_period");
    expect(compareRange).toEqual({ from: "2025-10", to: "2025-12" });
  });

  it("Step 5b: ไตรมาสก่อนหน้าจริง (Q1 ปีก่อน) เทียบ Q1 ปีนี้ (คำนวณรายได้ไตรมาสถูกต้อง)", async () => {
    // ไตรมาส Q1/2025 (ม.ค.-มี.ค. 2025) ยอดขายรวม = 300+300+300+999 = 1899
    const { current } = await buildBoth({ from: "2025-01", to: "2025-03" }, "none");
    expect(current.flow.incomeStatement.totalRevenue).toBe(1899);
  });

  it("Step 6: prev_year — งวดเดียวกัน ปีก่อนหน้าเป๊ะ (ไม่ใช่ shift ตามความยาวงวด)", async () => {
    const { compareRange, compare } = await buildBoth({ from: "2026-03", to: "2026-03" }, "prev_year");
    expect(compareRange).toEqual({ from: "2025-03", to: "2025-03" });
    // มี.ค. 2025 มี 2 บิล: q1c (300, 2025-03-05) + marLastYear (999, 2025-03-20) = 1299
    expect(compare!.flow.incomeStatement.totalRevenue).toBe(1299);
  });

  it("★ ข้ามปี: current=ม.ค. 2026 → prev_period ต้องได้ ธ.ค. 2025 (ปีก่อน) ไม่ใช่ ม.ค. 2025 หรือเดือนผิด", async () => {
    const { compareRange, compare } = await buildBoth({ from: "2026-01", to: "2026-01" }, "prev_period");
    expect(compareRange).toEqual({ from: "2025-12", to: "2025-12" });
    expect(compare!.flow.incomeStatement.totalRevenue).toBe(111);
  });

  it("Step 7: custom — ใช้งวดที่กรอกเองตรง ๆ", async () => {
    const { compareRange, compare } = await buildBoth(
      { from: "2026-03", to: "2026-03" },
      "custom",
      { from: "2025-01", to: "2025-03" }
    );
    expect(compareRange).toEqual({ from: "2025-01", to: "2025-03" });
    // ม.ค.-มี.ค. 2025: q1a(300)+q1b(300)+q1c(300)+marLastYear(999) = 1899
    expect(compare!.flow.incomeStatement.totalRevenue).toBe(1899);
  });

  it("mergeCompareLines/sumCompareLines ผสมกับผลจริงจาก pipeline ให้ผลถูกต้อง (จำลองที่จอ/พิมพ์/excel ทำ)", async () => {
    const { current, compare } = await buildBoth({ from: "2026-03", to: "2026-03" }, "prev_period");
    const rows = mergeCompareLines(current.flow.incomeStatement.revenues, compare!.flow.incomeStatement.revenues);
    const totals = sumCompareLines(rows);
    expect(totals).toEqual({ current: 3000, compare: 2000 });
  });
});

// ==========================================================================
// Step 8-13: งบกระแสเงินสด — ผสมทุกกรณีผ่าน pipeline เต็ม (loadCombinedJournalLines + buildFormalStatements)
// ==========================================================================
describe("Steps 8-13 — งบกระแสเงินสด ผสมทุกกรณีผ่าน pipeline เต็มจริง", () => {
  it("บิลขายเงินสด + บิลซื้อเชื่อ+รับชำระบางส่วน + manual JE (ซื้อสินทรัพย์/เพิ่มทุน/ฝากธนาคาร) + CN → ครบและ reconciled=true", async () => {
    const entries: BillEntry[] = [
      // ขายเงินสด 1000 (operating +1000)
      mkEntry({ id: "sale1", entryType: "sale", paymentMethod: "cash", docDate: "2026-03-03", lines: [mkLine({ accountCode: "4010", amount: 1000 })] }),
      // ซื้อเชื่อ 800 (ตั้ง AP ไว้ ยังไม่กระทบเงินสด)
      mkEntry({ id: "purch1", entryType: "purchase", paymentMethod: "credit", docDate: "2026-03-05", counterpartyName: "ผู้ขาย A", lines: [mkLine({ accountCode: "5010", amount: 800 })] }),
    ];

    // รับชำระบางส่วนของบิลซื้อ (จ่าย AP บางส่วน 300 ด้วยเงินสด) → operating -300 เท่านั้น (ไม่ใช่ 800 เต็ม)
    const paymentRow: Row = {
      id: "bp1", tenant_id: "t1", entry_id: "purch1", customer_id: "c1",
      pay_date: "2026-03-20", amount: 300, method: "cash", bank_account_id: null, notes: null,
      created_at: "2026-03-20T00:00:00Z", deleted_at: null,
    };

    // manual JE: ซื้ออุปกรณ์สำนักงานด้วยเงินสด 2000 → investing -2000
    const jeAssetHead: Row = { id: "je-asset", tenant_id: "t1", customer_id: "c1", doc_type: "PV", doc_date: "2026-03-08", doc_no: "PV-A", memo: "ซื้ออุปกรณ์", status: "confirmed", created_at: "2026-03-08T00:00:00Z", confirmed_at: "2026-03-08T00:00:00Z" };
    const jeAssetLines: Row[] = [
      { id: "jal1", entry_id: "je-asset", tenant_id: "t1", line_no: 1, account_code: "1640", account_name: "อุปกรณ์สำนักงาน", description: null, debit: 2000, credit: 0 },
      { id: "jal2", entry_id: "je-asset", tenant_id: "t1", line_no: 2, account_code: "1010", account_name: "เงินสด", description: null, debit: 0, credit: 2000 },
    ];

    // manual JE: เพิ่มทุนรับเงินสด 5000 → financing +5000
    const jeCapitalHead: Row = { id: "je-capital", tenant_id: "t1", customer_id: "c1", doc_type: "RV", doc_date: "2026-03-09", doc_no: "RV-C", memo: "เพิ่มทุน", status: "confirmed", created_at: "2026-03-09T00:00:00Z", confirmed_at: "2026-03-09T00:00:00Z" };
    const jeCapitalLines: Row[] = [
      { id: "jcl1", entry_id: "je-capital", tenant_id: "t1", line_no: 1, account_code: "1010", account_name: "เงินสด", description: null, debit: 5000, credit: 0 },
      { id: "jcl2", entry_id: "je-capital", tenant_id: "t1", line_no: 2, account_code: "3010", account_name: "ทุนเรือนหุ้น", description: null, debit: 0, credit: 5000 },
    ];

    // manual JE: ฝากเงินสดเข้าธนาคาร (intra-pool) 1500 → ไม่ปรากฏใน CF เลย
    const jeDepositHead: Row = { id: "je-deposit", tenant_id: "t1", customer_id: "c1", doc_type: "JV", doc_date: "2026-03-11", doc_no: "JV-D", memo: "ฝากธนาคาร", status: "confirmed", created_at: "2026-03-11T00:00:00Z", confirmed_at: "2026-03-11T00:00:00Z" };
    const jeDepositLines: Row[] = [
      { id: "jdl1", entry_id: "je-deposit", tenant_id: "t1", line_no: 1, account_code: "1020", account_name: "เงินฝากธนาคาร #1", description: null, debit: 1500, credit: 0 },
      { id: "jdl2", entry_id: "je-deposit", tenant_id: "t1", line_no: 2, account_code: "1010", account_name: "เงินสด", description: null, debit: 0, credit: 1500 },
    ];

    // CN ลดยอดขายของ sale1 (contra AR เสมอ ไม่แตะเงินสด) → ไม่ปรากฏใน CF เลย
    const noteRow: Row = {
      id: "cn1", tenant_id: "t1", entry_id: "sale1", customer_id: "c1", doc_type: "credit_note",
      doc_date: "2026-03-25", doc_no: "CN-001", reason: "คืนสินค้า", status: "confirmed",
      created_at: "2026-03-25T00:00:00Z", confirmed_at: "2026-03-25T00:00:00Z",
    };
    // ★ CN ของบิลเงินสด (sale1 paymentMethod=cash) — contra ปกติของ CN บิลขาย = AR (1140) เสมอตาม mapper เดิม
    const noteLineRow: Row = { id: "nl1", note_id: "cn1", tenant_id: "t1", line_no: 1, description: null, account_code: "4010", account_name: "ขายสินค้า", amount: 50, vat_amount: 0 };

    const db = makeFakeDb({
      manualHeads: [jeAssetHead, jeCapitalHead, jeDepositHead],
      manualLines: [...jeAssetLines, ...jeCapitalLines, ...jeDepositLines],
      payments: [paymentRow],
      notes: [noteRow],
      noteLines: [noteLineRow],
    });

    const period = { from: "2026-03", to: "2026-03", includeDraft: true };
    const { flow, cumulative } = await loadBothCombined(db, entries, period);
    const formal = buildFormalStatements(entries, flow, cumulative, opening, chartByCode, period, TEST_CHART);

    expect(formal.cashFlow.totalOperating).toBe(700); // 1000 (ขายเงินสด) - 300 (จ่าย AP บางส่วน)
    expect(formal.cashFlow.totalInvesting).toBe(-2000);
    expect(formal.cashFlow.totalFinancing).toBe(5000);
    expect(formal.cashFlow.netChange).toBe(3700); // 700 - 2000 + 5000
    expect(formal.cashFlow.reconciled).toBe(true);

    const allCf = [...formal.cashFlow.operating, ...formal.cashFlow.investing, ...formal.cashFlow.financing];
    expect(allCf.some((l) => l.entryId === "je-deposit")).toBe(false); // ฝากธนาคาร (intra-pool) ไม่ปรากฏ
    expect(allCf.some((l) => l.entryId === "cn1")).toBe(false); // CN ไม่ปรากฏเลย

    // ★★★ [แก้บั๊ก #2 แล้ว] reconciliation end-to-end: closingCash ที่ได้จาก cashFlow ต้องตรงกับผลรวม
    //   "เงินสด+ทุกบัญชีธนาคาร" (cash pool ทั้งกลุ่ม) ในงบแสดงฐานะการเงินเป๊ะ (ตามสัญญาที่ 0.9 ล็อกไว้) แม้ในเคส
    //   ที่มี manual JE/bill_payments ที่กระทบเงินสด "ภายในงวด flow เอง" ปนอยู่ด้วย (สถานการณ์ปกติในงานจริง)
    //   ★ root cause เดิม (ก่อนแก้): openingCash คำนวณจากรอบ "beforeFrom" โดยใช้ journalLines (manual
    //   JE/bill_payments/CN-DN) แบบเดิมทั้งชุดโดยไม่กรองตามวันที่ให้เหลือเฉพาะรายการที่เกิด "ก่อน
    //   beforeFromMonth" จริง — แก้แล้วด้วย journalLinesBeforeMonth() ใน formal-statements.ts ที่ตัดรายการ
    //   ซึ่งลงวันที่ตั้งแต่ fromMonth เป็นต้นไปทิ้งก่อนคำนวณ openingCash เสมอ
    //   ★ reconciled ไม่เคยจับบั๊กนี้ได้เลย เพราะ reconciled เทียบแค่ netChange ของรอบ flow กับผลรวมบรรทัด
    //   เงินสดใน journalLines ชุดเดียวกัน (สมดุลกันเองเสมอโดยธรรมชาติ double-entry) — ไม่เคยเทียบกับ balance
    //   sheet จริงเลยสักครั้ง (นี่คือเหตุผลที่ต้องมีเทสต์ end-to-end แยกต่างหากแบบนี้)
    const cashPoolCodes = new Set(["1010", "1015", "1020", "1025", "1030"]);
    const cashInBalance = formal.balanceSheet.assets
      .filter((a) => cashPoolCodes.has(a.code))
      .reduce((s, a) => s + a.amount, 0);
    expect(cashInBalance).toBe(8700); // งบแสดงฐานะการเงิน (สะสม) คำนวณเงินสดรวมได้ 8700
    expect(formal.cashFlow.closingCash).toBe(cashInBalance); // ตอนนี้ตรงกันแล้ว (8700 ทั้งคู่)
  });
});

// ==========================================================================
// Edge cases เพิ่มเติมที่แผนอาจมองข้าม
// ==========================================================================
describe("Edge case — ลูกค้าไม่มีรายการเงินสดเลยในงวด (openingCash = closingCash)", () => {
  it("บิลขายเชื่อล้วน ไม่มีรายการกระทบเงินสดเลย → netChange=0, closingCash=openingCash, reconciled=true", async () => {
    const entries: BillEntry[] = [
      mkEntry({ id: "credit-sale", entryType: "sale", paymentMethod: "credit", docDate: "2026-03-05", lines: [mkLine({ accountCode: "4010", amount: 5000 })] }),
    ];
    const period = { from: "2026-03", to: "2026-03", includeDraft: true };
    const { flow, cumulative } = await loadBothCombined(EMPTY_DB, entries, period);
    const formal = buildFormalStatements(entries, flow, cumulative, opening, chartByCode, period, TEST_CHART);
    expect(formal.cashFlow.operating).toHaveLength(0);
    expect(formal.cashFlow.investing).toHaveLength(0);
    expect(formal.cashFlow.financing).toHaveLength(0);
    expect(formal.cashFlow.netChange).toBe(0);
    expect(formal.cashFlow.openingCash).toBe(formal.cashFlow.closingCash);
    expect(formal.cashFlow.reconciled).toBe(true);
  });
});

describe("Edge case — รหัสบัญชีที่ tenant เพิ่มเองนอกชุด INVESTING_CODES/FINANCING_CODES → fallback operating", () => {
  it("manual JE 'เงินกู้ยืมระยะยาวจากกรรมการ' (รหัสสมมติ 2020 ไม่อยู่ใน FINANCING_CODES) รับเป็นเงินสด → เข้า operating (ไม่ใช่ financing)", async () => {
    const entries: BillEntry[] = [
      mkEntry({ id: "dummy", entryType: "sale", paymentMethod: "credit", docDate: "2026-03-01", lines: [mkLine({ accountCode: "4010", amount: 1 })] }),
    ];
    const jeHead: Row = { id: "je-loan", tenant_id: "t1", customer_id: "c1", doc_type: "RV", doc_date: "2026-03-12", doc_no: "RV-L", memo: "กู้จากกรรมการ", status: "confirmed", created_at: "2026-03-12T00:00:00Z", confirmed_at: "2026-03-12T00:00:00Z" };
    const jeLines: Row[] = [
      { id: "jll1", entry_id: "je-loan", tenant_id: "t1", line_no: 1, account_code: "1010", account_name: "เงินสด", description: null, debit: 7000, credit: 0 },
      { id: "jll2", entry_id: "je-loan", tenant_id: "t1", line_no: 2, account_code: "2020", account_name: "เงินกู้ยืมระยะยาวจากกรรมการ", description: null, debit: 0, credit: 7000 },
    ];
    const db = makeFakeDb({ manualHeads: [jeHead], manualLines: jeLines });
    const period = { from: "2026-03", to: "2026-03", includeDraft: true };
    const { flow, cumulative } = await loadBothCombined(db, entries, period);
    const formal = buildFormalStatements(entries, flow, cumulative, opening, chartByCode, period, TEST_CHART);
    expect(formal.cashFlow.financing).toHaveLength(0);
    expect(formal.cashFlow.investing).toHaveLength(0);
    expect(formal.cashFlow.operating.some((l) => l.accountCode === "2020")).toBe(true);
    expect(formal.cashFlow.totalOperating).toBe(7000);
    expect(formal.cashFlow.reconciled).toBe(true);
  });
});

describe("Edge case — งวดเทียบที่ไม่มีข้อมูลเลย (ทุกอย่างเป็น 0)", () => {
  it("compare period ไม่มีบิล/manual JE/opening ใด ๆ เลย → income statement ของงวดเทียบเป็น 0 ทุกช่อง ไม่ crash/ไม่ NaN", async () => {
    const entries: BillEntry[] = [
      mkEntry({ id: "only-mar", entryType: "sale", paymentMethod: "cash", docDate: "2026-03-05", lines: [mkLine({ accountCode: "4010", amount: 4000 })] }),
    ];
    const noOpening: OpeningBalance[] = []; // ไม่มียอดยกมาเลย — เพื่อให้งวดเทียบเป็น 0 จริง ๆ ทุกบัญชี
    const currentPeriod = { from: "2026-03", to: "2026-03", includeDraft: true };
    const comparePeriod = { from: "2020-01", to: "2020-01", includeDraft: true }; // ไม่มีข้อมูลเลย ก่อนเริ่มระบบ

    const { flow: flowCurrent, cumulative: cumulativeCurrent } = await loadBothCombined(EMPTY_DB, entries, currentPeriod);
    const current = buildFormalStatements(entries, flowCurrent, cumulativeCurrent, noOpening, chartByCode, currentPeriod, TEST_CHART);
    const { flow: flowCompare, cumulative: cumulativeCompare } = await loadBothCombined(EMPTY_DB, entries, comparePeriod);
    const compare = buildFormalStatements(entries, flowCompare, cumulativeCompare, noOpening, chartByCode, comparePeriod, TEST_CHART);

    expect(compare.flow.incomeStatement.totalRevenue).toBe(0);
    expect(compare.flow.incomeStatement.totalExpense).toBe(0);
    expect(compare.balanceSheet.totalAssets).toBe(0);
    expect(compare.cashFlow.openingCash).toBe(0);
    expect(compare.cashFlow.closingCash).toBe(0);
    expect(compare.cashFlow.reconciled).toBe(true);

    // ผสมเข้า mergeCompareLines/sumCompareLines (จำลองสิ่งที่จอ/พิมพ์/excel ทำจริง) — ไม่ควรมี NaN/null ปนเปื้อน
    const revenueRows = mergeCompareLines(current.flow.incomeStatement.revenues, compare.flow.incomeStatement.revenues);
    const revenueTotal = sumCompareLines(revenueRows);
    expect(revenueTotal).toEqual({ current: 4000, compare: 0 });
    expect(Number.isNaN(revenueTotal.current)).toBe(false);
    expect(Number.isNaN(revenueTotal.compare)).toBe(false);
  });
});

// ==========================================================================
// สิทธิ์: นักบัญชีนอกสโคป → เข้าถึงไม่ได้ (ยืนยันผ่าน customerInScope ที่ guard ทุกจุดเข้าถึงใช้ตรง ๆ)
//   ★ ยืนยันด้วยโค้ดจริงแล้วว่า financial-statements/page.tsx, print/page.tsx, export/route.ts ทั้ง 3
//     จุดเรียก resolveAccountingAccess + customerInScope ก่อนคำนวณ/แสดงผลทุกจุด (0.11) — grep ยืนยันแล้ว
//     ไม่มีจุดเข้าถึงไหนข้าม guard นี้เลย การทดสอบ full page render อยู่นอกขอบเขต unit test ของ repo นี้
//     (ไม่มี pattern render React Server Component ในชุดเทสต์เดิมเลยสักไฟล์)
// ==========================================================================
describe("สิทธิ์ — นักบัญชีนอกสโคป เข้าถึงลูกค้าที่ไม่ได้ดูแลไม่ได้ (customerInScope ที่ guard ทุกจุดใช้จริง)", () => {
  function accountant(ids: string[]): AccountingAccess {
    return {
      tenantId: "t1",
      employeeId: "emp-1",
      name: "นักบัญชีทดสอบ",
      mode: "accountant",
      navRole: "accountant",
      allowedCustomerIds: new Set(ids),
    };
  }
  it("นักบัญชีที่ไม่ได้ดูแลลูกค้ารายนั้น → customerInScope=false (การ์ด/พิมพ์/export จะถูกกันตั้งแต่ต้น)", () => {
    const access = accountant(["c1", "c2"]);
    expect(customerInScope(access, "c1")).toBe(true);
    expect(customerInScope(access, "c-other")).toBe(false);
  });
});
