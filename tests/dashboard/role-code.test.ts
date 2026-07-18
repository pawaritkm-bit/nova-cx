import { describe, it, expect } from "vitest";
import { isRoleCode, ROLE_CODES } from "@/lib/dashboard/types";
import { isPrivilegedRole } from "@/lib/dashboard/access";
import { isAdminRole } from "@/lib/admin/guard";
import { canExportReports } from "@/lib/reports";

/**
 * Phase 0 (โมดูล AI วิเคราะห์แชท): บทบาทใหม่ auditor_qa / hr
 *   - ต้องถูก "รู้จัก" (isRoleCode = true, มีป้ายภาษาไทย)
 *   - ★ ต้อง "ไม่" ได้สิทธิ์ privileged/admin/export ใด ๆ (default deny / ไม่แตะ pseudonymity)
 */
describe("RoleCode — รับบทบาทใหม่ auditor_qa/hr", () => {
  it("isRoleCode รับ 2 บทบาทใหม่", () => {
    expect(isRoleCode("auditor_qa")).toBe(true);
    expect(isRoleCode("hr")).toBe(true);
  });

  it("ยังรับบทบาทเดิมครบ + มีทั้งหมด 9 บทบาท", () => {
    for (const r of [
      "executive",
      "acc_lead",
      "accountant",
      "sales_lead",
      "sales",
      "cs",
      "admin",
    ]) {
      expect(isRoleCode(r), `${r} ต้องยังเป็น RoleCode`).toBe(true);
    }
    expect(ROLE_CODES).toHaveLength(9);
  });

  it("สตริงมั่ว/ค่าว่าง → false (fail-closed)", () => {
    expect(isRoleCode("superuser")).toBe(false);
    expect(isRoleCode("")).toBe(false);
  });

  it("★ auditor_qa/hr ต้องไม่ privileged / ไม่ admin / export ไม่ได้ (ไม่แตะ pseudonymity)", () => {
    for (const r of ["auditor_qa", "hr"] as const) {
      expect(isPrivilegedRole(r), `${r} ต้องไม่ privileged`).toBe(false);
      expect(isAdminRole(r), `${r} ต้องไม่ admin`).toBe(false);
      expect(canExportReports(r), `${r} ต้อง export ไม่ได้`).toBe(false);
    }
  });
});
