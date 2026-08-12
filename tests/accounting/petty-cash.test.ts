import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validatePettyCashFundInput,
  validatePettyCashVoucherInput,
  computeBalance,
  buildSettlementJournalEntryInput,
  createVoucher,
  isJeReferencedBySettledVoucher,
  type PettyCashFund,
  type PettyCashVoucher,
} from "@/lib/accounting/petty-cash";
import { isBalanced, validateManualEntryInput } from "@/lib/accounting/manual-journal";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";

/**
 * เทสต์ `petty-cash.ts` (wishlist ข้อ 3) — เงินสดย่อยระบบ imprest
 */

const CHART: ChartByCode = {
  "1015": { code: "1015", name: "เงินสดย่อย", category: "สินทรัพย์" },
  "1020": { code: "1020", name: "เงินฝากธนาคาร #1", category: "สินทรัพย์" },
  "5336": { code: "5336", name: "ค่าใช้จ่ายสำนักงาน", category: "ค่าใช้จ่าย" },
  "5340": { code: "5340", name: "ค่าน้ำมัน", category: "ค่าใช้จ่าย" },
  "4010": { code: "4010", name: "ขายสินค้า", category: "รายได้" },
};

function fund(overrides: Partial<PettyCashFund> = {}): PettyCashFund {
  return {
    id: "f1",
    tenantId: "t1",
    customerId: "c1",
    fundName: "เงินสดย่อย",
    floatAmount: 5000,
    cashAccountCode: "1015",
    sourceAccountCode: "1020",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function voucher(overrides: Partial<PettyCashVoucher> = {}): PettyCashVoucher {
  return {
    id: "v1",
    tenantId: "t1",
    customerId: "c1",
    fundId: "f1",
    voucherDate: "2026-07-01",
    description: null,
    categoryAccountCode: "5336",
    categoryAccountName: "ค่าใช้จ่ายสำนักงาน",
    amount: 100,
    receiptNo: null,
    status: "pending",
    settledJeId: null,
    settledAt: null,
    createdAt: "",
    ...overrides,
  };
}

describe("validatePettyCashFundInput", () => {
  it("input ถูกต้องครบ → ผ่าน", () => {
    const r = validatePettyCashFundInput({ fundName: "เงินสดย่อย", floatAmount: 5000, cashAccountCode: "1015", sourceAccountCode: "1020" }, CHART);
    expect(r.ok).toBe(true);
  });

  it("floatAmount ติดลบ → ปฏิเสธ", () => {
    const r = validatePettyCashFundInput({ floatAmount: -100, cashAccountCode: "1015", sourceAccountCode: "1020" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("cashAccountCode อยู่หมวดผิด (ค่าใช้จ่ายแทนสินทรัพย์) → ปฏิเสธ", () => {
    const r = validatePettyCashFundInput({ floatAmount: 5000, cashAccountCode: "5336", sourceAccountCode: "1020" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("sourceAccountCode ไม่อยู่ในผัง → ปฏิเสธ", () => {
    const r = validatePettyCashFundInput({ floatAmount: 5000, cashAccountCode: "1015", sourceAccountCode: "9999" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("ไม่ระบุ fundName → default 'เงินสดย่อย'", () => {
    const r = validatePettyCashFundInput({ floatAmount: 5000, cashAccountCode: "1015", sourceAccountCode: "1020" }, CHART);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fundName).toBe("เงินสดย่อย");
  });
});

describe("validatePettyCashVoucherInput", () => {
  it("input ถูกต้องครบ → ผ่าน", () => {
    const r = validatePettyCashVoucherInput({ voucherDate: "2026-07-01", categoryAccountCode: "5336", amount: 100 }, CHART);
    expect(r.ok).toBe(true);
  });

  it("วันที่ผิดรูปแบบ → ปฏิเสธ", () => {
    const r = validatePettyCashVoucherInput({ voucherDate: "01/07/2026", categoryAccountCode: "5336", amount: 100 }, CHART);
    expect(r.ok).toBe(false);
  });

  it("วันที่ปฏิทินไม่มีจริง (2026-02-30) → ปฏิเสธ", () => {
    const r = validatePettyCashVoucherInput({ voucherDate: "2026-02-30", categoryAccountCode: "5336", amount: 100 }, CHART);
    expect(r.ok).toBe(false);
  });

  it("categoryAccountCode อยู่หมวดผิด (รายได้แทนค่าใช้จ่าย) → ปฏิเสธ", () => {
    const r = validatePettyCashVoucherInput({ voucherDate: "2026-07-01", categoryAccountCode: "4010", amount: 100 }, CHART);
    expect(r.ok).toBe(false);
  });

  it("amount เป็น 0 หรือติดลบ → ปฏิเสธ", () => {
    expect(validatePettyCashVoucherInput({ voucherDate: "2026-07-01", categoryAccountCode: "5336", amount: 0 }, CHART).ok).toBe(false);
    expect(validatePettyCashVoucherInput({ voucherDate: "2026-07-01", categoryAccountCode: "5336", amount: -50 }, CHART).ok).toBe(false);
  });
});

describe("computeBalance", () => {
  it("ยอดคงเหลือ = floatAmount − ผลรวม voucher ที่ยัง pending", () => {
    const f = fund({ floatAmount: 5000 });
    const vouchers = [voucher({ amount: 300 }), voucher({ id: "v2", amount: 200 })];
    expect(computeBalance(f, vouchers)).toBe(4500);
  });

  it("voucher ที่ settled แล้ว ไม่นับเข้าไปหักยอดคงเหลือ", () => {
    const f = fund({ floatAmount: 5000 });
    const vouchers = [voucher({ amount: 300, status: "settled" }), voucher({ id: "v2", amount: 200 })];
    expect(computeBalance(f, vouchers)).toBe(4800); // หัก 200 เท่านั้น (300 settled แล้วไม่หัก)
  });

  it("ไม่มี voucher เลย → ยอดคงเหลือ = floatAmount เต็ม", () => {
    expect(computeBalance(fund({ floatAmount: 5000 }), [])).toBe(5000);
  });
});

describe("buildSettlementJournalEntryInput", () => {
  it("รวมใบเบิกหมวดเดียวกันเป็นบรรทัดเดียว + สมดุล", () => {
    const f = fund();
    const vouchers = [voucher({ amount: 100 }), voucher({ id: "v2", amount: 150 })];
    const r = buildSettlementJournalEntryInput(f, vouchers, "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docType).toBe("PV");
    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(isBalanced(v.value.lines)).toBe(true);
    expect(v.value.lines.length).toBe(2); // 1 บรรทัด Dr (รวม 5336) + 1 บรรทัด Cr (1020)
    const expenseLine = v.value.lines.find((l) => l.accountCode === "5336");
    expect(expenseLine?.debit).toBe(250);
    const sourceLine = v.value.lines.find((l) => l.accountCode === "1020");
    expect(sourceLine?.credit).toBe(250);
  });

  it("ใบเบิกหลายหมวด → แยกบรรทัดตามหมวด ยังสมดุล", () => {
    const f = fund();
    const vouchers = [voucher({ amount: 100, categoryAccountCode: "5336" }), voucher({ id: "v2", amount: 80, categoryAccountCode: "5340" })];
    const r = buildSettlementJournalEntryInput(f, vouchers, "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.lines.length).toBe(3); // 5336 + 5340 + 1020
    expect(isBalanced(v.value.lines)).toBe(true);
  });

  it("ใบเบิกที่ settled แล้วถูกกรองออก ไม่รวมเข้า JE รอบใหม่", () => {
    const f = fund();
    const vouchers = [voucher({ amount: 100, status: "settled" }), voucher({ id: "v2", amount: 50 })];
    const r = buildSettlementJournalEntryInput(f, vouchers, "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateManualEntryInput(r.value, CHART);
    if (!v.ok) return;
    const sourceLine = v.value.lines.find((l) => l.accountCode === "1020");
    expect(sourceLine?.credit).toBe(50); // ไม่รวม 100 ที่ settled แล้ว
  });

  it("ไม่มีใบเบิก pending เลย → ปฏิเสธ ไม่สร้าง JE เปล่า", () => {
    const r = buildSettlementJournalEntryInput(fund(), [voucher({ status: "settled" })], "2026-07-31");
    expect(r.ok).toBe(false);
  });

  it("array ว่างล้วน → ปฏิเสธ", () => {
    const r = buildSettlementJournalEntryInput(fund(), [], "2026-07-31");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// data layer — fake DB in-memory (mirror pattern เทสต์อื่นในเฟส 6/9b, เช่น bank-reconciliation.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in" | "is"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "in") return (f.val as unknown[]).includes(v);
    if (f.op === "is") return f.val === null ? v === null || v === undefined : v === f.val;
    return v === f.val;
  });
}

function makeFakeDb(): { db: SupabaseClient; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {};
  let seq = 1;

  function qb(table: string) {
    if (!tables[table]) tables[table] = [];
    const filters: Filter[] = [];
    let mode: "select" | "insert" = "select";
    let payload: unknown;
    let single = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => { filters.push({ col: c, op: "eq", val: v }); return api; };
    api.in = (c: string, v: unknown[]) => { filters.push({ col: c, op: "in", val: v }); return api; };
    api.is = (c: string, v: unknown) => { filters.push({ col: c, op: "is", val: v }); return api; };
    api.order = () => api;
    api.limit = () => api;
    api.insert = (p: unknown) => { mode = "insert"; payload = p; return api; };
    api.maybeSingle = () => { single = true; return api; };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      if (mode === "insert") {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = (items as Row[]).map((r) => ({ id: `row-${seq++}`, deleted_at: null, ...r }));
        tables[table].push(...inserted);
        data = single ? inserted[0] ?? null : inserted;
      } else {
        const found = tables[table].filter((r) => matchRow(r, filters)).map((r) => ({ ...r }));
        data = single ? found[0] ?? null : found;
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, tables };
}

const TENANT = "t1";
const CUSTOMER_A = "c-a";
const CUSTOMER_B = "c-b";

describe("createVoucher (data layer)", () => {
  it("fundId ที่ไม่ตรงกับกองทุนจริงของ customerId นี้ → ปฏิเสธ ไม่ insert (กัน IDOR ข้ามลูกค้า)", async () => {
    const { db, tables } = makeFakeDb();
    // seed กองทุนจริงของลูกค้า A และลูกค้า B แยกกัน
    tables["petty_cash_funds"] = [
      { id: "fund-a", tenant_id: TENANT, customer_id: CUSTOMER_A, source_account_code: "1020" },
      { id: "fund-b", tenant_id: TENANT, customer_id: CUSTOMER_B, source_account_code: "1020" },
    ];

    // ส่ง fundId ของลูกค้า B มาพร้อม customerId ของลูกค้า A (ปลอม/พลาดจาก client)
    const res = await createVoucher(
      db,
      TENANT,
      CUSTOMER_A,
      "fund-b",
      { voucherDate: "2026-07-01", categoryAccountCode: "5336", amount: 100 },
      CHART
    );
    expect(res.ok).toBe(false);
    expect(tables["petty_cash_vouchers"] ?? []).toHaveLength(0); // ★ ต้องไม่มี voucher ถูกสร้างขึ้นเลย
  });

  it("fundId ตรงกับกองทุนจริงของ customerId นี้ → สร้างใบเบิกสำเร็จ ผูก fund_id ที่โหลดจาก DB จริง", async () => {
    const { db, tables } = makeFakeDb();
    tables["petty_cash_funds"] = [{ id: "fund-a", tenant_id: TENANT, customer_id: CUSTOMER_A, source_account_code: "1020" }];

    const res = await createVoucher(
      db,
      TENANT,
      CUSTOMER_A,
      "fund-a",
      { voucherDate: "2026-07-01", categoryAccountCode: "5336", amount: 100 },
      CHART
    );
    expect(res.ok).toBe(true);
    expect(tables["petty_cash_vouchers"]).toHaveLength(1);
    expect(tables["petty_cash_vouchers"][0].fund_id).toBe("fund-a");
    expect(tables["petty_cash_vouchers"][0].customer_id).toBe(CUSTOMER_A);
  });
});

describe("isJeReferencedBySettledVoucher", () => {
  it("มีใบเบิก settled ที่ settled_je_id ตรงกับ id ที่ตรวจสอบ → true", async () => {
    const { db, tables } = makeFakeDb();
    tables["petty_cash_vouchers"] = [
      { id: "v1", tenant_id: TENANT, settled_je_id: "je-1", status: "settled", deleted_at: null },
    ];
    expect(await isJeReferencedBySettledVoucher(db, TENANT, "je-1")).toBe(true);
  });

  it("ไม่มีใบเบิกใดผูกกับ id นี้ → false", async () => {
    const { db } = makeFakeDb();
    expect(await isJeReferencedBySettledVoucher(db, TENANT, "je-999")).toBe(false);
  });

  it("ใบเบิกผูกกับ JE นี้แต่ยัง pending (ไม่ใช่ settled) → false (ยังไม่ถือว่าล็อก)", async () => {
    const { db, tables } = makeFakeDb();
    tables["petty_cash_vouchers"] = [
      { id: "v1", tenant_id: TENANT, settled_je_id: "je-1", status: "pending", deleted_at: null },
    ];
    expect(await isJeReferencedBySettledVoucher(db, TENANT, "je-1")).toBe(false);
  });

  it("ใบเบิก settled ที่ผูกกับ je-1 เป็นของ tenant อื่น → false (ไม่ข้าม tenant)", async () => {
    const { db, tables } = makeFakeDb();
    tables["petty_cash_vouchers"] = [
      { id: "v1", tenant_id: "other-tenant", settled_je_id: "je-1", status: "settled", deleted_at: null },
    ];
    expect(await isJeReferencedBySettledVoucher(db, TENANT, "je-1")).toBe(false);
  });

  it("ใบเบิก settled ที่ผูกกับ je-1 แต่ตัวเองถูก soft-delete ไปแล้ว → false (ไม่กันการลบ JE)", async () => {
    const { db, tables } = makeFakeDb();
    tables["petty_cash_vouchers"] = [
      { id: "v1", tenant_id: TENANT, settled_je_id: "je-1", status: "settled", deleted_at: "2026-08-01T00:00:00Z" },
    ];
    expect(await isJeReferencedBySettledVoucher(db, TENANT, "je-1")).toBe(false);
  });
});
