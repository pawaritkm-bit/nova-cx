import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";

/**
 * เทสต์ server actions ของหน้า "ทะเบียนทรัพย์สินถาวร" (/chat-audit/accounting/fixed-assets — เฟส 7 ส่วน V)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/recurring-journal-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD (0.12/0.13):
 *     - guard สโคป: นักบัญชีนอกสโคปทำทะเบียนของลูกค้าอื่นไม่ได้ (ทั้ง upsert/delete/generateNow)
 *     - generateNowAction: บังคับ today = todayIsoThai() (ฝั่ง server) เสมอ — action ไม่มีพารามิเตอร์
 *       รับ "today" จาก client เลยแม้แต่น้อย
 *     - 0.3: occurrence ที่สร้างจากปุ่ม "สร้างค่าเสื่อมตอนนี้" ต้องเป็น draft เสมอ ไม่ auto-confirm
 *     - 0.12: แก้/ลบทะเบียนที่มีประวัติค่าเสื่อมแล้ว → ปฏิเสธผ่าน action ด้วย (ไม่ใช่แค่ data layer)
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

const MOCK_TODAY = "2026-08-09";
const { todayIsoThaiMock } = vi.hoisted(() => ({ todayIsoThaiMock: vi.fn() }));

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

vi.mock("@/lib/accounting/recurring-journal", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/recurring-journal")>();
  return { ...actual, todayIsoThai: () => todayIsoThaiMock() };
});

import {
  upsertAssetAction,
  deleteAssetAction,
  generateNowAction,
  disposeAssetAction,
  undisposeAssetAction,
} from "@/app/chat-audit/accounting/fixed-assets/actions";

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
// fake DB stateful in-memory (pattern เดียวกับ tests/accounting/recurring-journal-actions.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in" | "lte"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.op === "lte") return (row[f.col] as string) <= (f.val as string);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = {
  fixed_assets: Row[];
  fixed_asset_depreciation_log: Row[];
  manual_journal_entries: Row[];
  manual_journal_entry_lines: Row[];
  chart_of_accounts: Row[];
};

const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
  fixed_assets: { deleted_at: null, disposal_date: null, disposal_proceeds: null, disposal_entry_id: null },
  fixed_asset_depreciation_log: { amount: null, message: null, manual_entry_id: null },
  manual_journal_entries: { deleted_at: null, fixed_asset_id: null, doc_no: null, memo: null },
};

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const t: Tables = {
    fixed_assets: [],
    fixed_asset_depreciation_log: [],
    manual_journal_entries: [],
    manual_journal_entry_lines: [],
    chart_of_accounts: TEST_CHART.map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: a.bank ?? false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: "tenant-1",
    })),
  };
  // ★ ต้องเป็น uuid จริง — actions.ts เช็ค isUuid(id) ก่อนแตะ DB เสมอ
  let seq = 1;
  const nextId = () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`;

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
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
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.lte = () => api;
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
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const r of rows as Row[]) {
          const row: Row = { id: nextId(), ...(ROW_DEFAULTS[table] ?? {}), ...r };
          t[table].push(row);
          inserted.push(row);
        }
        return Promise.resolve({ data: { id: inserted[0].id }, error: null });
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
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          t[table].push({ id: nextId(), ...(ROW_DEFAULTS[table] ?? {}), ...r });
        }
      } else if (mode === "update") {
        for (const row of t[table]) if (matchRow(row, filters)) Object.assign(row, payload as Row);
      } else if (mode === "delete") {
        for (let i = t[table].length - 1; i >= 0; i--) if (matchRow(t[table][i], filters)) t[table].splice(i, 1);
      } else {
        data = t[table].filter((r) => matchRow(r, filters)).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  /** จำลอง RPC claim_fixed_asset_depreciation (mirror ตรรกะ SQL migration 0076 — single-threaded อยู่แล้ว
   *  ในเทสต์นี้ ไม่จำลอง for update skip locked — ยืนยันแล้วที่ระดับ SQL จริงโดย agent ก่อนหน้า) */
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "claim_fixed_asset_depreciation") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const today = params.p_today as string;
    const row = t.fixed_assets.find(
      (r) =>
        r.id === params.p_asset_id &&
        r.tenant_id === params.p_tenant_id &&
        !r.deleted_at &&
        r.status === "active" &&
        r.next_dep_date !== null &&
        (r.next_dep_date as string) <= today
    );
    if (!row) return Promise.resolve({ data: { claimed: false }, error: null });

    const remaining = Number(row.cost) - Number(row.salvage_value) - Number(row.accumulated_depreciation);
    if (remaining <= 0) {
      row.next_dep_date = null;
      return Promise.resolve({ data: { claimed: false }, error: null });
    }
    const amount = Math.min(Number(row.monthly_depreciation), remaining);
    const newAccum = Math.round((Number(row.accumulated_depreciation) + amount) * 100) / 100;
    const period = row.next_dep_date as string;
    row.accumulated_depreciation = newAccum;
    row.next_dep_date =
      Math.round((Number(row.cost) - Number(row.salvage_value) - newAccum) * 100) / 100 <= 0 ? null : "2026-09-09";

    return Promise.resolve({
      data: {
        claimed: true,
        period,
        amount,
        customer_id: row.customer_id,
        name: row.name,
        dep_expense_account_code: row.dep_expense_account_code,
        accum_dep_account_code: row.accum_dep_account_code,
      },
      error: null,
    });
  }

  return { db: { from: (name: string) => qb(name as keyof Tables), rpc } as unknown as SupabaseClient, tables: t };
}

