import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import {
  addDays,
  validateTemplateInput,
  buildInvoiceOccurrenceInput,
  listTemplates,
  upsertTemplate,
  toggleTemplateActive,
  softDeleteTemplate,
  getTemplateScope,
  listGenerationLog,
  listOccurrencesByTemplateIds,
  generateOccurrenceForTemplate,
  generateDueOccurrences,
  type RecurringInvoiceTemplateInput,
  type RecurringInvoiceTemplate,
} from "@/lib/accounting/recurring-invoice";

/**
 * เทสต์ lib/accounting/recurring-invoice.ts (wishlist ข้อ 4)
 *   - addDays (pure date math เพิ่มเติมจากไฟล์นี้เอง — addMonthsClamped/nextRunDateAfter/todayIsoThai
 *     re-export ตรงจาก recurring-journal.ts ที่เทสต์ไว้ครบแล้วในไฟล์นั้น ไม่ duplicate ที่นี่)
 *   - validateTemplateInput ทุก branch ปฏิเสธ
 *   - buildInvoiceOccurrenceInput → header/lines shape ตรง (Dr ไม่มี ฝั่งนี้เป็น bill_entries ธรรมดา)
 *   - CRUD data layer (fake DB in-memory)
 *   - generateOccurrenceForTemplate/generateDueOccurrences: draft เสมอ, ล้มเหลวไม่ throw ทั้ง batch,
 *     ยังไม่ถึงรอบ skip เงียบ, ผูก recurring_invoice_template_id metadata กลับ
 */

const CHART: ChartAccount[] = TEST_CHART;

describe("addDays", () => {
  it("บวกวันธรรมดา ไม่ข้ามเดือน", () => {
    expect(addDays("2026-08-01", 10)).toBe("2026-08-11");
  });
  it("บวกวันข้ามเดือน (ก.พ. ปีปกติ)", () => {
    expect(addDays("2026-02-20", 15)).toBe("2026-03-07");
  });
  it("บวกวันข้ามปี", () => {
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
  });
  it("บวก 0 วัน → วันเดิม", () => {
    expect(addDays("2026-08-01", 0)).toBe("2026-08-01");
  });
});

const validInput: RecurringInvoiceTemplateInput = {
  counterpartyName: "บริษัท ABC จำกัด",
  counterpartyTaxId: "1234567890123",
  notes: "ค่าบริการรายเดือน",
  frequency: "monthly",
  startDate: "2026-08-01",
  dueDays: 30,
  lines: [{ description: "ค่าบริการ", accountCode: "4010", quantity: 1, unitPrice: 5000 }],
};

describe("validateTemplateInput", () => {
  it("input ถูกต้องครบ → ผ่าน", () => {
    const r = validateTemplateInput(validInput, buildChartByCode(CHART));
    expect(r.ok).toBe(true);
  });

  it("ไม่ระบุชื่อคู่ค้า → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, counterpartyName: "" }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("frequency ไม่รู้จัก → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, frequency: "weekly" }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("startDate ผิดรูปแบบ → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, startDate: "01/08/2026" }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("startDate ไม่มีจริงในปฏิทิน (2026-02-30) → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, startDate: "2026-02-30" }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("endDate ก่อน startDate → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, endDate: "2026-07-01" }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("dueDays ติดลบ → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, dueDays: -1 }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("dueDays ไม่ใช่จำนวนเต็ม → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, dueDays: 30.5 }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("ไม่มีบรรทัดเลย → ปฏิเสธ", () => {
    const r = validateTemplateInput({ ...validInput, lines: [] }, buildChartByCode(CHART));
    expect(r.ok).toBe(false);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ", () => {
    const r = validateTemplateInput(
      { ...validInput, lines: [{ accountCode: "9999", quantity: 1, unitPrice: 100 }] },
      buildChartByCode(CHART)
    );
    expect(r.ok).toBe(false);
  });

  it("รหัสบัญชีอยู่หมวดผิด (สินทรัพย์แทนรายได้) → ปฏิเสธ", () => {
    const r = validateTemplateInput(
      { ...validInput, lines: [{ accountCode: "1010", quantity: 1, unitPrice: 100 }] },
      buildChartByCode(CHART)
    );
    expect(r.ok).toBe(false);
  });

  it("quantity เป็น 0 หรือติดลบ → ปฏิเสธ", () => {
    expect(
      validateTemplateInput(
        { ...validInput, lines: [{ accountCode: "4010", quantity: 0, unitPrice: 100 }] },
        buildChartByCode(CHART)
      ).ok
    ).toBe(false);
    expect(
      validateTemplateInput(
        { ...validInput, lines: [{ accountCode: "4010", quantity: -1, unitPrice: 100 }] },
        buildChartByCode(CHART)
      ).ok
    ).toBe(false);
  });

  it("unitPrice ติดลบ → ปฏิเสธ", () => {
    const r = validateTemplateInput(
      { ...validInput, lines: [{ accountCode: "4010", quantity: 1, unitPrice: -1 }] },
      buildChartByCode(CHART)
    );
    expect(r.ok).toBe(false);
  });

  it("ยอดรวมเป็น 0 (unitPrice ทุกบรรทัด = 0) → ปฏิเสธ", () => {
    const r = validateTemplateInput(
      { ...validInput, lines: [{ accountCode: "4010", quantity: 1, unitPrice: 0 }] },
      buildChartByCode(CHART)
    );
    expect(r.ok).toBe(false);
  });

  it("ไม่ระบุ dueDays → default 30", () => {
    const r = validateTemplateInput({ ...validInput, dueDays: undefined }, buildChartByCode(CHART));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.dueDays).toBe(30);
  });

  it("vatType ไม่ระบุ → default 'vat'", () => {
    const r = validateTemplateInput(
      { ...validInput, lines: [{ accountCode: "4010", quantity: 1, unitPrice: 100 }] },
      buildChartByCode(CHART)
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0].vatType).toBe("vat");
  });
});

