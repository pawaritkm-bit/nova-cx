import { describe, it, expect } from "vitest";
import {
  customerIdsForAccountant,
  aggregateAccountantCards,
} from "@/lib/accounting/accountant-scope";
import { makeFakeDb, type ResolverArg } from "../helpers/fake-supabase";

/**
 * accountant-scope — สโคป "นักบัญชี ↔ ลูกค้าที่ดูแล"
 *   ครอบคลุม: customerIdsForAccountant (filter null + dedupe),
 *   aggregateAccountantCards (นับลูกค้า/บิลต่อคน + เรียง)
 */

describe("customerIdsForAccountant", () => {
  it("คืน customer_id (unique, ตัด null) ของนักบัญชีคนนั้น", async () => {
    const { db } = makeFakeDb((q: ResolverArg) => {
      if (q.table === "chat_groups") {
        return {
          data: [
            { customer_id: "c1" },
            { customer_id: "c2" },
            { customer_id: "c1" }, // ซ้ำ
            { customer_id: null }, // ยังไม่จับคู่ลูกค้า
          ],
        };
      }
      return { data: [] };
    });
    const ids = await customerIdsForAccountant(db, "t-1", "emp-1");
    expect(ids.sort()).toEqual(["c1", "c2"]);
  });

  it("ไม่ดูแลใคร → []", async () => {
    const { db } = makeFakeDb(() => ({ data: [] }));
    expect(await customerIdsForAccountant(db, "t-1", "emp-x")).toEqual([]);
  });
});

describe("aggregateAccountantCards", () => {
  it("นับลูกค้า/บิลต่อคน + เรียงตามจำนวนลูกค้ามาก→น้อย", () => {
    const groups = [
      { customer_id: "c1", responsible_employee_id: "e1" },
      { customer_id: "c2", responsible_employee_id: "e1" },
      { customer_id: "c3", responsible_employee_id: "e2" },
      { customer_id: null, responsible_employee_id: "e2" }, // ไม่มีลูกค้า → ข้าม
      { customer_id: "c4", responsible_employee_id: null }, // ไม่มีผู้ดูแล → ข้าม
    ];
    const names = new Map([
      ["e1", "ชาย"],
      ["e2", "หญิง"],
    ]);
    // บิล: c1×2, c2×1, c3×3
    const entryCustomerIds = ["c1", "c1", "c2", "c3", "c3", "c3", null];

    const cards = aggregateAccountantCards(groups, names, entryCustomerIds);
    expect(cards).toEqual([
      { employeeId: "e1", name: "ชาย", customerCount: 2, billCount: 3 },
      { employeeId: "e2", name: "หญิง", customerCount: 1, billCount: 3 },
    ]);
  });

  it("ไม่มีชื่อในแมป → fallback 'นักบัญชี'", () => {
    const cards = aggregateAccountantCards(
      [{ customer_id: "c1", responsible_employee_id: "e9" }],
      new Map(),
      []
    );
    expect(cards[0]).toMatchObject({ employeeId: "e9", name: "นักบัญชี", customerCount: 1, billCount: 0 });
  });
});
