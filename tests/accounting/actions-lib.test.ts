import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  upsertEntry,
  addLine,
  updateLine,
  deleteLine,
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

  it("allowConfirmed → แก้บิล confirmed ได้ + คงสถานะ confirmed (payload ไม่แตะ status)", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "confirmed" } });
    const res = await upsertEntry(
      db,
      "t1",
      { id: "e1", entryType: "sale", counterpartyName: "แก้ชื่อที่ AI อ่านผิด" },
      { allowConfirmed: true }
    );
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    // ★ ต้องไม่เขียน status กลับ (คงสถานะยืนยันไว้ตามเดิม)
    expect("status" in (upd.payload ?? {})).toBe(false);
    expect(upd.payload!.counterparty_name).toBe("แก้ชื่อที่ AI อ่านผิด");
    expect(upd.filters.tenant_id).toBe("t1");
  });
});

describe("upsertEntry — dueDate (เฟส 2 ส่วน E)", () => {
  it("ไม่ส่ง dueDate (undefined) → ไม่แตะค่าเดิม (ไม่อยู่ใน payload)", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale" });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect("due_date" in (upd.payload ?? {})).toBe(false);
  });

  it("ส่ง dueDate ใหม่ → อัปเดตจริง", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", dueDate: "2026-08-31" });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.payload!.due_date).toBe("2026-08-31");
  });

  it("ส่ง dueDate เป็น null → ล้างค่า", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", dueDate: null });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.payload!.due_date).toBeNull();
  });

  it("insert ใหม่พร้อม dueDate → ติดใน payload insert", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertEntry(db, "t1", { entryType: "sale", dueDate: "2026-09-15" });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert")!;
    expect(ins.payload!.due_date).toBe("2026-09-15");
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

  it("entry confirmed + allowConfirmed → เพิ่ม line ได้", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "confirmed" } });
    const res = await addLine(db, "t1", "e1", { amount: 100 }, { allowConfirmed: true });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.amount).toBe(100);
  });

  it("ส่ง productId (เฟส 1 ส่วน B) → เก็บ product_id ตรง ๆ", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await addLine(db, "t1", "e1", { amount: 100, productId: "prod-1" });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.product_id).toBe("prod-1");
  });

  it("ไม่ส่ง productId → product_id เป็น null (ไม่ผูกสินค้า)", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    await addLine(db, "t1", "e1", { amount: 100 });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.product_id).toBeNull();
  });

  it("ส่ง quantity (เฟส 8 ส่วน Y) → เก็บ quantity ตรง ๆ", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await addLine(db, "t1", "e1", { amount: 100, productId: "prod-1", quantity: 5 });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.quantity).toBe(5);
  });

  it("ไม่ส่ง quantity → quantity เป็น null (ไม่ผูกจำนวนสต็อก)", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    await addLine(db, "t1", "e1", { amount: 100 });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.quantity).toBeNull();
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

  it("entry confirmed → ปกติห้ามแก้ line", async () => {
    const { db } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "confirmed" },
    });
    const res = await updateLine(db, "t1", "l1", { amount: 500 });
    expect(res).toEqual({ ok: false, error: "entry_confirmed" });
  });

  it("entry confirmed + allowConfirmed → แก้ line ได้", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "confirmed" },
    });
    const res = await updateLine(db, "t1", "l1", { amount: 500 }, { allowConfirmed: true });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.amount).toBe(500);
  });

  it("ส่ง productId (เฟส 1 ส่วน B) → แก้ product_id ด้วย", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    const res = await updateLine(db, "t1", "l1", { productId: "prod-2" });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.product_id).toBe("prod-2");
  });

  it("ไม่ส่ง productId → ไม่แตะ product_id เดิม (undefined = ไม่อยู่ใน patch)", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    await updateLine(db, "t1", "l1", { amount: 500 });
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect("product_id" in (upd.payload ?? {})).toBe(false);
  });

  it("ส่ง quantity (เฟส 8 ส่วน Y) → แก้ quantity ด้วย", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    const res = await updateLine(db, "t1", "l1", { quantity: 12 });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.quantity).toBe(12);
  });

  it("ส่ง quantity เป็น null → ล้างค่า", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    await updateLine(db, "t1", "l1", { quantity: null });
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.quantity).toBeNull();
  });

  it("ไม่ส่ง quantity → ไม่แตะ quantity เดิม (undefined = ไม่อยู่ใน patch)", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    await updateLine(db, "t1", "l1", { amount: 500 });
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect("quantity" in (upd.payload ?? {})).toBe(false);
  });
});

