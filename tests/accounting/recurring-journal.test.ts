import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import {
  addMonthsClamped,
  nextRunDateAfter,
  validateTemplateInput,
  buildOccurrenceInput,
  listTemplates,
  upsertTemplate,
  toggleTemplateActive,
  softDeleteTemplate,
  getTemplateScope,
  listGenerationLog,
  listOccurrencesByTemplateIds,
  generateOccurrenceForTemplate,
  generateDueOccurrences,
  type RecurringTemplateInput,
} from "@/lib/accounting/recurring-journal";

/**
 * เทสต์ lib/accounting/recurring-journal.ts (เฟส 6 ส่วน R, T39–T40/T43)
 *   - date arithmetic (addMonthsClamped/nextRunDateAfter) ต้องตรงกับพฤติกรรม SQL public.add_months_clamped()
 *     ที่ยืนยันแล้วทุก edge case (migration 0073)
 *   - validateTemplateInput ทุก branch ปฏิเสธ
 *   - buildOccurrenceInput → ManualEntryInput shape ตรง
 *   - CRUD data layer (mock DB in-memory — pattern เดียวกับ sales-documents.test.ts)
 *   - generateOccurrenceForTemplate/generateDueOccurrences (0.3/0.4/0.8): draft เสมอ, ล้มเหลวไม่ throw
 *     ทั้ง batch, ยังไม่ถึงรอบ skip เงียบ
 */

