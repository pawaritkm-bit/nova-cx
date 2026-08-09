import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * เทสต์ server actions ของหน้า "งบประมาณ" (/chat-audit/accounting/budget — เฟส 6 ส่วน S)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/recurring-journal-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD (T46/T48):
 *     - guard สโคป: นักบัญชีนอกสโคปตั้งงบของลูกค้าอื่นไม่ได้
 *     - saveBudgetYearAction: batch upsert ทีเดียวทั้งปี (ทับของเดิม ไม่ insert ซ้ำ)
 *     - ปีนอกช่วง / แถวไม่ถูกต้อง → ปฏิเสธ ไม่แตะ DB
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

let currentDb: SupabaseClient;
let rows: Row[];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => currentDb),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
  };
});

import { saveBudgetYearAction } from "@/app/chat-audit/accounting/budget/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const adminCtx = {
  tenantId: "tenant-1",
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

function accountantCtx(allowed: string[]) {
  return {
    tenantId: "tenant-1",
    mode: "accountant" as const,
    employeeId: "emp-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

// ---------------------------------------------------------------------
// fake DB in-memory (mirror pattern เทสต์อื่นในเฟส 6 — account_budgets เท่านั้น)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    return row[f.col] === f.val;
  });
}

function makeFakeDb(): { db: SupabaseClient; rows: Row[] } {
  const t: Row[] = [];
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
        for (const r of items as Row[]) t.push({ id: `bgt-${seq++}`, ...r });
      } else if (mode === "delete") {
        for (let i = t.length - 1; i >= 0; i--) if (matchRow(t[i], filters)) t.splice(i, 1);
      } else {
        data = t.filter((r) => matchRow(r, filters)).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: () => qb() } as unknown as SupabaseClient, rows: t };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  const made = makeFakeDb();
  currentDb = made.db;
  rows = made.rows;
});

describe("saveBudgetYearAction", () => {
  it("บันทึกงบ 12 เดือนของบัญชีเดียวทีเดียว → เขียนลง DB สำเร็จ", async () => {
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 2026,
      rows: Array.from({ length: 12 }, (_, i) => ({ accountCode: "5320", month: i + 1, amount: 1000 })),
    });
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.customer_id === CUSTOMER_ID)).toBe(true);
  });

  it("★ บันทึกซ้ำชุดเดิมอีกครั้ง → ยังมี 12 แถว ไม่ insert ซ้ำ (ทับของเดิม)", async () => {
    const budgetRows = Array.from({ length: 12 }, (_, i) => ({ accountCode: "5320", month: i + 1, amount: 1000 }));
    await saveBudgetYearAction({ customerId: CUSTOMER_ID, year: 2026, rows: budgetRows });
    await saveBudgetYearAction({ customerId: CUSTOMER_ID, year: 2026, rows: budgetRows });
    expect(rows).toHaveLength(12);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 2026,
      rows: [{ accountCode: "5320", month: 7, amount: 1000 }],
    });
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("นักบัญชีในสโคป → ทำได้ตามปกติ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 2026,
      rows: [{ accountCode: "5320", month: 7, amount: 1000 }],
    });
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await saveBudgetYearAction({
      customerId: "not-a-uuid",
      year: 2026,
      rows: [{ accountCode: "5320", month: 7, amount: 1000 }],
    });
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("★ ปีนอกช่วง (2000-2100) → ปฏิเสธ ไม่แตะ DB", async () => {
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 1999,
      rows: [{ accountCode: "5320", month: 7, amount: 1000 }],
    });
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("★ แถวมียอดติดลบ → ปฏิเสธทั้งชุด ไม่เขียนอะไรเลย", async () => {
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 2026,
      rows: [
        { accountCode: "5320", month: 7, amount: 1000 },
        { accountCode: "5320", month: 8, amount: -1 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("ไม่มีสิทธิ์เข้าหน้าบัญชีเลย (ไม่ login) → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockRejectedValue(new Error("no access"));
    const res = await saveBudgetYearAction({
      customerId: CUSTOMER_ID,
      year: 2026,
      rows: [{ accountCode: "5320", month: 7, amount: 1000 }],
    });
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });
});
