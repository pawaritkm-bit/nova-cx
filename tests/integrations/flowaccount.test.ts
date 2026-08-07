import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAccessToken,
  createSalesDocument,
  __resetFlowAccountTokenCacheForTests,
  type FlowAccountCredential,
} from "@/lib/integrations/flowaccount";

/**
 * flowaccount.ts — thin REST client (OAuth2 client_credentials + create sales document)
 *   ครอบ: not_configured (ไม่ยิง fetch), token สำเร็จ/ล้มทุก branch, cache token (M2: keyed by clientId),
 *         create document สำเร็จ/4xx/401/5xx/timeout/network
 *
 * ★★ M2 — credential เป็นพารามิเตอร์ (ไม่ใช่ env อีกต่อไป) — token cache ต้องแยกตาม clientId เด็ดขาด
 *   (docs/05-flowaccount-integration.md หมวด M2, decision 0.4) — มีเทสต์บังคับพิสูจน์ตรงๆ ว่าไม่ปนกัน
 */
describe("flowaccount — getAccessToken / createSalesDocument", () => {
  const OLD_ENV = { ...process.env };

  const credentialA: FlowAccountCredential = { clientId: "cid-A", clientSecret: "secret-A" };
  const credentialB: FlowAccountCredential = { clientId: "cid-B", clientSecret: "secret-B" };

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetFlowAccountTokenCacheForTests();
    delete process.env.FLOWACCOUNT_TOKEN_URL;
    delete process.env.FLOWACCOUNT_API_BASE_URL;
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
    process.env.FLOWACCOUNT_SCOPE = "flowaccount-api";
  }

  function tokenRes(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  function docRes(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  /** mock fetch ที่ตอบ token ตาม client_id ใน form body จริง (ไม่ใช่ตามลำดับ call) */
  function tokenByClientIdFetch(map: Record<string, { accessToken: string; expiresIn?: number }>) {
    return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const params = new URLSearchParams(init.body as string);
      const clientId = params.get("client_id") ?? "";
      const found = map[clientId];
      if (!found) return tokenRes(401);
      return tokenRes(200, { access_token: found.accessToken, expires_in: found.expiresIn ?? 3600 });
    });
  }

  describe("getAccessToken", () => {
    it("ไม่ตั้ง env กลาง → not_configured (ไม่ยิง fetch) แม้ credential ครบ", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getAccessToken(credentialA);
      expect(res).toEqual({ ok: false, reason: "not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("สำเร็จ → ok:true + ส่ง form-urlencoded ครบ (client_id/secret ของ credential ที่ส่งเข้ามา + scope กลาง)", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetchSpy);

      const res = await getAccessToken(credentialA);
      expect(res).toEqual({ ok: true, token: "tok-1" });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://fa.example/test/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(init.body as string);
      expect(params.get("client_id")).toBe("cid-A");
      expect(params.get("client_secret")).toBe("secret-A");
      expect(params.get("grant_type")).toBe("client_credentials");
      expect(params.get("scope")).toBe("flowaccount-api");
    });

    it("cache: เรียกซ้ำก่อน token หมดอายุ (credential เดิม) → ไม่ยิง fetch รอบสอง", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetchSpy);

      const r1 = await getAccessToken(credentialA);
      const r2 = await getAccessToken(credentialA);
      expect(r1).toEqual({ ok: true, token: "tok-1" });
      expect(r2).toEqual({ ok: true, token: "tok-1" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("★ เทสต์บังคับ — token cache แยกตาม clientId (พิสูจน์ cross-tenant ไม่ปนกัน)", async () => {
      setEnv();
      const fetchSpy = tokenByClientIdFetch({
        "cid-A": { accessToken: "tok-A" },
        "cid-B": { accessToken: "tok-B" },
      });
      vi.stubGlobal("fetch", fetchSpy);

      // 1) A → tokenA, ยิง fetch 1 ครั้ง
      const r1 = await getAccessToken(credentialA);
      expect(r1).toEqual({ ok: true, token: "tok-A" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2) A ซ้ำ (ก่อนหมดอายุ) → cache, ไม่ยิง fetch เพิ่ม
      const r2 = await getAccessToken(credentialA);
      expect(r2).toEqual({ ok: true, token: "tok-A" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 3) B (clientId ต่างกัน) → ยิง fetch ใหม่ ไม่ใช้ cache ของ A ได้ tokenB
      const r3 = await getAccessToken(credentialB);
      expect(r3).toEqual({ ok: true, token: "tok-B" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // 4) A อีกครั้งหลังขอ B ไปแล้ว → ยังได้ tokenA ที่ถูกต้อง (ไม่ใช่ tokenB รั่วมาทับ cache ของ A)
      const r4 = await getAccessToken(credentialA);
      expect(r4).toEqual({ ok: true, token: "tok-A" });
      expect(fetchSpy).toHaveBeenCalledTimes(2); // ยังใช้ cache ของ A อยู่ ไม่ยิงเพิ่ม
    });

    it("401/403 → auth_failed", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(401)));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "auth_failed" });
    });

    it("400 → validation_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(400)));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "validation_error" });
    });

    it("500 → server_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(500)));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "server_error" });
    });

    it("response ไม่มี access_token → server_error", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenRes(200, {})));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "server_error" });
    });

    it("timeout (AbortError) → timeout", async () => {
      setEnv();
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "timeout" });
    });

    it("network error → network", async () => {
      setEnv();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
      expect(await getAccessToken(credentialA)).toEqual({ ok: false, reason: "network" });
    });
  });

  describe("createSalesDocument", () => {
    it("ไม่ตั้ง env กลาง → not_configured (ไม่ยิง fetch) แม้ credential ครบ", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await createSalesDocument({ docType: "tax_invoice", body: { foo: "bar" } }, credentialA);
      expect(res).toEqual({ ok: false, reason: "not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("token ล้ม → ส่งต่อ reason เดียวกัน ไม่ยิง create", async () => {
      setEnv();
      const fetchSpy = vi.fn().mockResolvedValue(tokenRes(401));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA);
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

      const res = await createSalesDocument({ docType: "tax_invoice", body: { subTotal: 100 } }, credentialA);
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
      const res = await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA);
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
      const res = await createSalesDocument({ docType: "cash_sale", body: {} }, credentialA);
      expect(res).toEqual({ ok: true, docId: "999", docNo: null });
    });

    it("ยิง create 2 ครั้ง (credential เดิม) → ขอ token แค่ครั้งเดียว (cache)", async () => {
      setEnv();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(tokenRes(200, { access_token: "tok-1", expires_in: 3600 }))
        .mockResolvedValueOnce(docRes(200, { recordId: 1 }))
        .mockResolvedValueOnce(docRes(200, { recordId: 2 }));
      vi.stubGlobal("fetch", fetchSpy);

      await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA);
      await createSalesDocument({ docType: "cash_sale", body: {} }, credentialA);
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
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
      expect(await createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA)).toEqual({
        ok: false,
        reason: "network",
      });
    });

    it("★ เทสต์บังคับ — ยิง concurrent สองลูกค้าแล้ว Bearer token ต้องไม่สลับกัน (จำลอง 2 นักบัญชีกดส่งบิลคนละบริษัทพร้อมกัน)", async () => {
      setEnv();

      // mock fetch ที่ตอบตาม "เนื้อ request จริง" (client_id ใน token body / URL+auth header ตอน create)
      // ไม่ใช่ตามลำดับการเรียก — เพื่อจำลอง race ที่ response กลับมาสลับลำดับกันได้จริง
      const tokenByClient: Record<string, string> = { "cid-A": "tok-A", "cid-B": "tok-B" };
      const fetchSpy = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith("/token")) {
          const params = new URLSearchParams(init.body as string);
          const clientId = params.get("client_id") ?? "";
          const token = tokenByClient[clientId];
          // หน่วงเวลาสลับกัน (A ช้ากว่า B) จำลอง race ของ network จริง
          await new Promise((r) => setTimeout(r, clientId === "cid-A" ? 10 : 0));
          return tokenRes(200, { access_token: token, expires_in: 3600 });
        }
        // create document — ตรวจว่า Authorization header ตรงกับ token ของ client ที่ควรจะเป็น
        const auth = (init.headers as Record<string, string>).Authorization;
        if (url.includes("/tax-invoices")) {
          return docRes(200, { recordId: "doc-A", documentSerial: `made-with:${auth}` });
        }
        return docRes(200, { recordId: "doc-B", documentSerial: `made-with:${auth}` });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const [resA, resB] = await Promise.all([
        createSalesDocument({ docType: "tax_invoice", body: {} }, credentialA),
        createSalesDocument({ docType: "cash_sale", body: {} }, credentialB),
      ]);

      expect(resA).toEqual({ ok: true, docId: "doc-A", docNo: "made-with:Bearer tok-A" });
      expect(resB).toEqual({ ok: true, docId: "doc-B", docNo: "made-with:Bearer tok-B" });
    });
  });
});
