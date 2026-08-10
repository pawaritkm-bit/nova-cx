import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { addMonthsClamped } from "@/lib/accounting/recurring-journal";
import { round2 } from "@/lib/accounting/queries";
import {
  validateFixedAssetInput,
  monthlyDepreciationAmount,
  netBookValue,
  listAssets,
  upsertAsset,
  softDeleteAsset,
  getAssetScope,
  listDepreciationLog,
  listOccurrencesByAssetIds,
  generateOne,
  generateDueDepreciation,
  disposeAsset,
  undisposeAsset,
  type FixedAssetInput,
  type DisposeAssetInput,
} from "@/lib/accounting/fixed-assets";

/**
 * เทสต์ lib/accounting/fixed-assets.ts (เฟส 7 ส่วน V, T58–T59)
 *   - monthlyDepreciationAmount/netBookValue (pure) — งวดสุดท้ายเป็น plug ต้องไม่มีเศษตกค้าง (0.5)
 *   - validateFixedAssetInput ทุก branch ปฏิเสธ (0.11)
 *   - CRUD data layer (mock DB in-memory — pattern เดียวกับ recurring-journal.test.ts) — ล็อกแก้/ลบเมื่อมี
 *     ประวัติค่าเสื่อมแล้ว (0.12)
 *   - generateOne/generateDueDepreciation (0.3/0.4/0.6): draft เสมอ, ล้มเหลวไม่ throw ทั้ง batch, ยังไม่ถึง
 *     รอบ skip เงียบ, ★ แยก claimErr จริง vs "ยังไม่ถึงรอบ" ให้ถูกต้อง (regression guard เทียบ
 *     recurring-journal.test.ts ที่เฟส 6 เคยแก้บั๊กเดียวกัน)
 */

const chartByCode = buildChartByCode(TEST_CHART);

// ---------------------------------------------------------------------
// monthlyDepreciationAmount / netBookValue (pure)
// ---------------------------------------------------------------------
describe("monthlyDepreciationAmount", () => {
  it("หารลงตัวพอดี → ได้ค่าตรงเป๊ะ", () => {
    expect(monthlyDepreciationAmount(10000, 1000, 9)).toBe(1000);
  });

  it("หารไม่ลงตัว → ปัด 2 ตำแหน่ง (ค่าคงที่ต่อเดือน ไม่ใช่ plug — plug คำนวณที่ RPC ฝั่ง DB)", () => {
    expect(monthlyDepreciationAmount(10000, 0, 7)).toBe(1428.57);
  });

  it("useful_life_months ไม่ใช่จำนวนเต็ม/ ≤ 0 → คืน 0 (กัน error หารด้วย 0/ค่าประหลาด)", () => {
    expect(monthlyDepreciationAmount(10000, 0, 0)).toBe(0);
    expect(monthlyDepreciationAmount(10000, 0, -3)).toBe(0);
    expect(monthlyDepreciationAmount(10000, 0, 3.5)).toBe(0);
  });
});

describe("netBookValue", () => {
  it("= ราคาทุน − ค่าเสื่อมสะสม", () => {
    expect(netBookValue({ cost: 10000, accumulatedDepreciation: 3000 })).toBe(7000);
  });
  it("ยังไม่เคย generate เลย (accumulated=0) → NBV = ราคาทุนเต็ม", () => {
    expect(netBookValue({ cost: 10000, accumulatedDepreciation: 0 })).toBe(10000);
  });
});

// ---------------------------------------------------------------------
// validateFixedAssetInput
// ---------------------------------------------------------------------
function baseInput(p: Partial<FixedAssetInput> = {}): FixedAssetInput {
  return {
    name: "คอมพิวเตอร์สำนักงาน",
    assetAccountCode: "1640",
    accumDepAccountCode: "1640.1",
    depExpenseAccountCode: "5375",
    acquisitionDate: "2026-08-01",
    cost: 30000,
    salvageValue: 0,
    usefulLifeMonths: 36,
    ...p,
  };
}

