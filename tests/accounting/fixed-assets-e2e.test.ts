import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { addMonthsClamped } from "@/lib/accounting/recurring-journal";
import { round2 } from "@/lib/accounting/queries";
import { buildCashFlowStatement } from "@/lib/accounting/cash-flow";
import type { JournalLine } from "@/lib/accounting/journal";
import {
  upsertAsset,
  softDeleteAsset,
  listDepreciationLog,
  generateOne,
  generateDueDepreciation,
  disposeAsset,
  undisposeAsset,
  netBookValue,
  type FixedAssetInput,
  type DisposeAssetInput,
} from "@/lib/accounting/fixed-assets";

/**
 * เทสต์ end-to-end เต็ม flow ของเฟส 7 (ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมอัตโนมัติ + จำหน่าย) — QC เพิ่มเติม
 * ต่อจาก tests/accounting/fixed-assets.test.ts (unit test ต่อฟังก์ชัน) โดยเน้น "ครบวงจรชีวิตทรัพย์สิน 1
 * ชิ้นจริง" ตาม docs/06-accounting-features-roadmap.md หมวด "เฟส 7 — แผนละเอียด" § 4.2 (manual integration
 * test checklist):
 *   1) สร้าง → generate ค่าเสื่อมครบทุกงวดจนหมดอายุการใช้งาน → ผลรวม = cost−salvage เป๊ะ + next_dep_date=null
 *   2) generate ซ้ำหลังตัดค่าเสื่อมครบแล้ว → skip เงียบ ไม่สร้างซ้ำ
 *   3) จำหน่ายกลางทาง (ยังไม่ตัดค่าเสื่อมครบ ผ่าน generate loop จริง ไม่ใช่ set accumulated ตรง ๆ) —
 *      proceeds สูง/ต่ำ/เท่า NBV → ตรวจ manual JE สมดุลทุกกรณี
 *   4) ยกเลิกการจำหน่ายก่อน confirm JE → กลับ active + next_dep_date ถูกต้อง → generate ต่อได้ปกติจริง
 *   5) disposeAsset ร่วมกับ cash-flow.ts จริง (ไม่ hand-craft JournalLine เอง) — เงินสดจัดเป็น investing
 *      ครบทั้งขาสินทรัพย์+ค่าเสื่อมสะสม
 *   6) ลบทรัพย์สินที่จำหน่ายแล้ว (status='disposed', accumulated_depreciation=0) → ถูกปฏิเสธ
 *   7) edge case: useful_life_months=1, cron/generateDueDepreciation วันที่ไม่มีทรัพย์สินถึงกำหนดเลย
 *
 * ★ หมายเหตุ fake DB: ใช้ stateful in-memory fake เดียวกับ pattern ของ tests/accounting/fixed-assets.test.ts
 *   (จำลอง RPC claim_fixed_asset_depreciation ตรงตาม SQL migration 0076) แทน tests/helpers/fake-supabase.ts
 *   ตัวกลาง เพราะ helper กลางเป็นแบบ resolver ไม่มี state ต่อแถว/ไม่รองรับ filter จริง (lte/in ต่อคอลัมน์)
 *   ซึ่งจำเป็นสำหรับจำลอง atomic RPC ที่ต้อง advance next_dep_date จริงข้าม 9+ ครั้งเรียกต่อเนื่องในเทสต์เดียว
 *   — ยังคงเป็น "fake db ระดับ unit" ตามที่ขอ เพียงคนละไฟล์ (สอดคล้อง convention เดิมที่ทั้ง
 *   fixed-assets.test.ts และ fixed-assets-actions.test.ts ก็ประกาศ fake db ของตัวเองแยกกันอยู่แล้ว)
 */

const chartByCode = buildChartByCode(TEST_CHART);

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

function makeFakeDb(chart: ChartAccount[] = TEST_CHART): { db: SupabaseClient; tables: Tables } {
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

  /** จำลอง RPC claim_fixed_asset_depreciation — mirror ตรรกะ SQL migration 0076 เป๊ะ (รวม plug งวดสุดท้าย) */
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
  };
}

