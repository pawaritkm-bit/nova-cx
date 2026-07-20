import { describe, it, expect } from "vitest";
import {
  filterLeadCandidates,
  leadEmployeeTypeForTeam,
} from "@/lib/admin/team-lead-filter";

type Emp = { id: string; employee_type: string };
const employees: Emp[] = [
  { id: "a1", employee_type: "accountant" },
  { id: "a2", employee_type: "accountant" },
  { id: "s1", employee_type: "sales" },
  { id: "c1", employee_type: "cs" },
  { id: "o1", employee_type: "other" },
];

describe("leadEmployeeTypeForTeam", () => {
  it("map ประเภททีม → ประเภทพนักงานถูกต้อง", () => {
    expect(leadEmployeeTypeForTeam("accounting")).toBe("accountant");
    expect(leadEmployeeTypeForTeam("sales")).toBe("sales");
    expect(leadEmployeeTypeForTeam("cs")).toBe("cs");
  });
  it("ประเภทที่ไม่มี mapping → undefined (ไม่จำกัด)", () => {
    expect(leadEmployeeTypeForTeam("other")).toBeUndefined();
    expect(leadEmployeeTypeForTeam("")).toBeUndefined();
  });
});

describe("filterLeadCandidates", () => {
  it("ทีมบัญชี → เฉพาะ accountant", () => {
    const r = filterLeadCandidates(employees, "accounting");
    expect(r.map((e) => e.id)).toEqual(["a1", "a2"]);
  });
  it("ทีมขาย → เฉพาะ sales", () => {
    const r = filterLeadCandidates(employees, "sales");
    expect(r.map((e) => e.id)).toEqual(["s1"]);
  });
  it("ทีม CS → เฉพาะ cs", () => {
    const r = filterLeadCandidates(employees, "cs");
    expect(r.map((e) => e.id)).toEqual(["c1"]);
  });
  it("ประเภทไม่มี mapping → คืนทั้งหมด (กันตัน)", () => {
    const r = filterLeadCandidates(employees, "unknown");
    expect(r).toHaveLength(employees.length);
  });
  it("ไม่มีพนักงานประเภทที่ตรง → คืน list ว่าง", () => {
    const onlySales: Emp[] = [{ id: "s1", employee_type: "sales" }];
    expect(filterLeadCandidates(onlySales, "accounting")).toEqual([]);
  });
});