describe("validateFixedAssetInput", () => {
  it("input ถูกต้องครบถ้วน → ผ่าน พร้อมคำนวณ monthlyDepreciation", () => {
    const res = validateFixedAssetInput(baseInput(), chartByCode);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.monthlyDepreciation).toBe(monthlyDepreciationAmount(30000, 0, 36));
    }
  });

  it("ไม่มีชื่อ → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ name: "" }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ name: undefined }), chartByCode).ok).toBe(false);
  });

  it("★ asset_account_code ไม่อยู่ในผัง → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ assetAccountCode: "9999-ไม่มีจริง" }), chartByCode).ok).toBe(false);
  });

  it("★ asset_account_code ไม่ใช่หมวดสินทรัพย์ → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ assetAccountCode: "5375" }), chartByCode).ok).toBe(false);
  });

  it("★ accum_dep_account_code ไม่ใช่หมวดสินทรัพย์ → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ accumDepAccountCode: "5375" }), chartByCode).ok).toBe(false);
  });

  it("★ dep_expense_account_code ไม่ใช่หมวดค่าใช้จ่าย → ปฏิเสธ", () => {
    const res = validateFixedAssetInput(baseInput({ depExpenseAccountCode: "1640" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("★ dep_expense_account_code ไม่อยู่ในผัง → ปฏิเสธ", () => {
    expect(
      validateFixedAssetInput(baseInput({ depExpenseAccountCode: "9999-ไม่มีจริง" }), chartByCode).ok
    ).toBe(false);
  });

  it("cost ≤ 0 → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ cost: 0 }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ cost: -100 }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ cost: "abc" }), chartByCode).ok).toBe(false);
  });

  it("salvage_value < 0 → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ salvageValue: -1 }), chartByCode).ok).toBe(false);
  });

  it("★ salvage_value >= cost → ปฏิเสธ (0.11 salvage ต้องน้อยกว่า cost เป๊ะ)", () => {
    expect(validateFixedAssetInput(baseInput({ cost: 1000, salvageValue: 1000 }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ cost: 1000, salvageValue: 1500 }), chartByCode).ok).toBe(false);
  });

  it("useful_life_months ≤ 0 หรือไม่ใช่จำนวนเต็ม → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ usefulLifeMonths: 0 }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ usefulLifeMonths: -5 }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ usefulLifeMonths: 3.5 }), chartByCode).ok).toBe(false);
  });

  it("acquisition_date ผิดรูปแบบ → ปฏิเสธ", () => {
    expect(validateFixedAssetInput(baseInput({ acquisitionDate: "01/08/2026" }), chartByCode).ok).toBe(false);
    expect(validateFixedAssetInput(baseInput({ acquisitionDate: "" }), chartByCode).ok).toBe(false);
  });

  it("★ acquisition_date ผ่าน regex แต่ไม่มีวันที่นี้จริงในปฏิทิน → ปฏิเสธ", () => {
    for (const bad of ["2026-02-30", "2026-04-31", "2026-13-01"]) {
      const res = validateFixedAssetInput(baseInput({ acquisitionDate: bad }), chartByCode);
      expect(res.ok, `acquisitionDate="${bad}" ควรถูกปฏิเสธ`).toBe(false);
      if (!res.ok) expect(res.message).toContain("วันที่ซื้อไม่ถูกต้อง");
    }
  });

  it("วันที่ปกติ (รวมปีอธิกสุรทิน 29 ก.พ.) ยังผ่านเหมือนเดิม", () => {
    expect(validateFixedAssetInput(baseInput({ acquisitionDate: "2024-02-29" }), chartByCode).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB in-memory) — pattern เดียวกับ tests/accounting/recurring-journal.test.ts
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

/** ★ ใช้จำลอง DB error ชั่วคราวที่ precheck ตรวจไม่พบ (เทสต์ compensating rollback ชั้น 2 ของ generateOne
 *   และเทสต์ softDeleteManualEntry ล้มเหลวของ undisposeAsset) — consume ครั้งเดียวแล้วลบทิ้ง (ครั้งต่อไป
 *   ตารางเดียวกัน/mode เดียวกันทำงานปกติ) ไม่กระทบเทสต์เดิมที่ไม่ได้ส่ง forceErrors มา (default ว่างเปล่า)
 *   ★ คืน reference ของ array เดิม (ไม่ copy) ให้เทสต์ push เพิ่มได้เองระหว่างทาง — จำเป็นสำหรับเคสที่ต้อง
 *   บังคับ error เฉพาะ "ครั้งถัดไป" ของ table+mode นั้น ๆ (หลังผ่าน setup call อื่นที่ table+mode เดียวกัน
 *   มาก่อนแล้ว เช่น disposeAsset ก็ update manual_journal_entries เหมือนกันก่อนถึง undisposeAsset) */
type ForceError = { table: keyof Tables; mode: "insert" | "update" | "delete" | "select"; message: string };

function makeFakeDb(
  chart: ChartAccount[] = TEST_CHART,
  opts: { forceErrors?: ForceError[] } = {}
): { db: SupabaseClient; tables: Tables; forceErrors: ForceError[] } {
  const forceErrors: ForceError[] = opts.forceErrors ?? [];
  function consumeForceError(table: keyof Tables, mode: string): string | null {
    const idx = forceErrors.findIndex((f) => f.table === table && f.mode === mode);
    if (idx === -1) return null;
    const [f] = forceErrors.splice(idx, 1);
    return f.message;
  }
  const tables: Tables = {
    fixed_assets: [],
    fixed_asset_depreciation_log: [],
    manual_journal_entries: [],
    manual_journal_entry_lines: [],
    chart_of_accounts: chart.map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: a.bank ?? false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: "t1",
    })),
  };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;

  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    fixed_assets: {
      deleted_at: null,
      disposal_date: null,
      disposal_proceeds: null,
      disposal_entry_id: null,
    },
    fixed_asset_depreciation_log: { amount: null, message: null, manual_entry_id: null },
    manual_journal_entries: { deleted_at: null, fixed_asset_id: null, doc_no: null, memo: null },
  };

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown;
    let orderCol: string | null = null;
    let orderAsc = true;
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
    api.lte = (c: string, v: unknown) => {
      filters.push({ col: c, op: "lte", val: v });
      return api;
    };
    api.order = (c: string, opts?: { ascending?: boolean }) => {
      orderCol = c;
      orderAsc = opts?.ascending !== false;
      return api;
    };
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

    function applyOrder(rows: Row[]): Row[] {
      if (!orderCol) return rows;
      const col = orderCol;
      const sorted = [...rows].sort((a, b) => {
        const av = a[col] as string;
        const bv = b[col] as string;
        if (av === bv) return 0;
        return av < bv ? -1 : 1;
      });
      return orderAsc ? sorted : sorted.reverse();
    }

    api.maybeSingle = () => {
      const forced = consumeForceError(table, mode);
      if (forced) return Promise.resolve({ data: null, error: { message: forced } });
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const r of rows as Row[]) {
          const row: Row = { id: nextId(table), ...(ROW_DEFAULTS[table] ?? {}), ...r };
          tables[table].push(row);
          inserted.push(row);
        }
        return Promise.resolve({ data: { id: inserted[0].id }, error: null });
      }
      if (mode === "update") {
        const row = tables[table].find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      const row = tables[table].find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };

    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      const forced = consumeForceError(table, mode);
      if (forced) return Promise.resolve({ data: null, error: { message: forced } }).then(onF);
      let data: unknown = null;
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          tables[table].push({ id: nextId(table), ...(ROW_DEFAULTS[table] ?? {}), ...r });
        }
        data = null;
      } else if (mode === "update") {
        for (const row of tables[table]) if (matchRow(row, filters)) Object.assign(row, payload as Row);
        data = null;
      } else if (mode === "delete") {
        for (let i = tables[table].length - 1; i >= 0; i--) {
          if (matchRow(tables[table][i], filters)) tables[table].splice(i, 1);
        }
        data = null;
      } else {
        data = applyOrder(tables[table].filter((r) => matchRow(r, filters))).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  /** จำลอง RPC claim_fixed_asset_depreciation (mirror ตรรกะ SQL ใน migration 0076 เป๊ะ — รวม plug งวดสุดท้าย
   *  0.5 — for update skip locked ไม่จำลอง เพราะเทสต์นี้ single-threaded อยู่แล้ว ยืนยันแล้วที่ระดับ SQL จริง) */
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "claim_fixed_asset_depreciation") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const today = params.p_today as string;
    const row = tables.fixed_assets.find(
      (r) =>
        r.id === params.p_asset_id &&
        r.tenant_id === params.p_tenant_id &&
        !r.deleted_at &&
        r.status === "active" &&
        r.next_dep_date !== null &&
        (r.next_dep_date as string) <= today
    );
    if (!row) return Promise.resolve({ data: { claimed: false }, error: null });

    const remaining = round2(
      Number(row.cost) - Number(row.salvage_value) - Number(row.accumulated_depreciation)
    );
    if (remaining <= 0) {
      row.next_dep_date = null;
      return Promise.resolve({ data: { claimed: false }, error: null });
    }

    const amount = Math.min(Number(row.monthly_depreciation), remaining);
    const newAccum = round2(Number(row.accumulated_depreciation) + amount);
    const period = row.next_dep_date as string;
    let newNext: string | null;
    if (round2(Number(row.cost) - Number(row.salvage_value) - newAccum) <= 0) {
      newNext = null;
    } else {
      newNext = addMonthsClamped(period, 1);
    }
    row.accumulated_depreciation = newAccum;
    row.next_dep_date = newNext;

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

  return {
    db: { from: (t: string) => qb(t as keyof Tables), rpc } as unknown as SupabaseClient,
    tables,
    forceErrors,
  };
}