describe("buildInvoiceOccurrenceInput", () => {
  const template: Pick<RecurringInvoiceTemplate, "customerId" | "counterpartyName" | "counterpartyTaxId" | "notes" | "dueDays" | "lines"> = {
    customerId: "c1",
    counterpartyName: "บริษัท ABC จำกัด",
    counterpartyTaxId: "1234567890123",
    notes: "ค่าบริการรายเดือน",
    dueDays: 30,
    lines: [
      { lineNo: 1, description: "ค่าบริการ A", accountCode: "4010", accountName: "ขายสินค้า", vatType: "vat", quantity: 2, unitPrice: 1000 },
      { lineNo: 2, description: "ค่าบริการ B (ไม่มี VAT)", accountCode: "4020", accountName: "รายได้อื่น ๆ", vatType: "novat", quantity: 1, unitPrice: 500 },
    ],
  };

  it("สร้าง header ถูกต้อง (entryType='sale', dueDate = runDate + dueDays)", () => {
    const { header } = buildInvoiceOccurrenceInput(template, "2026-08-01");
    expect(header.entryType).toBe("sale");
    expect(header.customerId).toBe("c1");
    expect(header.docDate).toBe("2026-08-01");
    expect(header.docNo).toBeNull();
    expect(header.counterpartyName).toBe("บริษัท ABC จำกัด");
    expect(header.dueDate).toBe("2026-08-31");
  });

  it("สร้าง lines ถูกต้อง — amount = quantity×unitPrice, vatAmount ตาม vatType", () => {
    const { lines } = buildInvoiceOccurrenceInput(template, "2026-08-01");
    expect(lines).toHaveLength(2);
    expect(lines[0].amount).toBe(2000);
    expect(lines[0].vatAmount).toBe(140); // 2000 * 7%
    expect(lines[1].amount).toBe(500);
    expect(lines[1].vatAmount).toBe(0); // novat
  });
});

// ---------------------------------------------------------------------
// data layer — fake DB in-memory (mirror pattern tests/accounting/recurring-journal.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in" | "lte"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.op === "lte") return (row[f.col] as string) <= (f.val as string);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = {
  recurring_invoice_templates: Row[];
  recurring_invoice_template_lines: Row[];
  recurring_invoice_generation_log: Row[];
  bill_entries: Row[];
  bill_entry_lines: Row[];
  chart_of_accounts: Row[];
};

function makeFakeDb(chart: ChartAccount[] = TEST_CHART): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = {
    recurring_invoice_templates: [],
    recurring_invoice_template_lines: [],
    recurring_invoice_generation_log: [],
    bill_entries: [],
    bill_entry_lines: [],
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
    recurring_invoice_templates: { last_generated_at: null, deleted_at: null, end_date: null },
    recurring_invoice_generation_log: { message: null, bill_entry_id: null },
    bill_entries: { deleted_at: null, recurring_invoice_template_id: null, doc_no: null, status: "draft" },
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
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
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

  // จำลอง RPC claim_recurring_invoice_occurrence (mirror ตรรกะ SQL ใน migration 0105 — for update skip
  //   locked ไม่จำลอง เพราะเทสต์นี้ single-threaded อยู่แล้ว)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "claim_recurring_invoice_occurrence") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const today = params.p_today as string;
    const row = tables.recurring_invoice_templates.find(
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
    row.next_run_date = addMonthsClampedForRpc(runDate, months);
    row.last_generated_at = "2026-08-09T00:00:00Z";

    return Promise.resolve({
      data: {
        claimed: true,
        run_date: runDate,
        customer_id: row.customer_id,
        counterparty_name: row.counterparty_name,
        counterparty_tax_id: row.counterparty_tax_id,
        notes: row.notes,
        due_days: row.due_days,
      },
      error: null,
    });
  }

  return {
    db: { from: (t: string) => qb(t as keyof Tables), rpc } as unknown as SupabaseClient,
    tables,
  };
}

