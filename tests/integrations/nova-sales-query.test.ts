import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCustomerFromNovaSales } from "@/lib/integrations/nova-sales-query";

/**
 * เทสต์ NOVA-CX → NOVA Sales query client (ดึงข้อมูลลูกค้าด้วยเลขภาษี):
 *   - gated: ไม่ตั้ง env → not_configured (ไม่ยิง fetch)
 *   - validate: เลขภาษีไม่ครบ 13 → invalid_tax_id (ไม่ยิง)
 *   - ยิงจริง: Bearer header + parse response หลายทรง (array / {data:[]} / object เดี่ยว / contact ซ้อน)
 *   - degrade: 401/404/500/network → ok:false ตามเหตุ ไม่ throw
 */
describe("nova-sales-query — fetchCustomerFromNovaSales", () => {
  const OLD_ENV = { ...process.env };
  const VALID_TAX = "0994000000001";

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOVA_SALES_QUERY_URL;
    delete process.env.NOVA_SALES_QUERY_API_KEY;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  function setEnv() {
    process.env.NOVA_SALES_QUERY_URL = "https://sales.example/api/v1";
    process.env.NOVA_SALES_QUERY_API_KEY = "nova_acc_secret";
  }

  it("ไม่ตั้ง env → not_configured (ไม่ยิง fetch)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await fetchCustomerFromNovaSales(VALID_TAX);
    expect(res).toEqual({ ok: false, reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ตั้ง env แต่เลขภาษีไม่ครบ 13 → invalid_tax_id (ไม่ยิง)", async () => {
    setEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await fetchCustomerFromNovaSales("12345");
    expect(res).toEqual({ ok: false, reason: "invalid_tax_id" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ยิงจริง: ส่ง Bearer + query tax_id, parse {data:[...]} + business_name/address/phone", async () => {
    setEnv();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            business_name: "บริษัท ตัวอย่าง จำกัด",
            name: "ตัวอย่าง",
            address: "123 ถนนทดสอบ กรุงเทพฯ",
            phone: "021234567",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await fetchCustomerFromNovaSales(VALID_TAX);
    expect(res).toEqual({
      ok: true,
      data: {
        name: "บริษัท ตัวอย่าง จำกัด", // business_name มาก่อน name
        address: "123 ถนนทดสอบ กรุงเทพฯ",
        phone: "021234567",
      },
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://sales.example/api/v1/customers?tax_id=0994000000001");
    expect(init.headers.Authorization).toBe("Bearer nova_acc_secret");
    expect(init.method).toBe("GET");
  });

  it("parse: object เดี่ยว + เบอร์ซ้อนใน contact", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ name: "ร้านเดี่ยว", contact: { phone: "0899999999" } }),
      })
    );
    const res = await fetchCustomerFromNovaSales(VALID_TAX);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.name).toBe("ร้านเดี่ยว");
      expect(res.data.phone).toBe("0899999999");
      expect(res.data.address).toBeNull();
    }
  });

  it("response ว่าง (ไม่มีช่องใช้ได้เลย) → not_found", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
    );
    const res = await fetchCustomerFromNovaSales(VALID_TAX);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("401 → unauthorized · 404 → not_found · 500 → error · network → error (ไม่ throw)", async () => {
    setEnv();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchCustomerFromNovaSales(VALID_TAX)).toEqual({ ok: false, reason: "unauthorized" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchCustomerFromNovaSales(VALID_TAX)).toEqual({ ok: false, reason: "not_found" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchCustomerFromNovaSales(VALID_TAX)).toEqual({ ok: false, reason: "error" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchCustomerFromNovaSales(VALID_TAX)).toEqual({ ok: false, reason: "error" });
  });
});
