import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  saleDraftsFromStatementTxns,
  saleDraftsFromPlatformLines,
  pickIncomeAccount,
  createSaleBillDrafts,
  DEDUP_MARK,
} from "@/lib/accounting/statement-to-bills";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { PlatformReportLine } from "@/lib/accounting/platform-report-analyze";

/** สะพาน เงินเข้าสเตทเมนต์/แพลตฟอร์ม → บิลขายร่าง (requirement 2026-09-01) */

const TENANT = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";

const txn = (p: Partial<StatementTxn>): StatementTxn => ({
  date: "2026-06-01",
  description: "รับโอนจาก KBANK x7135",
  counterparty_name: "บจก. ชูทับทิม",
  counterparty_account_no: "x7135",
  direction: "in",
  amount: 3880,
  ...p,
});

describe("saleDraftsFromStatementTxns", () => {
  it("เอาเฉพาะเงินเข้า + มีวันที่ + ยอด > 0 (1 โอน = 1 บิล)", () => {
    const drafts = saleDraftsFromStatementTxns([
      txn({}),
      txn({ direction: "out" }), // เงินออก → ไม่เอา
      txn({ amount: null }), // อ่านยอดไม่ได้ → ไม่เอา
      txn({ date: null }), // ไม่มีวันที่ → ไม่เอา
      txn({ amount: 0 }), // ศูนย์บาท → ไม่เอา
      txn({ date: "2026-06-02", amount: 1000, counterparty_account_no: "x9999" }),
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ docDate: "2026-06-01", amount: 3880, counterpartyName: "บจก. ชูทับทิม" });
    expect(drafts[0].dedupKey).toBe("2026-06-01|3880.00|x7135");
  });

  it("timestamp ISO → ตัดเหลือวัน", () => {
    const d = saleDraftsFromStatementTxns([txn({ date: "2026-06-05T10:30:00Z" })]);
    expect(d[0].docDate).toBe("2026-06-05");
  });
});

describe("saleDraftsFromPlatformLines", () => {
  const line = (p: Partial<PlatformReportLine>): PlatformReportLine => ({
    date: "2026-06-01",
    order_no: null,
    description: "ออเดอร์",
    category: "sales",
    direction: "credit",
    amount: 100,
    ...p,
  });

  it("รวมยอดขายต่อวันเป็น 1 บิล — ค่าธรรมเนียม (deduct) ไม่รวม", () => {
    const drafts = saleDraftsFromPlatformLines(
      [
        line({}),
        line({ amount: 50 }),
        line({ date: "2026-06-02", amount: 200 }),
        line({ direction: "deduct", category: "commission_fee", amount: 10 }),
      ],
      "Shopee"
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ docDate: "2026-06-01", amount: 150 });
    expect(drafts[1]).toMatchObject({ docDate: "2026-06-02", amount: 200 });
    expect(drafts[0].description).toContain("Shopee");
  });
});

describe("pickIncomeAccount", () => {
  const acc = (code: string, name: string, category = "รายได้") => ({ code, name, category });
  it("ชื่อมี 'บริการ' มาก่อน 4010", () => {
    const got = pickIncomeAccount([acc("4010", "ขายสินค้า"), acc("4015", "รายได้ค่าบริการ")]);
    expect(got?.code).toBe("4015");
  });
  it("ไม่มีบริการ → 4010 → ตัวแรกของหมวดรายได้", () => {
    expect(pickIncomeAccount([acc("4010", "ขายสินค้า"), acc("4020", "รายได้อื่น ๆ")])?.code).toBe("4010");
    expect(pickIncomeAccount([acc("4020", "รายได้อื่น ๆ")])?.code).toBe("4020");
    expect(pickIncomeAccount([acc("5010", "ซื้อสินค้า", "ค่าใช้จ่าย")])).toBeNull();
  });
});

// ---------------- createSaleBillDrafts (mock DB) ----------------

type Row = Record<string, unknown>;

