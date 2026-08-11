import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  outstandingFxForEntry,
  unrealizedFxGainLoss,
  computeGroupUnrealizedAmount,
  buildRevaluationEntryInput,
  buildReversingEntryInput,
  nextPeriodStartDate,
  loadOutstandingFxGroup,
  deriveLiveRevaluationStatus,
  assertNoPendingCycle,
  assertReversalConfirmedForPayment,
  createFxRevaluationDraft,
  confirmFxRevaluation,
  confirmFxReversing,
  unconfirmFxReversing,
  voidFxPeriodRevaluationIfJeDeleted,
  listFxPeriodRevaluations,
  countOverdueUnconfirmedReversals,
  isRevaluationOrReversingJeId,
  isFxCycleConfirmedForJe,
  listActiveFxJeIds,
  getFxPeriodRevaluationCustomerId,
} from "@/lib/accounting/fx-revaluation";
import { realizedFxGainLoss } from "@/lib/accounting/fx";
import { isBalanced } from "@/lib/accounting/manual-journal";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";

/**
 * fx-revaluation.ts — เฟส 10b (docs/06-accounting-features-roadmap.md บรรทัด 5485-6084) — หัวใจของเฟสนี้
 *   เน้น: outstandingFxForEntry ทุก branch · unrealizedFxGainLoss = reuse fx.ts::realizedFxGainLoss ตรง ๆ
 *   (พิสูจน์ไม่ใช่สูตรคู่ขนาน) · golden test 3 งวดต่อเนื่องตรงย่อหน้า 29 (0.2) · buildRevaluationEntryInput/
 *   buildReversingEntryInput สมดุลเสมอ · deriveLiveRevaluationStatus ทุก state · guard #1/#2 ทุกเคส
 */

const chartByCode = buildChartByCode(TEST_CHART);

// ---------------------------------------------------------------------
// outstandingFxForEntry (0.4)
// ---------------------------------------------------------------------
describe("outstandingFxForEntry", () => {
  it("ไม่มี payment เลย → เต็มยอด", () => {
    expect(outstandingFxForEntry(1000, [])).toBe(1000);
  });

  it("มี payment บางส่วน → ลดลงตามยอดที่จ่ายจริง", () => {
    expect(outstandingFxForEntry(1000, [{ fxAmount: 400, payDate: "2026-08-01" }])).toBe(600);
  });

  it("มี payment เกินยอด (ไม่ควรเกิดจาก flow ปกติ — defensive) → ติดลบ ไม่ throw", () => {
    expect(outstandingFxForEntry(1000, [{ fxAmount: 1500, payDate: "2026-08-01" }])).toBe(-500);
  });

  it("มี fxNoteAdjustment (CN ลบ/DN บวก)", () => {
    expect(outstandingFxForEntry(1000, [], -200)).toBe(800);
    expect(outstandingFxForEntry(1000, [], 150)).toBe(1150);
  });

  it("asOfDate ตัดพอดี — payDate ≤ asOfDate นับ, > asOfDate ไม่นับ (inclusive)", () => {
    const payments = [
      { fxAmount: 300, payDate: "2026-08-01" },
      { fxAmount: 200, payDate: "2026-08-15" },
    ];
    expect(outstandingFxForEntry(1000, payments, 0, "2026-08-10")).toBe(700); // หัก 300 อย่างเดียว
    expect(outstandingFxForEntry(1000, payments, 0, "2026-08-01")).toBe(700); // ตรงวันพอดี นับด้วย
    expect(outstandingFxForEntry(1000, payments, 0, "2026-08-15")).toBe(500); // ตรงวันพอดี นับทั้งคู่
  });

  it("ไม่ส่ง asOfDate → ไม่กรอง payments เลย", () => {
    const payments = [{ fxAmount: 300, payDate: "2099-01-01" }];
    expect(outstandingFxForEntry(1000, payments)).toBe(700);
  });
});

// ---------------------------------------------------------------------
// unrealizedFxGainLoss — ★ ต้องเป็นตัวเดียวกันกับ fx.ts::realizedFxGainLoss เป๊ะ (0.2, ไม่ใช่สูตรคู่ขนาน)
// ---------------------------------------------------------------------
describe("unrealizedFxGainLoss", () => {
  it("เป็น reference เดียวกับ fx.ts::realizedFxGainLoss ตรง ๆ (import แล้ว re-export ไม่ copy สูตร)", () => {
    expect(unrealizedFxGainLoss).toBe(realizedFxGainLoss);
  });

  it("ผลลัพธ์เทียบกับเรียก fx.ts::realizedFxGainLoss ตรง ๆ ด้วยพารามิเตอร์เดียวกันทุกเคส", () => {
    const cases: [("sale" | "purchase"), number, number, number][] = [
      ["sale", 10000, 33.0, 33.5],
      ["sale", 10000, 33.5, 33.0],
      ["purchase", 500, 5.0, 4.8],
      ["purchase", 1234.56, 36.789, 35.001],
      ["sale", 100, 35.0, 35.0],
    ];
    for (const [entryType, fx, invoiceRate, closingRate] of cases) {
      expect(unrealizedFxGainLoss(entryType, fx, invoiceRate, closingRate)).toBe(
        realizedFxGainLoss(entryType, fx, invoiceRate, closingRate)
      );
    }
  });
});

// ---------------------------------------------------------------------
// computeGroupUnrealizedAmount — รวมยอดหลายบิลที่ invoiceFxRate ต่างกัน (หมวด 5 ความเสี่ยง)
// ---------------------------------------------------------------------
describe("computeGroupUnrealizedAmount", () => {
  it("บิลเดียว → เท่ากับ unrealizedFxGainLoss ตรง ๆ", () => {
    const bills = [{ outstandingFxAmount: 10000, invoiceFxRate: 33.0 }];
    expect(computeGroupUnrealizedAmount(bills, "sale", 33.5)).toBe(5000);
  });

  it("หลายบิล invoiceFxRate ต่างกัน → คำนวณต่อบิลแล้วรวม (ไม่ใช่เอายอดรวมคูณ closingRate ตรง ๆ)", () => {
    const bills = [
      { outstandingFxAmount: 10000, invoiceFxRate: 33.0 }, // sale: (33.5-33.0)*10000 = 5000
      { outstandingFxAmount: 5000, invoiceFxRate: 34.0 }, // sale: (33.5-34.0)*5000 = -2500
    ];
    expect(computeGroupUnrealizedAmount(bills, "sale", 33.5)).toBe(2500);
  });

  it("ฝั่งซื้อ (purchase) ทิศตรงข้ามขาย", () => {
    const bills = [{ outstandingFxAmount: 1000, invoiceFxRate: 5.0 }];
    expect(computeGroupUnrealizedAmount(bills, "purchase", 4.8)).toBe(200); // กำไร (จ่ายน้อยกว่าที่ตั้งไว้)
  });
});

