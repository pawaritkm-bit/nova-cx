import { describe, it, expect } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { saveWeights, getActiveWeights } from "@/lib/chat-admin/weights";
import { DEFAULT_WEIGHTS, type Weights } from "@/lib/evaluation/weights";

const T = "tenant-1";

const valid: Weights = {
  correctness: 20, completeness: 10, sla: 15, clarity: 10,
  politeness: 10, ownership: 15, resolution: 10, sop: 10,
};

describe("saveWeights", () => {
  it("รวม = 100 → ปิดชุดเดิม (update is_active=false) + insert ชุดใหม่ active", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "evaluation_weights" && q.op === "update") return { error: null };
      if (q.table === "evaluation_weights" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);
    await expect(saveWeights(db, T, valid)).resolves.toBeUndefined();
    const closed = cap.updates.find((u) => u.table === "evaluation_weights") as { payload: Record<string, unknown> };
    expect(closed.payload.is_active).toBe(false);
    const ins = cap.inserts.find((i) => i.table === "evaluation_weights") as { payload: Record<string, unknown> };
    expect(ins.payload.tenant_id).toBe(T);
    expect(ins.payload.is_active).toBe(true);
    expect((ins.payload.weights as Record<string, number>).correctness).toBe(20);
  });

  it("รวม != 100 → throw ก่อนแตะ DB", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ error: null }), cap);
    const bad = { ...valid, correctness: 30 };
    await expect(saveWeights(db, T, bad)).rejects.toThrow(/100/);
    expect(cap.updates.length).toBe(0);
    expect(cap.inserts.length).toBe(0);
  });

  it("CHECK constraint 23514 → ข้อความสุภาพเรื่องรวม 100", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "evaluation_weights" && q.op === "update") return { error: null };
      if (q.table === "evaluation_weights" && q.op === "insert") return { error: { code: "23514", message: "check" } };
      return { data: null };
    }, cap);
    await expect(saveWeights(db, T, valid)).rejects.toThrow(/100/);
  });
});

describe("getActiveWeights", () => {
  it("ไม่มีชุด active → fallback DEFAULT_WEIGHTS", async () => {
    const { db } = makeFakeDb((q) => {
      if (q.table === "evaluation_weights" && q.terminal === "maybeSingle") return { data: null };
      return { data: null };
    });
    const w = await getActiveWeights(db, T);
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it("มีชุด active → คืนค่าใน DB (เติมมิติที่ขาดด้วย default)", async () => {
    const { db } = makeFakeDb((q) => {
      if (q.table === "evaluation_weights" && q.terminal === "maybeSingle")
        return { data: { weights: { correctness: 40, completeness: 5, sla: 10, clarity: 5, politeness: 10, ownership: 10, resolution: 10, sop: 10 } } };
      return { data: null };
    });
    const w = await getActiveWeights(db, T);
    expect(w.correctness).toBe(40);
    expect(w.completeness).toBe(5);
  });
});