const TENANT = "t1";
const CUSTOMER = "c1";

const validInput: FixedAssetInput = {
  name: "คอมพิวเตอร์สำนักงาน",
  assetAccountCode: "1640",
  accumDepAccountCode: "1640.1",
  depExpenseAccountCode: "5375",
  acquisitionDate: "2026-08-01",
  cost: 30000,
  salvageValue: 0,
  usefulLifeMonths: 36,
};

describe("upsertAsset (สร้างใหม่)", () => {
  it("input ถูกต้อง → สร้างสำเร็จ next_dep_date = acquisition_date เสมอ (0.2)", async () => {
    const { db, tables } = makeFakeDb();
    const res = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    expect(res.ok).toBe(true);
    expect(tables.fixed_assets).toHaveLength(1);
    const a = tables.fixed_assets[0];
    expect(a.next_dep_date).toBe("2026-08-01");
    expect(a.status).toBe("active");
    expect(a.accumulated_depreciation).toBe(0);
    expect(a.monthly_depreciation).toBe(monthlyDepreciationAmount(30000, 0, 36));
  });

  it("cost ≤ 0 → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await upsertAsset(db, TENANT, CUSTOMER, { ...validInput, cost: 0 }, chartByCode);
    expect(res.ok).toBe(false);
    expect(tables.fixed_assets).toHaveLength(0);
  });
});

describe("upsertAsset (แก้ไข)", () => {
  it("ยังไม่มีประวัติค่าเสื่อม → แก้ raw ทุกฟิลด์ได้อิสระ", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");

    const res = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, name: "คอมพิวเตอร์ใหม่", cost: 40000, usefulLifeMonths: 48 },
      chartByCode,
      created.id
    );
    expect(res.ok).toBe(true);
    const a = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(a.name).toBe("คอมพิวเตอร์ใหม่");
    expect(a.cost).toBe(40000);
    expect(a.useful_life_months).toBe(48);
  });

  it("★ 0.12 มีประวัติค่าเสื่อมแล้ว (accumulated_depreciation>0) → แก้ cost/salvage/life/วันที่ซื้อไม่ได้ (ปฏิเสธชัดเจน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets.find((r) => r.id === created.id)!.accumulated_depreciation = 833.33;

    const res = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, cost: 99999 },
      chartByCode,
      created.id
    );
    expect(res.ok).toBe(false);
    const a = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(a.cost).toBe(30000); // ไม่ถูกแก้

    const res2 = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, usefulLifeMonths: 99 },
      chartByCode,
      created.id
    );
    expect(res2.ok).toBe(false);

    const res3 = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, acquisitionDate: "2026-01-01" },
      chartByCode,
      created.id
    );
    expect(res3.ok).toBe(false);
  });

  it("★ 0.12 มีประวัติค่าเสื่อมแล้ว → ยังแก้ชื่อ/รหัสบัญชีได้ปกติ (ไม่แก้ตัวเลข)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets.find((r) => r.id === created.id)!.accumulated_depreciation = 833.33;

    const res = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, name: "คอมพิวเตอร์สำนักงาน (เปลี่ยนชื่อ)", depExpenseAccountCode: "5344" },
      chartByCode,
      created.id
    );
    expect(res.ok).toBe(true);
    const a = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(a.name).toBe("คอมพิวเตอร์สำนักงาน (เปลี่ยนชื่อ)");
    expect(a.dep_expense_account_code).toBe("5344");
    expect(a.cost).toBe(30000);
  });

  it("ลูกค้าไม่ตรงกับทรัพย์สินเดิม → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const res = await upsertAsset(db, TENANT, "other-customer", validInput, chartByCode, created.id);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบทรัพย์สิน (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode, "not-exist-id");
    expect(res.ok).toBe(false);
  });

  it("★ status='disposed' → แก้ไม่ได้ (0.7)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets.find((r) => r.id === created.id)!.status = "disposed";

    const res = await upsertAsset(db, TENANT, CUSTOMER, { ...validInput, name: "ชื่อใหม่" }, chartByCode, created.id);
    expect(res.ok).toBe(false);
  });
});