// ---------------------------------------------------------------------
// buildRevaluationEntryInput (0.7 ของไฟล์นี้)
// ---------------------------------------------------------------------
describe("buildRevaluationEntryInput", () => {
  it("unrealized > 0 → Dr AR/AP · Cr gainLoss, isBalanced ผ่าน", () => {
    const input = buildRevaluationEntryInput("sale", 5000, "1140", "4025", "2026-07-31", "memo");
    expect(input).not.toBeNull();
    expect(input!.docType).toBe("JV");
    const lines = input!.lines as { accountCode: string; debit: number; credit: number }[];
    expect(isBalanced(lines)).toBe(true);
    const ar = lines.find((l) => l.accountCode === "1140")!;
    expect(ar.debit).toBe(5000);
    expect(ar.credit).toBe(0);
    const fx = lines.find((l) => l.accountCode === "4025")!;
    expect(fx.credit).toBe(5000);
  });

  it("unrealized < 0 → Dr gainLoss · Cr AR/AP (ขนาด |amount|), isBalanced ผ่าน", () => {
    const input = buildRevaluationEntryInput("sale", -3000, "1140", "4025", "2026-07-31", "memo");
    expect(input).not.toBeNull();
    const lines = input!.lines as { accountCode: string; debit: number; credit: number }[];
    expect(isBalanced(lines)).toBe(true);
    const ar = lines.find((l) => l.accountCode === "1140")!;
    expect(ar.credit).toBe(3000);
    const fx = lines.find((l) => l.accountCode === "4025")!;
    expect(fx.debit).toBe(3000);
  });

  it("purchase ก็ใช้กติกาทิศทางเดียวกัน (ไม่ขึ้นกับ entryType — ขึ้นกับเครื่องหมาย unrealizedAmount เท่านั้น)", () => {
    const input = buildRevaluationEntryInput("purchase", 800, "2010", "4025", "2026-07-31", "memo");
    const lines = input!.lines as { accountCode: string; debit: number; credit: number }[];
    const ap = lines.find((l) => l.accountCode === "2010")!;
    expect(ap.debit).toBe(800);
  });

  it("★ unrealized = 0 → คืน null (ไม่มี JV เปล่า)", () => {
    expect(buildRevaluationEntryInput("sale", 0, "1140", "4025", "2026-07-31", "memo")).toBeNull();
  });

  it("ติด fx metadata ที่ทุกบรรทัดเมื่อส่ง fxMeta มา", () => {
    const input = buildRevaluationEntryInput("sale", 5000, "1140", "4025", "2026-07-31", "memo", {
      currency: "USD",
      closingRate: 33.5,
      outstandingFxAmount: 10000,
    });
    const lines = input!.lines as { fxCurrency?: string; fxRate?: number; fxAmount?: number }[];
    for (const l of lines) {
      expect(l.fxCurrency).toBe("USD");
      expect(l.fxRate).toBe(33.5);
      expect(l.fxAmount).toBe(10000);
    }
  });
});

// ---------------------------------------------------------------------
// buildReversingEntryInput (0.9) — สลับ debit/credit เป๊ะ ไม่คำนวณใหม่
// ---------------------------------------------------------------------
describe("buildReversingEntryInput", () => {
  const revalLines = [
    { accountCode: "1140", accountName: "ลูกหนี้การค้า", description: null, debit: 5000, credit: 0, fxCurrency: "USD", fxRate: 33.5, fxAmount: 10000 },
    { accountCode: "4025", accountName: "กำไร FX", description: null, debit: 0, credit: 5000, fxCurrency: "USD", fxRate: 33.5, fxAmount: 10000 },
  ];

  it("สลับ debit↔credit ของทุกบรรทัดเป๊ะ (ไม่คำนวณใหม่)", () => {
    const input = buildReversingEntryInput(revalLines, "2026-08-01", "memo กลับรายการ");
    const lines = input.lines as { accountCode: string; debit: number; credit: number }[];
    expect(lines[0]).toMatchObject({ accountCode: "1140", debit: 0, credit: 5000 });
    expect(lines[1]).toMatchObject({ accountCode: "4025", debit: 5000, credit: 0 });
    expect(isBalanced(lines)).toBe(true);
    expect(input.docDate).toBe("2026-08-01");
    expect(input.docType).toBe("JV");
  });

  it("รักษา fx metadata ไว้ (ไม่ลบ/ไม่เปลี่ยน)", () => {
    const input = buildReversingEntryInput(revalLines, "2026-08-01", "memo");
    const lines = input.lines as { fxCurrency?: string; fxAmount?: number }[];
    expect(lines[0].fxCurrency).toBe("USD");
    expect(lines[0].fxAmount).toBe(10000);
  });
});

// ---------------------------------------------------------------------
// nextPeriodStartDate — รองรับข้ามเดือน/ข้ามปี
// ---------------------------------------------------------------------
describe("nextPeriodStartDate", () => {
  it("วันปกติ +1 วัน", () => {
    expect(nextPeriodStartDate("2026-07-15")).toBe("2026-07-16");
  });
  it("ข้ามเดือน", () => {
    expect(nextPeriodStartDate("2026-07-31")).toBe("2026-08-01");
  });
  it("ข้ามปี", () => {
    expect(nextPeriodStartDate("2026-12-31")).toBe("2027-01-01");
  });
  it("เดือนกุมภาพันธ์ปีอธิกสุรทิน", () => {
    expect(nextPeriodStartDate("2028-02-29")).toBe("2028-03-01");
  });
});

