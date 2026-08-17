import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMappableServices } from "@/lib/integrations/nova-sales-interested-service";

describe("extractMappableServices", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("คืน [] เมื่อไม่มี a_services", () => {
    expect(extractMappableServices({})).toEqual([]);
    expect(extractMappableServices({ a_services: null })).toEqual([]);
    expect(extractMappableServices({ a_services: "single" })).toEqual([]);
  });

  it("คืน [] เมื่อเลือกเฉพาะ none (ยังไม่ต้องการ)", () => {
    expect(extractMappableServices({ a_services: ["none"] })).toEqual([]);
  });

  it("คืน valid codes ที่อยู่ในลิสต์ Sales 22 ตัว", () => {
    const result = extractMappableServices({
      a_services: ["tax_planning", "cfo", "holding_company"],
    });
    expect(result).toEqual(["tax_planning", "cfo", "holding_company"]);
  });

  it("ข้าม code ที่ไม่อยู่ในลิสต์ + log", () => {
    const result = extractMappableServices({
      a_services: ["tax_planning", "cx_marketing", "cfo"],
    });
    expect(result).toEqual(["tax_planning", "cfo"]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("skip unmappable option: cx_marketing")
    );
  });

  it("ข้าม none + ค่าว่าง + non-string", () => {
    const result = extractMappableServices({
      a_services: ["none", "", null, 123, "tax_planning"],
    });
    expect(result).toEqual(["tax_planning"]);
  });

  it("ครบทุก valid code (22 ตัว)", () => {
    const all22 = [
      "reg_company", "reg_partnership", "acct_monthly_personal",
      "acct_monthly_corporate", "personal_tax_annual", "vat_registration",
      "specific_business_tax", "social_security", "tax_planning",
      "internal_accounting", "company_closure", "change_director",
      "change_shareholder", "change_address", "legal_general",
      "visa", "audit_closing", "cfo", "stock_audit",
      "system_setup", "due_diligence", "holding_company",
    ];
    const result = extractMappableServices({ a_services: all22 });
    expect(result).toEqual(all22);
    expect(result).toHaveLength(22);
  });

  it("ผสม valid + invalid + none → คืนเฉพาะ valid", () => {
    const result = extractMappableServices({
      a_services: [
        "tax_planning",
        "none",
        "cx_ai_automation",
        "cfo",
        "unknown_code",
        "holding_company",
      ],
    });
    expect(result).toEqual(["tax_planning", "cfo", "holding_company"]);
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });
});
