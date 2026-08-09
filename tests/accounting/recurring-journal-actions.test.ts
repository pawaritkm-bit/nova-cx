import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";

/**
 * เทสต์ server actions ของหน้า "รายการบันทึกซ้ำ" (/chat-audit/accounting/recurring-journal — เฟส 6 ส่วน R)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/journal-entry-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD (T42/T43):
 *     - guard สโคป: นักบัญชีนอกสโคปทำเทมเพลตของลูกค้าอื่นไม่ได้ (ทั้ง save/toggle/delete/generateNow)
 *     - generateNowAction: บังคับ today = todayIsoThai() (ฝั่ง server) เสมอ — action ไม่มีพารามิเตอร์
 *       รับ "today" จาก client เลยแม้แต่น้อย (ดู signature จริงของ generateNowAction(id, customerId))
 *     - 0.3: occurrence ที่สร้างจากปุ่ม "สร้างตอนนี้" ต้องเป็น draft เสมอ ไม่ auto-confirm
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

// ★ mock todayIsoThai แบบ partial (คง export อื่นทั้งหมดของจริง) — ควบคุมวันที่ "ปัจจุบัน" ให้ deterministic
//   ในเทสต์ แต่ยังยืนยันว่า action เรียกฟังก์ชันนี้จริง (ไม่รับ today จาก client)
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
  saveTemplateAction,
  toggleTemplateActiveAction,
  deleteTemplateAction,
  generateNowAction,
} from "@/app/chat-audit/accounting/recurring-journal/actions";

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
// fake DB stateful in-memory (pattern เดียวกับ tests/accounting/recurring-journal.test.ts)
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

const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
  recurring_journal_templates: { last_generated_at: null, deleted_at: null, end_date: null },
  recurring_journal_generation_log: { message: null, manual_entry_id: null },
  manual_journal_entries: { deleted_at: null, recurring_template_id: null, doc_no: null, memo: null },
};

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const t: Tables = {
    recurring_journal_templates: [],
    recurring_journal_template_lines: [],
    recurring_journal_generation_log: [],
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
  // ★ ต้องเป็น uuid จริง — actions.ts เช็ค isUuid(id) ก่อนแตะ DB เสมอ (ไม่ใช่แค่ "table-1" แบบ
  //   tests/accounting/recurring-journal.test.ts ที่เรียก data layer ตรง ๆ ไม่ผ่าน isUuid guard)
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

  // จำลอง RPC claim_recurring_je_occurrence (mirror ตรรกะ SQL migration 0073 — for update skip locked
  //   ไม่จำลองที่นี่ เพราะเทสต์ single-threaded — ยืนยันแล้วที่ระดับ SQL จริงโดย agent ก่อนหน้า)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "claim_recurring_je_occurrence") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const today = params.p_today as string;
    const row = t.recurring_journal_templates.find(
      (r) =>
        r.id === params.p_template_id &&
        r.tenant_id === params.p_tenant_id &&
        !r.deleted_at &&
        r.is_active === true &&
        (r.next_run_date as string) <= today &&
        (r.end_date === null || (r.next_run_date as string) <= (r.end_date as string))
    );
    if (!row) return Promise.resolve({ data: { claimed: false }, error: null });
    row.last_generated_at = "2026-08-09T00:00:00Z";
    return Promise.resolve({
      data: {
        claimed: true,
        run_date: row.next_run_date,
        doc_type: row.doc_type,
        memo: row.memo,
        customer_id: row.customer_id,
      },
      error: null,
    });
  }

  return { db: { from: (name: string) => qb(name as keyof Tables), rpc } as unknown as SupabaseClient, tables: t };
}

const balancedLines = [
  { accountCode: "5344", debit: 5000, credit: 0 },
  { accountCode: "2015", debit: 0, credit: 5000 },
];
const unbalancedLines = [
  { accountCode: "5344", debit: 5000, credit: 0 },
  { accountCode: "2015", debit: 0, credit: 4000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  todayIsoThaiMock.mockReturnValue(MOCK_TODAY);
  const made = makeFakeDb();
  currentDb = made.db;
  tables = made.tables;
});

// ---------------------------------------------------------------------
// saveTemplateAction
// ---------------------------------------------------------------------
describe("saveTemplateAction", () => {
  it("สร้างเทมเพลตใหม่ + สมดุล → บันทึกสำเร็จ", async () => {
    const res = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(true);
    expect(tables.recurring_journal_templates).toHaveLength(1);
    expect(tables.recurring_journal_templates[0].next_run_date).toBe("2026-08-01");
  });

  it("★ เดบิต ≠ เครดิต (ไม่สมดุล) → บันทึกไม่สำเร็จ ไม่มี insert เกิดขึ้นเลย", async () => {
    const res = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: unbalancedLines,
    });
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates).toHaveLength(0);
  });

  it("★ frequency ไม่รู้จัก (เช่น weekly) → ปฏิเสธ (0.2)", async () => {
    const res = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "weekly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates).toHaveLength(0);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → บันทึกไม่สำเร็จ", async () => {
    const res = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: [
        { accountCode: "9999-ไม่มีจริง", debit: 5000, credit: 0 },
        { accountCode: "2015", debit: 0, credit: 5000 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates).toHaveLength(0);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates).toHaveLength(0);
  });

  it("แก้ไขเทมเพลตที่มี id แต่ customerId ไม่ตรงของเดิม → ปฏิเสธ", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(created.ok).toBe(true);
    const res = await saveTemplateAction({
      id: created.id,
      customerId: CUSTOMER_OTHER,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
  });

  it("ไม่พบเทมเพลตเดิม (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    const res = await saveTemplateAction({
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// toggleTemplateActiveAction / deleteTemplateAction
// ---------------------------------------------------------------------
describe("toggleTemplateActiveAction", () => {
  it("ปิดใช้งานสำเร็จ", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    const res = await toggleTemplateActiveAction(created.id, CUSTOMER_ID, false);
    expect(res.ok).toBe(true);
    expect(tables.recurring_journal_templates[0].is_active).toBe(false);
  });

  it("★ ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await toggleTemplateActiveAction(created.id, CUSTOMER_ID, false);
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates[0].is_active).toBe(true);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await toggleTemplateActiveAction("not-a-uuid", CUSTOMER_ID, false);
    expect(res.ok).toBe(false);
  });
});

describe("deleteTemplateAction", () => {
  it("ลบสำเร็จ (soft-delete)", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    const res = await deleteTemplateAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(tables.recurring_journal_templates[0].deleted_at).toBeTruthy();
  });

  it("★ ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-08-01",
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteTemplateAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.recurring_journal_templates[0].deleted_at).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// generateNowAction — ★ 0.3/0.4 บังคับวันที่ปัจจุบันจริงเสมอ (today จาก todayIsoThai() ฝั่ง server เท่านั้น)
// ---------------------------------------------------------------------
describe("generateNowAction", () => {
  it("★ เทมเพลตถึงกำหนดวันนี้พอดี → สร้าง occurrence เป็น draft เสมอ (ไม่ auto-confirm) ด้วยวันที่จาก todayIsoThai()", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: MOCK_TODAY, // next_run_date = startDate ตอนสร้างใหม่ (=วันนี้พอดี)
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER_ID;

    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(todayIsoThaiMock).toHaveBeenCalled();
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft");
    expect(tables.manual_journal_entries[0].doc_date).toBe(MOCK_TODAY);
    expect(tables.manual_journal_entries[0].recurring_template_id).toBe(created.id);
  });

  it("เทมเพลตยังไม่ถึงกำหนด (next_run_date ในอนาคต) → ไม่สร้างอะไร แจ้งข้อความ ไม่ throw", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: "2026-12-01", // อนาคตเทียบ MOCK_TODAY
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER_ID;

    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่เรียก generate เลย", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: MOCK_TODAY,
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER_ID;

    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await generateNowAction(created.id, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("customerId ไม่ตรงกับเจ้าของเทมเพลตจริง (สวมรอย) → ปฏิเสธ", async () => {
    const created = await saveTemplateAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      frequency: "monthly",
      startDate: MOCK_TODAY,
      lines: balancedLines,
    });
    if (!created.ok || !created.id) throw new Error("setup failed");
    tables.recurring_journal_templates[0].customer_id = CUSTOMER_ID;

    // admin เห็นทุกลูกค้า แต่ customerId ที่ส่งมาไม่ตรงกับเจ้าของเทมเพลตจริง → ต้องปฏิเสธ
    const res = await generateNowAction(created.id, CUSTOMER_OTHER);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await generateNowAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});
