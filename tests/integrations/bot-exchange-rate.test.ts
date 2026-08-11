import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBotReferenceRate } from "@/lib/integrations/bot-exchange-rate";

/**
 * bot-exchange-rate.ts — เฟส 10 (0.12) — best-effort prefill อัตราแลกเปลี่ยนอ้างอิง ธปท.
 *   เน้น: ทุกกรณีล้มเหลว (network/timeout/status ไม่ 200/format เปลี่ยน/ไม่มีอัตราวันนั้น) → {ok:false}
 *   เสมอ ไม่ throw ทะลุ (T80)
 */
describe("fetchBotReferenceRate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("input ผิดรูปแบบ (currency/date) → {ok:false} ทันที ไม่ยิง fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res1 = await fetchBotReferenceRate("usd", "2026-08-01");
    const res2 = await fetchBotReferenceRate("USD", "2026-13-40");
    expect(res1).toEqual({ ok: false });
    expect(res2).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("สำเร็จ: status 200 + มีอัตราของสกุลนั้น → {ok:true, rate}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          result: { data: { data_detail: [{ currency_id: "USD", period: "2026-08-01", mid_rate: 35.5 }] } },
        }),
      })
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: true, rate: 35.5 });
  });

  it("status ไม่ 200 → {ok:false}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("network error (fetch throw) → {ok:false} ไม่ throw ทะลุ", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("timeout (AbortError) → {ok:false} ไม่ throw ทะลุ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("รูปแบบ response เปลี่ยน/พัง (json parse ไม่ได้) → {ok:false}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      })
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("ไม่มีอัตราของสกุลนั้นวันนั้น (data_detail ว่าง) → {ok:false}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: { data: { data_detail: [] } } }),
      })
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("rate เป็นค่าที่ไม่ถูกต้อง (0/ลบ/ไม่ใช่ตัวเลข) → {ok:false}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: { data: { data_detail: [{ currency_id: "USD", mid_rate: "abc" }] } } }),
      })
    );
    const res = await fetchBotReferenceRate("USD", "2026-08-01");
    expect(res).toEqual({ ok: false });
  });

  it("ไม่มี console.* ที่มี response payload เต็ม (PDPA/best-effort) — แค่ smoke ว่าไม่ throw ตอน log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await fetchBotReferenceRate("USD", "2026-08-01");
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("data_detail");
    }
    warnSpy.mockRestore();
  });
});
