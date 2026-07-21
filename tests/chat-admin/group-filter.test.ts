import { describe, it, expect } from "vitest";
import { filterChatGroups, matchesGroupQuery } from "@/lib/chat-admin/group-filter";

type Row = {
  id: string;
  groupName: string | null;
  customerName: string | null;
  responsibleName: string | null;
};

const rows: Row[] = [
  { id: "1", groupName: "กลุ่มบริษัท เอบีซี จำกัด", customerName: "เอบีซี", responsibleName: "สมชาย" },
  { id: "2", groupName: "Team ABC Support", customerName: null, responsibleName: "Ann" },
  { id: "3", groupName: "กลุ่มร้านกาแฟดอย", customerName: "ร้านกาแฟดอย", responsibleName: "สมหญิง" },
  { id: "4", groupName: null, customerName: "ลูกค้าไร้ชื่อกลุ่ม", responsibleName: null },
];

describe("filterChatGroups", () => {
  it("คำค้นว่าง → คืนทุกกลุ่ม", () => {
    expect(filterChatGroups(rows, "")).toHaveLength(4);
    expect(filterChatGroups(rows, "   ")).toHaveLength(4);
  });

  it("ค้นหาชื่อกลุ่มภาษาไทยแบบ substring (contains)", () => {
    const res = filterChatGroups(rows, "กาแฟ");
    expect(res.map((r) => r.id)).toEqual(["3"]);
  });

  it("case-insensitive สำหรับอังกฤษ (row 2 มี latin ABC)", () => {
    expect(filterChatGroups(rows, "abc").map((r) => r.id)).toEqual(["2"]);
    expect(filterChatGroups(rows, "ABC").map((r) => r.id)).toEqual(["2"]);
  });

  it("ตัดช่องว่างหัวท้ายของคำค้น", () => {
    expect(filterChatGroups(rows, "  ดอย  ").map((r) => r.id)).toEqual(["3"]);
  });

  it("ค้นครอบชื่อลูกค้า", () => {
    expect(filterChatGroups(rows, "ไร้ชื่อกลุ่ม").map((r) => r.id)).toEqual(["4"]);
  });

  it("ค้นครอบชื่อนักบัญชีผู้ดูแล", () => {
    expect(filterChatGroups(rows, "สมหญิง").map((r) => r.id)).toEqual(["3"]);
  });

  it("ไม่พบ → คืน []", () => {
    expect(filterChatGroups(rows, "ไม่มีทางเจอ")).toEqual([]);
  });

  it("แถวที่ชื่อกลุ่ม null ไม่ทำให้ crash และค้นชื่อว่างไม่เจอ", () => {
    const nullRow: Row[] = [{ id: "x", groupName: null, customerName: null, responsibleName: null }];
    expect(() => filterChatGroups(nullRow, "อะไรก็ได้")).not.toThrow();
    expect(filterChatGroups(nullRow, "อะไรก็ได้")).toEqual([]);
    // คำค้นว่างยังโชว์แถวชื่อว่าง
    expect(filterChatGroups(nullRow, "")).toHaveLength(1);
  });
});

describe("matchesGroupQuery", () => {
  it("คำค้นว่าง (normalized) → true เสมอ", () => {
    expect(matchesGroupQuery(rows[3], "")).toBe(true);
  });

  it("ไม่ match คำที่พาดคนละฟิลด์ต่อกัน", () => {
    // "สมชาย" (นักบัญชี) + "เอบีซี" (ลูกค้า) ไม่ควรต่อกันเป็น "สมชายเอบีซี"
    expect(matchesGroupQuery(rows[0], "สมชายเอบีซี")).toBe(false);
  });
});