/** copy สั้น ๆ ของ add_months_clamped เฉพาะใช้จำลอง RPC ในเทสต์นี้ (ของจริง import จาก recurring-journal.ts) */
function addMonthsClampedForRpc(dateIso: string, months: number): string {
  const y = Number(dateIso.slice(0, 4));
  const mo = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));
  const totalMonths = y * 12 + (mo - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth1 = (((totalMonths % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth1, 0)).getUTCDate();
  const targetDay = Math.min(d, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

const TENANT = "t1";
const CUSTOMER = "c1";

describe("upsertTemplate / listTemplates / getTemplateScope (data layer)", () => {
  it("สร้างเทมเพลตใหม่ → next_run_date = start_date เสมอ", async () => {
    const { db } = makeFakeDb();
    const res = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(1);
    expect(list[0].nextRunDate).toBe("2026-08-01");
    expect(list[0].lines).toHaveLength(1);
  });

  it("แก้เทมเพลตที่ยังไม่เคย generate → next_run_date ตาม startDate ใหม่", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");
    await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-09-01" },
      buildChartByCode(CHART),
      created.id
    );
    const list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list[0].nextRunDate).toBe("2026-09-01");
  });

  it("แก้เทมเพลตของลูกค้าอื่น (customerId ไม่ตรง) → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");
    const res = await upsertTemplate(db, TENANT, "other-customer", validInput, buildChartByCode(CHART), created.id);
    expect(res.ok).toBe(false);
  });

  it("getTemplateScope คืน null ถ้าไม่พบ", async () => {
    const { db } = makeFakeDb();
    expect(await getTemplateScope(db, TENANT, "missing")).toBeNull();
  });

  it("toggleTemplateActive / softDeleteTemplate ทำงานถูกต้อง", async () => {
    const { db } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");

    const off = await toggleTemplateActive(db, TENANT, created.id, false);
    expect(off.ok).toBe(true);
    let list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list[0].isActive).toBe(false);

    const del = await softDeleteTemplate(db, TENANT, created.id);
    expect(del.ok).toBe(true);
    list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(0); // ลบแล้วไม่โชว์ในลิสต์
  });
});