// ---------------------------------------------------------------------
// ★★★ golden test 3 งวดต่อเนื่อง (T130) — ต้องตรงย่อหน้า 29 TAS 21 เป๊ะ ≥2 ชุดตัวเลขอิสระ (0.2)
// ---------------------------------------------------------------------
describe("golden test — 3 งวดต่อเนื่อง ตรงย่อหน้า 29 TAS 21 เป๊ะ (0.2)", () => {
  function runScenario(opts: {
    entryType: "sale" | "purchase";
    fxAmount: number;
    invoiceRate: number;
    closingRate1: number;
    settleRate2: number;
  }) {
    const { entryType, fxAmount, invoiceRate, closingRate1, settleRate2 } = opts;
    // (1) unrealized งวด 1 (invoice rate → closing rate งวด 1)
    const unrealizedP1 = unrealizedFxGainLoss(entryType, fxAmount, invoiceRate, closingRate1);
    // (2) reversing (สลับ debit/credit) — pure structural, ไม่กระทบตัวเลข (ยืนยันแค่ isBalanced)
    const revalInput = buildRevaluationEntryInput(entryType, unrealizedP1, entryType === "sale" ? "1140" : "2010", "4025", "2026-06-30", "m")!;
    const reversingInput = buildReversingEntryInput(revalInput.lines as never, "2026-07-01", "m");
    expect(isBalanced(reversingInput.lines as never)).toBe(true);
    // (3) realized งวด 2 (สูตรเดิมเฟส 10a — invoice rate → settlement rate งวด 2, ไม่แก้ fx.ts)
    const realizedP2 = realizedFxGainLoss(entryType, fxAmount, invoiceRate, settleRate2);
    // (4) รวม P&L งวด 2 = reversal(-unrealizedP1) + realized(P2)
    const totalP2 = round2(-unrealizedP1 + realizedP2);
    const expected = round2(fxAmount * (entryType === "sale" ? settleRate2 - closingRate1 : closingRate1 - settleRate2));
    expect(totalP2).toBe(expected);
  }
  function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  it("ชุด 1 (ตามตัวอย่างในแผน 0.2) — ขาย USD 10,000 @33.00 → ปิดงวด1 @33.50 → settle งวด2 @34.00 → +5,000", () => {
    runScenario({ entryType: "sale", fxAmount: 10000, invoiceRate: 33.0, closingRate1: 33.5, settleRate2: 34.0 });
  });

  it("ชุด 2 (อิสระ, ตัวเลขต่างชุด) — ซื้อ CNY 2,500 @5.20 → ปิดงวด1 @5.00 → settle งวด2 @4.90", () => {
    runScenario({ entryType: "purchase", fxAmount: 2500, invoiceRate: 5.2, closingRate1: 5.0, settleRate2: 4.9 });
  });

  it("ชุด 3 (อิสระ, ทศนิยมไม่กลม) — ขาย EUR 1,234.56 @37.111 → ปิดงวด1 @37.789 → settle งวด2 @36.5", () => {
    runScenario({ entryType: "sale", fxAmount: 1234.56, invoiceRate: 37.111, closingRate1: 37.789, settleRate2: 36.5 });
  });
});

// ---------------------------------------------------------------------
// data layer — fake DB เบา (manual_journal_entries + fx_period_revaluations เท่านั้น) สำหรับ
//   deriveLiveRevaluationStatus/assertNoPendingCycle/assertReversalConfirmedForPayment/
//   isRevaluationOrReversingJeId/listActiveFxJeIds/countOverdueUnconfirmedReversals/
//   voidFxPeriodRevaluationIfJeDeleted/listFxPeriodRevaluations/getFxPeriodRevaluationCustomerId
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in" | "lte" | "neq"; val: unknown };
type OrderSpec = { col: string; ascending: boolean };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.op === "neq") return row[f.col] !== f.val;
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.op === "lte") return (row[f.col] as string) <= (f.val as string);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

/** DB จำลองหลายตาราง — ใช้ร่วมทั้งไฟล์ (mirror pattern ของ phase3-j-k-integration.test.ts::makeMultiTableDb
 *  ขยายเพิ่ม manual_journal_entries/manual_journal_entry_lines/fx_period_revaluations/chart_of_accounts) */
function makeMultiTableDb() {
  const tables: Record<string, Row[]> = {
    bill_entries: [],
    bill_entry_lines: [],
    bill_payments: [],
    credit_debit_notes: [],
    credit_debit_note_lines: [],
    customer_bank_accounts: [],
    customers: [],
    chart_of_accounts: [],
    manual_journal_entries: [],
    manual_journal_entry_lines: [],
    fx_period_revaluations: [],
  };
  let seq = 1;
  function nextId(table: string): string {
    return `${table}-${seq++}`;
  }

  function applySort(rows: Row[], orders: OrderSpec[]): Row[] {
    if (orders.length === 0) return rows;
    const sorted = [...rows];
    sorted.sort((a, b) => {
      for (const o of orders) {
        const av = a[o.col];
        const bv = b[o.col];
        if (av === bv) continue;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        const cmp = av > bv ? 1 : -1;
        return o.ascending ? cmp : -cmp;
      }
      return 0;
    });
    return sorted;
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    const orders: OrderSpec[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.neq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "neq", val: v });
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
      orders.push({ col: c, ascending: opts?.ascending !== false });
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
    api.maybeSingle = () => {
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        let firstId = "";
        for (const r of rows as Row[]) {
          const id = ((r as Row).id as string) ?? nextId(table);
          if (!firstId) firstId = id;
          tables[table].push({ id, deleted_at: null, ...(r as Row) });
        }
        return Promise.resolve({ data: { id: firstId }, error: null });
      }
      if (mode === "update") {
        const matched = (tables[table] ?? []).filter((r) => matchRow(r, filters));
        for (const row of matched) Object.assign(row, payload as Row);
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      }
      if (mode === "delete") {
        const matched = (tables[table] ?? []).filter((r) => matchRow(r, filters));
        tables[table] = (tables[table] ?? []).filter((r) => !matchRow(r, filters));
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      }
      const rows = applySort((tables[table] ?? []).filter((r) => matchRow(r, filters)), orders);
      return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          const id = ((r as Row).id as string) ?? nextId(table);
          tables[table].push({ id, deleted_at: null, ...(r as Row) });
        }
        data = null;
      } else if (mode === "update") {
        for (const row of tables[table] ?? []) if (matchRow(row, filters)) Object.assign(row, payload as Row);
        data = null;
      } else if (mode === "delete") {
        tables[table] = (tables[table] ?? []).filter((r) => !matchRow(r, filters));
        data = null;
      } else {
        data = applySort((tables[table] ?? []).filter((r) => matchRow(r, filters)), orders);
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, tables };
}

function seedJe(tables: Record<string, Row[]>, id: string, p: { status: "draft" | "confirmed"; deleted?: boolean }) {
  tables.manual_journal_entries.push({
    id,
    tenant_id: "t1",
    customer_id: "c1",
    doc_type: "JV",
    doc_date: "2026-06-30",
    doc_no: null,
    memo: null,
    status: p.status,
    created_at: "2026-06-30T00:00:00Z",
    confirmed_at: p.status === "confirmed" ? "2026-06-30T00:00:00Z" : null,
    deleted_at: p.deleted ? "2026-07-01T00:00:00Z" : null,
  });
}