/** แปลง manual_journal_entry_lines จริงที่ upsertManualEntry สร้าง → JournalLine[] ให้ buildCashFlowStatement
 *  ใช้ต่อได้จริง (ไม่ hand-craft เอง) — bridge ระหว่าง fixed-assets.ts กับ cash-flow.ts สองโมดูล */
function toJournalLines(tables: Tables, entryId: string): JournalLine[] {
  const entry = tables.manual_journal_entries.find((e) => e.id === entryId) as
    | { doc_date: string; doc_no: string | null; customer_id: string }
    | undefined;
  if (!entry) return [];
  return tables.manual_journal_entry_lines
    .filter((l) => l.entry_id === entryId)
    .map((l) => {
      const debit = Number(l.debit);
      const credit = Number(l.credit);
      return {
        entryId,
        date: entry.doc_date,
        docNo: entry.doc_no,
        accountCode: l.account_code as string,
        accountName: (l.account_name as string) ?? (chartByCode[l.account_code as string]?.name ?? (l.account_code as string)),
        debit,
        credit,
        side: debit > 0 ? "debit" : "credit",
        customerId: entry.customer_id,
        counterparty: null,
      } as JournalLine;
    });
}

const TENANT = "t1";
const CUSTOMER = "c1";

function makeAssetInput(p: Partial<FixedAssetInput> = {}): FixedAssetInput {
  return {
    name: "คอมพิวเตอร์สำนักงาน",
    assetAccountCode: "1640",
    accumDepAccountCode: "1640.1",
    depExpenseAccountCode: "5375",
    acquisitionDate: "2026-01-01",
    cost: 30000,
    salvageValue: 0,
    usefulLifeMonths: 36,
    ...p,
  };
}

function baseDisposeInput(p: Partial<DisposeAssetInput> = {}): DisposeAssetInput {
  return {
    disposalDate: "2026-05-15",
    proceeds: 20000,
    cashAccountCode: "1010",
    gainLossAccountCode: "4020",
    ...p,
  };
}

// ---------------------------------------------------------------------
// 1) generate ครบทุกงวดจนหมดอายุการใช้งาน — ผลรวม = cost−salvage เป๊ะ
// ---------------------------------------------------------------------
describe("E2E 1: generate ค่าเสื่อมครบทุกงวดจนหมดอายุการใช้งาน (cost=10000, salvage=1000, useful_life=9 — หารลงตัวเป๊ะ ตามตัวอย่างในแผน T57)", () => {
  it("งวด 1-8 = 1000.00 เป๊ะทุกงวด, งวดที่ 9 (สุดท้าย) = plug = 1000.00 พอดี, next_dep_date=null หลังงวดที่ 9, สะสมรวม=9000.00", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      makeAssetInput({ cost: 10000, salvageValue: 1000, usefulLifeMonths: 9 }),
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const FAR_FUTURE = "2030-01-01"; // ★ ไม่ต้อง advance next_dep_date มือทีละงวด — เกินทุกงวดที่จะเกิดขึ้นจริง
    const amounts: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const res = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
      expect(res.status, `งวดที่ ${i} ต้อง generated`).toBe("generated");
      if (res.status !== "generated") break;
      const log = tables.fixed_asset_depreciation_log.find((l) => l.manual_entry_id === res.manualEntryId)!;
      amounts.push(Number(log.amount));
    }

    expect(amounts).toHaveLength(9);
    for (let i = 0; i < 8; i++) expect(amounts[i]).toBe(1000);
    expect(amounts[8]).toBe(1000); // ★ งวดสุดท้ายเป็น plug แต่หารลงตัวเป๊ะในเคสนี้ → เท่ากับยอดคงที่พอดี

    const total = round2(amounts.reduce((s, a) => s + a, 0));
    expect(total).toBe(9000); // cost(10000) − salvage(1000)

    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    expect(row.accumulated_depreciation).toBe(9000);
    expect(row.next_dep_date).toBeNull();
    expect(row.status).toBe("active"); // ★ 0.6 ตัดค่าเสื่อมครบแล้วแต่ยัง active (ยังไม่จำหน่าย)

    // ★ ทุก occurrence เป็น draft เสมอ (0.3 ห้าม auto-confirm)
    expect(tables.manual_journal_entries).toHaveLength(9);
    expect(tables.manual_journal_entries.every((e) => e.status === "draft")).toBe(true);
    expect(tables.manual_journal_entries.every((e) => e.fixed_asset_id === created.id)).toBe(true);
  });

  it("★ 2) รัน generateOne ซ้ำหลังตัดค่าเสื่อมครบแล้ว → skip เงียบ ๆ (claimed:false) ไม่สร้างซ้ำ ไม่เพิ่ม log", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      makeAssetInput({ cost: 10000, salvageValue: 1000, usefulLifeMonths: 9 }),
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const FAR_FUTURE = "2030-01-01";
    for (let i = 1; i <= 9; i++) {
      await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
    }
    expect(tables.manual_journal_entries).toHaveLength(9);
    expect(tables.fixed_asset_depreciation_log.filter((l) => l.status === "generated")).toHaveLength(9);

    // ★ รันซ้ำอีกหลายครั้ง (จำลอง cron รันทุกวันต่อจากนี้ไปอีกหลายวัน) → ต้องนิ่ง ไม่สร้างซ้ำเลย
    for (let i = 0; i < 5; i++) {
      const extra = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
      expect(extra.status).toBe("skipped");
    }
    expect(tables.manual_journal_entries).toHaveLength(9); // ไม่เพิ่มขึ้นอีกเลย
    expect(tables.fixed_asset_depreciation_log.filter((l) => l.status === "generated")).toHaveLength(9);

    // generateDueDepreciation (mirror cron) ก็ต้องไม่หยิบทรัพย์สินนี้มา scan อีก (next_dep_date=null)
    const summary = await generateDueDepreciation(db, TENANT, FAR_FUTURE, chartByCode);
    expect(summary.scanned).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 3) จำหน่ายทรัพย์สินกลางทาง (ยังไม่ตัดค่าเสื่อมครบ) ผ่าน generate loop จริง — proceeds สูง/ต่ำ/เท่า NBV
