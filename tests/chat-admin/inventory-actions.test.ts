import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * เทสต์ server actions ของหน้า "สต็อกสินค้าคงเหลือ" (/chat-audit/accounting/inventory — เฟส 8 ส่วน X, T72/T75)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/recurring-journal-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม 0.13:
 *     - guard สโคป: นักบัญชีนอกสโคปทำรายการของลูกค้าอื่นไม่ได้ (ทั้ง createAdjustment/deleteMovement/upsertOpeningBalance)
 *     - deleteMovementAction: ★ derive scope จาก movement id จริงเสมอ (ไม่เชื่อ customerId จาก client
 *       ลำพัง — สวมรอยส่ง customerId ที่ตัวเองมีสิทธิ์ แต่ movement จริงเป็นของลูกค้าอื่น → ต้องปฏิเสธ)
 *     - createAdjustment/upsertOpeningBalance: productId ต้องเป็นสินค้าของ tenant นี้จริง (กัน IDOR ข้าม tenant)
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

let currentDb: SupabaseClient;
let tables: Tables;

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

import {
  createAdjustmentAction,
  deleteMovementAction,
  upsertOpeningBalanceAction,
} from "@/app/chat-audit/accounting/inventory/actions";

const TENANT = "tenant-1";
const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PRODUCT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const PRODUCT_OTHER_TENANT = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const adminCtx = {
  tenantId: TENANT,
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

function accountantCtx(allowed: string[]) {
  return {
    tenantId: TENANT,
    mode: "accountant" as const,
    employeeId: "emp-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

// ---------------------------------------------------------------------
// fake DB stateful in-memory (mirror tests/accounting/recurring-journal-actions.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = {
  products: Row[];
  product_stock_movements: Row[];
  product_opening_balances: Row[];
};

const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
  product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null },
  product_opening_balances: { deleted_at: null, note: null },
};

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const t: Tables = {
    products: [
      { id: PRODUCT_ID, tenant_id: TENANT, deleted_at: null },
      { id: PRODUCT_OTHER_TENANT, tenant_id: "other-tenant", deleted_at: null },
    ],
    product_stock_movements: [],
    product_opening_balances: [],
  };
  let seq = 1;
  const nextId = () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`;

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: unknown;
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
    api.order = () => api;
    api.limit = () => api;
    api.insert = (p: unknown) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.update = (p: unknown) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "insert") {
        const row: Row = { id: nextId(), created_at: new Date().toISOString(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
        t[table].push(row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      if (mode === "update") {
        const row = t[table].find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      const row = t[table].find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      if (mode === "insert") {
        const row: Row = { id: nextId(), created_at: new Date().toISOString(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
        t[table].push(row);
      } else if (mode === "update") {
        for (const row of t[table]) if (matchRow(row, filters)) Object.assign(row, payload as Row);
      } else {
        data = t[table].filter((r) => matchRow(r, filters)).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: (name: string) => qb(name as keyof Tables) } as unknown as SupabaseClient, tables: t };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  const made = makeFakeDb();
  currentDb = made.db;
  tables = made.tables;
});

// ---------------------------------------------------------------------
// createAdjustmentAction
// ---------------------------------------------------------------------
describe("createAdjustmentAction", () => {
  it("บันทึกปรับปรุงสต็อกเข้าสำเร็จ", async () => {
    const res = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements).toHaveLength(1);
    expect(tables.product_stock_movements[0]).toMatchObject({ customer_id: CUSTOMER_ID, product_id: PRODUCT_ID });
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("★ productId เป็นสินค้าของ tenant อื่น (IDOR ข้าม tenant) → ปฏิเสธ ไม่แตะ DB", async () => {
    const res = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_OTHER_TENANT,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("productId ไม่มีอยู่จริง → ปฏิเสธ", async () => {
    const res = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("customerId/productId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await createAdjustmentAction({
      customerId: "not-a-uuid",
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("validate ไม่ผ่าน (quantity<=0) → ปฏิเสธ ไม่แตะ DB (validate ที่ data layer)", async () => {
    const res = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      movementType: "adjustment_out",
      quantity: -1,
      movementDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// deleteMovementAction — ★ derive scope จาก movement id จริงเสมอ (0.13)
// ---------------------------------------------------------------------
describe("deleteMovementAction", () => {
  it("ยกเลิกรายการสำเร็จ (soft-delete)", async () => {
    const created = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    if (!created.ok || !created.id) throw new Error("setup failed");

    const res = await deleteMovementAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements[0].deleted_at).toBeTruthy();
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่ลบ", async () => {
    const created = await createAdjustmentAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    if (!created.ok || !created.id) throw new Error("setup failed");

    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteMovementAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements[0].deleted_at).toBeFalsy();
  });

  it("★★ สวมรอย: ส่ง customerId ที่ตัวเองมีสิทธิ์ แต่ movement จริงเป็นของลูกค้าอื่น → ปฏิเสธ (IDOR-safe, 0.13)", async () => {
    // movement จริงผูกกับ CUSTOMER_OTHER
    const created = await createAdjustmentAction({
      customerId: CUSTOMER_OTHER,
      productId: PRODUCT_ID,
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 10,
      movementDate: "2026-01-01",
    });
    if (!created.ok || !created.id) throw new Error("setup failed");

    // นักบัญชีดูแลทั้ง CUSTOMER_ID และ CUSTOMER_OTHER... จำกัดสโคปแค่ CUSTOMER_ID (ไม่รวม CUSTOMER_OTHER)
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    // อ้าง (สวมรอย) ว่า customerId=CUSTOMER_ID (ซึ่งตัวเองมีสิทธิ์) แต่ movement จริงเป็นของ CUSTOMER_OTHER
    const res = await deleteMovementAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements[0].deleted_at).toBeFalsy();
  });

  it("ไม่พบ movement (ถูกลบไปแล้ว/ไม่มีจริง) → ปฏิเสธ", async () => {
    const res = await deleteMovementAction("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await deleteMovementAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// upsertOpeningBalanceAction
// ---------------------------------------------------------------------
describe("upsertOpeningBalanceAction", () => {
  it("ตั้งยอดยกมาใหม่สำเร็จ", async () => {
    const res = await upsertOpeningBalanceAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      quantity: 100,
      unitCost: 65,
      note: "ยกมาจากปีก่อน",
    });
    expect(res.ok).toBe(true);
    expect(tables.product_opening_balances).toHaveLength(1);
  });

  it("เรียกซ้ำ (แก้ยอดยกมาเดิม) → update ทับแถวเดิม ไม่สร้างซ้ำ", async () => {
    await upsertOpeningBalanceAction({ customerId: CUSTOMER_ID, productId: PRODUCT_ID, quantity: 100, unitCost: 65 });
    await upsertOpeningBalanceAction({ customerId: CUSTOMER_ID, productId: PRODUCT_ID, quantity: 120, unitCost: 70 });
    expect(tables.product_opening_balances).toHaveLength(1);
    expect(tables.product_opening_balances[0]).toMatchObject({ quantity: 120, unit_cost: 70 });
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await upsertOpeningBalanceAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      quantity: 100,
      unitCost: 65,
    });
    expect(res.ok).toBe(false);
    expect(tables.product_opening_balances).toHaveLength(0);
  });

  it("★ productId เป็นสินค้าของ tenant อื่น (IDOR ข้าม tenant) → ปฏิเสธ", async () => {
    const res = await upsertOpeningBalanceAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_OTHER_TENANT,
      quantity: 100,
      unitCost: 65,
    });
    expect(res.ok).toBe(false);
    expect(tables.product_opening_balances).toHaveLength(0);
  });

  it("validate ไม่ผ่าน (unit_cost ติดลบ) → ปฏิเสธ ไม่แตะ DB", async () => {
    const res = await upsertOpeningBalanceAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      quantity: 100,
      unitCost: -1,
    });
    expect(res.ok).toBe(false);
    expect(tables.product_opening_balances).toHaveLength(0);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await upsertOpeningBalanceAction({
      customerId: "not-a-uuid",
      productId: PRODUCT_ID,
      quantity: 100,
      unitCost: 65,
    });
    expect(res.ok).toBe(false);
  });
});