function seedJeLines(tables: Record<string, Row[]>, entryId: string, lines: { accountCode: string; debit: number; credit: number }[]) {
  lines.forEach((l, i) => {
    tables.manual_journal_entry_lines.push({
      id: `${entryId}-l${i}`,
      entry_id: entryId,
      tenant_id: "t1",
      line_no: i + 1,
      account_code: l.accountCode,
      account_name: null,
      description: null,
      debit: l.debit,
      credit: l.credit,
      fx_currency: "USD",
      fx_rate: 33.5,
      fx_amount: 10000,
    });
  });
}

function seedFxRevalRow(
  tables: Record<string, Row[]>,
  id: string,
  p: {
    customerId?: string;
    entryType?: "sale" | "purchase";
    currency?: string;
    periodEndDate: string;
    closingRate?: number;
    revaluationJeId: string | null;
    reversingJeId?: string | null;
    status: "reval_draft" | "reversing_draft" | "reversing_confirmed" | "voided";
    deleted?: boolean;
  }
) {
  tables.fx_period_revaluations.push({
    id,
    tenant_id: "t1",
    customer_id: p.customerId ?? "c1",
    entry_type: p.entryType ?? "sale",
    currency: p.currency ?? "USD",
    period_end_date: p.periodEndDate,
    closing_rate: p.closingRate ?? 33.5,
    source: "manual",
    outstanding_fx_amount: 10000,
    unrealized_amount: 5000,
    revaluation_je_id: p.revaluationJeId,
    reversing_je_id: p.reversingJeId ?? null,
    status: p.status,
    created_at: "2026-06-30T00:00:00Z",
    deleted_at: p.deleted ? "2026-07-05T00:00:00Z" : null,
  });
}

describe("deriveLiveRevaluationStatus (0.12/0.14)", () => {
  it("revaluation JE ไม่พบ → voided", async () => {
    const { db } = makeMultiTableDb();
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "missing", reversingJeId: null });
    expect(status).toBe("voided");
  });

  it("revaluation JE ถูกลบ (soft-delete) → voided (0.14)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: null });
    expect(status).toBe("voided");
  });

  it("revaluation JE ยัง draft → reval_draft", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "draft" });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: null });
    expect(status).toBe("reval_draft");
  });

  it("revaluation confirmed แต่ยังไม่มี reversing_je_id → reval_draft (defensive, สถานะกึ่งกลาง)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: null });
    expect(status).toBe("reval_draft");
  });

  it("reversing JE ถูกลบ → voided", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft", deleted: true });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: "je2" });
    expect(status).toBe("voided");
  });

  it("reversing ยังไม่ confirmed → reversing_draft", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: "je2" });
    expect(status).toBe("reversing_draft");
  });

  it("reversing confirmed → reversing_confirmed", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" });
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: "je2" });
    expect(status).toBe("reversing_confirmed");
  });

  it("★ ไม่เชื่อ cache — สถานะ live ต้องถูกต้องแม้ cache ของ row จะผิด (status drift, 0.12)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" }); // reversing ยังไม่ confirmed จริง
    // cache (สมมติค้างผิด) บอกว่า reversing_confirmed แล้ว — deriveLiveRevaluationStatus ต้องไม่เชื่อ
    const status = await deriveLiveRevaluationStatus(db, "t1", { revaluationJeId: "je1", reversingJeId: "je2" });
    expect(status).toBe("reversing_draft");
  });
});

describe("assertNoPendingCycle (guard #1, 0.8/0.10)", () => {
  it("ไม่มีรอบก่อนหน้าเลย → ผ่าน", async () => {
    const { db } = makeMultiTableDb();
    const res = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-07-31");
    expect(res.ok).toBe(true);
  });

  it("รอบก่อนหน้า live-status ยังไม่ reversing_confirmed → ปฏิเสธ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" }); // reversing ยังไม่ confirm
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_draft",
    });
    const res = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-07-31");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.blockingRevaluationId).toBe("r1");
  });

  it("รอบก่อนหน้า reversing_confirmed จริง (live) → ผ่าน", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_confirmed",
    });
    const res = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-07-31");
    expect(res.ok).toBe(true);
  });

  it("periodEndDate ใหม่ ≤ ของรอบล่าสุด (แม้ reversing confirmed แล้ว) → ปฏิเสธ (ลำดับเวลาต้องต่อเนื่อง)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_confirmed",
    });
    const sameDate = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(sameDate.ok).toBe(false);
    const earlier = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-05-31");
    expect(earlier.ok).toBe(false);
  });

  it("★ 0.14 — รอบก่อนหน้าถูก voided (JE เดิมถูกลบ) → ไม่นับเป็นข้อจำกัด (ผ่าน)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true }); // ถูกลบ → live-status voided
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: null,
      status: "reval_draft", // cache ค้างผิด (ไม่ใช่ voided) — ต้องเช็ค live ไม่ใช่ cache
    });
    const res = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-08-31");
    expect(res.ok).toBe(true);
  });

  it("แยกกลุ่มตาม currency/entryType — กลุ่มอื่นไม่ถูกบล็อกข้ามกัน", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", {
      currency: "USD",
      entryType: "sale",
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_draft",
    });
    const otherCurrency = await assertNoPendingCycle(db, "t1", "c1", "EUR", "sale", "2026-07-31");
    expect(otherCurrency.ok).toBe(true);
    const otherEntryType = await assertNoPendingCycle(db, "t1", "c1", "USD", "purchase", "2026-07-31");
    expect(otherEntryType.ok).toBe(true);
    const otherCustomer = await assertNoPendingCycle(db, "t1", "c2", "USD", "sale", "2026-07-31");
    expect(otherCustomer.ok).toBe(true);
  });
});

describe("assertReversalConfirmedForPayment (guard #2, 0.11)", () => {
  it("ไม่มี cycle ที่เกี่ยวข้องเลย → ผ่าน (ไม่กระทบ flow ปกติของเฟส 10a)", async () => {
    const { db } = makeMultiTableDb();
    const res = await assertReversalConfirmedForPayment(db, "t1", "c1", "USD", "sale", "2026-08-15");
    expect(res.ok).toBe(true);
  });

  it("มี cycle แต่ reversing confirmed แล้ว (live) → ผ่าน", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30", // งวดใหม่เริ่ม 2026-07-01
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_confirmed",
    });
    const res = await assertReversalConfirmedForPayment(db, "t1", "c1", "USD", "sale", "2026-07-15");
    expect(res.ok).toBe(true);
  });

  it("มี cycle reversing ยังไม่ confirm และ payDate ≥ วันเริ่มงวดใหม่ → ปฏิเสธ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30", // งวดใหม่เริ่ม 2026-07-01
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_draft",
    });
    const res = await assertReversalConfirmedForPayment(db, "t1", "c1", "USD", "sale", "2026-07-01");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.blockingRevaluationId).toBe("r1");
  });

  it("payDate < วันเริ่มงวดใหม่ (ชำระในงวดเดิม) → ไม่ถูกบล็อกเลย", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: "je2",
      status: "reversing_draft",
    });
    const res = await assertReversalConfirmedForPayment(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(res.ok).toBe(true);
  });

  it("cycle ที่เกี่ยวข้อง voided แล้ว → ไม่บล็อก (ไม่มีอะไรให้สมมติฐานยึดอีกต่อไป)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true });
    seedFxRevalRow(tables, "r1", {
      periodEndDate: "2026-06-30",
      revaluationJeId: "je1",
      reversingJeId: null,
      status: "reval_draft",
    });
    const res = await assertReversalConfirmedForPayment(db, "t1", "c1", "USD", "sale", "2026-07-15");
    expect(res.ok).toBe(true);
  });
});