// ---------------------------------------------------------------------
describe("E2E 3: จำหน่ายทรัพย์สินกลางทาง (generate ค่าเสื่อมจริง 4 งวดก่อน แล้วค่อยจำหน่าย)", () => {
  async function setupPartiallyDepreciated() {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput(), chartByCode); // cost=30000,salvage=0,life=36
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const FAR_FUTURE = "2030-01-01";
    for (let i = 1; i <= 4; i++) {
      const r = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
      expect(r.status).toBe("generated");
    }
    const row = tables.fixed_assets.find((a) => a.id === created.id)!;
    // 30000/36 = 833.33 ต่อเดือน × 4 = 3333.32 (ปัดเศษสะสมแบบเดียวกับ RPC จริง)
    expect(row.accumulated_depreciation).toBe(3333.32);
    return { db, tables, assetId: created.id, row };
  }

  it("proceeds > NBV → กำไร, JE สมดุลถูกต้อง (Dr accum + Dr cash = Cr asset + Cr gain)", async () => {
    const { db, tables, assetId, row } = await setupPartiallyDepreciated();
    const nbv = netBookValue({ cost: 30000, accumulatedDepreciation: 3333.32 });
    expect(nbv).toBe(26666.68);

    const res = await disposeAsset(db, TENANT, CUSTOMER, assetId, baseDisposeInput({ proceeds: 27000 }), chartByCode);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === row.disposal_entry_id);
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);

    const gainLine = lines.find((l) => l.account_code === "4020")!;
    expect(gainLine.credit).toBe(round2(27000 - nbv)); // 333.32 กำไร
    expect(row.status).toBe("disposed");
    expect(row.next_dep_date).toBeNull();
  });

  it("proceeds < NBV → ขาดทุน, JE สมดุลถูกต้อง", async () => {
    const { db, tables, assetId, row } = await setupPartiallyDepreciated();
    const nbv = netBookValue({ cost: 30000, accumulatedDepreciation: 3333.32 });

    const res = await disposeAsset(db, TENANT, CUSTOMER, assetId, baseDisposeInput({ proceeds: 25000 }), chartByCode);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === row.disposal_entry_id);
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);

    const lossLine = lines.find((l) => l.account_code === "4020")!;
    expect(lossLine.debit).toBe(round2(nbv - 25000)); // 1666.68 ขาดทุน
    expect(lossLine.credit).toBe(0);
  });

  it("proceeds = NBV เป๊ะ → ไม่มี gain/loss leg เลย แต่ยังสมดุล", async () => {
    const { db, tables, assetId, row } = await setupPartiallyDepreciated();
    const nbv = netBookValue({ cost: 30000, accumulatedDepreciation: 3333.32 }); // 26666.68

    const res = await disposeAsset(db, TENANT, CUSTOMER, assetId, baseDisposeInput({ proceeds: nbv }), chartByCode);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === row.disposal_entry_id);
    expect(lines.find((l) => l.account_code === "4020")).toBeUndefined();
    expect(lines).toHaveLength(3); // accum + cash + asset เท่านั้น
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);
  });
});

