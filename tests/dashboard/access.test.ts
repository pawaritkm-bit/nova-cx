import { describe, it, expect } from "vitest";
import { isPrivilegedRole, PRIVILEGED_ROLES } from "@/lib/dashboard/access";
import type { RoleCode } from "@/lib/dashboard/types";

describe("isPrivilegedRole — gate หน้า /cases (allow-list, default deny)", () => {
  it("executive/admin/cs = privileged", () => {
    for (const r of ["executive", "admin", "cs"] as RoleCode[]) {
      expect(isPrivilegedRole(r), `${r} ต้อง privileged`).toBe(true);
    }
    expect([...PRIVILEGED_ROLES].sort()).toEqual(["admin", "cs", "executive"]);
  });

  it("บทบาทอื่น (member/lead) = ไม่ privileged", () => {
    for (const r of ["accountant", "sales", "acc_lead", "sales_lead"] as RoleCode[]) {
      expect(isPrivilegedRole(r), `${r} ต้องไม่ privileged`).toBe(false);
    }
  });

  it("null/undefined/สตริงมั่ว → false (fail-closed)", () => {
    expect(isPrivilegedRole(null)).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
    expect(isPrivilegedRole("superuser")).toBe(false);
    expect(isPrivilegedRole("")).toBe(false);
  });
});