describe("isRevaluationOrReversingJeId (0.13)", () => {
  it("id เป็น revaluation_je_id ของแถวที่ยังไม่จบ cycle → true", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "reval_draft" });
    expect(await isRevaluationOrReversingJeId(db, "t1", "je1")).toBe(true);
  });

  it("id เป็น reversing_je_id ของแถวที่ยังไม่จบ cycle → true", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    expect(await isRevaluationOrReversingJeId(db, "t1", "je2")).toBe(true);
  });

  it("id ไม่เกี่ยวกับ fx revaluation เลย → false", async () => {
    const { db } = makeMultiTableDb();
    expect(await isRevaluationOrReversingJeId(db, "t1", "je-unrelated")).toBe(false);
  });

  it("แถวที่ voided แล้ว → คืน false (ไม่มีอะไรให้ปกป้องอีกต่อไป, T137 DoD)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "voided" });
    expect(await isRevaluationOrReversingJeId(db, "t1", "je1")).toBe(false);
  });

  it("★ แถว reversing_confirmed แล้ว (cycle จบสมบูรณ์) → ยังคืน true (ล็อกถาวร ไม่ปล่อยกลับไปแก้ผ่านปุ่ม generic ได้อีก — กัน status drift ตามหมวด 5 ของแผน แม้ cycle จบแล้วก็ตาม)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_confirmed" });
    expect(await isRevaluationOrReversingJeId(db, "t1", "je1")).toBe(true);
    expect(await isRevaluationOrReversingJeId(db, "t1", "je2")).toBe(true);
  });
});

describe("isFxCycleConfirmedForJe (QC fix เฟส 10b — ปุ่ม 'ลบ' ของหน้า journal-entry)", () => {
  it("id ไม่เกี่ยวกับ fx revaluation เลย → false (ลบได้ปกติ)", async () => {
    const { db } = makeMultiTableDb();
    expect(await isFxCycleConfirmedForJe(db, "t1", "je-unrelated")).toBe(false);
  });

  it("revaluation JE ยังเป็น draft (cache 'reval_draft') → false (ลบได้ ไม่มีอะไรตกค้าง) — id ที่เช็คคือตัว revaluation JE เอง", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "draft" });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "reval_draft" });
    expect(await isFxCycleConfirmedForJe(db, "t1", "je1")).toBe(false);
  });

  it("★ revaluation JE confirmed แล้ว (cache 'reversing_draft') → true แม้ id ที่เช็คคือ reversing JE (draft, ยังไม่ confirm) — ปิดช่องโหว่ 'ลบเฉพาะ reversing JE เดี่ยวๆ'", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" }); // revaluation JE confirmed แล้ว
    seedJe(tables, "je2", { status: "draft" }); // reversing JE ยังไม่ confirm
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    expect(await isFxCycleConfirmedForJe(db, "t1", "je2")).toBe(true); // เช็คที่ reversing JE
    expect(await isFxCycleConfirmedForJe(db, "t1", "je1")).toBe(true); // เช็คที่ revaluation JE เอง
  });

  it("cycle จบสมบูรณ์แล้ว (reversing_confirmed) → true ทั้ง revaluation และ reversing JE (ต้องไปยกเลิกยืนยันที่หน้า FX ก่อนเท่านั้น)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_confirmed" });
    expect(await isFxCycleConfirmedForJe(db, "t1", "je1")).toBe(true);
    expect(await isFxCycleConfirmedForJe(db, "t1", "je2")).toBe(true);
  });

  it("revaluation JE ถูกลบไปแล้ว (live = voided) → false แม้ cache ยังค้างเป็น 'reversing_draft' (เช็ค live state จริง ไม่เชื่อ cache)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    expect(await isFxCycleConfirmedForJe(db, "t1", "je2")).toBe(false);
  });
});

describe("listActiveFxJeIds (0.13, UI hint)", () => {
  it("รวม id ของแถวที่ยังไม่จบ cycle ทั้งสองคอลัมน์ ของลูกค้ารายนั้น", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { customerId: "c1", periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    seedFxRevalRow(tables, "r3", { customerId: "c2", periodEndDate: "2026-06-30", revaluationJeId: "je5", status: "reval_draft" });
    const ids = await listActiveFxJeIds(db, "t1", "c1");
    expect(ids.has("je1")).toBe(true);
    expect(ids.has("je2")).toBe(true);
    expect(ids.has("je5")).toBe(false); // ลูกค้าอื่น
  });

  it("★ QC fix — ไม่ตัด 'reversing_confirmed' ออก (ต้องตรงกับ isRevaluationOrReversingJeId ที่ล็อกถาวรทุก status ที่ไม่ใช่ voided มิฉะนั้นปุ่ม generic จะโชว์ปกติทั้งที่กดแล้วถูกปฏิเสธเสมอ)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r2", { customerId: "c1", periodEndDate: "2026-05-31", revaluationJeId: "je3", reversingJeId: "je4", status: "reversing_confirmed" });
    const ids = await listActiveFxJeIds(db, "t1", "c1");
    expect(ids.has("je3")).toBe(true);
    expect(ids.has("je4")).toBe(true);
  });

  it("ตัดออกเฉพาะ 'voided' เท่านั้น", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { customerId: "c1", periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "voided" });
    const ids = await listActiveFxJeIds(db, "t1", "c1");
    expect(ids.has("je1")).toBe(false);
    expect(ids.has("je2")).toBe(false);
  });
});

