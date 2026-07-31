import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeTaxId, isValidTaxId, taxIdDigits } from "@/lib/accounting/tax-id";
import { pushCustomerTaxId } from "@/lib/integrations/nova-sales-outbound";

/**
 * เทสต์ loop เก็บเลขภาษี:
 *   1) validate/normalize เลขภาษี (pure)
 *   2) outbound ส่งกลับ NOVA Sale — gated/skip เมื่อไม่ตั้ง env, ยิงจริงเมื่อตั้ง (fetch mock)
 */

describe("tax-id — normalize / validate (13 หลัก)", () => {
  it("strip ขีด/ช่องว่าง เหลือ 13 หลัก → คืนตัวเลขล้วน", () => {
    expect(normalizeTaxId("0-9940-00000-00-1")).toBe("0994000000001");
    expect(normalizeTaxId("0994 0000 00001")).toBe("0994000000001");
    expect(normalizeTaxId("0994000000001")).toBe("0994000000001");
  });

  it("ไม่ครบ 13 / เกิน 13 / ว่าง / ไม่ใช่ string → null", () => {
    expect(normalizeTaxId("099400000000")).toBeNull(); // 12 หลัก
    expect(normalizeTaxId("09940000000012")).toBeNull(); // 14 หลัก
    expect(normalizeTaxId("")).toBeNull();
    expect(normalizeTaxId("abcdefghijklm")).toBeNull(); // ไม่มีตัวเลข
    expect(normalizeTaxId(null)).toBeNull();
    expect(normalizeTaxId(12345678901 as unknown)).toBeNull();
  });

  it("isValidTaxId / taxIdDigits", () => {
    expect(isValidTaxId("0-9940-00000-00-1")).toBe(true);
    expect(isValidTaxId("123")).toBe(false);
    expect(taxIdDigits("0-99a40 001")).toBe("09940001");
    expect(taxIdDigits(null)).toBe("");
  });
});

describe("nova-sales-outbound — pushCustomerTaxId (gated/skip/degrade)", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOVA_SALES_OUTBOUND_URL;
    delete process.env.NOVA_SALES_API_KEY;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("ไม่ตั้ง NOVA_SALES_OUTBOUND_URL → skip (ok:true, skipped:true) ไม่ยิง fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await pushCustomerTaxId({
      externalRef: "ext-1",
      customerCode: "N001",
      taxId: "0994000000001",
    });
    expect(res).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ตั้ง URL แต่ไม่มี external_ref/customer_code → skip (ระบุลูกค้าไม่ได้)", async () => {
    process.env.NOVA_SALES_OUTBOUND_URL = "https://sales.example/api/tax-id";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await pushCustomerTaxId({
      externalRef: null,
      customerCode: null,
      taxId: "0994000000001",
    });
    expect(res).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ตั้ง URL + key → POST payload ถูกต้อง + x-api-key header", async () => {
    process.env.NOVA_SALES_OUTBOUND_URL = "https://sales.example/api/tax-id";
    process.env.NOVA_SALES_API_KEY = "secret-key";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await pushCustomerTaxId({
      externalRef: "ext-9",
      customerCode: "N023",
      taxId: "0994000000001",
    });
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://sales.example/api/tax-id");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("secret-key");
    expect(JSON.parse(init.body)).toEqual({
      external_customer_id: "ext-9",
      customer_code: "N023",
      tax_id: "0994000000001",
    });
    vi.unstubAllGlobals();
  });

  it("NOVA Sale ตอบ non-2xx → ok:false (ไม่ throw)", async () => {
    process.env.NOVA_SALES_OUTBOUND_URL = "https://sales.example/api/tax-id";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await pushCustomerTaxId({
      externalRef: "ext-1",
      customerCode: null,
      taxId: "0994000000001",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("status_500");
    vi.unstubAllGlobals();
  });

  it("fetch โยน error (เชื่อมต่อไม่ได้) → ok:false network (ไม่ throw)", async () => {
    process.env.NOVA_SALES_OUTBOUND_URL = "https://sales.example/api/tax-id";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await pushCustomerTaxId({
      externalRef: "ext-1",
      customerCode: null,
      taxId: "0994000000001",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network");
    vi.unstubAllGlobals();
  });
});
