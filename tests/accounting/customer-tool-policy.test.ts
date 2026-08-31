import { describe, expect, it } from "vitest";
import { canUseAccountingTool } from "@/lib/accounting/customer-tool-policy";

describe("customer tool policy", () => {
  it("บุคคลธรรมดาและนิติบุคคลใช้วงจรบัญชีรายเดือนได้", () => {
    expect(canUseAccountingTool("individual", "monthly")).toBe(true);
    expect(canUseAccountingTool("company", "monthly")).toBe(true);
  });

  it("งานปิดงบ/งบทางการใช้ได้เฉพาะนิติบุคคล", () => {
    expect(canUseAccountingTool("individual", "company_closing")).toBe(false);
    expect(canUseAccountingTool("company", "company_closing")).toBe(true);
  });

  it("ลูกค้าที่ยังไม่ระบุประเภทต้องตั้งค่าก่อน", () => {
    expect(canUseAccountingTool(null, "monthly")).toBe(false);
    expect(canUseAccountingTool(null, "company_closing")).toBe(false);
  });
});