describe("voidFxPeriodRevaluationIfJeDeleted (0.14)", () => {
  it("JE ถูกลบไปแล้ว แต่ cache ยังไม่ voided → refresh cache เป็น voided + คืน voided", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "reval_draft" });
    const live = await voidFxPeriodRevaluationIfJeDeleted(db, "t1", "r1");
    expect(live).toBe("voided");
    const row = tables.fx_period_revaluations.find((r) => r.id === "r1")!;
    expect(row.status).toBe("voided");
  });

  it("live ตรงกับ cache อยู่แล้ว → ไม่ update ซ้ำโดยไม่จำเป็น (แต่คืนค่าถูกต้อง)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "draft" });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "reval_draft" });
    const live = await voidFxPeriodRevaluationIfJeDeleted(db, "t1", "r1");
    expect(live).toBe("reval_draft");
  });

  it("ไม่พบแถว → null", async () => {
    const { db } = makeMultiTableDb();
    expect(await voidFxPeriodRevaluationIfJeDeleted(db, "t1", "missing")).toBeNull();
  });
});

describe("listFxPeriodRevaluations", () => {
  it("คืนรายการพร้อม liveStatus ที่ refresh แล้ว (ไม่ใช่แค่ cache)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed", deleted: true });
    seedFxRevalRow(tables, "r1", { customerId: "c1", periodEndDate: "2026-06-30", revaluationJeId: "je1", status: "reval_draft" });
    const list = await listFxPeriodRevaluations(db, "t1", "c1");
    expect(list).toHaveLength(1);
    expect(list[0].liveStatus).toBe("voided");
  });

  it("ลูกค้าอื่นไม่ปน", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { customerId: "c1", periodEndDate: "2026-06-30", revaluationJeId: null, status: "voided" });
    seedFxRevalRow(tables, "r2", { customerId: "c2", periodEndDate: "2026-06-30", revaluationJeId: null, status: "voided" });
    const list = await listFxPeriodRevaluations(db, "t1", "c1");
    expect(list.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("getFxPeriodRevaluationCustomerId", () => {
  it("คืน customerId ของแถวที่พบ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxRevalRow(tables, "r1", { customerId: "c9", periodEndDate: "2026-06-30", revaluationJeId: null, status: "voided" });
    expect(await getFxPeriodRevaluationCustomerId(db, "t1", "r1")).toBe("c9");
  });
  it("ไม่พบ → null", async () => {
    const { db } = makeMultiTableDb();
    expect(await getFxPeriodRevaluationCustomerId(db, "t1", "missing")).toBeNull();
  });
});

describe("countOverdueUnconfirmedReversals (0.18)", () => {
  it("นับเฉพาะที่เกิน threshold วันจริงและยังไม่ confirm (live)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" }); // ยังไม่ confirm
    // period_end_date 2026-06-30 → งวดใหม่เริ่ม 07-01 → ถ้า "วันนี้" = 07-10 = ค้าง 9 วัน ≥ 7
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    const count = await countOverdueUnconfirmedReversals(db, "t1", undefined, 7, "2026-07-10");
    expect(count).toBe(1);
  });

  it("ยังไม่ครบ threshold วัน → ไม่นับ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    const count = await countOverdueUnconfirmedReversals(db, "t1", undefined, 7, "2026-07-03"); // ค้างแค่ 2 วัน
    expect(count).toBe(0);
  });

  it("★ เช็ค live status จริง — แม้ cache='reversing_draft' แต่ live confirmed แล้ว → ไม่นับ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "confirmed" }); // live confirmed แล้วจริง (cache ค้างผิด)
    seedFxRevalRow(tables, "r1", { periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    const count = await countOverdueUnconfirmedReversals(db, "t1", undefined, 7, "2026-07-10");
    expect(count).toBe(0);
  });

  it("กรอง customerId เมื่อระบุ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedJe(tables, "je1", { status: "confirmed" });
    seedJe(tables, "je2", { status: "draft" });
    seedFxRevalRow(tables, "r1", { customerId: "c1", periodEndDate: "2026-06-30", revaluationJeId: "je1", reversingJeId: "je2", status: "reversing_draft" });
    const countC1 = await countOverdueUnconfirmedReversals(db, "t1", "c1", 7, "2026-07-10");
    const countC2 = await countOverdueUnconfirmedReversals(db, "t1", "c2", 7, "2026-07-10");
    expect(countC1).toBe(1);
    expect(countC2).toBe(0);
  });
});

// ---------------------------------------------------------------------
// loadOutstandingFxGroup / createFxRevaluationDraft / confirmFxRevaluation / confirmFxReversing
//   — full flow ผ่าน bill_entries/bill_entry_lines/bill_payments/chart_of_accounts (0.4/0.9/0.10/0.15/0.16)
// ---------------------------------------------------------------------
const CHART_ROWS = [
  ...TEST_CHART.map((a) => ({ code: a.code, name: a.name, category: a.category, is_bank: a.bank ?? false })),
  { code: "4025", name: "กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน", category: "รายได้", is_bank: false },
];
/** chartByCode ที่มี "4025" (บัญชี FX gain/loss) รวมด้วย — createFxRevaluationDraft ต้องใช้ผังชุดนี้
 *  (chartByCode ตัวบนไม่มี 4025 — ใช้เฉพาะเทสต์ pure ที่ไม่ผ่าน validateManualEntryInput จริง) */
const chartByCodeWithFx = buildChartByCode(
  CHART_ROWS.map((r) => ({ code: r.code, name: r.name, category: r.category, ...(r.is_bank ? { bank: true as const } : {}) }))
);

function seedChart(tables: Record<string, Row[]>) {
  tables.chart_of_accounts = CHART_ROWS.map((r, i) => ({
    id: `coa-${i}`,
    tenant_id: "t1",
    is_active: true,
    deleted_at: null,
    sort_order: i,
    ...r,
  }));
}

function seedFxBill(
  tables: Record<string, Row[]>,
  id: string,
  p: {
    customerId: string;
    entryType: "sale" | "purchase";
    currency: string;
    fxRate: number;
    fxLinesTotal: number;
    docNo?: string;
  }
) {
  tables.bill_entries.push({
    id,
    tenant_id: "t1",
    customer_id: p.customerId,
    entry_type: p.entryType,
    payment_method: "credit",
    status: "confirmed",
    deleted_at: null,
    currency: p.currency,
    fx_rate: p.fxRate,
    doc_no: p.docNo ?? id,
    doc_date: "2026-06-01",
    counterparty_name: "คู่ค้าทดสอบ",
    counterparty_tax_id: null,
    seller_name: null,
    seller_tax_id: null,
    buyer_name: null,
    buyer_tax_id: null,
    wht_form: null,
    payment_bank_account_id: null,
    due_date: null,
    source: "manual",
    ai_confidence: null,
    notes: null,
    created_at: "2026-06-01T00:00:00Z",
    confirmed_at: "2026-06-01T00:00:00Z",
    attachment_id: null,
    upload_path: null,
    upload_name: null,
    upload_mime: null,
  });
  tables.bill_entry_lines.push({
    id: `${id}-l1`,
    tenant_id: "t1",
    entry_id: id,
    line_no: 1,
    vat_type: "vat",
    description: null,
    account_code: p.entryType === "sale" ? "4010" : "5010",
    account_name: null,
    product_id: null,
    quantity: null,
    fx_amount: p.fxLinesTotal,
    amount: Math.round(p.fxLinesTotal * p.fxRate * 100) / 100,
    vat_amount: 0,
    wht_rate: 0,
    wht_amount: 0,
    ai_filled: false,
    ai_low_confidence: false,
  });
}