// ---------------------------------------------------------------------
// addMonthsClamped / nextRunDateAfter — ต้องตรงกับผลลัพธ์ SQL ที่ยืนยันแล้วเป๊ะทุก edge case (0.5)
// ---------------------------------------------------------------------
describe("addMonthsClamped", () => {
  it("31 ม.ค. + 1 เดือน (ปีปกติ 2026) → 28 ก.พ. (clamp วันสิ้นเดือน)", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("31 ม.ค. + 1 เดือน (ปีอธิกสุรทิน 2024) → 29 ก.พ.", () => {
    expect(addMonthsClamped("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("29 ก.พ. (อธิกสุรทิน 2024) + 12 เดือน (yearly) → 28 ก.พ. 2025 (ปีถัดไปไม่ใช่อธิกสุรทิน)", () => {
    expect(addMonthsClamped("2024-02-29", 12)).toBe("2025-02-28");
  });

  it("30 พ.ย. + 3 เดือน (quarterly ข้ามปี) → 28 ก.พ. ปีถัดไป (ก.พ. มีแค่ 28/29 วัน)", () => {
    expect(addMonthsClamped("2025-11-30", 3)).toBe("2026-02-28");
  });

  it("31 ธ.ค. + 1 เดือน (ข้ามปี) → 31 ม.ค. ปีถัดไป (ไม่ต้อง clamp)", () => {
    expect(addMonthsClamped("2026-12-31", 1)).toBe("2027-01-31");
  });

  it("31 ม.ค. + 1 ปี (yearly) → 31 ม.ค. ปีถัดไปเป๊ะ (ไม่ clamp)", () => {
    expect(addMonthsClamped("2026-01-31", 12)).toBe("2027-01-31");
  });

  it("วันที่ผิดรูปแบบ → คืนค่าดิบกลับ (ไม่พัง)", () => {
    expect(addMonthsClamped("not-a-date", 1)).toBe("not-a-date");
  });
});

describe("nextRunDateAfter", () => {
  it("monthly = +1 เดือน", () => {
    expect(nextRunDateAfter("2026-01-31", "monthly")).toBe("2026-02-28");
  });
  it("quarterly = +3 เดือน", () => {
    expect(nextRunDateAfter("2025-11-30", "quarterly")).toBe("2026-02-28");
  });
  it("yearly = +12 เดือน", () => {
    expect(nextRunDateAfter("2024-02-29", "yearly")).toBe("2025-02-28");
  });
});

// ---------------------------------------------------------------------
// validateTemplateInput
// ---------------------------------------------------------------------
const chartByCode = buildChartByCode(TEST_CHART);

function baseInput(p: Partial<RecurringTemplateInput> = {}): RecurringTemplateInput {
  return {
    docType: "JV",
    memo: "ค่าเช่าสำนักงาน",
    frequency: "monthly",
    startDate: "2026-08-01",
    lines: [
      { accountCode: "5344", debit: 5000, credit: 0 },
      { accountCode: "2015", debit: 0, credit: 5000 },
    ],
    ...p,
  };
}

describe("validateTemplateInput", () => {
  it("input ถูกต้องครบถ้วน → ผ่าน", () => {
    const res = validateTemplateInput(baseInput(), chartByCode);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.frequency).toBe("monthly");
      expect(res.value.lines).toHaveLength(2);
    }
  });

  it("docType ผิด/ไม่รู้จัก → ปฏิเสธ", () => {
    expect(validateTemplateInput(baseInput({ docType: "XX" }), chartByCode).ok).toBe(false);
    expect(validateTemplateInput(baseInput({ docType: undefined }), chartByCode).ok).toBe(false);
  });

  it("★ frequency ไม่รู้จัก (ไม่ใช่ monthly/quarterly/yearly) → ปฏิเสธ (0.2 ตัด weekly ออก)", () => {
    expect(validateTemplateInput(baseInput({ frequency: "weekly" }), chartByCode).ok).toBe(false);
    expect(validateTemplateInput(baseInput({ frequency: "" }), chartByCode).ok).toBe(false);
  });

  it("★ start_date ผิดรูปแบบ → ปฏิเสธ", () => {
    expect(validateTemplateInput(baseInput({ startDate: "01/08/2026" }), chartByCode).ok).toBe(false);
    expect(validateTemplateInput(baseInput({ startDate: "" }), chartByCode).ok).toBe(false);
  });

  it("★ [tester] start_date ผ่าน regex แต่ไม่มีวันที่นี้จริงในปฏิทิน → ปฏิเสธ พร้อมข้อความชัดเจน (กันหลุดไป Postgres reject แบบไม่ระบุสาเหตุ)", () => {
    for (const bad of ["2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-06-31"]) {
      const res = validateTemplateInput(baseInput({ startDate: bad }), chartByCode);
      expect(res.ok, `startDate="${bad}" ควรถูกปฏิเสธ`).toBe(false);
      if (!res.ok) expect(res.message).toContain("วันที่เริ่มต้นไม่ถูกต้อง");
    }
  });

  it("★ [tester] end_date ผ่าน regex แต่ไม่มีวันที่นี้จริงในปฏิทิน → ปฏิเสธ พร้อมข้อความชัดเจน", () => {
    for (const bad of ["2026-02-30", "2026-04-31", "2026-13-01"]) {
      const res = validateTemplateInput(baseInput({ startDate: "2026-01-01", endDate: bad }), chartByCode);
      expect(res.ok, `endDate="${bad}" ควรถูกปฏิเสธ`).toBe(false);
      if (!res.ok) expect(res.message).toContain("วันที่สิ้นสุดไม่ถูกต้อง");
    }
  });

  it("★ [tester] วันที่ปกติ (รวมปีอธิกสุรทิน 29 ก.พ.) ยังผ่านเหมือนเดิม (regression guard)", () => {
    expect(validateTemplateInput(baseInput({ startDate: "2026-08-01" }), chartByCode).ok).toBe(true);
    expect(validateTemplateInput(baseInput({ startDate: "2024-02-29" }), chartByCode).ok).toBe(true); // 2024 = leap year
    expect(
      validateTemplateInput(baseInput({ startDate: "2026-01-01", endDate: "2026-12-31" }), chartByCode).ok
    ).toBe(true);
  });

  it("end_date ผิดรูปแบบ → ปฏิเสธ", () => {
    expect(validateTemplateInput(baseInput({ endDate: "31-12-2026" }), chartByCode).ok).toBe(false);
  });

  it("end_date ก่อน start_date → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(baseInput({ startDate: "2026-08-01", endDate: "2026-07-01" }), chartByCode).ok
    ).toBe(false);
  });

  it("end_date ว่าง/null → ไม่บังคับ (ผ่าน ไม่มีวันสิ้นสุด)", () => {
    const res = validateTemplateInput(baseInput({ endDate: null }), chartByCode);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.endDate).toBeNull();
  });

  it("จำนวนบรรทัดน้อยกว่า MIN_LINES → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(baseInput({ lines: [{ accountCode: "5344", debit: 5000, credit: 0 }] }), chartByCode).ok
    ).toBe(false);
  });

  it("จำนวนบรรทัดเกิน MAX_LINES → ปฏิเสธ", () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({
      accountCode: "5344",
      debit: i % 2 === 0 ? 100 : 0,
      credit: i % 2 === 0 ? 0 : 100,
    }));
    expect(validateTemplateInput(baseInput({ lines }), chartByCode).ok).toBe(false);
  });

  it("บรรทัดไม่ระบุรหัสบัญชี → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(
        baseInput({ lines: [{ accountCode: "", debit: 100, credit: 0 }, { accountCode: "2015", debit: 0, credit: 100 }] }),
        chartByCode
      ).ok
    ).toBe(false);
  });

  it("★ รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ (0.8 กรณีบัญชีถูกลบ)", () => {
    expect(
      validateTemplateInput(
        baseInput({ lines: [{ accountCode: "9999-ไม่มีจริง", debit: 100, credit: 0 }, { accountCode: "2015", debit: 0, credit: 100 }] }),
        chartByCode
      ).ok
    ).toBe(false);
  });

  it("บรรทัดมีทั้งเดบิตและเครดิต → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(
        baseInput({ lines: [{ accountCode: "5344", debit: 100, credit: 100 }, { accountCode: "2015", debit: 0, credit: 100 }] }),
        chartByCode
      ).ok
    ).toBe(false);
  });

  it("บรรทัดไม่มีทั้งเดบิตและเครดิต (ยอด 0 ทั้งคู่) → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(
        baseInput({ lines: [{ accountCode: "5344", debit: 0, credit: 0 }, { accountCode: "2015", debit: 0, credit: 100 }] }),
        chartByCode
      ).ok
    ).toBe(false);
  });

  it("★ เดบิตรวม ≠ เครดิตรวม (ไม่สมดุล) → ปฏิเสธ (reuse isBalanced)", () => {
    expect(
      validateTemplateInput(
        baseInput({ lines: [{ accountCode: "5344", debit: 5000, credit: 0 }, { accountCode: "2015", debit: 0, credit: 4000 }] }),
        chartByCode
      ).ok
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// buildOccurrenceInput
// ---------------------------------------------------------------------
describe("buildOccurrenceInput", () => {
  it("คืน ManualEntryInput ที่ debit=credit ตรงเทมเพลตเป๊ะ + docDate=runDate ที่ได้จาก claim", () => {
    const input = buildOccurrenceInput(
      {
        docType: "PV",
        memo: "ค่าเช่าสำนักงานรายเดือน",
        lines: [
          { lineNo: 1, accountCode: "5344", accountName: "ค่าบริการแพลตฟอร์ม", description: null, debit: 5000, credit: 0 },
          { lineNo: 2, accountCode: "2015", accountName: "เจ้าหนี้อื่น ๆ", description: null, debit: 0, credit: 5000 },
        ],
      },
      "2026-09-01"
    );
    expect(input).toEqual({
      docType: "PV",
      docDate: "2026-09-01",
      docNo: null,
      memo: "ค่าเช่าสำนักงานรายเดือน",
      lines: [
        { accountCode: "5344", accountName: "ค่าบริการแพลตฟอร์ม", description: null, debit: 5000, credit: 0 },
        { accountCode: "2015", accountName: "เจ้าหนี้อื่น ๆ", description: null, debit: 0, credit: 5000 },
      ],
    });
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB in-memory) — pattern เดียวกับ tests/accounting/sales-documents.test.ts
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
  recurring_journal_templates: Row[];
  recurring_journal_template_lines: Row[];
  recurring_journal_generation_log: Row[];
  manual_journal_entries: Row[];
  manual_journal_entry_lines: Row[];
  chart_of_accounts: Row[];
};

function makeFakeDb(chart: ChartAccount[] = TEST_CHART): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = {
    recurring_journal_templates: [],
    recurring_journal_template_lines: [],
    recurring_journal_generation_log: [],
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

  /** ค่า default ของคอลัมน์ nullable ที่ upsertTemplate ไม่ได้ระบุตอน insert เสมอ (mirror DB จริง — คอลัมน์
   *  ที่ไม่ระบุค่า = null เสมอ ไม่ใช่ undefined) */
  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    recurring_journal_templates: { last_generated_at: null, deleted_at: null, end_date: null },
    recurring_journal_generation_log: { message: null, manual_entry_id: null },
    manual_journal_entries: { deleted_at: null, recurring_template_id: null, doc_no: null, memo: null },
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

  // จำลอง RPC claim_recurring_je_occurrence (mirror ตรรกะ SQL ใน migration 0073 — for update skip
  //   locked ไม่จำลอง เพราะเทสต์นี้ single-threaded อยู่แล้ว การล็อกแถวคอนเคอร์เรนซีเทสต์ที่ระดับ SQL
  //   จริงแล้ว (ยืนยันโดย agent ก่อนหน้า — ดูบริบทงาน)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "claim_recurring_je_occurrence") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const today = params.p_today as string;
    const row = tables.recurring_journal_templates.find(
      (r) =>
        r.id === params.p_template_id &&
        r.tenant_id === params.p_tenant_id &&
        !r.deleted_at &&
        r.is_active === true &&
        (r.next_run_date as string) <= today &&
        (r.end_date === null || (r.next_run_date as string) <= (r.end_date as string))
    );
    if (!row) return Promise.resolve({ data: { claimed: false }, error: null });

    const months = row.frequency === "monthly" ? 1 : row.frequency === "quarterly" ? 3 : 12;
    const runDate = row.next_run_date as string;
    row.next_run_date = addMonthsClamped(runDate, months);
    row.last_generated_at = "2026-08-09T00:00:00Z";

    return Promise.resolve({
      data: {
        claimed: true,
        run_date: runDate,
        doc_type: row.doc_type,
        memo: row.memo,
        customer_id: row.customer_id,
      },
      error: null,
    });
  }

  return {
    db: { from: (t: string) => qb(t as keyof Tables), rpc } as unknown as SupabaseClient,
    tables,
  };
}

const TENANT = "t1";
const CUSTOMER = "c1";

const validInput: RecurringTemplateInput = {
  docType: "JV",
  memo: "ค่าเช่าสำนักงาน",
  frequency: "monthly",
  startDate: "2026-08-01",
  lines: [
    { accountCode: "5344", debit: 5000, credit: 0 },
    { accountCode: "2015", debit: 0, credit: 5000 },
  ],
};

describe("upsertTemplate (สร้างใหม่)", () => {
  it("input ถูกต้อง → สร้างสำเร็จ next_run_date = start_date เสมอ (รอบแรก)", async () => {
    const { db, tables } = makeFakeDb();
    const res = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    expect(res.ok).toBe(true);
    expect(tables.recurring_journal_templates).toHaveLength(1);
    const t = tables.recurring_journal_templates[0];
    expect(t.next_run_date).toBe("2026-08-01");
    expect(t.is_active).toBe(true);
    expect(tables.recurring_journal_template_lines).toHaveLength(2);
  });

  it("frequency ไม่รู้จัก → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await upsertTemplate(db, TENANT, CUSTOMER, { ...validInput, frequency: "weekly" }, chartByCode);
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates).toHaveLength(0);
  });
});

describe("upsertTemplate (แก้ไข)", () => {
  it("★ ยังไม่เคย generate (last_generated_at=null) → แก้ start_date แล้ว next_run_date ตามไปด้วย", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-09-15" },
      chartByCode,
      created.id
    );
    expect(res.ok).toBe(true);
    const t = tables.recurring_journal_templates.find((r) => r.id === created.id)!;
    expect(t.start_date).toBe("2026-09-15");
    expect(t.next_run_date).toBe("2026-09-15");
  });

  it("★ generate ไปแล้วอย่างน้อย 1 รอบ → next_run_date เดิมคงอยู่แม้แก้ start_date", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const t = tables.recurring_journal_templates.find((r) => r.id === created.id)!;
    t.last_generated_at = "2026-08-01T00:00:00Z";
    t.next_run_date = "2026-09-01"; // จำลองว่า generate ไปแล้ว 1 รอบ advance มาแล้ว

    const res = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-08-15" },
      chartByCode,
      created.id
    );
    expect(res.ok).toBe(true);
    expect(t.next_run_date).toBe("2026-09-01"); // ไม่เปลี่ยนตาม start_date ใหม่
  });

  it("ลูกค้าไม่ตรงกับเทมเพลตเดิม → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const res = await upsertTemplate(db, TENANT, "other-customer", validInput, chartByCode, created.id);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบเทมเพลต (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode, "not-exist-id");
    expect(res.ok).toBe(false);
  });
});

