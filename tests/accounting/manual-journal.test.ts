import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isBalanced,
  validateManualEntryInput,
  toJournalLines,
  toJournalPosting,
  bookOfDocType,
  listManualEntries,
  upsertManualEntry,
  confirmManualEntry,
  unconfirmManualEntry,
  softDeleteManualEntry,
  type ManualEntryInput,
  type ManualJournalEntry,
} from "@/lib/accounting/manual-journal";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";

/**
 * manual-journal.ts — เฟส 1 ส่วน C (Manual Journal Entry: JV/PV/RV)
 *   เน้น: validate (สมดุล/บัญชีอยู่ในผัง/จำนวนบรรทัด) + mapper (toJournalLines/toJournalPosting)
 *   + data layer (mock DB — pattern เดียวกับ actions-lib.test.ts)
 */

const chartByCode = buildChartByCode(TEST_CHART);

// ---------------------------------------------------------------------
// isBalanced (pure)
// ---------------------------------------------------------------------
describe("isBalanced", () => {
  it("เดบิตรวม = เครดิตรวม → true", () => {
    expect(isBalanced([{ debit: 1000, credit: 0 }, { debit: 0, credit: 1000 }])).toBe(true);
  });
  it("เดบิตรวม ≠ เครดิตรวม → false", () => {
    expect(isBalanced([{ debit: 1000, credit: 0 }, { debit: 0, credit: 900 }])).toBe(false);
  });
  it("ผลต่างเล็กกว่า EPSILON (เศษปัดเศษ) → true", () => {
    expect(isBalanced([{ debit: 100.001, credit: 0 }, { debit: 0, credit: 100 }])).toBe(true);
  });
});

// ---------------------------------------------------------------------
// validateManualEntryInput (pure)
// ---------------------------------------------------------------------
describe("validateManualEntryInput", () => {
  const validInput: ManualEntryInput = {
    docType: "JV",
    docDate: "2026-07-01",
    docNo: "JV-001",
    memo: "ปรับปรุงค่าเสื่อมราคา",
    lines: [
      { accountCode: "5370", debit: 1000, credit: 0 },
      { accountCode: "1615.1", debit: 0, credit: 1000 },
    ],
  };

  it("input ถูกต้อง + สมดุล → ok:true", () => {
    const r = validateManualEntryInput(validInput, chartByCode);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines).toHaveLength(2);
      expect(r.value.docType).toBe("JV");
    }
  });

  it("doc_type ผิด (ไม่ใช่ JV/PV/RV) → ปฏิเสธ", () => {
    const r = validateManualEntryInput({ ...validInput, docType: "XX" }, chartByCode);
    expect(r.ok).toBe(false);
  });

  it("doc_date ผิดรูป → ปฏิเสธ", () => {
    const r = validateManualEntryInput({ ...validInput, docDate: "1/7/2026" }, chartByCode);
    expect(r.ok).toBe(false);
  });

  it("บรรทัดน้อยกว่า 2 → ปฏิเสธ", () => {
    const r = validateManualEntryInput({ ...validInput, lines: [{ accountCode: "1010", debit: 100, credit: 0 }] }, chartByCode);
    expect(r.ok).toBe(false);
  });

  it("บรรทัดเกิน 50 → ปฏิเสธ", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      accountCode: "1010",
      debit: i % 2 === 0 ? 10 : 0,
      credit: i % 2 === 0 ? 0 : 10,
    }));
    const r = validateManualEntryInput({ ...validInput, lines: many }, chartByCode);
    expect(r.ok).toBe(false);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ", () => {
    const r = validateManualEntryInput(
      { ...validInput, lines: [{ accountCode: "9999", debit: 1000, credit: 0 }, { accountCode: "1615.1", debit: 0, credit: 1000 }] },
      chartByCode
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("9999");
  });

  it("บรรทัดไม่ระบุรหัสบัญชี → ปฏิเสธ", () => {
    const r = validateManualEntryInput(
      { ...validInput, lines: [{ accountCode: "", debit: 1000, credit: 0 }, { accountCode: "1615.1", debit: 0, credit: 1000 }] },
      chartByCode
    );
    expect(r.ok).toBe(false);
  });

  it("บรรทัดมีทั้งเดบิตและเครดิต → ปฏิเสธ", () => {
    const r = validateManualEntryInput(
      { ...validInput, lines: [{ accountCode: "5370", debit: 1000, credit: 500 }, { accountCode: "1615.1", debit: 0, credit: 1000 }] },
      chartByCode
    );
    expect(r.ok).toBe(false);
  });

  it("บรรทัดไม่มีทั้งเดบิตและเครดิต (ยอด 0 ทั้งคู่) → ปฏิเสธ", () => {
    const r = validateManualEntryInput(
      { ...validInput, lines: [{ accountCode: "5370", debit: 0, credit: 0 }, { accountCode: "1615.1", debit: 0, credit: 1000 }] },
      chartByCode
    );
    expect(r.ok).toBe(false);
  });

  it("★ เดบิตรวม ≠ เครดิตรวม (ไม่สมดุล) → ปฏิเสธเสมอ (เทสต์บังคับตาม DoD)", () => {
    const r = validateManualEntryInput(
      { ...validInput, lines: [{ accountCode: "5370", debit: 1000, credit: 0 }, { accountCode: "1615.1", debit: 0, credit: 900 }] },
      chartByCode
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("สมดุล");
  });

  it("ชื่อบัญชีไม่ระบุ → fallback เป็นชื่อจากผัง", () => {
    const r = validateManualEntryInput(validInput, chartByCode);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0].accountName).toBe(chartByCode["5370"].name);
    }
  });
});