function makeDb(store: { entries: Row[]; lines: Row[]; banks: Row[]; chart: Row[] }): SupabaseClient {
  function qb(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    let mode: "select" | "insert" = "select";
    let insertRow: Row = {};
    const chain = () => api;
    api.select = chain;
    api.eq = chain;
    api.is = chain;
    api.like = chain;
    api.limit = chain;
    api.order = chain;
    api.insert = (row: Row) => {
      mode = "insert";
      insertRow = row;
      return api;
    };
    api.single = () => {
      const id = `e${store.entries.length + 1}`;
      store.entries.push({ id, ...insertRow });
      return Promise.resolve({ data: { id }, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "insert") {
        if (table === "bill_entry_lines") store.lines.push(insertRow);
        return Promise.resolve({ data: null, error: null }).then(onF);
      }
      if (table === "customer_bank_accounts") data = store.banks;
      else if (table === "chart_of_accounts") data = store.chart;
      else if (table === "bill_entries") data = store.entries.map((e) => ({ notes: e.notes ?? null }));
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

const CHART = [
  { code: "4010", name: "ขายสินค้า", category: "รายได้", is_bank: false },
  { code: "1140", name: "ลูกหนี้การค้า", category: "สินทรัพย์", is_bank: false },
];

describe("createSaleBillDrafts", () => {
  it("สร้างบิลร่างขาย 1 ใบต่อร่าง + บรรทัดมีรหัสรายได้ + คีย์กันซ้ำใน notes", async () => {
    const store = { entries: [] as Row[], lines: [] as Row[], banks: [{ id: "bank-1" }], chart: CHART };
    const drafts = saleDraftsFromStatementTxns([txn({}), txn({ date: "2026-06-02", counterparty_account_no: "x2" })]);
    const r = await createSaleBillDrafts(makeDb(store), {
      tenantId: TENANT,
      customerId: CUSTOMER,
      drafts,
      sourceLabel: "สเตทเมนต์ทดสอบ",
    });
    expect(r.created).toBe(2);
    expect(r.skippedDup).toBe(0);
    expect(r.incomeAccountCode).toBe("4010");
    expect(store.entries).toHaveLength(2);
    expect(store.entries[0]).toMatchObject({
      entry_type: "sale",
      status: "draft",
      doc_date: "2026-06-01",
      payment_method: "transfer", // มีบัญชีเดียว → โอนเข้าบัญชีนั้น
      payment_bank_account_id: "bank-1",
    });
    expect(String(store.entries[0].notes)).toContain(DEDUP_MARK);
    expect(store.lines[0]).toMatchObject({ vat_type: "novat", account_code: "4010", amount: 3880 });
  });

  it("idempotent: รันซ้ำด้วยร่างเดิม → ข้ามทั้งหมด (skippedDup)", async () => {
    const store = { entries: [] as Row[], lines: [] as Row[], banks: [] as Row[], chart: CHART };
    const drafts = saleDraftsFromStatementTxns([txn({})]);
    const db = makeDb(store);
    const r1 = await createSaleBillDrafts(db, { tenantId: TENANT, customerId: CUSTOMER, drafts, sourceLabel: "x" });
    const r2 = await createSaleBillDrafts(db, { tenantId: TENANT, customerId: CUSTOMER, drafts, sourceLabel: "x" });
    expect(r1.created).toBe(1);
    expect(r2.created).toBe(0);
    expect(r2.skippedDup).toBe(1);
    expect(store.entries).toHaveLength(1);
  });

  it("หลายบัญชีธนาคาร → ไม่เดา (payment null = journal ตีเป็นลูกหนี้)", async () => {
    const store = { entries: [] as Row[], lines: [] as Row[], banks: [{ id: "b1" }, { id: "b2" }], chart: CHART };
    await createSaleBillDrafts(makeDb(store), {
      tenantId: TENANT,
      customerId: CUSTOMER,
      drafts: saleDraftsFromStatementTxns([txn({})]),
      sourceLabel: "x",
    });
    expect(store.entries[0]).toMatchObject({ payment_method: null, payment_bank_account_id: null });
  });
});
