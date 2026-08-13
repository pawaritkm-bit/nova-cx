import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateInstallmentPlanInput,
  computeInstallmentStatuses,
  listInstallments,
  listInstallmentsForEntries,
  setInstallmentPlan,
  clearInstallmentPlan,
  type BillInstallment,
  type InstallmentRowInput,
} from "@/lib/accounting/bill-installments";

/**
 * bill-installments.ts — wishlist ข้อ 7 (แผนงวดผ่อนชำระบนบิลเชื่อ AR/AP)
 *   เน้น: validate แผนงวดชำระ (0.1-0.4) · สถานะต่องวดคำนวณสด ๆ (paid/overdue/upcoming) · data layer (mock DB)
 */

function mkRow(overrides: Partial<InstallmentRowInput> = {}): InstallmentRowInput {
  return { dueDate: "2026-09-01", amount: 500, ...overrides };
}

function mkInstallment(overrides: Partial<BillInstallment> = {}): BillInstallment {
  return {
    id: "i1",
    tenantId: "t1",
    entryId: "e1",
    installmentNo: 1,
    dueDate: "2026-09-01",
    plannedAmount: 500,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("validateInstallmentPlanInput", () => {
  it("แผนถูกต้อง (2 งวด รวมเท่ายอดเต็มบิล) → ผ่าน", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ dueDate: "2026-09-01", amount: 500 }), mkRow({ dueDate: "2026-10-01", amount: 500 })],
      1000
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([
        { dueDate: "2026-09-01", plannedAmount: 500 },
        { dueDate: "2026-10-01", plannedAmount: 500 },
      ]);
    }
  });

  it("★ น้อยกว่า 2 งวด → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput([mkRow({ amount: 1000 })], 1000);
    expect(res.ok).toBe(false);
  });

  it("★ เกิน 60 งวด → ปฏิเสธ", () => {
    const rows = Array.from({ length: 61 }, (_, i) => mkRow({ dueDate: `2030-01-${String((i % 28) + 1).padStart(2, "0")}`, amount: 1 }));
    const res = validateInstallmentPlanInput(rows, 61);
    expect(res.ok).toBe(false);
  });

  it("★ วันครบกำหนดผิดรูปแบบ → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ dueDate: "31/12/2026" }), mkRow({ dueDate: "2026-10-01" })],
      1000
    );
    expect(res.ok).toBe(false);
  });

  it("★ วันที่ไม่มีจริง (ปฏิทิน) → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ dueDate: "2026-02-30" }), mkRow({ dueDate: "2026-10-01" })],
      1000
    );
    expect(res.ok).toBe(false);
  });

  it("★ วันครบกำหนดไม่เรียงจากน้อยไปมาก (งวดหลังต้องอยู่หลังงวดก่อน) → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ dueDate: "2026-10-01", amount: 500 }), mkRow({ dueDate: "2026-09-01", amount: 500 })],
      1000
    );
    expect(res.ok).toBe(false);
  });

  it("★ วันครบกำหนดซ้ำกัน (ไม่ใช่ ascending จริง) → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ dueDate: "2026-09-01", amount: 500 }), mkRow({ dueDate: "2026-09-01", amount: 500 })],
      1000
    );
    expect(res.ok).toBe(false);
  });

  it("★ ยอดงวดใดงวดหนึ่งไม่มากกว่า 0 → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ amount: 0 }), mkRow({ dueDate: "2026-10-01", amount: 1000 })],
      1000
    );
    expect(res.ok).toBe(false);
    const res2 = validateInstallmentPlanInput(
      [mkRow({ amount: -100 }), mkRow({ dueDate: "2026-10-01", amount: 1100 })],
      1000
    );
    expect(res2.ok).toBe(false);
  });

  it("★ ยอดรวมไม่เท่ายอดเต็มบิล → ปฏิเสธ", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ amount: 500 }), mkRow({ dueDate: "2026-10-01", amount: 400 })],
      1000
    );
    expect(res.ok).toBe(false);
  });

  it("ยอดรวมต่างจากยอดเต็มบิลเล็กน้อยในขอบเขต EPSILON (rounding) → ยังผ่าน", () => {
    const res = validateInstallmentPlanInput(
      [mkRow({ amount: 333.33 }), mkRow({ dueDate: "2026-10-01", amount: 333.34 }), mkRow({ dueDate: "2026-11-01", amount: 333.33 })],
      1000
    );
    expect(res.ok).toBe(true);
  });
});

