import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ★ ตั้งคีย์ก่อน import (queries decrypt gist ฝั่ง server)
beforeAll(() => {
  process.env.CREDENTIAL_ENC_KEY = "test-enc-key-สำหรับ-unit-test";
});

import {
  countByCategory,
  getKnowledgeList,
  updateKnowledgeStatus,
  type KnowledgeRow,
} from "@/lib/knowledge/queries";
import { encryptField } from "@/lib/crypto/field";

// ---------------------------------------------------------------------
// countByCategory (pure)
// ---------------------------------------------------------------------
describe("countByCategory — นับต่อหมวด เรียงมาก→น้อย", () => {
  it("รวมหมวดซ้ำ + หมวดว่าง → 'ไม่ระบุหมวด'", () => {
    const c = countByCategory([
      { category: "ภาษี" },
      { category: "ภาษี" },
      { category: "เอกสาร" },
      { category: null },
      { category: "  " },
    ]);
    expect(c[0]).toEqual({ category: "ภาษี", count: 2 });
    const uncategorized = c.find((x) => x.category === "ไม่ระบุหมวด");
    expect(uncategorized?.count).toBe(2);
  });

  it("ว่าง → []", () => {
    expect(countByCategory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// getKnowledgeList (fake db) — decrypt + filter หมวด/สถานะ + นับหมวดจากชุดเต็ม
// ---------------------------------------------------------------------
function row(p: Partial<KnowledgeRow>): KnowledgeRow {
  return {
    id: p.id ?? "k1",
    category: p.category ?? "เอกสาร",
    question_gist_enc: p.question_gist_enc ?? null,
    answer_gist_enc: p.answer_gist_enc ?? null,
    staff_role: p.staff_role ?? null,
    confidence: p.confidence ?? null,
    status: p.status ?? "new",
    blocked_reason: p.blocked_reason ?? null,
    validated: p.validated ?? true,
    created_at: p.created_at ?? "2026-07-20T00:00:00Z",
  };
}

/** fake db (select-only) คืน canned reply_knowledge */
function selectDb(rows: KnowledgeRow[]): SupabaseClient {
  const qb = {
    select() {
      return qb;
    },
    eq() {
      return qb;
    },
    is() {
      return qb;
    },
    order() {
      return qb;
    },
    limit() {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { from: () => qb } as unknown as SupabaseClient;
}

describe("getKnowledgeList — decrypt + filter", () => {
  it("decrypt gist ฝั่ง server + นับหมวดจากชุดเต็ม", async () => {
    const rows = [
      row({ id: "k1", category: "ภาษี", question_gist_enc: encryptField("ถามยื่นภาษี"), answer_gist_enc: encryptField("แนะยื่นออนไลน์"), status: "new" }),
      row({ id: "k2", category: "เอกสาร", status: "approved" }),
    ];
    const d = await getKnowledgeList(selectDb(rows), "t-1");
    expect(d.total).toBe(2);
    expect(d.categories.find((c) => c.category === "ภาษี")?.count).toBe(1);
    const k1 = d.items.find((i) => i.id === "k1");
    expect(k1?.question).toBe("ถามยื่นภาษี");
    expect(k1?.answer).toBe("แนะยื่นออนไลน์");
  });

  it("filter สถานะ → เห็นเฉพาะสถานะนั้น (แต่ตัวนับหมวดยังนับจากชุดเต็ม)", async () => {
    const rows = [
      row({ id: "k1", category: "ภาษี", status: "new" }),
      row({ id: "k2", category: "เอกสาร", status: "approved" }),
    ];
    const d = await getKnowledgeList(selectDb(rows), "t-1", { status: "approved" });
    expect(d.items).toHaveLength(1);
    expect(d.items[0].id).toBe("k2");
    // ตัวนับหมวดคงที่ (2 หมวด)
    expect(d.categories).toHaveLength(2);
  });

  it("filter หมวด → เห็นเฉพาะหมวดนั้น", async () => {
    const rows = [
      row({ id: "k1", category: "ภาษี" }),
      row({ id: "k2", category: "เอกสาร" }),
    ];
    const d = await getKnowledgeList(selectDb(rows), "t-1", { category: "เอกสาร" });
    expect(d.items).toHaveLength(1);
    expect(d.items[0].id).toBe("k2");
  });

  it("row ที่ถูกบล็อก (blocked_reason) → question/answer เป็น null (ไม่มี gist)", async () => {
    const rows = [row({ id: "kb", blocked_reason: "residual_pii", question_gist_enc: null, answer_gist_enc: null })];
    const d = await getKnowledgeList(selectDb(rows), "t-1");
    expect(d.items[0].blockedReason).toBe("residual_pii");
    expect(d.items[0].question).toBeNull();
  });
});

// ---------------------------------------------------------------------
// updateKnowledgeStatus — ต้องกรอง tenant_id
// ---------------------------------------------------------------------
describe("updateKnowledgeStatus — tenant guard", () => {
  it("ส่ง eq tenant_id + id และคืนจำนวนแถวที่อัปเดต", async () => {
    const filters: Record<string, unknown> = {};
    const qb = {
      update() {
        return qb;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return qb;
      },
      is() {
        return qb;
      },
      select() {
        return Promise.resolve({ data: [{ id: "k1" }], error: null });
      },
    };
    const db = { from: () => qb } as unknown as SupabaseClient;
    const n = await updateKnowledgeStatus(db, "t-1", "k1", "approved");
    expect(n).toBe(1);
    expect(filters.tenant_id).toBe("t-1");
    expect(filters.id).toBe("k1");
  });

  it("ไม่พบแถว (ข้าม tenant) → คืน 0", async () => {
    const qb = {
      update() {
        return qb;
      },
      eq() {
        return qb;
      },
      is() {
        return qb;
      },
      select() {
        return Promise.resolve({ data: [], error: null });
      },
    };
    const db = { from: () => qb } as unknown as SupabaseClient;
    const n = await updateKnowledgeStatus(db, "t-other", "k1", "rejected");
    expect(n).toBe(0);
  });
});