// ---------------------------------------------------------------------
// 4) ยกเลิกการจำหน่ายก่อน confirm JE → กลับ active + next_dep_date ถูกต้อง → generate ต่อได้ปกติจริง
// ---------------------------------------------------------------------
describe("E2E 4: ยกเลิกการจำหน่าย (ก่อน confirm) แล้ว generate ต่อได้จริง (ไม่ใช่แค่ next_dep_date ถูกต้องเฉย ๆ)", () => {
  it("generate 2 งวด (ม.ค.,ก.พ.) → จำหน่าย มี.ค. → undo → generateOne อีกครั้ง → ได้งวด มี.ค. สำเร็จ ยอดถูกต้อง ต่อเนื่องจากของเดิม", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      makeAssetInput({ acquisitionDate: "2026-01-01", usefulLifeMonths: 12, cost: 12000, salvageValue: 0 }),
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;

    const FAR_FUTURE = "2030-01-01";
    const g1 = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
    expect(g1.status).toBe("generated");
    const g2 = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
    expect(g2.status).toBe("generated");
    expect(row.accumulated_depreciation).toBe(2000); // 1000/เดือน × 2
    expect(row.next_dep_date).toBe("2026-03-01");

    const disposeRes = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ disposalDate: "2026-03-10", proceeds: 5000 }),
      chartByCode
    );
    expect(disposeRes.ok).toBe(true);
    expect(row.status).toBe("disposed");
    expect(row.next_dep_date).toBeNull();
    const disposalEntryId = row.disposal_entry_id as string; // ★ เก็บไว้ก่อน undo (undo จะเคลียร์เป็น null)

    const undoRes = await undisposeAsset(db, TENANT, created.id);
    expect(undoRes.ok).toBe(true);
    expect(row.status).toBe("active");
    expect(row.next_dep_date).toBe("2026-03-01"); // เดือนถัดไปจากงวดล่าสุดที่ generate จริง (ก.พ.)
    expect(row.accumulated_depreciation).toBe(2000); // ประวัติค่าเสื่อมเดิมไม่หาย

    // ★ จุดสำคัญ: ต้อง generate ต่อได้จริง ไม่ใช่แค่ next_dep_date ตัวเลขถูกต้องเฉย ๆ
    const g3 = await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
    expect(g3.status).toBe("generated");
    if (g3.status !== "generated") return;
    const log3 = tables.fixed_asset_depreciation_log.find((l) => l.manual_entry_id === g3.manualEntryId)!;
    expect(log3.period).toBe("2026-03-01");
    expect(log3.amount).toBe(1000);
    expect(row.accumulated_depreciation).toBe(3000);
    expect(tables.fixed_asset_depreciation_log.filter((l) => l.status === "generated")).toHaveLength(3);
    // JE ของการจำหน่ายที่ยกเลิกไปถูก soft-delete แล้ว ไม่ปนกับ occurrence ใหม่
    const disposalEntry = tables.manual_journal_entries.find((e) => e.id === disposalEntryId);
    expect(disposalEntry?.deleted_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
// 5) disposeAsset ร่วมกับ cash-flow.ts จริง — เงินสดจัดเป็น investing ครบทั้งขาสินทรัพย์+ค่าเสื่อมสะสม
// ---------------------------------------------------------------------
describe("E2E 5: disposeAsset จริง → JE lines จริง → buildCashFlowStatement (integration ข้ามโมดูล ไม่ hand-craft JournalLine)", () => {
  it("จำหน่ายทรัพย์สินหลัง generate 4 งวด (กำไร) → cash-flow จัดขาสินทรัพย์+ค่าเสื่อมสะสมเป็น investing ครบ ผลรวม investing+operating(gain) = proceeds เป๊ะ", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput(), chartByCode); // 1640/1640.1, cost 30000
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;

    const FAR_FUTURE = "2030-01-01";
    for (let i = 1; i <= 4; i++) await generateOne(db, TENANT, created.id, FAR_FUTURE, chartByCode);
    expect(row.accumulated_depreciation).toBe(3333.32);

    const disposeRes = await disposeAsset(
      db,
      TENANT,
      CUSTOMER,
      created.id,
      baseDisposeInput({ disposalDate: "2026-05-01", proceeds: 27000, cashAccountCode: "1010" }),
      chartByCode
    );
    expect(disposeRes.ok).toBe(true);
    if (!disposeRes.ok) return;
    const disposalEntryId = row.disposal_entry_id as string; // ★ disposeRes.id = asset id (ไม่ใช่ JE id)

    // ★ ดึง manual_journal_entry_lines จริงที่ disposeAsset สร้าง → แปลงเป็น JournalLine[] → ยิงเข้า
    //   buildCashFlowStatement จริง (ไม่ hand-craft เลียนแบบเอง) — bridge ข้ามโมดูลจริง
    const lines = toJournalLines(tables, disposalEntryId);
    expect(lines.length).toBeGreaterThan(0);

    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);

    const investingCodes = cf.investing.map((l) => l.accountCode).sort();
    expect(investingCodes).toEqual(["1640", "1640.1"]); // ★ 0.10 ครบทั้งขาสินทรัพย์ + ค่าเสื่อมสะสม
    const nbv = netBookValue({ cost: 30000, accumulatedDepreciation: 3333.32 });
    expect(cf.totalInvesting).toBe(nbv); // 30000 - 3333.32 = 26666.68

    // กำไร (leg 4020) ไม่อยู่ใน INVESTING_CODES/FINANCING_CODES → fallback ไป operating (0.10 ยอมรับไว้)
    expect(cf.operating).toHaveLength(1);
    expect(cf.operating[0].accountCode).toBe("4020");
    const gain = round2(27000 - nbv);
    expect(cf.operating[0].amount).toBe(gain);

    // ★ รวมกันแล้วต้องเท่ากับ proceeds เป๊ะ — เงินสดที่ได้รับจริงทั้งหมดของธุรกรรมนี้
    expect(round2(cf.totalInvesting + cf.totalOperating)).toBe(27000);
    expect(cf.reconciled).toBe(true);
    expect(cf.netChange).toBe(27000);
    expect(cf.closingCash).toBe(27000);
  });
});