describe("computeInstallmentStatuses", () => {
  const installments: BillInstallment[] = [
    mkInstallment({ id: "i1", installmentNo: 1, dueDate: "2026-01-01", plannedAmount: 300 }),
    mkInstallment({ id: "i2", installmentNo: 2, dueDate: "2026-02-01", plannedAmount: 300 }),
    mkInstallment({ id: "i3", installmentNo: 3, dueDate: "2026-03-01", plannedAmount: 400 }),
  ];

  it("ยังไม่จ่ายเลย + ทุกงวดยังไม่ครบกำหนด → upcoming ทั้งหมด", () => {
    const res = computeInstallmentStatuses(installments, 0, "2025-12-01");
    expect(res.map((r) => r.status)).toEqual(["upcoming", "upcoming", "upcoming"]);
  });

  it("ยังไม่จ่ายเลย + งวดแรกเกินกำหนดแล้ว → overdue เฉพาะงวดที่เกินกำหนด", () => {
    const res = computeInstallmentStatuses(installments, 0, "2026-01-15");
    expect(res.map((r) => r.status)).toEqual(["overdue", "upcoming", "upcoming"]);
  });

  it("จ่ายพอดีงวดแรก (cumulative=300) → งวดแรก paid งวดถัดไปตามกำหนดวัน", () => {
    const res = computeInstallmentStatuses(installments, 300, "2026-01-15");
    expect(res.map((r) => r.status)).toEqual(["paid", "upcoming", "upcoming"]);
  });

  it("จ่ายเกินงวดแรก (cumulative งวด 1=300, งวด 1+2=600) แต่ยังไม่ถึงงวด 3 → งวด 1,2 paid", () => {
    const res = computeInstallmentStatuses(installments, 500, "2026-01-15");
    expect(res.map((r) => r.status)).toEqual(["paid", "upcoming", "upcoming"]);
  });

  it("จ่ายครบทุกงวด (cumulative เต็ม 1000) → paid ทั้งหมดแม้บางงวดยังไม่ถึงวันครบกำหนด", () => {
    const res = computeInstallmentStatuses(installments, 1000, "2026-01-15");
    expect(res.map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
  });

  it("ไม่ได้เรียงลำดับ installmentNo มาจาก DB → ฟังก์ชัน sort ให้เองก่อนคำนวณ cumulative", () => {
    const shuffled = [installments[2], installments[0], installments[1]];
    const res = computeInstallmentStatuses(shuffled, 300, "2026-01-15");
    expect(res.map((r) => r.installmentNo)).toEqual([1, 2, 3]);
    expect(res.map((r) => r.status)).toEqual(["paid", "upcoming", "upcoming"]);
  });

  it("cumulativePlanned สะสมถูกต้องต่องวด", () => {
    const res = computeInstallmentStatuses(installments, 0, "2025-12-01");
    expect(res.map((r) => r.cumulativePlanned)).toEqual([300, 600, 1000]);
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB — pattern เดียวกับ bill-payments.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;

function makeFakeDb(seed: {
  entries?: Record<string, Row>;
  lines?: Record<string, Row[]>;
  installments?: Row[];
}): { db: SupabaseClient; installments: Row[] } {
  const entries = seed.entries ?? {};
  const lines = seed.lines ?? {};
  const installments: Row[] = [...(seed.installments ?? [])];
  let nextId = 1;

  type Filter = { col: string; op: "eq" | "in" | "is"; val: unknown };

  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.op === "is") return f.val === null ? row[f.col] === null || row[f.col] === undefined : row[f.col] === f.val;
      return row[f.col] === f.val;
    });
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "delete" = "select";
    let payload: Row | Row[] = {};
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
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "is", val: v });
      return api;
    };
    const orderSpecs: { col: string; asc: boolean }[] = [];
    api.order = (c: string, o?: { ascending?: boolean }) => {
      orderSpecs.push({ col: c, asc: o?.ascending !== false });
      return api;
    };
    api.limit = () => api;
    api.insert = (p: Row | Row[]) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => {
      if (table === "bill_entries") {
        const idFilter = filters.find((f) => f.col === "id");
        const row = idFilter ? entries[idFilter.val as string] : undefined;
        return Promise.resolve({ data: row ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      let error: unknown = null;
      if (table === "bill_entry_lines") {
        const entryFilter = filters.find((f) => f.col === "entry_id");
        data = entryFilter ? lines[entryFilter.val as string] ?? [] : [];
      } else if (table === "bill_installments") {
        if (mode === "insert") {
          const arr = Array.isArray(payload) ? payload : [payload];
          for (const p of arr) installments.push({ id: `bi${nextId++}`, created_at: "2026-01-01T00:00:00Z", ...p });
          data = null;
        } else if (mode === "delete") {
          const keep = installments.filter((r) => !matchRow(r, filters));
          installments.length = 0;
          installments.push(...keep);
          data = null;
        } else {
          let out = installments.filter((r) => matchRow(r, filters));
          for (const spec of [...orderSpecs].reverse()) {
            out = [...out].sort((a, b) => {
              const av = a[spec.col] as string | number;
              const bv = b[spec.col] as string | number;
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (spec.asc ? 1 : -1);
            });
          }
          data = out;
        }
      }
      return Promise.resolve({ data, error }).then(onF);
    };
    return api;
  }
  const db = {
    from: (t: string) => qb(t),
    // ★ มิเรอร์ RPC set_bill_installment_plan (migration 0107) — ทรานแซกชันเดียว: ลบของเดิม + insert ชุดใหม่
    rpc: (fn: string, params: { p_tenant_id: string; p_entry_id: string; p_installments: Row[] }) => {
      if (fn !== "set_bill_installment_plan") return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
      const keep = installments.filter((r) => !(r.tenant_id === params.p_tenant_id && r.entry_id === params.p_entry_id));
      installments.length = 0;
      installments.push(...keep);
      for (const p of params.p_installments) {
        installments.push({
          id: `bi${nextId++}`,
          created_at: "2026-01-01T00:00:00Z",
          tenant_id: params.p_tenant_id,
          entry_id: params.p_entry_id,
          ...p,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { db, installments };
}

const ENTRY_CREDIT_SALE: Row = { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" };

describe("listInstallments / listInstallmentsForEntries", () => {
  it("ไม่มีแผน → array ว่าง", async () => {
    const { db } = makeFakeDb({});
    expect(await listInstallments(db, "t1", "e1")).toEqual([]);
  });

  it("มีแผน → คืนเรียงตามงวด map ครบทุกฟิลด์", async () => {
    const { db } = makeFakeDb({
      installments: [
        { id: "bi1", tenant_id: "t1", entry_id: "e1", installment_no: 2, due_date: "2026-10-01", planned_amount: 500, created_at: "2026-01-01T00:00:00Z" },
        { id: "bi2", tenant_id: "t1", entry_id: "e1", installment_no: 1, due_date: "2026-09-01", planned_amount: 500, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const list = await listInstallments(db, "t1", "e1");
    expect(list.map((i) => i.installmentNo)).toEqual([1, 2]);
    expect(list[0]).toEqual({
      id: "bi2",
      tenantId: "t1",
      entryId: "e1",
      installmentNo: 1,
      dueDate: "2026-09-01",
      plannedAmount: 500,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("listInstallmentsForEntries — จัดกลุ่มตาม entryId ถูกต้อง หลายบิลพร้อมกัน", async () => {
    const { db } = makeFakeDb({
      installments: [
        { id: "bi1", tenant_id: "t1", entry_id: "e1", installment_no: 1, due_date: "2026-09-01", planned_amount: 500, created_at: "x" },
        { id: "bi2", tenant_id: "t1", entry_id: "e2", installment_no: 1, due_date: "2026-09-01", planned_amount: 200, created_at: "x" },
      ],
    });
    const map = await listInstallmentsForEntries(db, "t1", ["e1", "e2", "e3"]);
    expect(map.get("e1")?.length).toBe(1);
    expect(map.get("e2")?.length).toBe(1);
    expect(map.get("e3")).toBeUndefined();
  });

  it("listInstallmentsForEntries — entryIds ว่าง → Map ว่าง ไม่ query", async () => {
    const { db } = makeFakeDb({});
    const map = await listInstallmentsForEntries(db, "t1", []);
    expect(map.size).toBe(0);
  });
});

describe("setInstallmentPlan", () => {
  it("บิลไม่พบ → ปฏิเสธ", async () => {
    const { db } = makeFakeDb({ entries: {} });
    const res = await setInstallmentPlan(db, "t1", "missing", [mkRow(), mkRow({ dueDate: "2026-10-01" })]);
    expect(res.ok).toBe(false);
  });

  it("★ บิลไม่ eligible (ไม่ใช่ payment_method='credit') → ปฏิเสธ ไม่เขียน DB", async () => {
    const { db, installments } = makeFakeDb({
      entries: { e1: { ...ENTRY_CREDIT_SALE, payment_method: "cash" } },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });
    const res = await setInstallmentPlan(db, "t1", "e1", [mkRow({ amount: 500 }), mkRow({ dueDate: "2026-10-01", amount: 500 })]);
    expect(res.ok).toBe(false);
    expect(installments).toHaveLength(0);
  });

  it("★ ยอดรวมไม่เท่ายอดเต็มบิล (จาก DB จริง ไม่เชื่อ client) → ปฏิเสธ ไม่เขียน DB", async () => {
    const { db, installments } = makeFakeDb({
      entries: { e1: ENTRY_CREDIT_SALE },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });
    const res = await setInstallmentPlan(db, "t1", "e1", [mkRow({ amount: 500 }), mkRow({ dueDate: "2026-10-01", amount: 400 })]);
    expect(res.ok).toBe(false);
    expect(installments).toHaveLength(0);
  });

  it("แผนถูกต้อง → insert ครบทุกงวด installment_no เรียง 1..N", async () => {
    const { db, installments } = makeFakeDb({
      entries: { e1: ENTRY_CREDIT_SALE },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });
    const res = await setInstallmentPlan(db, "t1", "e1", [
      mkRow({ dueDate: "2026-09-01", amount: 500 }),
      mkRow({ dueDate: "2026-10-01", amount: 500 }),
    ]);
    expect(res.ok).toBe(true);
    expect(installments).toHaveLength(2);
    expect(installments.map((r) => r.installment_no)).toEqual([1, 2]);
    expect(installments.every((r) => r.tenant_id === "t1" && r.entry_id === "e1")).toBe(true);
  });

  it("แก้แผนเดิม → ลบแถวเดิมทั้งหมดก่อน insert ชุดใหม่ (ไม่ค้างของเก่า)", async () => {
    const { db, installments } = makeFakeDb({
      entries: { e1: ENTRY_CREDIT_SALE },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
      installments: [
        { id: "old1", tenant_id: "t1", entry_id: "e1", installment_no: 1, due_date: "2026-01-01", planned_amount: 1000, created_at: "x" },
      ],
    });
    const res = await setInstallmentPlan(db, "t1", "e1", [
      mkRow({ dueDate: "2026-09-01", amount: 500 }),
      mkRow({ dueDate: "2026-10-01", amount: 500 }),
    ]);
    expect(res.ok).toBe(true);
    expect(installments).toHaveLength(2);
    expect(installments.find((r) => r.id === "old1")).toBeUndefined();
  });

  it("ไม่กระทบแผนของบิลอื่น (tenant/entry คนละใบ)", async () => {
    const { db, installments } = makeFakeDb({
      entries: { e1: ENTRY_CREDIT_SALE },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
      installments: [
        { id: "other1", tenant_id: "t1", entry_id: "e2", installment_no: 1, due_date: "2026-01-01", planned_amount: 999, created_at: "x" },
      ],
    });
    await setInstallmentPlan(db, "t1", "e1", [mkRow({ dueDate: "2026-09-01", amount: 500 }), mkRow({ dueDate: "2026-10-01", amount: 500 })]);
    expect(installments.find((r) => r.id === "other1")).toBeDefined();
  });
});

describe("clearInstallmentPlan", () => {
  it("ลบแถวทั้งหมดของบิลนั้น ไม่กระทบบิลอื่น", async () => {
    const { db, installments } = makeFakeDb({
      installments: [
        { id: "bi1", tenant_id: "t1", entry_id: "e1", installment_no: 1, due_date: "2026-09-01", planned_amount: 500, created_at: "x" },
        { id: "bi2", tenant_id: "t1", entry_id: "e2", installment_no: 1, due_date: "2026-09-01", planned_amount: 200, created_at: "x" },
      ],
    });
    const res = await clearInstallmentPlan(db, "t1", "e1");
    expect(res.ok).toBe(true);
    expect(installments.find((r) => r.entry_id === "e1")).toBeUndefined();
    expect(installments.find((r) => r.entry_id === "e2")).toBeDefined();
  });
});