describe("listAssets / getAssetScope", () => {
  it("โหลดทะเบียนครบ เรียงล่าสุดก่อน", async () => {
    const { db } = makeFakeDb();
    await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    const list = await listAssets(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(1);
    expect(list[0].customerId).toBe(CUSTOMER);
    expect(list[0].status).toBe("active");
  });

  it("getAssetScope คืน customerId + accumulatedDepreciation + status", async () => {
    const { db } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const scope = await getAssetScope(db, TENANT, created.id);
    expect(scope?.customerId).toBe(CUSTOMER);
    expect(scope?.accumulatedDepreciation).toBe(0);
    expect(scope?.status).toBe("active");
  });

  it("ไม่พบ → คืน null", async () => {
    const { db } = makeFakeDb();
    expect(await getAssetScope(db, TENANT, "not-exist")).toBeNull();
  });
});

describe("softDeleteAsset", () => {
  it("ยังไม่มีประวัติค่าเสื่อม → ลบสำเร็จ (soft-delete)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const res = await softDeleteAsset(db, TENANT, created.id);
    expect(res.ok).toBe(true);
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.deleted_at).toBeTruthy();
  });

  it("★ 0.12 มีประวัติค่าเสื่อมแล้ว → ลบไม่ได้ (ปฏิเสธชัดเจน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets.find((r) => r.id === created.id)!.accumulated_depreciation = 833.33;

    const res = await softDeleteAsset(db, TENANT, created.id);
    expect(res.ok).toBe(false);
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.deleted_at).toBeFalsy();
  });

  it("ลบแล้วลิสต์ไม่เจออีก", async () => {
    const { db } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    await softDeleteAsset(db, TENANT, created.id);
    const list = await listAssets(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(0);
  });

  it("★ จำหน่ายไปแล้ว (status='disposed') แม้ accumulated_depreciation=0 → ลบไม่ได้ (ปฏิเสธชัดเจน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    // จำหน่ายก่อนมีค่าเสื่อมเลย (accumulated_depreciation ยังเป็น 0) — edge case ที่เคยหลุด guard เดิม
    tables.fixed_assets.find((r) => r.id === created.id)!.status = "disposed";

    const res = await softDeleteAsset(db, TENANT, created.id);
    expect(res.ok).toBe(false);
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.deleted_at).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// orchestrator — generateOne / generateDueDepreciation (T59 ★ จุดสำคัญที่สุดของเฟส 7-V)
// ---------------------------------------------------------------------
describe("generateOne", () => {
  it("★ 0.3 สำเร็จ → สร้าง occurrence เป็น draft เสมอ (ไม่ auto-confirm) + ผูก fixed_asset_id + log 'generated'", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("generated");
    if (res.status !== "generated") return;

    const entry = tables.manual_journal_entries.find((e) => e.id === res.manualEntryId)!;
    expect(entry.status).toBe("draft");
    expect(entry.fixed_asset_id).toBe(created.id);
    expect(entry.doc_date).toBe("2026-08-01");

    const log = tables.fixed_asset_depreciation_log.find((l) => l.status === "generated");
    expect(log).toBeTruthy();
    expect(log!.manual_entry_id).toBe(res.manualEntryId);
    expect(log!.amount).toBe(monthlyDepreciationAmount(30000, 0, 36));
  });

  it("ยังไม่ถึงรอบ (next_dep_date > today) → skip เงียบ ๆ ไม่เขียน log", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, { ...validInput, acquisitionDate: "2026-09-01" }, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(0);
    expect(tables.fixed_asset_depreciation_log).toHaveLength(0);
  });

  it("★ status='disposed' → skip (ไม่ claim)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    tables.fixed_assets[0].status = "disposed";

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("skipped");
  });

  it("★ ตัดค่าเสื่อมครบแล้ว (next_dep_date=null) → skip", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    tables.fixed_assets[0].next_dep_date = null;
    tables.fixed_assets[0].accumulated_depreciation = 30000;

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("skipped");
  });

  it("★ 0.8 บัญชีถูกลบไปแล้วหลังตั้งทะเบียน → claim สำเร็จแต่ insert ล้ม → log 'failed' พร้อมเหตุผล ไม่ throw", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    // จำลองบัญชีค่าเสื่อมราคาถูกลบออกจากผังหลังตั้งทะเบียนแล้ว — chartByCode ที่ cron/generateOne ใช้ ณ
    //   ตอน generate จะเป็นสแนปช็อตที่โหลดจาก DB ใหม่ (ไม่มีรหัสนี้แล้ว) ต่างจาก chartByCode ที่ตั้งทะเบียนไว้
    const brokenChartByCode = { ...chartByCode };
    delete brokenChartByCode["5375"];

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", brokenChartByCode);
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.message).toBeTruthy();
    expect(tables.manual_journal_entries).toHaveLength(0);
    const log = tables.fixed_asset_depreciation_log.find((l) => l.status === "failed");
    expect(log).toBeTruthy();

    // ★★★ บั๊กร้ายแรง (code review) — ต้องไม่มีการ commit accumulated_depreciation/next_dep_date ใด ๆ
    //   ทั้งที่ไม่มี manual JE รองรับงวดนี้เลย (precheck ต้องกันไว้ก่อนเรียก RPC เลย ไม่ใช่ claim ไปแล้วค่อย
    //   พังทีหลัง) — ก่อนแก้บั๊กนี้ assertion นี้ล้ม (accumulated_depreciation เพิ่มไปแล้ว/next_dep_date
    //   เลื่อนไปแล้วทั้งที่สร้าง JE ไม่สำเร็จ กู้คืนผ่าน UI ไม่ได้อีก)
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.accumulated_depreciation).toBe(0);
    expect(row.next_dep_date).toBe("2026-08-01");
  });

  it("★★★ layer 2: upsertManualEntry ล้มเหลวด้วยเหตุอื่นที่ precheck ตรวจไม่พบ (เช่น DB error ชั่วคราวตอน insert หัว JE) หลัง claim สำเร็จแล้ว → compensating rollback คืน accumulated_depreciation/next_dep_date กลับเป็นค่าก่อน claim (ไม่ใช่ค่าที่ claim เพิ่งเขียนไปทับ)", async () => {
    const { db, tables } = makeFakeDb(TEST_CHART, {
      forceErrors: [
        { table: "manual_journal_entries", mode: "insert", message: "DB error ชั่วคราว (จำลองเทสต์)" },
      ],
    });
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    // ★ precheck ผ่านปกติ (chartByCode ปกติ ไม่มีรหัสหาย) — เจตนาบังคับให้ล้มเหลว "หลัง" claim สำเร็จแล้ว
    //   ด้วยเหตุอื่น (ไม่ใช่รหัสบัญชีถูกลบ) เพื่อยืนยันว่า compensating rollback (ชั้นที่ 2) ทำงานจริง
    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("failed");
    expect(tables.manual_journal_entries).toHaveLength(0);

    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.accumulated_depreciation).toBe(0); // ★ ต้อง revert กลับเป็นก่อน claim
    expect(row.next_dep_date).toBe("2026-08-01"); // ★ ต้อง revert next_dep_date กลับเป็นก่อน claim เช่นกัน

    const log = tables.fixed_asset_depreciation_log.find((l) => l.status === "failed");
    expect(log).toBeTruthy();

    // ★ generate ใหม่หลัง rollback ต้อง retry ได้ปกติ (ยืนยันว่า state คืนกลับสมบูรณ์ ไม่ใช่แค่ค่าตรงเผื่อโชค)
    const retry = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(retry.status).toBe("generated");
  });

  // -------------------------------------------------------------------
  // ★★★ จุดเสี่ยงสูงสุดของเฟสนี้ — แยก RPC claim error จริง ออกจาก "ยังไม่ถึงรอบ" (0.4)
  //   ห้ามพลาดซ้ำแบบที่ recurring-journal.ts::generateOne เคยพลาดมาก่อนแล้วถูกแก้
  // -------------------------------------------------------------------
  it("★ RPC claim error จริง (เช่น migration ไม่ครบ/DB connection พัง) → status:'failed' + log 'failed' พร้อมเหตุผล (ไม่ใช่ skipped เงียบ ๆ)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    // จำลอง RPC error จริง (claimErr ไม่ใช่ null) — ต่างจาก "ยังไม่ถึงรอบ" ที่ error=null แต่ claimed=false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc = (fn: string) => {
      if (fn === "claim_fixed_asset_depreciation") {
        return Promise.resolve({ data: null, error: { message: 'relation "fixed_assets" does not exist' } });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    };

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.message).toContain("does not exist");
    expect(tables.manual_journal_entries).toHaveLength(0);

    const log = tables.fixed_asset_depreciation_log.find((l) => l.status === "failed");
    expect(log).toBeTruthy();
    expect(log!.message).toContain("does not exist");
    expect(log!.period).toBe("2026-08-01"); // ไม่มี period จาก claim (error ก่อนถึงจุดนั้น) → ใช้ today แทน
  });

  it("★ regression guard: ยังไม่ถึงรอบจริง (claimErr=null, claimData.claimed=false) → ยัง skip เงียบเหมือนเดิม ไม่ log (ต้องไม่ปนกับกรณี RPC error ด้านบน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, acquisitionDate: "2026-09-01" },
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);
    expect(res.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(0);
    expect(tables.fixed_asset_depreciation_log).toHaveLength(0);
  });
});

