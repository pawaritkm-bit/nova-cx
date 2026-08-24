import { describe, it, expect } from "vitest";
import { normalizeDocNo, hasEntryForSameContent } from "@/lib/line/bill-extract-worker";

describe("normalizeDocNo", () => {
  it("ตัดช่องว่าง/ขีด/พิมพ์ใหญ่ — รูปแบบต่างกันของเลขเดียวกันให้ผลเท่ากัน", () => {
    expect(normalizeDocNo("INV-001")).toBe("INV001");
    expect(normalizeDocNo("inv 001")).toBe("INV001");
    expect(normalizeDocNo(" INV_001 ")).toBe("INV001");
    expect(normalizeDocNo("INV/001")).toBe("INV001");
  });
  it("ว่าง/null → ''", () => {
    expect(normalizeDocNo(null)).toBe("");
    expect(normalizeDocNo("   ")).toBe("");
  });
});

/** fake supabase query builder ที่คืน rows ที่กำหนด (chainable .eq/.is/.limit/.select) */
function fakeDb(rows: { doc_no: string | null; attachment_id: string | null }[] | { throw: true }) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is"]) builder[m] = () => builder;
  builder.limit = async () => {
    if ("throw" in rows) throw new Error("db error");
    return { data: rows };
  };
  return { from: () => builder } as never;
}

describe("hasEntryForSameContent", () => {
  const T = "t1", C = "cust1", DATE = "2026-08-01";

  it("เจอบิลเนื้อหาเดียวกัน (เลขที่ format ต่าง) → true", async () => {
    const db = fakeDb([{ doc_no: "inv 001", attachment_id: "att-OTHER" }]);
    expect(await hasEntryForSameContent(db, T, C, "INV-001", DATE, "att-NEW")).toBe(true);
  });

  it("ข้ามใบของ attachment เดียวกัน (ตัวเอง) → false", async () => {
    const db = fakeDb([{ doc_no: "INV001", attachment_id: "att-SELF" }]);
    expect(await hasEntryForSameContent(db, T, C, "INV-001", DATE, "att-SELF")).toBe(false);
  });

  it("เลขที่ต่างกัน → false (ไม่ dedup บิลจริงคนละใบ)", async () => {
    const db = fakeDb([{ doc_no: "INV-002", attachment_id: "att-OTHER" }]);
    expect(await hasEntryForSameContent(db, T, C, "INV-001", DATE, "att-NEW")).toBe(false);
  });

  it("ไม่มีบิลวันเดียวกัน → false", async () => {
    const db = fakeDb([]);
    expect(await hasEntryForSameContent(db, T, C, "INV-001", DATE, "att-NEW")).toBe(false);
  });

  it("query error → false (ไม่บล็อก ดีกว่าพลาดบิลจริง)", async () => {
    const db = fakeDb({ throw: true });
    expect(await hasEntryForSameContent(db, T, C, "INV-001", DATE, "att-NEW")).toBe(false);
  });
});