describe("loadOutstandingFxGroup (0.4)", () => {
  it("บิลเดียว ไม่มี payment เลย → ยอดคงค้างเท่ากับยอด fx เต็ม", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.outstandingFxAmount).toBe(10000);
    expect(group.bills).toHaveLength(1);
    expect(group.bills[0].invoiceFxRate).toBe(33.0);
  });

  it("มี payment บางส่วน (ก่อน asOfDate) → ยอดคงค้างลดลง", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    tables.bill_payments.push({
      id: "p1",
      tenant_id: "t1",
      entry_id: "e1",
      customer_id: "c1",
      pay_date: "2026-06-15",
      amount: 132000,
      method: "cash",
      bank_account_id: null,
      notes: null,
      created_at: "2026-06-15T00:00:00Z",
      deleted_at: null,
      currency: "USD",
      fx_rate: 33.0,
      fx_amount: 4000,
      fx_gain_loss_note_id: null,
    });
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.outstandingFxAmount).toBe(6000);
  });

  it("payment วันที่หลัง asOfDate (ยังไม่เกิดขึ้นจริง ณ วันนั้น) → ไม่ถูกหักออก (0.5)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    tables.bill_payments.push({
      id: "p1",
      tenant_id: "t1",
      entry_id: "e1",
      customer_id: "c1",
      pay_date: "2026-08-01", // หลัง asOfDate
      amount: 132000,
      method: "cash",
      bank_account_id: null,
      notes: null,
      created_at: "2026-08-01T00:00:00Z",
      deleted_at: null,
      currency: "USD",
      fx_rate: 33.0,
      fx_amount: 4000,
      fx_gain_loss_note_id: null,
    });
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.outstandingFxAmount).toBe(10000);
  });

  it("หลายบิล invoiceFxRate ต่างกัน → breakdown ครบทุกบิล + รวมยอดถูกต้อง", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    seedFxBill(tables, "e2", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 34.0, fxLinesTotal: 5000 });
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.outstandingFxAmount).toBe(15000);
    expect(group.bills).toHaveLength(2);
  });

  it("บิลจ่ายครบแล้ว (outstanding ≈ 0) → ไม่รวมเข้า breakdown", async () => {
    const { db, tables } = makeMultiTableDb();
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    tables.bill_payments.push({
      id: "p1",
      tenant_id: "t1",
      entry_id: "e1",
      customer_id: "c1",
      pay_date: "2026-06-15",
      amount: 330000,
      method: "cash",
      bank_account_id: null,
      notes: null,
      created_at: "2026-06-15T00:00:00Z",
      deleted_at: null,
      currency: "USD",
      fx_rate: 33.0,
      fx_amount: 10000,
      fx_gain_loss_note_id: null,
    });
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.bills).toHaveLength(0);
    expect(group.outstandingFxAmount).toBe(0);
  });

  it("ไม่มีบิล FX สกุลนี้ของกลุ่มนี้เลย → คืนกลุ่มว่าง (ไม่ throw)", async () => {
    const { db } = makeMultiTableDb();
    const group = await loadOutstandingFxGroup(db, "t1", "c1", "USD", "sale", "2026-06-30");
    expect(group.bills).toHaveLength(0);
    expect(group.outstandingFxAmount).toBe(0);
  });
});

describe("createFxRevaluationDraft (0.10/0.15/0.16)", () => {
  it("สำเร็จ → insert แถวสถานะ reval_draft + JV draft ผูกถูกต้อง", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    const res = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.5, "manual", chartByCodeWithFx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = tables.fx_period_revaluations.find((r) => r.id === res.id)!;
    expect(row.status).toBe("reval_draft");
    expect(row.unrealized_amount).toBe(5000);
    const je = tables.manual_journal_entries.find((r) => r.id === row.revaluation_je_id)!;
    expect(je.status).toBe("draft"); // never-auto-confirm
    const lines = tables.manual_journal_entry_lines.filter((l) => l.entry_id === row.revaluation_je_id);
    expect(isBalanced(lines as { debit: number; credit: number }[])).toBe(true);
  });

  it("★ QC fix ข้อ 3 — self-heal cache ก่อน insert: แถวเดิมของงวด+กลุ่มเดียวกันที่ JE ถูกลบไปแล้ว (ผ่านช่องทางอื่นตรง ๆ) แต่ cache ยังค้างไม่ voided → ถูก refresh เป็น voided ก่อนสร้างรอบใหม่ (กัน unique index ที่พึ่ง cache ตรง ๆ บล็อกผิด ๆ)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    // จำลอง JE ของรอบเดิม (งวดเดียวกันเป๊ะ) ถูกลบไปแล้ว แต่ cache ยังค้างเป็น 'reval_draft' (ไม่มีใครไป sync ให้)
    seedJe(tables, "je-old", { status: "draft", deleted: true });
    seedFxRevalRow(tables, "r-old", {
      customerId: "c1",
      currency: "USD",
      entryType: "sale",
      periodEndDate: "2026-06-30",
      revaluationJeId: "je-old",
      reversingJeId: null,
      status: "reval_draft", // cache ค้างผิด — live status จริงต้องเป็น voided (JE ถูกลบไปแล้ว)
    });

    const res = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.5, "manual", chartByCodeWithFx);
    expect(res.ok).toBe(true);

    // แถวเดิมต้องถูก self-heal เป็น voided แล้ว (ก่อน insert แถวใหม่)
    const oldRow = tables.fx_period_revaluations.find((r) => r.id === "r-old")!;
    expect(oldRow.status).toBe("voided");
    // แถวใหม่ถูกสร้างสำเร็จ (ไม่ถูกบล็อกโดยแถวเดิมที่ตอนนี้ voided แล้ว)
    expect(tables.fx_period_revaluations).toHaveLength(2);
  });

  it("unrealized = 0 (อัตราปิด = อัตราตอนออกบิลพอดี) → ปฏิเสธ ไม่สร้าง JV เปล่า", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    const res = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.0, "manual", chartByCodeWithFx);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
    expect(tables.fx_period_revaluations).toHaveLength(0);
  });

  it("★ guard #1 — มีรอบก่อนหน้าที่ยังไม่ reversing_confirmed → ปฏิเสธก่อนคำนวณ/สร้างอะไรเลย", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    seedJe(tables, "je-old", { status: "confirmed" });
    seedFxRevalRow(tables, "r-old", {
      customerId: "c1",
      currency: "USD",
      entryType: "sale",
      periodEndDate: "2026-05-31",
      revaluationJeId: "je-old",
      reversingJeId: null,
      status: "reval_draft",
    });
    const res = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.5, "manual", chartByCodeWithFx);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries.filter((j) => j.id !== "je-old")).toHaveLength(0);
    expect(tables.fx_period_revaluations).toHaveLength(1); // ไม่มีแถวใหม่ถูกสร้าง
  });

  it("ไม่มียอดคงค้าง FX ของกลุ่มนี้เลย → ปฏิเสธ", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    const res = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.5, "manual", chartByCodeWithFx);
    expect(res.ok).toBe(false);
  });

  it("source='bot' ถูกบันทึกลงแถวถูกต้อง", async () => {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "purchase", currency: "EUR", fxRate: 37.0, fxLinesTotal: 2000 });
    const res = await createFxRevaluationDraft(db, "t1", "c1", "purchase", "EUR", "2026-06-30", 36.5, "bot", chartByCodeWithFx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = tables.fx_period_revaluations.find((r) => r.id === res.id)!;
    expect(row.source).toBe("bot");
  });
});