describe("generateDueDepreciation", () => {
  it("★ ทรัพย์สินถึงกำหนดหลายชิ้น บางชิ้นล้มเหลว → ที่เหลือยัง generate สำเร็จ (ไม่ throw ทั้ง batch)", async () => {
    const { db, tables } = makeFakeDb();
    const ok1 = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    const ok2 = await upsertAsset(db, TENANT, CUSTOMER, { ...validInput, name: "อุปกรณ์ B" }, chartByCode);
    if (!ok1.ok || !ok2.ok) throw new Error("setup failed");
    for (const a of tables.fixed_assets) a.customer_id = CUSTOMER;

    // ทำให้ทรัพย์สินที่ 2 ล้มเหลว (บัญชีค่าเสื่อมสะสมถูกลบไปแล้ว)
    tables.fixed_assets.find((a) => a.id === ok2.id)!.accum_dep_account_code = "9999-ไม่มีอยู่จริง";

    const summary = await generateDueDepreciation(db, TENANT, "2026-08-01", chartByCode);
    expect(summary.scanned).toBe(2);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft");
  });

  it("ทรัพย์สินยังไม่ถึงรอบ → ไม่อยู่ใน candidate เลย (ไม่ scan)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, { ...validInput, acquisitionDate: "2026-12-01" }, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const summary = await generateDueDepreciation(db, TENANT, "2026-08-01", chartByCode);
    expect(summary.scanned).toBe(0);
    expect(summary.generated).toBe(0);
  });

  it("ทรัพย์สิน status='disposed' → ไม่อยู่ใน candidate", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    tables.fixed_assets[0].status = "disposed";

    const summary = await generateDueDepreciation(db, TENANT, "2026-08-01", chartByCode);
    expect(summary.scanned).toBe(0);
  });

  it("★★ รัน generate ซ้ำวันเดียวกันทันที (จำลอง cron retry/กดปุ่มซ้ำ) → ไม่สร้างซ้ำสอง (claim ไม่ติดครั้งที่ 2)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const first = await generateDueDepreciation(db, TENANT, "2026-08-01", chartByCode);
    expect(first.scanned).toBe(1);
    expect(first.generated).toBe(1);
    expect(tables.manual_journal_entries).toHaveLength(1);

    const second = await generateDueDepreciation(db, TENANT, "2026-08-01", chartByCode);
    expect(second.scanned).toBe(0);
    expect(second.generated).toBe(0);
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.fixed_asset_depreciation_log.filter((l) => l.status === "generated")).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // ★★★ 0.5 — งวดสุดท้ายเป็น plug ต้องไม่มีเศษสตางค์ตกค้าง (จุดเสี่ยงสูงสุดอีกจุดของเฟสนี้)
  // -------------------------------------------------------------------
  it("★★★ 0.5 หารไม่ลงตัว (cost=10000,salvage=0,useful_life=7) → generate ครบ 7 งวด ผลรวมค่าเสื่อมสะสม = 10000.00 เป๊ะ ไม่มีเศษตกค้าง งวดสุดท้ายได้ plug ไม่ใช่ยอดคงที่", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, cost: 10000, salvageValue: 0, usefulLifeMonths: 7 },
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    expect(row.monthly_depreciation).toBe(1428.57);

    // ★ 10000/7 ปัด 2 ตำแหน่งไม่ลงตัวเป๊ะ (1428.57 ซ้ำ 7 ครั้ง = 9999.99 ไม่ใช่ 10000.00) — RPC ("amount =
    //   min(monthly, remaining)") อาจต้องใช้มากกว่า usefulLifeMonths งวดกว่าจะหมดเศษ (ยอมรับได้ตามการ
    //   ออกแบบ 0.5 — "ผลรวมสุดท้ายเท่ากับ cost−salvage เป๊ะ" ไม่ได้ระบุว่าต้องจบภายในจำนวนงวดตาม
    //   useful_life_months เป๊ะเมื่อหารไม่ลงตัว) — วนจน skip โดยจำกัดเพดานกันลูปไม่จบถ้ามีบั๊ก
    const today = "2026-08-01";
    const amounts: number[] = [];
    const SAFETY_CAP = 20;
    for (let i = 1; i <= SAFETY_CAP; i++) {
      const res = await generateOne(db, TENANT, created.id, today, chartByCode);
      if (res.status === "skipped") break;
      expect(res.status, `งวดที่ ${i} ไม่ควร failed`).toBe("generated");
      const log = tables.fixed_asset_depreciation_log
        .filter((l) => l.status === "generated")
        .sort((a, b) => ((a.created_at as string) < (b.created_at as string) ? -1 : 1));
      amounts.push(Number(log[log.length - 1].amount));
      // จำลอง advance เดือนถัดไป (ถ้ายังมี next_dep_date) → set กลับเป็น <= today เพื่อ claim รอบถัดไปได้ทันที
      if (row.next_dep_date) row.next_dep_date = today;
    }

    expect(amounts.length).toBeGreaterThan(0);
    // ★ งวดสุดท้าย (plug) ต้องน้อยกว่าหรือเท่ากับยอดคงที่ต่อเดือนเสมอ (ไม่มีทางเกิน monthly_depreciation)
    expect(amounts[amounts.length - 1]).toBeLessThanOrEqual(1428.57);

    const total = round2(amounts.reduce((s, a) => s + a, 0));
    expect(total).toBe(10000); // ★ ผลรวมทั้งหมดต้องเท่ากับ cost−salvage เป๊ะ ไม่มีเศษตกค้าง

    expect(row.accumulated_depreciation).toBe(10000);
    expect(row.next_dep_date).toBeNull();
    expect(row.status).toBe("active"); // ★ 0.6 ตัดค่าเสื่อมครบแล้วแต่ยัง active (ยังไม่จำหน่าย)

    // งวดถัดไป (เกินแล้ว) → ต้อง skip ไม่สร้างซ้ำ
    const extra = await generateOne(db, TENANT, created.id, today, chartByCode);
    expect(extra.status).toBe("skipped");
  });
});