// ---------------------------------------------------------------------
// toJournalLines / toJournalPosting / bookOfDocType (pure mapper)
// ---------------------------------------------------------------------
function mkManualEntry(p: Partial<ManualJournalEntry> = {}): ManualJournalEntry {
  return {
    id: "je1",
    tenantId: "t1",
    customerId: "c1",
    docType: "JV",
    docDate: "2026-07-15",
    docNo: "JV-001",
    memo: "ปรับปรุงบัญชี",
    status: "confirmed",
    createdAt: "2026-07-15T00:00:00Z",
    confirmedAt: "2026-07-15T00:00:00Z",
    lines: [
      { id: "l1", lineNo: 1, accountCode: "5370", accountName: "ค่าเสื่อมราคา-อาคาร", description: null, debit: 1000, credit: 0 },
      { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "ค่าเสื่อมสะสม-อาคาร", description: null, debit: 0, credit: 1000 },
    ],
    ...p,
  };
}

describe("bookOfDocType", () => {
  it("JV → ทั่วไป (general)", () => expect(bookOfDocType("JV")).toBe("general"));
  it("PV → จ่ายเงิน (payment)", () => expect(bookOfDocType("PV")).toBe("payment"));
  it("RV → รับเงิน (receipt)", () => expect(bookOfDocType("RV")).toBe("receipt"));
});

describe("toJournalLines", () => {
  it("แปลงเป็น JournalLine[] สมดุล เดบิต=เครดิต", () => {
    const entry = mkManualEntry();
    const lines = toJournalLines(entry);
    expect(lines).toHaveLength(2);
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    expect(totalDebit).toBe(1000);
    expect(totalCredit).toBe(1000);
    expect(lines[0].side).toBe("debit");
    expect(lines[1].side).toBe("credit");
    expect(lines.every((l) => l.entryId === entry.id)).toBe(true);
  });

  it("บรรทัดยอด 0 ทั้งคู่ → ถูกกรองออก", () => {
    const entry = mkManualEntry({
      lines: [
        { id: "l1", lineNo: 1, accountCode: "5370", accountName: "x", description: null, debit: 1000, credit: 0 },
        { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "y", description: null, debit: 0, credit: 1000 },
        { id: "l3", lineNo: 3, accountCode: "1010", accountName: "z", description: null, debit: 0, credit: 0 },
      ],
    });
    expect(toJournalLines(entry)).toHaveLength(2);
  });

  it("description ต่อบรรทัด (ถ้ามี) ใช้เป็น counterparty · ไม่มี → fallback เป็น memo", () => {
    const entry = mkManualEntry({
      memo: "memo ทั้งใบ",
      lines: [
        { id: "l1", lineNo: 1, accountCode: "5370", accountName: "x", description: "รายละเอียดบรรทัด", debit: 1000, credit: 0 },
        { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "y", description: null, debit: 0, credit: 1000 },
      ],
    });
    const lines = toJournalLines(entry);
    expect(lines[0].counterparty).toBe("รายละเอียดบรรทัด");
    expect(lines[1].counterparty).toBe("memo ทั้งใบ");
  });
});