describe("confirmFxRevaluation → confirmFxReversing (0.9, flow เต็ม)", () => {
  async function setupConfirmedGroup() {
    const { db, tables } = makeMultiTableDb();
    seedChart(tables);
    seedFxBill(tables, "e1", { customerId: "c1", entryType: "sale", currency: "USD", fxRate: 33.0, fxLinesTotal: 10000 });
    const created = await createFxRevaluationDraft(db, "t1", "c1", "sale", "USD", "2026-06-30", 33.5, "manual", chartByCodeWithFx);
    if (!created.ok) throw new Error("setup failed");
    return { db, tables, revaluationId: created.id };
  }

  it("ยืนยัน JV ปรับปรุง → สร้าง reversing JV draft ใหม่ (สลับ debit/credit ถูกต้อง) + update status='reversing_draft'", async () => {
    const { db, tables, revaluationId } = await setupConfirmedGroup();
    const res = await confirmFxRevaluation(db, "t1", revaluationId);
    expect(res.ok).toBe(true);

    const row = tables.fx_period_revaluations.find((r) => r.id === revaluationId)!;
    expect(row.status).toBe("reversing_draft");
    expect(row.reversing_je_id).toBeTruthy();

    const revalJe = tables.manual_journal_entries.find((r) => r.id === row.revaluation_je_id)!;
    expect(revalJe.status).toBe("confirmed");
    const reversingJe = tables.manual_journal_entries.find((r) => r.id === row.reversing_je_id)!;
    expect(reversingJe.status).toBe("draft"); // never-auto-confirm — ยังต้องยืนยันเองอีกครั้ง
    expect(reversingJe.doc_date).toBe("2026-07-01"); // period_end_date + 1 วัน

    const revalLines = tables.manual_journal_entry_lines
      .filter((l) => l.entry_id === row.revaluation_je_id)
      .sort((a, b) => (a.line_no as number) - (b.line_no as number));
    const reversingLines = tables.manual_journal_entry_lines
      .filter((l) => l.entry_id === row.reversing_je_id)
      .sort((a, b) => (a.line_no as number) - (b.line_no as number));
    expect(reversingLines).toHaveLength(revalLines.length);
    for (let i = 0; i < revalLines.length; i++) {
      expect(reversingLines[i].account_code).toBe(revalLines[i].account_code);
      expect(reversingLines[i].debit).toBe(revalLines[i].credit); // สลับเป๊ะ
      expect(reversingLines[i].credit).toBe(revalLines[i].debit);
    }
    expect(isBalanced(reversingLines as { debit: number; credit: number }[])).toBe(true);
  });

  it("ยืนยันซ้ำ (เคยยืนยันแล้วมี reversing อยู่แล้ว) → ok เฉย ๆ ไม่สร้าง reversing ซ้ำสอง", async () => {
    const { db, tables, revaluationId } = await setupConfirmedGroup();
    await confirmFxRevaluation(db, "t1", revaluationId);
    const countBefore = tables.manual_journal_entries.length;
    const res2 = await confirmFxRevaluation(db, "t1", revaluationId);
    expect(res2.ok).toBe(true);
    expect(tables.manual_journal_entries).toHaveLength(countBefore);
  });

  it("ยืนยัน reversing → status เปลี่ยนเป็น reversing_confirmed + ปลดล็อกงวดถัดไป (guard #1 ผ่าน)", async () => {
    const { db, tables, revaluationId } = await setupConfirmedGroup();
    await confirmFxRevaluation(db, "t1", revaluationId);
    const res = await confirmFxReversing(db, "t1", revaluationId);
    expect(res.ok).toBe(true);
    const row = tables.fx_period_revaluations.find((r) => r.id === revaluationId)!;
    expect(row.status).toBe("reversing_confirmed");

    // guard #1 ต้องผ่านแล้วสำหรับงวดถัดไปของกลุ่มเดียวกัน
    const guard = await assertNoPendingCycle(db, "t1", "c1", "USD", "sale", "2026-07-31");
    expect(guard.ok).toBe(true);
  });

  it("ยืนยัน reversing ก่อนยืนยัน JV ปรับปรุง (ยังไม่มี reversing_je_id) → ปฏิเสธ", async () => {
    const { db, revaluationId } = await setupConfirmedGroup();
    const res = await confirmFxReversing(db, "t1", revaluationId);
    expect(res.ok).toBe(false);
  });

  it("unconfirmFxReversing → กลับเป็น reversing_draft ได้ (0.13)", async () => {
    const { db, tables, revaluationId } = await setupConfirmedGroup();
    await confirmFxRevaluation(db, "t1", revaluationId);
    await confirmFxReversing(db, "t1", revaluationId);
    const res = await unconfirmFxReversing(db, "t1", revaluationId);
    expect(res.ok).toBe(true);
    const row = tables.fx_period_revaluations.find((r) => r.id === revaluationId)!;
    expect(row.status).toBe("reversing_draft");
  });
});
