import { describe, it, expect } from "vitest";
import {
  mergeTeamMemberIds,
  dedupeCustomerIds,
  teamMemberIdsForLead,
  customerIdsForLead,
  aggregateTeamCards,
} from "@/lib/accounting/lead-scope";
import { makeFakeDb, type ResolverArg } from "../helpers/fake-supabase";

/**
 * lead-scope — สโคป "หัวหน้าทีม ↔ ทีมของตัวเอง"
 *   ครอบคลุม: รวม/ dedupe ids (pure), teamMemberIdsForLead (union ทีม+ตัวเอง),
 *   customerIdsForLead (union ลูกค้าทั้งทีม), aggregateTeamCards (กรองเฉพาะคนในทีม + นับสถานะ)
 */

describe("mergeTeamMemberIds (pure)", () => {
  it("รวมลูกทีม + ตัวหัวหน้า (unique, หัวหน้ามาก่อน, ตัด null)", () => {
    expect(mergeTeamMemberIds("lead", ["m1", "m2", null, "m1", "lead"])).toEqual([
      "lead",
      "m1",
      "m2",
    ]);
  });

  it("ไม่มีลูกทีม → เหลือแค่หัวหน้า", () => {
    expect(mergeTeamMemberIds("lead", [])).toEqual(["lead"]);
  });
});

describe("dedupeCustomerIds (pure)", () => {
  it("ตัด null/ซ้ำ", () => {
    expect(dedupeCustomerIds(["c1", "c2", "c1", null, undefined]).sort()).toEqual(["c1", "c2"]);
  });
});

describe("teamMemberIdsForLead", () => {
  it("union สมาชิกทุกทีมที่ตัวเองเป็นหัวหน้า + ตัวเอง", async () => {
    const { db } = makeFakeDb((q: ResolverArg) => {
      if (q.table === "teams") return { data: [{ id: "t1" }, { id: "t2" }] };
      if (q.table === "team_members")
        return {
          data: [
            { employee_id: "m1" },
            { employee_id: "m2" },
            { employee_id: null },
            { employee_id: "lead-1" }, // ตัวหัวหน้าเองอยู่ในทีมด้วย → ไม่ซ้ำ
          ],
        };
      return { data: [] };
    });
    const ids = await teamMemberIdsForLead(db, "t-1", "lead-1");
    expect(ids).toEqual(["lead-1", "m1", "m2"]);
  });

  it("ไม่เป็นหัวหน้าทีมไหนเลย → เห็นแค่ตัวเอง", async () => {
    const { db } = makeFakeDb((q: ResolverArg) => {
      if (q.table === "teams") return { data: [] };
      return { data: [] };
    });
    expect(await teamMemberIdsForLead(db, "t-1", "lead-1")).toEqual(["lead-1"]);
  });
});

describe("customerIdsForLead", () => {
  it("union ลูกค้าของสมาชิกทุกคนในทีม (unique, ตัด null)", async () => {
    const { db } = makeFakeDb((q: ResolverArg) => {
      if (q.table === "teams") return { data: [{ id: "t1" }] };
      if (q.table === "team_members") return { data: [{ employee_id: "m1" }] };
      if (q.table === "chat_groups")
        return {
          data: [
            { customer_id: "c1" },
            { customer_id: "c2" },
            { customer_id: "c1" }, // ซ้ำ
            { customer_id: null }, // ยังไม่จับคู่
          ],
        };
      return { data: [] };
    });
    const ids = await customerIdsForLead(db, "t-1", "lead-1");
    expect(ids.sort()).toEqual(["c1", "c2"]);
  });
});

describe("aggregateTeamCards (pure)", () => {
  it("กรองเฉพาะคนในทีม + นับลูกค้า/บิล/สถานะ + เรียงค้างตรวจมากสุดก่อน", () => {
    const cards = aggregateTeamCards({
      memberIds: ["lead", "m1", "m2"],
      leadEmployeeId: "lead",
      groups: [
        { customer_id: "c1", responsible_employee_id: "m1" },
        { customer_id: "c2", responsible_employee_id: "m1" },
        { customer_id: "c3", responsible_employee_id: "lead" },
        { customer_id: "c9", responsible_employee_id: "outsider" }, // นอกทีม → ข้าม
      ],
      names: new Map([
        ["lead", "สวย"],
        ["m1", "ฟรีม"],
        ["m2", "บิว"],
      ]),
      entries: [
        { customer_id: "c1", status: "confirmed", entry_type: "purchase" },
        { customer_id: "c1", status: "draft", entry_type: "purchase" },
        { customer_id: "c2", status: "draft", entry_type: "unspecified" },
        { customer_id: "c3", status: "confirmed", entry_type: "sale" },
        { customer_id: "c9", status: "draft", entry_type: "purchase" }, // นอกทีม → ข้าม
      ],
    });

    // เรียง: m1 (pending 2) → lead (pending 0, 1 ลูกค้า) → m2 (pending 0, 0 ลูกค้า)
    expect(cards.map((c) => c.employeeId)).toEqual(["m1", "lead", "m2"]);

    const m1 = cards[0];
    expect(m1).toMatchObject({
      name: "ฟรีม",
      customerCount: 2,
      billCount: 3,
      confirmedCount: 1,
      draftCount: 1,
      unspecifiedCount: 1,
      pendingCount: 2,
      isSelf: false,
    });

    const lead = cards[1];
    expect(lead).toMatchObject({
      name: "สวย",
      customerCount: 1,
      billCount: 1,
      confirmedCount: 1,
      pendingCount: 0,
      isSelf: true, // ตัวหัวหน้าเอง
    });

    // m2 ไม่มีลูกค้า → การ์ดว่าง (ยังโชว์)
    expect(cards[2]).toMatchObject({ employeeId: "m2", customerCount: 0, billCount: 0 });
  });

  it("ไม่มีชื่อในแมป → fallback 'นักบัญชี'", () => {
    const cards = aggregateTeamCards({
      memberIds: ["e9"],
      leadEmployeeId: "e9",
      groups: [],
      names: new Map(),
      entries: [],
    });
    expect(cards[0]).toMatchObject({ employeeId: "e9", name: "นักบัญชี", customerCount: 0 });
  });
});
