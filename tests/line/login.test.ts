import { describe, it, expect } from "vitest";
import {
  buildLineAuthorizeUrl,
  exchangeLineCodeForIdToken,
  LINE_AUTHORIZE_URL,
} from "@/lib/line/login";

/**
 * LINE Login helper — สร้าง authorize URL + แลก code → id_token (mock fetch)
 *   ครอบคลุม: URL มี param ครบ + scope openid, แลกสำเร็จ/HTTP ไม่ ok/ไม่มี id_token/พารามิเตอร์ขาด
 */
const CHANNEL = "2010493797";
const REDIRECT = "https://app.example.com/api/auth/line/callback";

describe("buildLineAuthorizeUrl", () => {
  it("ประกอบ URL ครบ param + ขอ scope openid (จำเป็นต่อ id_token)", () => {
    const url = buildLineAuthorizeUrl({
      channelId: CHANNEL,
      redirectUri: REDIRECT,
      state: "st",
      nonce: "nc",
    });
    expect(url.startsWith(`${LINE_AUTHORIZE_URL}?`)).toBe(true);
    const sp = new URL(url).searchParams;
    expect(sp.get("response_type")).toBe("code");
    expect(sp.get("client_id")).toBe(CHANNEL);
    expect(sp.get("redirect_uri")).toBe(REDIRECT);
    expect(sp.get("state")).toBe("st");
    expect(sp.get("nonce")).toBe("nc");
    expect(sp.get("scope")).toContain("openid");
  });
});

function fakeFetch(response: { ok: boolean; json: () => Promise<unknown> }): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe("exchangeLineCodeForIdToken", () => {
  const args = { code: "c", redirectUri: REDIRECT, channelId: CHANNEL, channelSecret: "sec" };

  it("สำเร็จ → คืน idToken", async () => {
    const f = fakeFetch({ ok: true, json: async () => ({ id_token: "jwt.here", access_token: "a" }) });
    expect(await exchangeLineCodeForIdToken(args, f)).toEqual({ idToken: "jwt.here" });
  });

  it("HTTP ไม่ ok → null", async () => {
    const f = fakeFetch({ ok: false, json: async () => ({ error: "invalid_grant" }) });
    expect(await exchangeLineCodeForIdToken(args, f)).toBeNull();
  });

  it("ไม่มี id_token ในผลลัพธ์ → null", async () => {
    const f = fakeFetch({ ok: true, json: async () => ({ access_token: "a" }) });
    expect(await exchangeLineCodeForIdToken(args, f)).toBeNull();
  });

  it("พารามิเตอร์ขาด → null (ไม่เรียก network)", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ id_token: "x" }) };
    }) as unknown as typeof fetch;
    expect(await exchangeLineCodeForIdToken({ ...args, code: "" }, f)).toBeNull();
    expect(await exchangeLineCodeForIdToken({ ...args, channelSecret: "" }, f)).toBeNull();
    expect(called).toBe(false);
  });

  it("network error → null (fail-closed)", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await exchangeLineCodeForIdToken(args, f)).toBeNull();
  });
});