describe("listTemplates / getTemplateScope", () => {
  it("โหลดเทมเพลต + บรรทัดครบ เรียงล่าสุดก่อน", async () => {
    const { db } = makeFakeDb();
    await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    const list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(1);
    expect(list[0].lines).toHaveLength(2);
    expect(list[0].customerId).toBe(CUSTOMER);
  });

  it("getTemplateScope คืน customerId + lastGeneratedAt", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const scope = await getTemplateScope(db, TENANT, created.id);
    expect(scope?.customerId).toBe(CUSTOMER);
    expect(scope?.lastGeneratedAt).toBeNull();
  });

  it("ไม่พบ → คืน null", async () => {
    const { db } = makeFakeDb();
    expect(await getTemplateScope(db, TENANT, "not-exist")).toBeNull();
  });
});

describe("toggleTemplateActive / softDeleteTemplate", () => {
  it("toggle ปิดใช้งาน → is_active=false", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const res = await toggleTemplateActive(db, TENANT, created.id, false);
    expect(res.ok).toBe(true);
    expect(tables.recurring_journal_templates.find((t) => t.id === created.id)!.is_active).toBe(false);
  });

  it("softDeleteTemplate → deleted_at ถูกตั้งค่า + is_active=false", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    const res = await softDeleteTemplate(db, TENANT, created.id);
    expect(res.ok).toBe(true);
    const row = tables.recurring_journal_templates.find((t) => t.id === created.id)!;
    expect(row.deleted_at).toBeTruthy();
    expect(row.is_active).toBe(false);
  });

  it("ลบแล้วลิสต์ไม่เจออีก", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    await softDeleteTemplate(db, TENANT, created.id);
    const list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// orchestrator — generateOccurrenceForTemplate / generateDueOccurrences (T40 ★ จุดสำคัญที่สุดของ R)
// ---------------------------------------------------------------------
describe("generateOccurrenceForTemplate", () => {
  it("★ 0.3 สำเร็จ → สร้าง occurrence เป็น draft เสมอ (ไม่ auto-confirm) + ผูก recurring_template_id + log 'generated'", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("generated");
    if (res.status !== "generated") return;

    const entry = tables.manual_journal_entries.find((e) => e.id === res.manualEntryId)!;
    expect(entry.status).toBe("draft");
    expect(entry.recurring_template_id).toBe(created.id);
    expect(entry.doc_date).toBe("2026-08-01");

    const log = tables.recurring_journal_generation_log.find((l) => l.status === "generated");
    expect(log).toBeTruthy();
    expect(log!.manual_entry_id).toBe(res.manualEntryId);
  });

  it("ยังไม่ถึงรอบ (next_run_date > today) → skip เงียบ ๆ ไม่เขียน log", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, { ...validInput, startDate: "2026-09-01" }, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(0);
    expect(tables.recurring_journal_generation_log).toHaveLength(0);
  });

  it("is_active=false → skip (ไม่ claim)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    await toggleTemplateActive(db, TENANT, created.id, false);

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("skipped");
  });

  it("end_date ผ่านไปแล้ว (next_run_date > end_date) → skip", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    // จำลองว่าเทมเพลตมี end_date ที่ next_run_date ปัจจุบันเลยไปแล้ว (ตั้งตรงในตารางแทน — validate เดิม
    //   ปฏิเสธ end_date < start_date ตั้งแต่ตอนสร้าง ทดสอบพฤติกรรม RPC/guard ที่เช็คตอน claim แยกกัน)
    tables.recurring_journal_templates[0].end_date = "2026-07-01";
    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("skipped");
  });

  it("★ 0.8 บัญชีถูกลบไปแล้วหลังตั้งเทมเพลต → claim สำเร็จแต่ insert ล้ม → log 'failed' พร้อมเหตุผล ไม่ throw", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    // จำลองบัญชี 5344 ถูกลบออกจากผัง (soft-delete) หลังตั้งเทมเพลตแล้ว
    tables.chart_of_accounts = tables.chart_of_accounts.filter((a) => a.code !== "5344");

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.message).toBeTruthy();
    expect(tables.manual_journal_entries).toHaveLength(0);
    const log = tables.recurring_journal_generation_log.find((l) => l.status === "failed");
    expect(log).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // ★ [แก้บั๊ก #2] RPC claim error จริงต้องไม่ถูกกลืนเป็น "skipped" เหมือนกรณี "ยังไม่ถึงรอบ" (0.8)
  // -------------------------------------------------------------------
  it("★ RPC claim error จริง (เช่น migration ไม่ครบ/DB connection พัง) → status:'failed' + log 'failed' พร้อมเหตุผล (ไม่ใช่ skipped เงียบ ๆ)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    // จำลอง RPC error จริง (claimErr ไม่ใช่ null) — ต่างจาก "ยังไม่ถึงรอบ" ที่ error=null แต่ claimed=false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc = (fn: string) => {
      if (fn === "claim_recurring_je_occurrence") {
        return Promise.resolve({ data: null, error: { message: 'relation "recurring_journal_templates" does not exist' } });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    };

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.message).toContain("does not exist");
    expect(tables.manual_journal_entries).toHaveLength(0);

    const log = tables.recurring_journal_generation_log.find((l) => l.status === "failed");
    expect(log).toBeTruthy();
    expect(log!.message).toContain("does not exist");
    expect(log!.run_date).toBe("2026-08-01"); // ไม่มี run_date จาก claim (error ก่อนถึงจุดนั้น) → ใช้ today แทน
  });

  it("★ regression guard: ยังไม่ถึงรอบจริง (claimErr=null, claimData.claimed=false) → ยัง skip เงียบเหมือนเดิม ไม่ log (ต้องไม่ปนกับกรณี RPC error ด้านบน)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-09-01" },
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(0);
    expect(tables.recurring_journal_generation_log).toHaveLength(0);
  });
});