// ---------------------------------------------------------------------
// 6) ลบทรัพย์สินที่จำหน่ายแล้ว (edge case: accumulated_depreciation=0) → ต้องถูกปฏิเสธ
// ---------------------------------------------------------------------
describe("E2E 6: ลบทรัพย์สินที่จำหน่ายแล้ว (status='disposed') ต้องถูกปฏิเสธเสมอ แม้ accumulated_depreciation=0", () => {
  it("จำหน่ายทันทีตั้งแต่ยังไม่เคย generate ค่าเสื่อมเลย (accumulated=0) → softDeleteAsset ต้องปฏิเสธ", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput(), chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    expect(row.accumulated_depreciation).toBe(0);

    const disposeRes = await disposeAsset(db, TENANT, CUSTOMER, created.id, baseDisposeInput({ proceeds: 32000 }), chartByCode);
    expect(disposeRes.ok).toBe(true);
    expect(row.status).toBe("disposed");
    expect(row.accumulated_depreciation).toBe(0); // ★ edge case จริง — ยังเป็น 0 อยู่ (ไม่เคย generate)

    const delRes = await softDeleteAsset(db, TENANT, created.id);
    expect(delRes.ok).toBe(false); // ★ ต้องถูกปฏิเสธเพราะ status='disposed' (ไม่ใช่เพราะ accumulated>0)
    expect(row.deleted_at).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// 7) edge cases ที่แผนอาจมองข้าม
// ---------------------------------------------------------------------
describe("E2E 7: edge cases เพิ่มเติม", () => {
  it("useful_life_months=1 → หมดอายุตั้งแต่งวดแรก (generate ครั้งเดียวจบ, next_dep_date=null ทันที, ค่าเสื่อม=cost−salvage เต็มจำนวน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      makeAssetInput({ cost: 5000, salvageValue: 500, usefulLifeMonths: 1 }),
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    const row = tables.fixed_assets.find((r) => r.id === created.id)!;
    row.customer_id = CUSTOMER;
    expect(row.monthly_depreciation).toBe(4500);

    const res = await generateOne(db, TENANT, created.id, "2030-01-01", chartByCode);
    expect(res.status).toBe("generated");
    expect(row.accumulated_depreciation).toBe(4500);
    expect(row.next_dep_date).toBeNull();
    expect(row.status).toBe("active");

    // ★ generate รอบต่อไป (แม้เรียกทันที) → skip เงียบ ไม่มีทางเกินมูลค่าที่ต้องตัด
    const res2 = await generateOne(db, TENANT, created.id, "2030-01-01", chartByCode);
    expect(res2.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(1);
  });

  it("cron/generateDueDepreciation รันวันที่ไม่มีทรัพย์สินถึงกำหนดเลย (ไม่มีทรัพย์สินในระบบด้วยซ้ำ) → คืนสำเร็จ scanned=0 ไม่ throw", async () => {
    const { db } = makeFakeDb();
    const summary = await generateDueDepreciation(db, TENANT, "2026-08-10", chartByCode);
    expect(summary).toEqual({ scanned: 0, generated: 0, failed: 0, skipped: 0, results: [] });
  });

  it("cron/generateDueDepreciation รันวันที่มีทรัพย์สินอยู่แต่ยังไม่ถึงกำหนดสักชิ้น → scanned=0 คืนสำเร็จ ไม่ throw", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertAsset(
      db,
      TENANT,
      CUSTOMER,
      makeAssetInput({ acquisitionDate: "2027-01-01" }), // อนาคตไกล
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.fixed_assets[0].customer_id = CUSTOMER;

    const summary = await generateDueDepreciation(db, TENANT, "2026-08-10", chartByCode);
    expect(summary.scanned).toBe(0);
    expect(summary.generated).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("★ ทรัพย์สินหลายชิ้นของลูกค้าเดียวกัน ถึงกำหนดพร้อมกัน บางชิ้นบัญชีถูกลบไปแล้ว (account_code หาย) — ชิ้นที่เหลือต้องยัง generate สำเร็จครบ ไม่กระทบกัน", async () => {
    const { db, tables } = makeFakeDb();
    const a1 = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput({ name: "เครื่อง A" }), chartByCode);
    const a2 = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput({ name: "เครื่อง B" }), chartByCode);
    const a3 = await upsertAsset(db, TENANT, CUSTOMER, makeAssetInput({ name: "เครื่อง C" }), chartByCode);
    if (!a1.ok || !a2.ok || !a3.ok) throw new Error("setup failed");
    for (const a of tables.fixed_assets) a.customer_id = CUSTOMER;

    // เครื่อง B บัญชีค่าเสื่อมราคาถูกลบไปจากผัง (ลบจริงจากตาราง chart_of_accounts จำลอง)
    tables.fixed_assets.find((a) => a.id === a2.id)!.dep_expense_account_code = "9999-ถูกลบไปแล้ว";

    const summary = await generateDueDepreciation(db, TENANT, "2026-01-01", chartByCode);
    expect(summary.scanned).toBe(3);
    expect(summary.generated).toBe(2); // A, C สำเร็จ
    expect(summary.failed).toBe(1); // B ล้มเหลว

    const generatedFor = (id: string) =>
      tables.manual_journal_entries.some((e) => e.fixed_asset_id === id);
    expect(generatedFor(a1.id)).toBe(true);
    expect(generatedFor(a2.id)).toBe(false);
    expect(generatedFor(a3.id)).toBe(true);

    const failedLog = tables.fixed_asset_depreciation_log.find(
      (l) => l.asset_id === a2.id && l.status === "failed"
    );
    expect(failedLog).toBeTruthy();
    expect(failedLog!.message).toBeTruthy();
  });
});