describe("toJournalPosting", () => {
  it("JV → book=general, สมดุล debits/credits", () => {
    const p = toJournalPosting(mkManualEntry({ docType: "JV" }));
    expect(p.book).toBe("general");
    expect(p.totalDebit).toBe(1000);
    expect(p.totalCredit).toBe(1000);
    expect(p.debits).toHaveLength(1);
    expect(p.credits).toHaveLength(1);
  });

  it("PV → book=payment", () => {
    const p = toJournalPosting(mkManualEntry({ docType: "PV" }));
    expect(p.book).toBe("payment");
  });

  it("RV → book=receipt", () => {
    const p = toJournalPosting(mkManualEntry({ docType: "RV" }));
    expect(p.book).toBe("receipt");
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB) — pattern เดียวกับ actions-lib.test.ts
// ---------------------------------------------------------------------
type Op = { kind: string; table: string; payload?: unknown; filters: Record<string, unknown> };

function makeDb(canned: Record<string, unknown>): { db: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode = "select";
    let payload: unknown = {};
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.in = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.update = (p: unknown) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.insert = (p: unknown) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "insert") {
        ops.push({ kind: "insert", table, payload, filters });
        return Promise.resolve({ data: canned[`${table}:insert`] ?? { id: "new-id" }, error: null });
      }
      return Promise.resolve({ data: canned[table] ?? null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") ops.push({ kind: "update", table, payload, filters });
      else if (mode === "delete") ops.push({ kind: "delete", table, filters });
      else if (mode === "insert") ops.push({ kind: "insert", table, payload, filters });
      const data = mode === "select" ? canned[`${table}:list`] ?? [] : null;
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, ops };
}

const validEntryInput: ManualEntryInput = {
  docType: "JV",
  docDate: "2026-07-01",
  docNo: "JV-001",
  memo: "ปรับปรุง",
  lines: [
    { accountCode: "5370", debit: 1000, credit: 0 },
    { accountCode: "1615.1", debit: 0, credit: 1000 },
  ],
};

const unbalancedEntryInput: ManualEntryInput = {
  ...validEntryInput,
  lines: [
    { accountCode: "5370", debit: 1000, credit: 0 },
    { accountCode: "1615.1", debit: 0, credit: 900 },
  ],
};

describe("listManualEntries", () => {
  it("โหลด header + lines แล้วประกอบเป็น ManualJournalEntry[]", async () => {
    const { db } = makeDb({
      "manual_journal_entries:list": [
        {
          id: "je1",
          tenant_id: "t1",
          customer_id: "c1",
          doc_type: "JV",
          doc_date: "2026-07-01",
          doc_no: "JV-001",
          memo: "ทดสอบ",
          status: "draft",
          created_at: "2026-07-01T00:00:00Z",
          confirmed_at: null,
        },
      ],
      "manual_journal_entry_lines:list": [
        { id: "l1", entry_id: "je1", line_no: 1, account_code: "5370", account_name: "ค่าเสื่อม", description: null, debit: 1000, credit: 0 },
        { id: "l2", entry_id: "je1", line_no: 2, account_code: "1615.1", account_name: "ค่าเสื่อมสะสม", description: null, debit: 0, credit: 1000 },
      ],
    });
    const rows = await listManualEntries(db, "t1", "c1");
    expect(rows).toHaveLength(1);
    expect(rows[0].lines).toHaveLength(2);
    expect(rows[0].docType).toBe("JV");
    expect(rows[0].lines[0].debit).toBe(1000);
  });

  it("ไม่มี entry ของลูกค้านี้ → []", async () => {
    const { db } = makeDb({ "manual_journal_entries:list": [] });
    const rows = await listManualEntries(db, "t1", "c1");
    expect(rows).toEqual([]);
  });
});

describe("upsertManualEntry", () => {
  it("ไม่สมดุล → ปฏิเสธ ไม่แตะ DB เลย", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertManualEntry(db, "t1", "c1", unbalancedEntryInput, chartByCode);
    expect(res.ok).toBe(false);
    expect(ops).toHaveLength(0);
  });

  it("สร้างใหม่ (ไม่มี id) สมดุล → insert header + lines สำเร็จ", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertManualEntry(db, "t1", "c1", validEntryInput, chartByCode);
    expect(res.ok).toBe(true);
    const headerIns = ops.find((o) => o.kind === "insert" && o.table === "manual_journal_entries");
    expect(headerIns).toBeTruthy();
    expect((headerIns!.payload as Record<string, unknown>).status).toBe("draft");
    const linesIns = ops.find((o) => o.kind === "insert" && o.table === "manual_journal_entry_lines");
    expect(linesIns).toBeTruthy();
    expect((linesIns!.payload as unknown[]).length).toBe(2);
  });

  it("แก้ไข (มี id) แต่รายการเดิม confirmed แล้ว → ปฏิเสธ", async () => {
    const { db } = makeDb({ manual_journal_entries: { customer_id: "c1", status: "confirmed" } });
    const res = await upsertManualEntry(db, "t1", "c1", validEntryInput, chartByCode, "je1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("ยืนยันแล้ว");
  });

  it("แก้ไข (มี id) รายการเดิมเป็น draft → สำเร็จ + update header + แทนที่ lines", async () => {
    const { db, ops } = makeDb({ manual_journal_entries: { customer_id: "c1", status: "draft" } });
    const res = await upsertManualEntry(db, "t1", "c1", validEntryInput, chartByCode, "je1");
    expect(res.ok).toBe(true);
    expect(ops.some((o) => o.kind === "update" && o.table === "manual_journal_entries")).toBe(true);
    expect(ops.some((o) => o.kind === "delete" && o.table === "manual_journal_entry_lines")).toBe(true);
    expect(ops.some((o) => o.kind === "insert" && o.table === "manual_journal_entry_lines")).toBe(true);
  });

  it("ไม่พบรายการเดิม → ปฏิเสธ (not found)", async () => {
    const { db } = makeDb({ manual_journal_entries: null });
    const res = await upsertManualEntry(db, "t1", "c1", validEntryInput, chartByCode, "missing");
    expect(res.ok).toBe(false);
  });
});

describe("confirmManualEntry", () => {
  it("บรรทัดสมดุล → ยืนยันสำเร็จ", async () => {
    const { db, ops } = makeDb({
      manual_journal_entries: { customer_id: "c1", status: "draft" },
      "manual_journal_entry_lines:list": [
        { debit: 1000, credit: 0 },
        { debit: 0, credit: 1000 },
      ],
    });
    const res = await confirmManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "manual_journal_entries");
    expect((upd!.payload as Record<string, unknown>).status).toBe("confirmed");
  });

  it("★ บรรทัดไม่สมดุล (แก้ผ่านช่องทางอื่นแล้วไม่สมดุล) → ยืนยันไม่ได้", async () => {
    const { db } = makeDb({
      manual_journal_entries: { customer_id: "c1", status: "draft" },
      "manual_journal_entry_lines:list": [
        { debit: 1000, credit: 0 },
        { debit: 0, credit: 900 },
      ],
    });
    const res = await confirmManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(false);
  });

  it("มีไม่ครบ 2 บรรทัด → ยืนยันไม่ได้", async () => {
    const { db } = makeDb({
      manual_journal_entries: { customer_id: "c1", status: "draft" },
      "manual_journal_entry_lines:list": [{ debit: 1000, credit: 0 }],
    });
    const res = await confirmManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(false);
  });

  it("confirmed อยู่แล้ว → คืน ok ทันที (idempotent)", async () => {
    const { db, ops } = makeDb({ manual_journal_entries: { customer_id: "c1", status: "confirmed" } });
    const res = await confirmManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(true);
    expect(ops.filter((o) => o.kind === "update")).toHaveLength(0);
  });
});

describe("unconfirmManualEntry", () => {
  it("confirmed → draft (confirmed_at ล้าง)", async () => {
    const { db, ops } = makeDb({ manual_journal_entries: { customer_id: "c1", status: "confirmed" } });
    const res = await unconfirmManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "manual_journal_entries")!;
    expect((upd.payload as Record<string, unknown>).status).toBe("draft");
    expect((upd.payload as Record<string, unknown>).confirmed_at).toBeNull();
  });
});

describe("softDeleteManualEntry", () => {
  it("ตั้ง deleted_at (soft-delete)", async () => {
    const { db, ops } = makeDb({ manual_journal_entries: { customer_id: "c1", status: "draft" } });
    const res = await softDeleteManualEntry(db, "t1", "je1");
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "manual_journal_entries")!;
    expect((upd.payload as Record<string, unknown>).deleted_at).toBeTruthy();
  });

  it("ไม่พบรายการ → ปฏิเสธ", async () => {
    const { db } = makeDb({ manual_journal_entries: null });
    const res = await softDeleteManualEntry(db, "t1", "missing");
    expect(res.ok).toBe(false);
  });
});