describe("generateDueOccurrences", () => {
  it("★ เทมเพลตถึงกำหนดหลายใบ บางใบล้มเหลว → ใบที่เหลือยัง generate สำเร็จ (ไม่ throw ทั้ง batch)", async () => {
    const { db, tables } = makeFakeDb();
    const ok1 = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    const ok2 = await upsertTemplate(db, TENANT, CUSTOMER, { ...validInput, memo: "ค่าบริการ B" }, chartByCode);
    if (!ok1.ok || !ok2.ok) throw new Error("setup failed");
    for (const t of tables.recurring_journal_templates) t.customer_id = CUSTOMER;

    // ทำให้เทมเพลตที่ 2 ล้มเหลว (บัญชีถูกลบไปแล้ว)
    tables.recurring_journal_template_lines
      .filter((l) => l.template_id === ok2.id)
      .forEach((l) => (l.account_code = "9999-ไม่มีอยู่จริง"));

    const summary = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(summary.scanned).toBe(2);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft");
  });

  it("เทมเพลตยังไม่ถึงรอบ → ไม่อยู่ใน candidate เลย (ไม่ scan)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, { ...validInput, startDate: "2026-12-01" }, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    const summary = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(summary.scanned).toBe(0);
    expect(summary.generated).toBe(0);
  });

  it("เทมเพลต is_active=false → ไม่อยู่ใน candidate", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    await toggleTemplateActive(db, TENANT, created.id, false);

    const summary = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(summary.scanned).toBe(0);
  });

  it("★★ [tester] รัน generate ซ้ำวันเดียวกันทันที (จำลอง cron retry/กดปุ่มซ้ำ) → ไม่สร้าง occurrence ซ้ำสอง (claim ไม่ติดครั้งที่ 2)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    const first = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(first.scanned).toBe(1);
    expect(first.generated).toBe(1);
    expect(tables.manual_journal_entries).toHaveLength(1);

    // เรียกซ้ำทันทีด้วย "วันเดียวกัน" (จำลอง retry ของ cron/กดปุ่ม "สร้างตอนนี้" ซ้ำ) —
    // next_run_date ถูก advance ไปเดือนถัดไปแล้วตอน claim ครั้งแรก จึงไม่ถูกนับเป็น candidate อีก
    const second = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(second.scanned).toBe(0);
    expect(second.generated).toBe(0);
    expect(tables.manual_journal_entries).toHaveLength(1); // ยังมีแค่ 1 ใบ ไม่ซ้ำสอง
    expect(tables.recurring_journal_generation_log.filter((l) => l.status === "generated")).toHaveLength(1);
  });

  it("★★ [tester] เทมเพลตที่ end_date ตรงกับวันนี้เป๊ะ (start_date=end_date รอบเดียว) → generate ได้ครั้งสุดท้ายสำเร็จ แล้วรอบถัดไปไม่ claim อีก", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-08-31", endDate: "2026-08-31" },
      chartByCode
    );
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;

    // วันนี้ตรงกับ end_date เป๊ะ → ยัง generate ได้ (RPC เช็ค next_run_date <= end_date ไม่ใช่ today < end_date)
    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-31");
    expect(res.status).toBe("generated");
    expect(tables.manual_journal_entries).toHaveLength(1);

    // รอบถัดไป next_run_date ถูก advance ไปเดือนหน้าแล้ว (เกิน end_date) → claim ไม่ติดอีกแม้เรียกวันเดียวกัน
    const again = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-31");
    expect(again.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// ★★ [tester] end-to-end flow เต็ม (mirror docs 06 หมวด 4.2 ข้อ 1-2): ตั้งเทมเพลตค่าเช่าวันที่ 31
//   → generate → เห็น draft เสมอ → ยืนยัน (confirmManualEntry เดิม) → รัน generate ซ้ำวันเดียวกัน (retry)
//   → ไม่ซ้ำสอง → เทมเพลตที่บัญชีถูกลบ generate ไม่สำเร็จ แต่เทมเพลตอื่นที่ตามมายัง generate สำเร็จ
// ---------------------------------------------------------------------
describe("★★ [tester] R — end-to-end: เทมเพลตค่าเช่าวันที่ 31 → generate → confirm → retry ไม่ซ้ำ + เทมเพลตอื่นไม่พังตาม", () => {
  it("flow เต็ม", async () => {
    const { db, tables } = makeFakeDb();

    // 1) ตั้งเทมเพลตค่าเช่ารายเดือน วันที่ 31 (เจอ clamp วันสิ้นเดือนทุกเดือนที่ไม่มี 31 วัน)
    const rent = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, memo: "ค่าเช่าสำนักงาน", startDate: "2026-01-31" },
      chartByCode
    );
    if (!rent.ok) throw new Error("setup failed");
    tables.recurring_journal_templates.find((t) => t.id === rent.id)!.customer_id = CUSTOMER;

    // 2) รัน generate รอบแรก (ถึงกำหนดวันที่ 2026-01-31) → เห็น draft เสมอ (0.3) ไม่ auto-confirm
    const gen1 = await generateOccurrenceForTemplate(db, TENANT, rent.id, "2026-01-31");
    expect(gen1.status).toBe("generated");
    if (gen1.status !== "generated") return;
    const occurrence = tables.manual_journal_entries.find((e) => e.id === gen1.manualEntryId)!;
    expect(occurrence.status).toBe("draft");
    expect(occurrence.recurring_template_id).toBe(rent.id);

    // ★ next_run_date ต้อง clamp ไปเดือน ก.พ. ถูกต้อง (28/29 — ไม่เบี้ยวแบบ Postgres date+interval ดิบ)
    const tmplAfterFirstGen = tables.recurring_journal_templates.find((t) => t.id === rent.id)!;
    expect(["2026-02-28", "2026-02-28"]).toContain(tmplAfterFirstGen.next_run_date);

    // 3) รัน generate ซ้ำ "วันเดียวกัน" (จำลอง retry ของ cron) → ไม่สร้างซ้ำสอง
    const retrySameDay = await generateOccurrenceForTemplate(db, TENANT, rent.id, "2026-01-31");
    expect(retrySameDay.status).toBe("skipped");
    expect(tables.manual_journal_entries).toHaveLength(1);

    // 4) เทมเพลตที่ 2 (ถึงกำหนดวันเดียวกัน) แต่ account_code ถูกลบไปแล้วก่อนถึงรอบ → generate ไม่สำเร็จ
    const broken = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, memo: "ค่าบริการที่บัญชีถูกลบ", startDate: "2026-01-31" },
      chartByCode
    );
    if (!broken.ok) throw new Error("setup failed");
    tables.recurring_journal_templates.find((t) => t.id === broken.id)!.customer_id = CUSTOMER;
    tables.recurring_journal_template_lines
      .filter((l) => l.template_id === broken.id)
      .forEach((l) => (l.account_code = "9999-ถูกลบไปแล้ว"));

    // เทมเพลตที่ 3 (ถึงกำหนดวันเดียวกัน) ปกติดี — ต้อง generate สำเร็จต่อได้แม้เทมเพลตก่อนหน้าพัง (ไม่ throw ทั้ง batch)
    const ok3 = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, memo: "ค่าบริการปกติ", startDate: "2026-01-31" },
      chartByCode
    );
    if (!ok3.ok) throw new Error("setup failed");
    tables.recurring_journal_templates.find((t) => t.id === ok3.id)!.customer_id = CUSTOMER;

    const summary = await generateDueOccurrences(db, TENANT, "2026-01-31");
    // เทมเพลตค่าเช่า (rent) ถูก claim ไปแล้วก่อนหน้า (next_run_date ขยับไปแล้ว) จึงไม่อยู่ใน candidate รอบนี้
    // เหลือแค่ broken + ok3 = scan 2 ใบ
    expect(summary.scanned).toBe(2);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toBe(1);
    const failedLog = tables.recurring_journal_generation_log.find(
      (l) => l.template_id === broken.id && l.status === "failed"
    );
    expect(failedLog).toBeTruthy();
    expect(failedLog!.message).toBeTruthy();
    // เทมเพลตที่ 3 ต้อง generate สำเร็จเป็น draft ต่อได้ตามปกติ ไม่ถูกกระทบจากเทมเพลตที่พัง
    const ok3Log = tables.recurring_journal_generation_log.find(
      (l) => l.template_id === ok3.id && l.status === "generated"
    );
    expect(ok3Log).toBeTruthy();
    const ok3Entry = tables.manual_journal_entries.find((e) => e.id === ok3Log!.manual_entry_id)!;
    expect(ok3Entry.status).toBe("draft");
  });
});

describe("listGenerationLog / listOccurrencesByTemplateIds", () => {
  it("listGenerationLog คืนประวัติของเทมเพลตนั้น เรียงล่าสุดก่อน", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");

    const log = await listGenerationLog(db, TENANT, created.id);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("generated");
  });

  it("listOccurrencesByTemplateIds คืน occurrence ที่ผูกเทมเพลต + สถานะ draft", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, chartByCode);
    if (!created.ok) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER;
    await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");

    const occ = await listOccurrencesByTemplateIds(db, TENANT, CUSTOMER, [created.id]);
    expect(occ).toHaveLength(1);
    expect(occ[0].status).toBe("draft");
    expect(occ[0].templateId).toBe(created.id);
  });

  it("templateIds ว่าง → คืน [] ทันที ไม่ query", async () => {
    const { db } = makeFakeDb();
    expect(await listOccurrencesByTemplateIds(db, TENANT, CUSTOMER, [])).toEqual([]);
  });
});
