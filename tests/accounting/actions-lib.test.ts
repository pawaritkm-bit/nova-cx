import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  upsertEntry,
  addLine,
  updateLine,
  confirmEntry,
  deleteEntry,
} from "@/lib/accounting/actions-lib";

/**
 * accounting/actions-lib — เขียน (upsert/line/confirm/delete)
 *   เน้น: guard tenant, กันแก้ confirmed, auto-calc WHT, confirm ต้องมีมูลค่า
 */

type Op = { kind: string; table: string; payload?: Record<string, unknown>; filters: Record<string, unknown> };

/** mock DB: canned select ต่อ table + เก็บ update/insert/delete */
function makeDb(canned: Record<string, unknown>): { db: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode = "select";
    let payload: Record<string, unknown> = {};
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
    api.update = (p: Record<string, unknown>) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.insert = (p: Record<string, unknown>) => {
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
        return Promise.resolve({ data: { id: "new-id" }, error: null });
      }
      // select single: คืน canned ของ table
      return Promise.resolve({ data: canned[table] ?? null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") ops.push({ kind: "update", table, payload, filters });
      else if (mode === "delete") ops.push({ kind: "delete", table, filters });
      else if (mode === "insert") ops.push({ kind: "insert", table, payload, filters });
      // select list → canned (array) หรือ []
      const data = mode === "select" ? canned[`${table}:list`] ?? [] : null;
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, ops };
}

describe("upsertEntry", () => {
  it("insert ใหม่ (ไม่มี id) → source manual, status draft", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertEntry(db, "t1", { entryType: "purchase", docNo: "X-1" });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert")!;
    expect(ins.payload!.tenant_id).toBe("t1");
    expect(ins.payload!.source).toBe("manual");
    expect(ins.payload!.status).toBe("draft");
  });

  it("update ของที่ confirmed แล้ว → error entry_confirmed", async () => {
    const { db } = makeDb({ bill_entries: { status: "confirmed" } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale" });
    expect(res).toEqual({ ok: false, error: "entry_confirmed" });
  });

  it("update ของ draft → สำเร็จ + scope ด้วย tenant_id", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", docNo: "S-9" });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.filters.tenant_id).toBe("t1");
    expect(upd.filters.id).toBe("e1");
  });

  it("update entry ที่ไม่พบ → not_found", async () => {
    const { db } = makeDb({ bill_entries: null });
    const res = await upsertEntry(db, "t1", { id: "missing", entryType: "sale" });
    expect(res).toEqual({ ok: false, error: "not_found" });
  });
});

describe("addLine — auto-calc WHT", () => {
  it("ส่ง whtRate อย่างเดียว → คำนวณ wht_amount = amount*rate/100", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await addLine(db, "t1", "e1", { amount: 1000, whtRate: 3 });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.wht_rate).toBe(3);
    expect(ins.payload!.wht_amount).toBe(30); // 1000 * 3 / 100
    expect(ins.payload!.ai_filled).toBe(false);
  });

  it("entry confirmed → ห้ามเพิ่ม line", async () => {
    const { db } = makeDb({ bill_entries: { status: "confirmed" } });
    const res = await addLine(db, "t1", "e1", { amount: 100 });
    expect(res).toEqual({ ok: false, error: "entry_confirmed" });
  });
});

describe("updateLine", () => {
  it("แก้ line ของ entry draft → set ai_filled=false + scope tenant", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    const res = await updateLine(db, "t1", "l1", { amount: 500, vatAmount: 35 });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.amount).toBe(500);
    expect(upd.payload!.ai_filled).toBe(false);
    expect(upd.filters.tenant_id).toBe("t1");
  });

  it("line ไม่พบ → not_found", async () => {
    const { db } = makeDb({ bill_entry_lines: null });
    const res = await updateLine(db, "t1", "lx", { amount: 1 });
    expect(res).toEqual({ ok: false, error: "not_found" });
  });
});

describe("confirmEntry", () => {
  it("draft (ระบุ purchase) ที่มี line มีมูลค่า → confirmed", async () => {
    const { db, ops } = makeDb({
      bill_entries: { status: "draft", entry_type: "purchase" },
      "bill_entry_lines:list": [{ amount: 100, vat_amount: 7 }],
    });
    const res = await confirmEntry(db, "t1", "e1");
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.status).toBe("confirmed");
    expect(upd.payload!.confirmed_at).toBeTruthy();
    expect(upd.filters.status).toBe("draft"); // guard race
  });

  it("draft ว่างเปล่า (ทุก line = 0) → error no_amount", async () => {
    const { db } = makeDb({
      bill_entries: { status: "draft", entry_type: "sale" },
      "bill_entry_lines:list": [{ amount: 0, vat_amount: 0 }],
    });
    const res = await confirmEntry(db, "t1", "e1");
    expect(res).toEqual({ ok: false, error: "no_amount" });
  });

  it("ยังเป็น unspecified (ยังไม่เลือกซื้อ/ขาย) → error entry_type_unspecified", async () => {
    const { db } = makeDb({
      bill_entries: { status: "draft", entry_type: "unspecified" },
      "bill_entry_lines:list": [{ amount: 100, vat_amount: 7 }],
    });
    const res = await confirmEntry(db, "t1", "e1");
    expect(res).toEqual({ ok: false, error: "entry_type_unspecified" });
  });

  it("confirmed อยู่แล้ว → already_confirmed", async () => {
    const { db } = makeDb({ bill_entries: { status: "confirmed", entry_type: "purchase" } });
    const res = await confirmEntry(db, "t1", "e1");
    expect(res).toEqual({ ok: false, error: "already_confirmed" });
  });
});

describe("deleteEntry — soft delete", () => {
  it("set deleted_at + scope tenant", async () => {
    const { db, ops } = makeDb({});
    const res = await deleteEntry(db, "t1", "e1");
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.payload!.deleted_at).toBeTruthy();
    expect(upd.filters.tenant_id).toBe("t1");
    expect(upd.filters.id).toBe("e1");
  });
});