describe("listDepreciationLog / listOccurrencesByAssetIds", () => {
  it("listDepreciationLog คืนประวัติของทรัพย์สินนั้น เรียงล่าสุดก่อน", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);

    const log = await listDepreciationLog(db, TENANT, created.id);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("generated");
  });

  it("listOccurrencesByAssetIds คืน occurrence ที่ผูกทรัพย์สิน + สถานะ draft", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    await generateOne(db, TENANT, created.id, "2026-08-01", chartByCode);

    const occ = await listOccurrencesByAssetIds(db, TENANT, CUSTOMER, [created.id]);
    expect(occ).toHaveLength(1);
    expect(occ[0].status).toBe("draft");
    expect(occ[0].assetId).toBe(created.id);
  });

  it("assetIds ว่าง → คืน [] ทันที ไม่ query", async () => {
    const { db } = makeFakeDb();
    expect(await listOccurrencesByAssetIds(db, TENANT, CUSTOMER, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// disposeAsset / undisposeAsset (T60, เฟส 7 ส่วน W, 0.7/0.8)
// ---------------------------------------------------------------------
function baseDisposeInput(p: Partial<DisposeAssetInput> = {}): DisposeAssetInput {
  return {
    disposalDate: "2026-08-15",
    proceeds: 20000,
    cashAccountCode: "1010",
    gainLossAccountCode: "4020",
    ...p,
  };
}

describe("disposeAsset", () => {
  it("★ proceeds > NBV → กำไร (Cr gainLossAccountCode) สมดุลถูกต้อง + update ทะเบียนครบ", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    row.accumulated_depreciation = 10000; // NBV = 30000 - 10000 = 20000

    const res = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ proceeds: 25000 }), // gainLoss = 25000 - 20000 = +5000 (กำไร)
      chartByCode
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(row.status).toBe("disposed");
    expect(row.disposal_date).toBe("2026-08-15");
    expect(row.disposal_proceeds).toBe(25000);
    expect(row.next_dep_date).toBeNull();
    expect(row.disposal_entry_id).toBeTruthy();

    const entry = tables.manual_journal_entries.find((e) => e.id === row.disposal_entry_id)!;
    expect(entry.status).toBe("draft"); // ★ 0.3 ห้าม auto-confirm
    expect(entry.fixed_asset_id).toBe(created.id);

    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === entry.id);
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit); // ★ ต้องสมดุลเสมอ

    const gainLine = lines.find((l) => l.account_code === "4020")!;
    expect(gainLine.credit).toBe(5000);
    expect(gainLine.debit).toBe(0);
    const assetLine = lines.find((l) => l.account_code === validInput.assetAccountCode)!;
    expect(assetLine.credit).toBe(30000);
    const accumLine = lines.find((l) => l.account_code === validInput.accumDepAccountCode)!;
    expect(accumLine.debit).toBe(10000);
    const cashLine = lines.find((l) => l.account_code === "1010")!;
    expect(cashLine.debit).toBe(25000);
  });

  it("★ proceeds < NBV → ขาดทุน (Dr gainLossAccountCode) สมดุลถูกต้อง", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    row.accumulated_depreciation = 10000; // NBV = 20000

    const res = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ proceeds: 15000 }), // gainLoss = 15000 - 20000 = -5000 (ขาดทุน)
      chartByCode
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const entry = tables.manual_journal_entries.find((e) => e.id === row.disposal_entry_id)!;
    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === entry.id);
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);

    const lossLine = lines.find((l) => l.account_code === "4020")!;
    expect(lossLine.debit).toBe(5000);
    expect(lossLine.credit).toBe(0);
  });

  it("★ proceeds = NBV เป๊ะ → ไม่มี gain/loss leg เลย (ไม่ใช่ leg ยอด 0) แต่ยังสมดุล", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    row.accumulated_depreciation = 10000; // NBV = 20000

    const res = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ proceeds: 20000 }), // gainLoss = 0 เป๊ะ
      chartByCode
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const entry = tables.manual_journal_entries.find((e) => e.id === row.disposal_entry_id)!;
    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === entry.id);
    expect(lines.find((l) => l.account_code === "4020")).toBeUndefined();
    expect(lines).toHaveLength(3); // accum + cash + asset (ไม่มี gain/loss leg)
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);
  });

  it("★ accumulated_depreciation=0 (ยังไม่เคย generate เลย) → NBV=cost เต็ม ไม่มีขาค่าเสื่อมสะสม", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER; // accumulated_depreciation = 0 (ค่าเริ่มต้นตอนสร้าง)

    const res = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ proceeds: 32000 }), // gainLoss = 32000 - 30000 = +2000
      chartByCode
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const entry = tables.manual_journal_entries.find((e) => e.id === row.disposal_entry_id)!;
    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === entry.id);
    expect(lines.find((l) => l.account_code === validInput.accumDepAccountCode)).toBeUndefined();
    const gainLine = lines.find((l) => l.account_code === "4020")!;
    expect(gainLine.credit).toBe(2000);
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);
  });

  it("ลูกค้าไม่ตรงกับทรัพย์สินเดิม → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await disposeAsset(db, TENANT, "other-customer", created.id, baseDisposeInput(), chartByCode);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("★ status='disposed' อยู่แล้ว → จำหน่ายซ้ำไม่ได้", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;
    tables.fixed_assets[0].status = "disposed";

    const res = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput(), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบทรัพย์สิน → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await disposeAsset(db, TENANT, CUSTOMER, "not-exist", baseDisposeInput(), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("รหัสบัญชีที่รับเงิน/กำไร-ขาดทุนไม่อยู่ในผัง → ปฏิเสธผ่าน validate ของ upsertManualEntry", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ gainLossAccountCode: "9999-ไม่มีจริง" }),
      chartByCode
    );
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });
});

