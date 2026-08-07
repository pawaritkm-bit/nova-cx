import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAccessToken,
  createSalesDocument,
  __resetFlowAccountTokenCacheForTests,
} from "@/lib/integrations/flowaccount";

/**
 * flowaccount.ts — thin REST client (OAuth2 client_credentials + create sales document)
 *   ครอบ: not_configured (ไม่ยิง fetch), token สำเร็จ/ล้มทุก branch, cache token,
 *         create document สำเร็จ/4xx/401/5xx/timeout/network
 */
describe("flowaccount — getAccessToken / createSalesDocument", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetFlowAccountTokenCacheForTests();
    delete process.env.FLOWACCOUNT_TOKEN_URL;
    delete process.env.FLOWACCOUNT_API_BASE_URL;
    delete process.env.FLOWACCOUNT_CLIENT_ID;
    delete process.env.FLOWACCOUNT_CLIENT_SECRET;
    delete process.env.FLOWACCOUNT_SCOPE;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
    __resetFlowAccountTokenCacheForTests();
  });

  function setEnv() {
    process.env.FLOWACCOUNT_TOKEN_URL = "https://fa.example/test/token";
    process.env.FLOWACCOUNT_API_BASE_URL = "https://fa.example/test";
    process.env.FLOWACCOUNT_CLIENT_ID = "cid";
    process.env.FLOWACCOUNT_CLIENT_SECRET = "csecret";
    process.env.FLOWACCOUNT_SCOPE = "flowaccount-api";
  }

  function tokenRes(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  function docRes(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  describe("getAccessToken", () => {
    it("ไม่ตั้ง env → not_configured (ไม่ยิง fetch)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getAccessToken();
      expect(res).toEqual({ ok: false, reason: "not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("สำเร็จ → ok:true + ส่ง form-urlencoded ครบ (client_id/secret/grant_type/scope)", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetchSpy);

      const res = await getAccessToken();
      expect(res).toEqual({ ok: true, token: "tok-1" });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://fa.example/test/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(init.body as string);
      expect(params.get("client_id")).toBe("cid");
      expect(params.get("client_secret")).toBe("csecret");
      expect(params.get("grant_type")).toBe("client_credentials");
      expect(params.get("scope")).toBe("flowaccount-api");
    });

    it("cache: เรียกซ้ำก่อน token หมดอายุ → ไม่ยิง fetch รอบสอง", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetchSpy);

      const r1 = await getAccessToken();
      const r2 = await getAccessToken();
      expect(r1).toEqual({ ok: true, token: "tok-1" });
      expect(r2).toEqual({ ok: true, token: "tok-1" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("401/403 → auth_failed", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(401)));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "auth_failed" });
    });

    it("400 → validation_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(400)));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "validation_error" });
    });

    it("500 → server_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(500)));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "server_error" });
    });

    it("response ไม่มี access_token → server_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(200, {})));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "server_error" });
    });

    it("timeout (AbortError) → timeout", async () => {
      setEnv();
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "timeout" });
    });

    it("network error → network", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
      expect(await getAccessToken()).toEqual({ ok: false, reason: "network" });
    });
  });

  describe("createSalesDocument", () => {
    it("ไม่ตั้ง env → not_configured (ไม่ยิง fetch)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await createSalesDocument({ docType: "tax_invoice", body: { foo: "bar" } });
      expect(res).toEqual({ ok: false, reason: "not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("token ล้ม → ส่งต่อ reason เดียวกัน ไม่ยิง create", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(401));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await createSalesDocument({ docType: "tax_invoice", body: {} });
      expect(res).toEqual({ ok: false, reason: "auth_failed" });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // แค่ token ไม่ยิง create ต่อ
    });

    it("สำเร็จ (tax_invoice) → ยิง POST /tax-invoices พร้อม Bearer + คืน docId/docNo", async () => {
      setEnv();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
        .mockResolvedValueOnce(docRes(200, { recordId: 12345, documentSerial: "IV-0001" }));
      vi.stubGlobal("fetch", fetchSpy);

      const res = await createSalesDocument({ docType: "tax_invoice", body: { subTotal: 100 } });
      expect(res).toEqual({ ok: true, docId: "12345", docNo: "IV-0001" });

      const [url, init] = fetchSpy.mock.calls[1];
      expect(url).toBe("https://fa.example/test/tax-invoices");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer tok-1");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({ subTotal: 100 });
    });

    it("สำเร็จ (ทรง response จริง — ห่อด้วย {status,message,code,data}) → unwrap data ถูกต้อง", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(
            docRes(200, {
              status: true,
              message: "",
              code: 0,
              data: { recordId: 555, documentSerial: "IV-2026-0055" },
            })
          )
      );
      const res = await createSalesDocument({ docType: "tax_invoice", body: {} });
      expect(res).toEqual({ ok: true, docId: "555", docNo: "IV-2026-0055" });
    });

    it("สำเร็จ (cash_sale) → ยิง POST /cash-invoices", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(docRes(200, { id: "999" }))
      );
      const res = await createSalesDocument({ docType: "cash_sale", body: {} });
      expect(res).toEqual({ ok: true, docId: "999", docNo: null });
    });

    it("ยิง create 2 ครั้ง → ขอ token แค่ครั้งเดียว (cache)", async () => {
      setEnv();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
        .mockResolvedValueOnce(docRes(200, { recordId: 1 }))
        .mockResolvedValueOnce(docRes(200, { recordId: 2 }));
      vi.stubGlobal("fetch", fetchSpy);

      await createSalesDocument({ docType: "tax_invoice", body: {} });
      await createSalesDocument({ docType: "cash_sale", body: {} });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 token + 2 create
    });

    it("401/403 → auth_failed", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(docRes(403))
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "auth_failed",
      });
    });

    it("4xx (ไม่ใช่ 401/403) → validation_error", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(docRes(422))
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "validation_error",
      });
    });

    it("5xx → server_error", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(docRes(500))
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "server_error",
      });
    });

    it("response สำเร็จแต่ไม่มี id → server_error", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockResolvedValueOnce(docRes(200, {}))
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "server_error",
      });
    });

    it("timeout (AbortError) → timeout", async () => {
      setEnv();
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockRejectedValueOnce(abortErr)
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "timeout",
      });
    });

    it("network error → network", async () => {
      setEnv();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
          .mockRejectedValueOnce(new Error("boom"))
      );
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} })).toEqual({
        ok: false,
        reason: "network",
      });
    });
  });
});
