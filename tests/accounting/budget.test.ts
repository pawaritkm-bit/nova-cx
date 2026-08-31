import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildJournalEntries } from "@/lib/accounting/journal";
import { buildLedger } from "@/lib/accounting/ledger";
import { buildTrialBalance, type TrialBalanceRow } from "@/lib/accounting/trial-balance";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { loadCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import {
  validateBudgetRowInput,
  buildBudgetComparison,
  listBudgetYear,
  upsertBudgetYear,
  type AccountBudget,
} from "@/lib/accounting/budget";

/**
 * เทสต์ lib/accounting/budget.ts (เฟส 6 ส่วน S, T45/T48)
 *   - validateBudgetRowInput: ปฏิเสธปี/เดือนนอกช่วง + ยอดติดลบ
 *   - buildBudgetComparison: ทิศทางเทียบตามหมวดบัญชี (0.11) ครบทุกกรณี + งบ=0 ไม่ throw หารศูนย์
 *     + regression-style: ตัวเลขต้องตรงกับ TrialBalanceRow ของ pipeline เดิม 100% (ไม่ใช่แค่เทียบเลขคำนวณมือ)
 *   - upsertBudgetYear: batch upsert ทับของเดิม ไม่ insert ซ้ำ
 */

// ---------------------------------------------------------------------
// validateBudgetRowInput
// ---------------------------------------------------------------------
describe("validateBudgetRowInput", () => {
  it("input ถูกต้อง → ผ่าน + ปัดทศนิยม 2 ตำแหน่ง", () => {
    const res = validateBudgetRowInput({ year: 2026, month: 7, amount: 1234.5678 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ year: 2026, month: 7, amount: 1234.57 });
  });

  it("ปีนอกช่วง (ต่ำกว่า 2000) → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 1999, month: 1, amount: 100 }).ok).toBe(false);
  });

  it("ปีนอกช่วง (เกิน 2100) → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 2101, month: 1, amount: 100 }).ok).toBe(false);
  });

  it("เดือน 0 → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 2026, month: 0, amount: 100 }).ok).toBe(false);
  });

  it("เดือน 13 → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 2026, month: 13, amount: 100 }).ok).toBe(false);
  });

  it("★ ยอดติดลบ → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 2026, month: 1, amount: -1 }).ok).toBe(false);
  });

  it("ยอด = 0 → ผ่าน (ไม่ตั้งงบถือว่า 0 ได้)", () => {
    expect(validateBudgetRowInput({ year: 2026, month: 1, amount: 0 }).ok).toBe(true);
  });

  it("ยอดไม่ใช่ตัวเลข → ปฏิเสธ", () => {
    expect(validateBudgetRowInput({ year: 2026, month: 1, amount: "abc" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// buildBudgetComparison — ทิศทางตาม 0.11
// ---------------------------------------------------------------------
function mkTbRow(p: Partial<TrialBalanceRow> & { code: string }): TrialBalanceRow {
  return {
    code: p.code,
    name: p.name ?? p.code,
    category: p.category ?? "",
    digit: p.digit ?? p.code[0],
    opening: p.opening ?? 0,
    debit: p.debit ?? 0,
    credit: p.credit ?? 0,
    balance: p.balance ?? 0,
  };
}

function mkBudget(p: Partial<AccountBudget> & { accountCode: string; year: number; month: number; amount: number }): AccountBudget {
  return {
    id: p.id ?? "b1",
    tenantId: p.tenantId ?? "t1",
    customerId: p.customerId ?? "c1",
    accountCode: p.accountCode,
    year: p.year,
    month: p.month,
    amount: p.amount,
  };
}

describe("buildBudgetComparison — ทิศทางเทียบยอดตามหมวดบัญชี (0.11)", () => {
  it("หมวด 4 (รายได้) → เทียบเครดิตเคลื่อนไหว (ไม่ใช่เดบิต/สุทธิ)", () => {
    const budgetRows = [mkBudget({ accountCode: "4010", year: 2026, month: 7, amount: 50000 })];
    const tb = [mkTbRow({ code: "4010", name: "ขายสินค้า", debit: 100, credit: 60000 })];
    const rows = buildBudgetComparison(budgetRows, tb, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = rows.find((x) => x.accountCode === "4010");
    expect(r?.actual).toBe(60000);
    expect(r?.budget).toBe(50000);
    expect(r?.diff).toBe(10000);
  });

  it("หมวด 5 (ค่าใช้จ่าย) → เทียบเดบิตเคลื่อนไหว (ไม่ใช่เครดิต/สุทธิ)", () => {
    const budgetRows = [mkBudget({ accountCode: "5320", year: 2026, month: 7, amount: 3000 })];
    const tb = [mkTbRow({ code: "5320", name: "ค่าไฟฟ้า", debit: 3500, credit: 50 })];
    const rows = buildBudgetComparison(budgetRows, tb, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = rows.find((x) => x.accountCode === "5320");
    expect(r?.actual).toBe(3500);
    expect(r?.diff).toBe(500);
  });

  it("หมวดอื่น (1/2/3/6) → เทียบยอดเคลื่อนไหวสุทธิ (debit − credit)", () => {
    const budgetRows = [mkBudget({ accountCode: "1010", year: 2026, month: 7, amount: 1000 })];
    const tb = [mkTbRow({ code: "1010", name: "เงินสด", debit: 5000, credit: 2000 })];
    const rows = buildBudgetComparison(budgetRows, tb, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = rows.find((x) => x.accountCode === "1010");
    expect(r?.actual).toBe(3000); // 5000-2000
  });

  it("★ งบ=0 (ไม่เคยตั้ง) + จริง>0 → diffPercent = null (N/A) ไม่ throw หารศูนย์", () => {
    const tb = [mkTbRow({ code: "5320", debit: 1000, credit: 0 })];
    const rows = buildBudgetComparison([], tb, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = rows.find((x) => x.accountCode === "5320");
    expect(r?.budget).toBe(0);
    expect(r?.diffPercent).toBeNull();
    expect(() => buildBudgetComparison([], tb, TEST_CHART, { from: "2026-07", to: "2026-07" })).not.toThrow();
  });

  it("งบ>0 + จริง=0 (ไม่มีความเคลื่อนไหวเดือนนั้น เลยไม่โผล่ใน trialBalanceRows) → ยังโผล่ในตารางเทียบ actual=0", () => {
    const budgetRows = [mkBudget({ accountCode: "5344", year: 2026, month: 7, amount: 2000 })];
    const rows = buildBudgetComparison(budgetRows, [], TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = rows.find((x) => x.accountCode === "5344");
    expect(r?.actual).toBe(0);
    expect(r?.budget).toBe(2000);
    expect(r?.diffPercent).toBe(-100);
    expect(r?.accountName).toBe("ค่าบริการแพลตฟอร์ม"); // เติมชื่อจากผัง (ไม่มีใน trialBalanceRows)
  });

  it("period หลายเดือน (ไตรมาส) → sum งบของทุกเดือนในช่วงต่อบัญชี", () => {
    const budgetRows = [
      mkBudget({ accountCode: "5320", year: 2026, month: 1, amount: 1000 }),
      mkBudget({ accountCode: "5320", year: 2026, month: 2, amount: 1000 }),
      mkBudget({ accountCode: "5320", year: 2026, month: 3, amount: 1000 }),
      mkBudget({ accountCode: "5320", year: 2026, month: 4, amount: 9999 }), // นอกช่วง ต้องไม่ถูกรวม
    ];
    const tb = [mkTbRow({ code: "5320", debit: 2500, credit: 0 })];
    const rows = buildBudgetComparison(budgetRows, tb, TEST_CHART, { from: "2026-01", to: "2026-03" });
    const r = rows.find((x) => x.accountCode === "5320");
    expect(r?.budget).toBe(3000);
  });
});

describe("buildBudgetComparison — regression-style: ต้องตรงกับ TrialBalanceRow ของ pipeline เดิม 100%", () => {
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
      tenantId: p.tenantId ?? "t",
      attachmentId: null,
      customerId: p.customerId ?? "c1",
      customerName: null,
      attachmentObjectPath: null,
      uploadPath: null,
      uploadName: null,
      uploadMime: null,
      entryType: p.entryType ?? "purchase",
      docDate: p.docDate ?? "2026-07-15",
      docNo: p.docNo ?? null,
      counterpartyName: null,
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
      source: p.source ?? "manual",
      aiConfidence: null,
      notes: null,
      createdAt: "2026-07-01T00:00:00Z",
      confirmedAt: null,
      inputTaxMonth: null,
      lines: p.lines ?? [],
    };
  }

  it("บัญชีค่าใช้จ่าย (5320 ค่าไฟฟ้า) — actual ต้องเท่ากับ tb.debit เป๊ะ (อ่านตรง ไม่คำนวณใหม่)", () => {
    const entries = [
      mkEntry({ id: "e1", entryType: "purchase", lines: [mkLine({ accountCode: "5320", amount: 3200 })] }),
      mkEntry({ id: "e2", entryType: "purchase", lines: [mkLine({ accountCode: "5320", amount: 800 })] }),
    ];
    const chartByCode = buildChartByCode(TEST_CHART);
    const journal = buildJournalEntries(entries, chartByCode);
    const ledger = buildLedger(journal.lines, [], chartByCode);
    const tb = buildTrialBalance(ledger);

    const budgetRows = [mkBudget({ accountCode: "5320", year: 2026, month: 7, amount: 3500 })];
    const comparison = buildBudgetComparison(budgetRows, tb.rows, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = comparison.find((x) => x.accountCode === "5320");
    const tbRow = tb.rows.find((x) => x.code === "5320");

    expect(tbRow).toBeDefined();
    expect(r?.actual).toBe(tbRow!.debit); // ★ ตรงกับ pipeline เดิม 100% (ไม่ใช่ค่าคำนวณมือ)
    expect(r?.actual).toBe(4000);
  });

  it("บัญชีรายได้ (4010 ขายสินค้า) — actual ต้องเท่ากับ tb.credit เป๊ะ", () => {
    const entries = [
      mkEntry({ id: "e3", entryType: "sale", paymentMethod: "credit", lines: [mkLine({ accountCode: "4010", amount: 20000 })] }),
    ];
    const chartByCode = buildChartByCode(TEST_CHART);
    const journal = buildJournalEntries(entries, chartByCode);
    const ledger = buildLedger(journal.lines, [], chartByCode);
    const tb = buildTrialBalance(ledger);

    const comparison = buildBudgetComparison([], tb.rows, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = comparison.find((x) => x.accountCode === "4010");
    const tbRow = tb.rows.find((x) => x.code === "4010");

    expect(tbRow).toBeDefined();
    expect(r?.actual).toBe(tbRow!.credit);
    expect(r?.actual).toBe(20000);
  });

  it("บัญชีสินทรัพย์ (1010 เงินสด) — actual ต้องเท่ากับ tb.debit-tb.credit เป๊ะ (สุทธิ)", () => {
    const entries = [
      mkEntry({ id: "e4", entryType: "purchase", paymentMethod: "cash", lines: [mkLine({ accountCode: "5320", amount: 500 })] }),
    ];
    const chartByCode = buildChartByCode(TEST_CHART);
    const journal = buildJournalEntries(entries, chartByCode);
    const ledger = buildLedger(journal.lines, [], chartByCode);
    const tb = buildTrialBalance(ledger);

    const comparison = buildBudgetComparison([], tb.rows, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = comparison.find((x) => x.accountCode === "1010");
    const tbRow = tb.rows.find((x) => x.code === "1010");

    expect(tbRow).toBeDefined();
    expect(r?.actual).toBe(tbRow!.debit - tbRow!.credit);
  });
});

// ---------------------------------------------------------------------
// ★★ [tester] end-to-end จริงยิ่งขึ้น: มีทั้งบิลจริง + manual JE จริงในเดือนเดียวกัน กระทบบัญชีเดียวกัน
//   → เทียบผ่าน pipeline เต็ม (listEntries-equivalent → filterEntriesForReport ไม่จำเป็นเพราะ entries
//   กรองงวดมาแล้ว → loadCombinedJournalLines → buildLedger → buildTrialBalance) แล้วเทียบ buildBudgetComparison
//   ต้องตรงกับ TrialBalanceRow 100% (mirror pattern เดียวกับ tests/accounting/statement-inputs.test.ts)
// ---------------------------------------------------------------------
describe("★★ [tester] buildBudgetComparison — regression เต็ม: บิลจริง + manual JE จริงผสมกันเดือนเดียวกัน", () => {
  type Row = Record<string, unknown>;
  type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };
  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }
  function makeFakeStatementInputsDb(seed: { manualHeads: Row[]; manualLines: Row[] }): SupabaseClient {
    function qb(table: string) {
      const filters: Filter[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {};
      api.select = () => api;
      api.eq = (c: string, v: unknown) => { filters.push({ col: c, op: "eq", val: v }); return api; };
      api.is = (c: string, v: unknown) => { filters.push({ col: c, op: "is", val: v }); return api; };
      api.in = (c: string, v: unknown[]) => { filters.push({ col: c, op: "in", val: v }); return api; };
      api.order = () => api;
      api.limit = () => api;
      api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
        let data: unknown = [];
        if (table === "manual_journal_entries") data = seed.manualHeads.filter((r) => matchRow(r, filters));
        else if (table === "manual_journal_entry_lines") data = seed.manualLines.filter((r) => matchRow(r, filters));
        else if (table === "bill_payments" || table === "credit_debit_notes" || table === "credit_debit_note_lines")
          data = [];
        return Promise.resolve({ data, error: null }).then(onF);
      };
      return api;
    }
    return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
  }

  it("บิลค่าไฟฟ้า 3,200 + manual JE ปรับปรุงค่าไฟฟ้าเพิ่ม 800 เดือนเดียวกัน → actual ของ buildBudgetComparison ต้องตรงกับ tb.debit ที่รวมทั้ง 2 แหล่งเป๊ะ", async () => {
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
        docDate: p.docDate ?? "2026-07-10",
        docNo: p.docNo ?? null,
        counterpartyName: null,
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
        source: p.source ?? "manual",
        aiConfidence: null,
        notes: null,
        createdAt: "2026-07-01T00:00:00Z",
        confirmedAt: null,
        inputTaxMonth: null,
        lines: p.lines ?? [],
      };
    }

    const chartByCode = buildChartByCode(TEST_CHART);
    const entries = [
      mkEntry({ id: "e1", lines: [mkLine({ entryId: "e1", accountCode: "5320", amount: 3200 })] }),
    ];
    const billLines = buildJournalEntries(entries, chartByCode).lines;

    const manualHeadRow: Row = {
      id: "je1",
      tenant_id: "t1",
      customer_id: "c1",
      doc_type: "JV",
      doc_date: "2026-07-15",
      doc_no: "JV-001",
      memo: "ปรับปรุงค่าไฟฟ้าเพิ่ม",
      status: "confirmed",
      created_at: "2026-07-15T00:00:00Z",
      confirmed_at: "2026-07-15T00:00:00Z",
    };
    const manualLineRows: Row[] = [
      { id: "l1", entry_id: "je1", tenant_id: "t1", line_no: 1, account_code: "5320", account_name: "ค่าไฟฟ้า", description: null, debit: 800, credit: 0 },
      { id: "l2", entry_id: "je1", tenant_id: "t1", line_no: 2, account_code: "2015", account_name: "เจ้าหนี้อื่น ๆ", description: null, debit: 0, credit: 800 },
    ];
    const db = makeFakeStatementInputsDb({ manualHeads: [manualHeadRow], manualLines: manualLineRows });

    const period = { from: "2026-07", to: "2026-07", includeDraft: true };
    const combined = await loadCombinedJournalLines(db, "t1", entries, period, chartByCode);
    const combinedLines = [...combined.manualJournalLines, ...combined.paymentJournalLines, ...combined.noteJournalLines];

    const ledger = buildLedger([...billLines, ...combinedLines], [], chartByCode);
    const tb = buildTrialBalance(ledger);
    const tbRow = tb.rows.find((x) => x.code === "5320");
    expect(tbRow).toBeDefined();
    expect(tbRow!.debit).toBe(4000); // 3200 (บิล) + 800 (manual JE)

    const budgetRows = [mkBudget({ accountCode: "5320", year: 2026, month: 7, amount: 3500 })];
    const comparison = buildBudgetComparison(budgetRows, tb.rows, TEST_CHART, { from: "2026-07", to: "2026-07" });
    const r = comparison.find((x) => x.accountCode === "5320");
    expect(r?.actual).toBe(tbRow!.debit); // ★ ตรงกับ pipeline เดิม (บิล+manual JE รวมกัน) 100%
    expect(r?.actual).toBe(4000);
    expect(r?.diff).toBe(500); // 4000 - 3500
  });

  it("★ ตั้งงบครบ 12 เดือน แต่บางเดือนไม่มีรายการจริงเลย (ไม่มีบิล/manual JE) → เดือนนั้นแสดง actual=0 ไม่ throw ไม่หายจากตาราง", () => {
    // ตั้งงบทุกเดือนของปีให้บัญชี 5320 แต่มีรายการจริงเดือน ก.ค. เดือนเดียว (เดือนอื่นไม่มีรายการเคลื่อนไหวเลย)
    const budgetRows = Array.from({ length: 12 }, (_, i) =>
      mkBudget({ accountCode: "5320", year: 2026, month: i + 1, amount: 1000 })
    );
    // เดือน ส.ค. (from=to="2026-08") ไม่มีความเคลื่อนไหวจริงเลย → trialBalanceRows ว่างเปล่าสำหรับงวดนั้น
    expect(() => buildBudgetComparison(budgetRows, [], TEST_CHART, { from: "2026-08", to: "2026-08" })).not.toThrow();
    const rows = buildBudgetComparison(budgetRows, [], TEST_CHART, { from: "2026-08", to: "2026-08" });
    const r = rows.find((x) => x.accountCode === "5320");
    expect(r).toBeDefined();
    expect(r?.actual).toBe(0);
    expect(r?.budget).toBe(1000);
    expect(r?.diffPercent).toBe(-100); // (0-1000)/1000*100
  });

  it("★ ไม่มีงบเลย + ไม่มีรายการจริงเลยทั้งปี (ลูกค้าใหม่ยังไม่เริ่มใช้งาน) → คืน [] ไม่ throw", () => {
    expect(() => buildBudgetComparison([], [], TEST_CHART, { from: "2026-01", to: "2026-01" })).not.toThrow();
    expect(buildBudgetComparison([], [], TEST_CHART, { from: "2026-01", to: "2026-01" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// data layer — listBudgetYear / upsertBudgetYear (fake DB in-memory, mirror pattern เทสต์อื่นในเฟส 6)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    return row[f.col] === f.val;
  });
}

function makeFakeBudgetDb(): { db: SupabaseClient; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 1;

  function qb() {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "delete" = "select";
    let payload: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.insert = (p: unknown) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      if (mode === "insert") {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const r of items as Row[]) rows.push({ id: `bgt-${seq++}`, ...r });
      } else if (mode === "delete") {
        for (let i = rows.length - 1; i >= 0; i--) if (matchRow(rows[i], filters)) rows.splice(i, 1);
      } else {
        data = rows.filter((r) => matchRow(r, filters)).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: () => qb() } as unknown as SupabaseClient, rows };
}

const TENANT = "t1";
const CUSTOMER = "c1";

describe("upsertBudgetYear — batch (T45)", () => {
  it("บันทึก 12 เดือนทีเดียว → มี 12 แถวใน DB", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const budgetRows = Array.from({ length: 12 }, (_, i) => ({ accountCode: "5320", month: i + 1, amount: 1000 + i }));
    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, budgetRows);
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(12);
  });

  it("★ บันทึกซ้ำชุดเดิมอีกครั้ง → ยังมี 12 แถว ไม่ insert ซ้ำ (ทับของเดิม)", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const budgetRows = Array.from({ length: 12 }, (_, i) => ({ accountCode: "5320", month: i + 1, amount: 1000 }));
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, budgetRows);
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, budgetRows);
    expect(rows).toHaveLength(12);
  });

  it("แก้ยอดเดือนเดียวแล้วบันทึกใหม่ (ส่งครบ 12 เดือนของบัญชีนั้น) → ยอดที่แก้ถูกอัปเดตจริง ไม่ซ้ำแถว", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const first = Array.from({ length: 12 }, (_, i) => ({ accountCode: "5320", month: i + 1, amount: 1000 }));
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, first);

    const second = first.map((r) => (r.month === 7 ? { ...r, amount: 9999 } : r));
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, second);

    expect(rows).toHaveLength(12);
    const julyRow = rows.find((r) => r.month === 7);
    expect(julyRow?.amount).toBe(9999);
  });

  it("ลบยอดกลับเป็นว่าง (ไม่ส่งเดือนนั้นมาอีก) → แถวเดือนนั้นหายไปจริง (ไม่ค้าง 0 ใน DB)", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const first = [{ accountCode: "5320", month: 7, amount: 1000 }];
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, first);
    expect(rows).toHaveLength(1);

    // ส่งเดือน 7 มาพร้อมยอด 0 (ผู้ใช้ล้างช่องนั้น) — ต้องไม่มีแถวเหลือของบัญชีนี้เลย
    const second = [{ accountCode: "5320", month: 7, amount: 0 }];
    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, second);
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("★ มีแถวที่ validate ไม่ผ่าน (เดือนนอกช่วง) → ปฏิเสธทั้งชุด ไม่เขียนอะไรเลย (all-or-nothing)", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const budgetRows = [
      { accountCode: "5320", month: 7, amount: 1000 },
      { accountCode: "5320", month: 13, amount: 1000 }, // ผิด
    ];
    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, budgetRows);
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("★ ยอดติดลบ → ปฏิเสธทั้งชุด", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [
      { accountCode: "5320", month: 7, amount: -100 },
    ]);
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("ไม่กระทบรหัสบัญชีอื่นที่ไม่ได้อยู่ในชุดที่ส่งมา", async () => {
    const { db, rows } = makeFakeBudgetDb();
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [{ accountCode: "5320", month: 7, amount: 1000 }]);
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [{ accountCode: "4010", month: 7, amount: 2000 }]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.account_code === "5320")).toBeDefined();
    expect(rows.find((r) => r.account_code === "4010")).toBeDefined();
  });
});

describe("listBudgetYear", () => {
  it("อ่านกลับมาได้ตรงกับที่บันทึกไว้", async () => {
    const { db } = makeFakeBudgetDb();
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [{ accountCode: "5320", month: 7, amount: 1500.5 }]);
    const list = await listBudgetYear(db, TENANT, CUSTOMER, 2026);
    expect(list).toHaveLength(1);
    expect(list[0].accountCode).toBe("5320");
    expect(list[0].amount).toBe(1500.5);
    expect(list[0].year).toBe(2026);
    expect(list[0].month).toBe(7);
  });
});
