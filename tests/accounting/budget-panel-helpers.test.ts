import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBudgetSaveRows, type BudgetGrid } from "@/lib/accounting/budget-panel-helpers";
import { upsertBudgetYear } from "@/lib/accounting/budget";
import { parseAmountInput } from "@/lib/accounting/calc";

/**
 * เทสต์ lib/accounting/budget-panel-helpers.ts (แก้บั๊ก #1 — เคลียร์งบทั้งปีของบัญชีหนึ่งไม่ได้จริงผ่าน UI)
 *   BudgetPanel.tsx เดิมกรองทิ้งทุกแถว amount<=0 ก่อนส่งไป server ทำให้ upsertBudgetYear ไม่รู้ว่าต้อง
 *   ลบของเดิมของบัญชีที่ถูกเคลียร์ค่าออก — buildBudgetSaveRows คือ pure helper ที่แก้ปัญหานี้ (ส่งครบ 12
 *   เดือนของบัญชีที่ "แก้ไขจริง" เท่านั้น รวมช่อง amount=0 ด้วย)
 */

describe("buildBudgetSaveRows", () => {
  it("บัญชีที่ไม่อยู่ใน dirtyCodes → ไม่ถูกส่งเลย แม้ grid จะมีค่าอยู่ (กันไม่ให้ payload บวมทั้งผังบัญชี)", () => {
    const grid: BudgetGrid = {
      "5320": Array.from({ length: 12 }, () => "1000"),
      "4010": Array.from({ length: 12 }, () => ""),
    };
    const rows = buildBudgetSaveRows(grid, new Set(), parseAmountInput);
    expect(rows).toHaveLength(0);
  });

  it("บัญชีที่อยู่ใน dirtyCodes → ส่งครบ 12 เดือน รวมช่องที่ว่าง/0 ด้วย (ไม่กรองด้วย amount>0)", () => {
    const grid: BudgetGrid = {
      "5320": ["1000", "", "500", "", "", "", "", "", "", "", "", ""],
    };
    const rows = buildBudgetSaveRows(grid, new Set(["5320"]), parseAmountInput);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.amount === 0)).toHaveLength(10);
    expect(rows.find((r) => r.month === 1)?.amount).toBe(1000);
    expect(rows.find((r) => r.month === 3)?.amount).toBe(500);
  });

  it("★ เคลียร์บัญชีที่เคยมีงบทุกเดือนกลับเป็นว่างทั้งหมด (dirty) → ยังส่งครบ 12 เดือนด้วย amount=0 ทุกช่อง", () => {
    const grid: BudgetGrid = {
      "5320": Array.from({ length: 12 }, () => ""), // ผู้ใช้ลบค่าทุกช่องออกหมดแล้ว
    };
    const rows = buildBudgetSaveRows(grid, new Set(["5320"]), parseAmountInput);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.amount === 0)).toBe(true);
    expect(rows.every((r) => r.accountCode === "5320")).toBe(true);
  });

  it("หลายบัญชี — ส่งเฉพาะบัญชีที่ dirty เท่านั้น ไม่รวมบัญชีอื่นที่ไม่ได้แก้", () => {
    const grid: BudgetGrid = {
      "5320": Array.from({ length: 12 }, () => "1000"),
      "4010": Array.from({ length: 12 }, () => "2000"),
      "1010": Array.from({ length: 12 }, () => ""),
    };
    const rows = buildBudgetSaveRows(grid, new Set(["4010"]), parseAmountInput);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.accountCode === "4010")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// end-to-end (pure logic + data layer): จำลองการ "เคลียร์งบทั้งปีของบัญชีหนึ่งผ่าน UI" ตั้งแต่ grid →
//   buildBudgetSaveRows → upsertBudgetYear จริง แล้วยืนยันว่า record เดิมถูกลบออกจาก DB จริง
//   (mirror pattern fake DB เดียวกับ tests/accounting/budget.test.ts)
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

describe("★ end-to-end: เคลียร์งบทั้งปีของบัญชีหนึ่งผ่าน UI (grid → buildBudgetSaveRows → upsertBudgetYear)", () => {
  it("บัญชีเคยมีงบ 3 เดือน → ผู้ใช้ลบค่าทุกช่องของบัญชีนั้นจนว่างหมด แล้วกดบันทึก → record เดิมถูกลบออกจาก DB จริง", async () => {
    const { db, rows } = makeFakeBudgetDb();

    // ตั้งงบเดิมไว้ 3 เดือนของบัญชี 5320 (จำลองสถานะก่อนหน้าใน DB)
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [
      { accountCode: "5320", month: 1, amount: 1000 },
      { accountCode: "5320", month: 2, amount: 2000 },
      { accountCode: "5320", month: 3, amount: 3000 },
    ]);
    expect(rows).toHaveLength(3);

    // จำลอง grid ที่โหลดค่าเดิมมาแสดง แล้วผู้ใช้ลบทุกช่องของ 5320 จนว่างหมด (เหมือน setCell ทุกเดือน)
    const grid: BudgetGrid = { "5320": Array.from({ length: 12 }, () => "") };
    const dirty = new Set(["5320"]); // ผู้ใช้แก้ไขบัญชีนี้ในรอบนี้จริง (ผ่าน setCell)

    const saveRows = buildBudgetSaveRows(grid, dirty, parseAmountInput);
    expect(saveRows).toHaveLength(12); // ส่งครบ 12 เดือน แม้ amount=0 ทั้งหมด

    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, saveRows);
    expect(res.ok).toBe(true);
    // ★ ต้องไม่มี record ของบัญชี 5320 ปีนี้ค้างอยู่ใน DB เลย (บั๊กเดิม: ยังค้างอยู่ 3 แถว)
    expect(rows).toHaveLength(0);
  });

  it("regression: ถ้าไม่ได้แก้บัญชีอื่น (ไม่ dirty) งบเดิมของบัญชีนั้นต้องไม่ถูกแตะแม้จะบันทึกพร้อมกัน", async () => {
    const { db, rows } = makeFakeBudgetDb();
    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, [
      { accountCode: "5320", month: 7, amount: 1000 },
      { accountCode: "4010", month: 7, amount: 5000 },
    ]);
    expect(rows).toHaveLength(2);

    // ผู้ใช้แก้เฉพาะ 5320 (เคลียร์ค่า) ไม่แตะ 4010 เลย
    const grid: BudgetGrid = {
      "5320": Array.from({ length: 12 }, () => ""),
      "4010": (() => {
        const m = Array.from({ length: 12 }, () => "");
        m[6] = "5000";
        return m;
      })(),
    };
    const dirty = new Set(["5320"]);
    const saveRows = buildBudgetSaveRows(grid, dirty, parseAmountInput);
    expect(saveRows.every((r) => r.accountCode === "5320")).toBe(true);

    await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, saveRows);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_code).toBe("4010"); // 4010 ไม่ถูกแตะ ยังอยู่เหมือนเดิม
  });

  it("regression: ตั้งงบปกติ (amount>0) ของบัญชีที่แก้ไข → บันทึกได้เหมือนเดิม ไม่เปลี่ยน behavior ปกติ", async () => {
    const { db, rows } = makeFakeBudgetDb();
    const grid: BudgetGrid = { "5320": Array.from({ length: 12 }, () => "1500") };
    const dirty = new Set(["5320"]);
    const saveRows = buildBudgetSaveRows(grid, dirty, parseAmountInput);

    const res = await upsertBudgetYear(db, TENANT, CUSTOMER, 2026, saveRows);
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.amount === 1500)).toBe(true);
  });
});