describe("undisposeAsset", () => {
  it("★ 0.8 สำเร็จเมื่อ disposal JE ยัง draft → กลับเป็น active + soft-delete JE + next_dep_date คำนวณใหม่ถูกต้อง", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, acquisitionDate: "2026-01-01", usefulLifeMonths: 12 },
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;

    // generate 2 งวดค่าเสื่อมก่อนจำหน่าย (ม.ค. + ก.พ.)
    await generateOne(db, TENANT, created.id, "2026-01-01", chartByCode);
    row.next_dep_date = "2026-02-01"; // จำลอง advance เดือนถัดไป
    await generateOne(db, TENANT, created.id, "2026-02-01", chartByCode);

    const disposeRes = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ disposalDate: "2026-03-01", proceeds: 28000 }),
      chartByCode
    );
    expect(disposeRes.ok).toBe(true);
    expect(row.status).toBe("disposed");
    const entryId = row.disposal_entry_id as string;

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(true);

    expect(row.status).toBe("active");
    expect(row.disposal_date).toBeNull();
    expect(row.disposal_proceeds).toBeNull();
    expect(row.disposal_entry_id).toBeNull();
    // ★ 0.8: next_dep_date = เดือนถัดไปจากงวดค่าเสื่อมที่ generate ล่าสุดจริง (ก.พ. 2026 → มี.ค. 2026)
    expect(row.next_dep_date).toBe("2026-03-01");

    const entry = tables.manual_journal_entries.find((e) => e.id === entryId)!;
    expect(entry.deleted_at).toBeTruthy(); // ★ soft-delete JE ที่ยัง draft
  });

  it("★ 0.8 ปฏิเสธชัดเจนเมื่อ disposal JE confirmed ไปแล้ว (ต้องยกเลิกยืนยันก่อน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;

    const disposeRes = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput(), chartByCode);
    expect(disposeRes.ok).toBe(true);
    const entryId = row.disposal_entry_id as string;
    tables.manual_journal_entries.find((e) => e.id === entryId)!.status = "confirmed";

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(false);
    if (!undoRes.ok) expect(undoRes.message).toContain("ยกเลิกการยืนยัน");
    // ★ ยังคง disposed อยู่ ไม่เปลี่ยนแปลงอะไร
    expect(row.status).toBe("disposed");
    expect(tables.manual_journal_entries.find((e) => e.id === entryId)!.deleted_at).toBeFalsy();
  });

  it("★ 0.8 ยังไม่เคย generate ค่าเสื่อมเลยก่อนจำหน่าย (accumulated=0) → undo แล้ว next_dep_date กลับเป็น acquisition_date เดิม", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER; // accumulated_depreciation=0, next_dep_date=acquisition_date เดิม (2026-08-01)

    const disposeRes = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput(), chartByCode);
    expect(disposeRes.ok).toBe(true);
    expect(row.next_dep_date).toBeNull(); // ★ 0.7 disposeAsset เคลียร์ next_dep_date=null เสมอ

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(true);
    expect(row.next_dep_date).toBe("2026-08-01"); // ★ กลับไป acquisition_date เดิม (ยังไม่เคย generate)
  });

  it("★ 0.6 ตัดค่าเสื่อมครบแล้วก่อนจำหน่าย (remaining<=0) → undo แล้ว next_dep_date ยังเป็น null เหมือนก่อนจำหน่าย", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    row.accumulated_depreciation = 30000; // ตัดค่าเสื่อมครบแล้ว (cost - salvage = 30000)
    row.next_dep_date = null;

    const disposeRes = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput({ proceeds: 0 }), chartByCode);
    expect(disposeRes.ok).toBe(true);

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(true);
    expect(row.next_dep_date).toBeNull();
  });

  it("ทรัพย์สินยัง active (ไม่ได้ถูกจำหน่าย) → ยกเลิกการจำหน่ายไม่ได้", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const res = await undisposeAsset(db, TENANT, created.id);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบทรัพย์สิน → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await undisposeAsset(db, TENANT, "not-exist");
    expect(res.ok).toBe(false);
  });

  it("🟡 softDeleteManualEntry ล้มเหลว (เช่น DB error ชั่วคราว) → ต้อง short-circuit ไม่ reset ทรัพย์สินเป็น active และไม่ลบ draft JE เดิม", async () => {
    const { db, tables, forceErrors } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;

    const disposeRes = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput(), chartByCode);
    expect(disposeRes.ok).toBe(true);
    const entryId = row.disposal_entry_id as string;
    expect(row.status).toBe("disposed");

    // ★ push forceError หลัง disposeAsset สำเร็จแล้วเท่านั้น (disposeAsset เองก็ update manual_journal_entries
    //   ตอนผูก fixed_asset_id ด้วย — ถ้า push ไว้ตั้งแต่ต้น จะไปโดน call นั้นก่อนถึง undisposeAsset) —
    //   บังคับให้ update ครั้งถัดไปของ manual_journal_entries (softDeleteManualEntry ข้างใน undisposeAsset)
    //   ล้มเหลวหนึ่งครั้ง — ต้อง short-circuit คืน error ไม่ดำเนินการ reset ทรัพย์สินต่อ
    forceErrors.push({ table: "manual_journal_entries", mode: "update", message: "DB error ชั่วคราว (จำลองเทสต์)" });

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(false);

    // ★★★ ก่อนแก้บั๊กนี้ ทรัพย์สินจะถูก reset เป็น active ไปแล้วทั้งที่ draft JE จำหน่ายเดิมยังไม่ถูกลบ
    //   (draft JE ค้างผูก fixed_asset_id อยู่ทั้งที่ทรัพย์สินตอนนี้ active) — ต้องยังคง disposed อยู่เหมือนเดิม
    expect(row.status).toBe("disposed");
    expect(row.disposal_entry_id).toBe(entryId);
    const entry = tables.manual_journal_entries.find((e) => e.id === entryId)!;
    expect(entry.deleted_at).toBeFalsy(); // ★ ยังไม่ถูกลบ (ตรงกับที่ทรัพย์สินยัง disposed)
  });
});