const validAssetPayload = {
  name: "คอมพิวเตอร์สำนักงาน",
  assetAccountCode: "1640",
  accumDepAccountCode: "1640.1",
  depExpenseAccountCode: "5375",
  cost: 30000,
  salvageValue: 0,
  usefulLifeMonths: 36,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  todayIsoThaiMock.mockReturnValue(MOCK_TODAY);
  const made = makeFakeDb();
  currentDb = made.db;
  tables = made.tables;
});

// ---------------------------------------------------------------------
// upsertAssetAction
// ---------------------------------------------------------------------
describe("upsertAssetAction", () => {
  it("สร้างทะเบียนใหม่ + ครบถูกต้อง → บันทึกสำเร็จ", async () => {
    const res = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(res.ok).toBe(true);
    expect(tables.fixed_assets).toHaveLength(1);
    expect(tables.fixed_assets[0].next_dep_date).toBe(MOCK_TODAY);
  });

  it("★ cost ≤ 0 → บันทึกไม่สำเร็จ ไม่มี insert เกิดขึ้นเลย", async () => {
    const res = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
      cost: 0,
    });
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets).toHaveLength(0);
  });

  it("★ รหัสบัญชีไม่อยู่ในผัง/หมวดผิด → บันทึกไม่สำเร็จ", async () => {
    const res = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
      depExpenseAccountCode: "1640", // หมวดสินทรัพย์ ไม่ใช่ค่าใช้จ่าย
    });
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets).toHaveLength(0);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets).toHaveLength(0);
  });

  it("แก้ไขทะเบียนที่มี id แต่ customerId ไม่ตรงของเดิม → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(created.ok).toBe(true);
    const res = await upsertAssetAction({
      id: created.id,
      customerId: CUSTOMER_OTHER,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(res.ok).toBe(false);
  });

  it("★ 0.12 มีประวัติค่าเสื่อมแล้ว → แก้ราคาทุนผ่าน action ไม่ได้ (ปฏิเสธชัดเจน)", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(created.ok).toBe(true);
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    tables.fixed_assets[0].accumulated_depreciation = 833.33;

    const res = await upsertAssetAction({
      id: created.id,
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
      cost: 99999,
    });
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].cost).toBe(30000);
  });

  it("ไม่พบทะเบียนเดิม (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    const res = await upsertAssetAction({
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// deleteAssetAction
// ---------------------------------------------------------------------
describe("deleteAssetAction", () => {
  it("ยังไม่มีประวัติค่าเสื่อม → ลบสำเร็จ (soft-delete)", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    const res = await deleteAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(tables.fixed_assets[0].deleted_at).toBeTruthy();
  });

  it("★ 0.12 มีประวัติค่าเสื่อมแล้ว → ลบผ่าน action ไม่ได้ (ปฏิเสธชัดเจน)", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    tables.fixed_assets[0].accumulated_depreciation = 833.33;

    const res = await deleteAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].deleted_at).toBeFalsy();
  });

  it("★ ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].deleted_at).toBeFalsy();
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await deleteAssetAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("customerId ไม่ตรงกับเจ้าของทะเบียนจริง (สวมรอย) → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await deleteAssetAction(created.id, CUSTOMER_OTHER);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].deleted_at).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// generateNowAction — ★ 0.3/0.4 บังคับวันที่ปัจจุบันจริงเสมอ (today จาก todayIsoThai() ฝั่ง server เท่านั้น)
// ---------------------------------------------------------------------
describe("generateNowAction", () => {
  it("★ ทรัพย์สินถึงกำหนดวันนี้พอดี → สร้าง occurrence เป็น draft เสมอ (ไม่ auto-confirm) ด้วยวันที่จาก todayIsoThai()", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY, // next_dep_date = acquisitionDate ตอนสร้างใหม่ (=วันนี้พอดี)
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(todayIsoThaiMock).toHaveBeenCalled();
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft");
    expect(tables.manual_journal_entries[0].doc_date).toBe(MOCK_TODAY);
    expect(tables.manual_journal_entries[0].fixed_asset_id).toBe(created.id);
  });

  it("ทรัพย์สินยังไม่ถึงกำหนด (next_dep_date ในอนาคต) → ไม่สร้างอะไร แจ้งข้อความ ไม่ throw", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: "2026-12-01", // อนาคตเทียบ MOCK_TODAY
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่เรียก generate เลย", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("customerId ไม่ตรงกับเจ้าของทรัพย์สินจริง (สวมรอย) → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    // admin เห็นทุกลูกค้า แต่ customerId ที่ส่งมาไม่ตรงกับเจ้าของทรัพย์สินจริง → ต้องปฏิเสธ
    const res = await generateNowAction(created.id, CUSTOMER_OTHER);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await generateNowAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("★ status='disposed' → generateNow ปฏิเสธ (RPC claim ไม่ติดเพราะ status ไม่ active)", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    tables.fixed_assets[0].status = "disposed";

    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// disposeAssetAction / undisposeAssetAction — เฟส 7 ส่วน W (T60, 0.7/0.8/0.13)
// ---------------------------------------------------------------------
const validDisposePayload = {
  disposalDate: MOCK_TODAY,
  proceeds: 20000,
  cashAccountCode: "1010",
  gainLossAccountCode: "4020",
};

describe("disposeAssetAction", () => {
  it("จำหน่ายสำเร็จ → สร้าง draft JE ผูก fixed_asset_id + update ทะเบียนเป็น disposed", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(res.ok).toBe(true);
    expect(tables.fixed_assets[0].status).toBe("disposed");
    expect(tables.fixed_assets[0].next_dep_date).toBeNull();
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft"); // ★ 0.3 ไม่ auto-confirm
    expect(tables.manual_journal_entries[0].fixed_asset_id).toBe(created.id);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].status).toBe("active");
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("customerId ที่ส่งมาไม่ตรงกับเจ้าของทรัพย์สินจริง (สวมรอย) → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await disposeAssetAction(created.id, CUSTOMER_OTHER, validDisposePayload);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].status).toBe("active");
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await disposeAssetAction("not-a-uuid", CUSTOMER_ID, validDisposePayload);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบทรัพย์สิน (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    const res = await disposeAssetAction(
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      CUSTOMER_ID,
      validDisposePayload
    );
    expect(res.ok).toBe(false);
  });

  it("★ status='disposed' อยู่แล้ว → จำหน่ายซ้ำไม่ได้", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    tables.fixed_assets[0].status = "disposed";

    const res = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(res.ok).toBe(false);
  });
});

describe("undisposeAssetAction", () => {
  it("★ 0.8 JE ยัง draft → ยกเลิกการจำหน่ายสำเร็จ กลับเป็น active", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const disposeRes = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(disposeRes.ok).toBe(true);

    const res = await undisposeAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(tables.fixed_assets[0].status).toBe("active");
    expect(tables.fixed_assets[0].disposal_entry_id).toBeNull();
    expect(tables.manual_journal_entries[0].deleted_at).toBeTruthy();
  });

  it("★ 0.8 JE confirmed ไปแล้ว → ปฏิเสธชัดเจน (ต้องยกเลิกยืนยันก่อน) ไม่แก้อะไร", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const disposeRes = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(disposeRes.ok).toBe(true);
    tables.manual_journal_entries[0].status = "confirmed";

    const res = await undisposeAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("ยกเลิกการยืนยัน");
    expect(tables.fixed_assets[0].status).toBe("disposed"); // ★ ไม่เปลี่ยนแปลงอะไร
    expect(tables.manual_journal_entries[0].deleted_at).toBeFalsy();
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แก้อะไร", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    const disposeRes = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(disposeRes.ok).toBe(true);

    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await undisposeAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].status).toBe("disposed");
  });

  it("customerId ที่ส่งมาไม่ตรงกับเจ้าของทรัพย์สินจริง (สวมรอย) → ปฏิเสธ", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;
    const disposeRes = await disposeAssetAction(created.id, CUSTOMER_ID, validDisposePayload);
    expect(disposeRes.ok).toBe(true);

    const res = await undisposeAssetAction(created.id, CUSTOMER_OTHER);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets[0].status).toBe("disposed");
  });

  it("ทรัพย์สินยัง active (ไม่ได้ถูกจำหน่าย) → ยกเลิกการจำหน่ายไม่ได้", async () => {
    const created = await upsertAssetAction({
      customerId: CUSTOMER_ID,
      acquisitionDate: MOCK_TODAY,
      ...validAssetPayload,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER_ID;

    const res = await undisposeAssetAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await undisposeAssetAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});