describe("generateOccurrenceForTemplate / generateDueOccurrences (orchestrator)", () => {
  it("ยังไม่ถึงรอบ (next_run_date > today) → skipped เฉย ๆ ไม่สร้างอะไร", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, startDate: "2026-09-01" },
      buildChartByCode(CHART)
    );
    if (!created.ok) throw new Error("setup failed");

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("skipped");
    expect(tables.bill_entries).toHaveLength(0);
  });

  it("ถึงรอบ → สร้างใบแจ้งหนี้จริง (bill_entries entry_type='sale', status='draft') + ผูก template_id", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("generated");
    if (res.status !== "generated") return;

    expect(tables.bill_entries).toHaveLength(1);
    const entry = tables.bill_entries[0];
    expect(entry.entry_type).toBe("sale");
    expect(entry.status).toBe("draft"); // ★ ห้าม auto-confirm เด็ดขาด
    expect(entry.recurring_invoice_template_id).toBe(created.id);
    expect(entry.customer_id).toBe(CUSTOMER);
    expect(entry.counterparty_name).toBe("บริษัท ABC จำกัด");
    expect(entry.due_date).toBe("2026-08-31"); // 2026-08-01 + 30 วัน

    expect(tables.bill_entry_lines).toHaveLength(1);
    expect(tables.bill_entry_lines[0].amount).toBe(5000);

    // log บันทึกสำเร็จ + ผูก bill_entry_id
    const log = await listGenerationLog(db, TENANT, created.id);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("generated");
    expect(log[0].billEntryId).toBe(entry.id);

    // next_run_date ถูก advance ไปแล้ว (RPC claim)
    const list = await listTemplates(db, TENANT, CUSTOMER);
    expect(list[0].nextRunDate).toBe("2026-09-01");
  });

  it("เรียกซ้ำวันเดียวกันหลัง claim ไปแล้ว → skipped (กัน double-generate)", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");

    await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    const second = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(second.status).toBe("skipped");
    expect(tables.bill_entries).toHaveLength(1); // ยังมีแค่ใบเดียว ไม่ซ้ำ
  });

  it("รหัสบัญชีในเทมเพลตถูกลบ/ปิดใช้งานก่อนถึงรอบ → failed + log เหตุผล ไม่ throw", async () => {
    // ผังบัญชีที่ไม่มี 4010 เลย (จำลองว่าถูกลบไปหลังตั้งเทมเพลต)
    const chartNoAccount: ChartAccount[] = CHART.filter((a) => a.code !== "4010");
    const { db, tables } = makeFakeDb();
    // สร้างเทมเพลตด้วยผังที่มี 4010 อยู่ก่อน (ตอนตั้งเทมเพลตยังผ่าน validate)
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");

    // generate จริงตอนผังไม่มี 4010 แล้ว (จำลองบัญชีถูกลบไปก่อนถึงรอบ)
    const chart = chartNoAccount.map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: a.bank ?? false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: "t1",
    }));
    tables.chart_of_accounts = chart;

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("failed");
    expect(tables.bill_entries).toHaveLength(0); // ไม่ทิ้งใบแจ้งหนี้ค้าง

    const log = await listGenerationLog(db, TENANT, created.id);
    expect(log[0].status).toBe("failed");
    expect(log[0].message).toBeTruthy();
  });

  it("เทมเพลตไม่มีบรรทัดเลยตอน generate (เช่นแก้ไขพร้อมกันแล้ว lines ว่างเปล่าชั่วคราว) → failed ไม่สร้างใบเปล่า", async () => {
    const { db, tables } = makeFakeDb();
    const created = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!created.ok) throw new Error("setup failed");

    // จำลองสถานะที่ lines ถูกลบไปแล้วแต่ insert ใหม่ยังไม่ทัน (ระหว่างแก้ไขเทมเพลต)
    tables.recurring_invoice_template_lines = [];

    const res = await generateOccurrenceForTemplate(db, TENANT, created.id, "2026-08-01");
    expect(res.status).toBe("failed");
    expect(tables.bill_entries).toHaveLength(0); // ไม่ทิ้งใบแจ้งหนี้หัวเปล่าค้าง

    const log = await listGenerationLog(db, TENANT, created.id);
    expect(log[0].status).toBe("failed");
    expect(log[0].message).toBeTruthy();
  });

  it("generateDueOccurrences: หลายเทมเพลต — ใบหนึ่งพัง ไม่ทำให้ใบอื่นของ tenant เดียวกันหยุด generate", async () => {
    const { db, tables } = makeFakeDb();
    const good = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!good.ok) throw new Error("setup failed");
    const bad = await upsertTemplate(
      db,
      TENANT,
      CUSTOMER,
      { ...validInput, lines: [{ accountCode: "4020", quantity: 1, unitPrice: 999 }] },
      buildChartByCode(CHART)
    );
    if (!bad.ok) throw new Error("setup failed");

    // ลบรหัส 4020 ออกจากผังก่อน generate (จำลองบัญชีถูกลบก่อนถึงรอบ เฉพาะเทมเพลตที่ 2)
    tables.chart_of_accounts = tables.chart_of_accounts.filter((r) => r.code !== "4020");

    const summary = await generateDueOccurrences(db, TENANT, "2026-08-01");
    expect(summary.scanned).toBe(2);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(tables.bill_entries).toHaveLength(1);
  });
});

describe("listOccurrencesByTemplateIds", () => {
  it("โหลด occurrence ที่ผูกกับเทมเพลตในลิสต์ — ไม่ปนของเทมเพลตอื่น", async () => {
    const { db } = makeFakeDb();
    const t1 = await upsertTemplate(db, TENANT, CUSTOMER, validInput, buildChartByCode(CHART));
    if (!t1.ok) throw new Error("setup failed");
    await generateOccurrenceForTemplate(db, TENANT, t1.id, "2026-08-01");

    const occ = await listOccurrencesByTemplateIds(db, TENANT, CUSTOMER, [t1.id]);
    expect(occ).toHaveLength(1);
    expect(occ[0].templateId).toBe(t1.id);
    expect(occ[0].status).toBe("draft");
  });

  it("templateIds ว่าง → คืน [] โดยไม่ query", async () => {
    const { db } = makeFakeDb();
    expect(await listOccurrencesByTemplateIds(db, TENANT, CUSTOMER, [])).toEqual([]);
  });
});
