import { describe, it, expect } from "vitest";
import { canExportReports, EXPORT_ALLOWED_ROLES } from "@/lib/reports";
import { ROLE_CODES } from "@/lib/dashboard/types";

/**
 * H1/M1 — export gate allow-list (default deny)
 *   อนุญาต export เฉพาะบทบาทที่มีสิทธิ์ดูข้อมูลผูกลูกค้า
 *   member (accountant/sales) + role=null/undefined → ปฏิเสธ (fail-closed)
 */
describe("export gate allow-list", () => {
  it("อนุญาตเฉพาะ executive/admin/acc_lead/sales_lead/cs", () => {
    for (const r of EXPORT_ALLOWED_ROLES) {
      expect(canExportReports(r), `${r} ควร export ได้`).toBe(true);
    }
    // ยืนยัน allow-list ตรงตามที่กำหนด (กันเผลอเพิ่มบทบาท)
    expect([...EXPORT_ALLOWED_ROLES].sort()).toEqual(
      ["acc_lead", "admin", "cs", "executive", "sales_lead"].sort()
    );
  });

  it("ปฏิเสธ member (accountant/sales)", () => {
    expect(canExportReports("accountant")).toBe(false);
    expect(canExportReports("sales")).toBe(false);
  });

  it("default deny: role=null / undefined → false (fail-closed)", () => {
    expect(canExportReports(null)).toBe(false);
    expect(canExportReports(undefined)).toBe(false);
  });

  it("ทุกบทบาทที่ไม่อยู่ใน allow-list ต้องถูกปฏิเสธ", () => {
    for (const r of ROLE_CODES) {
      const allowed = (EXPORT_ALLOWED_ROLES as readonly string[]).includes(r);
      expect(canExportReports(r)).toBe(allowed);
    }
  });
});