describe("deleteLine — allowConfirmed", () => {
  it("entry confirmed → ปกติห้ามลบ line", async () => {
    const { db } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "confirmed" },
    });
    const res = await deleteLine(db, "t1", "l1");
    expect(res).toEqual({ ok: false, error: "entry_confirmed" });
  });

  it("entry confirmed + allowConfirmed → ลบ line ได้", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "confirmed" },
    });
    const res = await deleteLine(db, "t1", "l1", { allowConfirmed: true });
    expect(res.ok).toBe(true);
    const del = ops.find((o) => o.kind === "delete" && o.table === "bill_entry_lines")!;
    expect(del.filters.tenant_id).toBe("t1");
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

describe("upsertEntry — currency/fxRate (เฟส 10 ส่วน Z, 0.6/0.9)", () => {
  it("insert ใหม่พร้อม currency/fxRate → ติดใน payload insert", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertEntry(db, "t1", { entryType: "sale", currency: "USD", fxRate: 35.5 });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert")!;
    expect(ins.payload!.currency).toBe("USD");
    expect(ins.payload!.fx_rate).toBe(35.5);
  });

  it("บิลไม่มี bill_payments ผูก → เปลี่ยน currency/fx_rate ได้ปกติ", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft", currency: null, fx_rate: null } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", currency: "USD", fxRate: 36 });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.payload!.currency).toBe("USD");
    expect(upd.payload!.fx_rate).toBe(36);
  });

  it("★ บิลมี bill_payments ผูกอยู่แล้ว (mock) + พยายามเปลี่ยน currency → ปฏิเสธด้วย fx_locked (เทสต์บังคับ 0.9)", async () => {
    const { db } = makeDb({
      bill_entries: { status: "draft", currency: "USD", fx_rate: 35 },
      "bill_payments:list": [{ id: "p1" }],
    });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", currency: "EUR", fxRate: 40 });
    expect(res).toEqual({ ok: false, error: "fx_locked" });
  });

  it("★ บิลมี bill_payments ผูกอยู่ + พยายามเปลี่ยนแค่ fxRate (currency เดิม) → ปฏิเสธด้วย fx_locked เช่นกัน", async () => {
    const { db } = makeDb({
      bill_entries: { status: "draft", currency: "USD", fx_rate: 35 },
      "bill_payments:list": [{ id: "p1" }],
    });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", currency: "USD", fxRate: 999 });
    expect(res).toEqual({ ok: false, error: "fx_locked" });
  });

  it("บิลมี bill_payments ผูกอยู่ แต่ส่งค่า currency/fxRate เดิม (ไม่เปลี่ยนจริง) → ผ่านปกติ (ไม่ล็อกฟิลด์อื่น)", async () => {
    const { db, ops } = makeDb({
      bill_entries: { status: "draft", currency: "USD", fx_rate: 35 },
      "bill_payments:list": [{ id: "p1" }],
    });
    const res = await upsertEntry(db, "t1", {
      id: "e1",
      entryType: "sale",
      currency: "USD",
      fxRate: 35,
      docNo: "แก้เลขที่ได้ปกติ",
    });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect(upd.payload!.doc_no).toBe("แก้เลขที่ได้ปกติ");
  });

  it("ไม่ส่ง currency/fxRate เลย (undefined) → ไม่แตะค่าเดิม + ไม่ query bill_payments เลย", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft", currency: "USD", fx_rate: 35 } });
    const res = await upsertEntry(db, "t1", { id: "e1", entryType: "sale", docNo: "X" });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update")!;
    expect("currency" in (upd.payload ?? {})).toBe(false);
    expect("fx_rate" in (upd.payload ?? {})).toBe(false);
    expect(ops.some((o) => o.table === "bill_payments")).toBe(false);
  });
});

describe("addLine/updateLine — fxAmount (เฟส 10 ส่วน Z)", () => {
  it("addLine ส่ง fxAmount → เก็บ fx_amount ตรง ๆ", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    const res = await addLine(db, "t1", "e1", { amount: 3550, fxAmount: 100 });
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.fx_amount).toBe(100);
  });

  it("addLine ไม่ส่ง fxAmount → fx_amount เป็น null", async () => {
    const { db, ops } = makeDb({ bill_entries: { status: "draft" } });
    await addLine(db, "t1", "e1", { amount: 100 });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "bill_entry_lines")!;
    expect(ins.payload!.fx_amount).toBeNull();
  });

  it("updateLine ส่ง fxAmount → แก้ fx_amount ด้วย · ไม่ส่ง → ไม่แตะค่าเดิม", async () => {
    const { db, ops } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    const res = await updateLine(db, "t1", "l1", { fxAmount: 200 });
    expect(res.ok).toBe(true);
    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect(upd.payload!.fx_amount).toBe(200);

    const { db: db2, ops: ops2 } = makeDb({
      bill_entry_lines: { entry_id: "e1" },
      bill_entries: { status: "draft" },
    });
    await updateLine(db2, "t1", "l1", { amount: 500 });
    const upd2 = ops2.find((o) => o.kind === "update" && o.table === "bill_entry_lines")!;
    expect("fx_amount" in (upd2.payload ?? {})).toBe(false);
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
