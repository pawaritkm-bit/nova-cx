import { describe, it, expect } from "vitest";
import { verifyLineIdToken } from "@/lib/line/verify-id-token";

/**
 * verifyLineIdToken — verify LINE ID token ฝั่ง server (mock fetch)
 *   ครอบคลุม: สำเร็จคืน userId(sub)+name, aud ไม่ตรง→null, res ไม่ ok→null,
 *   ไม่มี sub→null, input ว่าง→null (ไม่เรียก network), network error→null
 */

function fakeFetch(response: {
  ok: boolean;
  json: () => Promise<unknown>;
}): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

const CHANNEL = "2010493797";

describe("verifyLineIdToken", () => {
  it("สำเร็จ → คืน userId (sub) + name; aud ตรง client_id", async () => {
    const f = fakeFetch({
      ok: true,
      json: async () => ({ sub: "Uabc123", aud: CHANNEL, name: "สมชาย" }),
    });
    const res = await verifyLineIdToken("id.jwt.token", CHANNEL, f);
    expect(res).toEqual({ userId: "Uabc123", name: "สมชาย" });
  });

  it("aud ไม่ตรง client_id → null (กัน token ของ channel อื่น)", async () => {
    const f = fakeFetch({
      ok: true,
      json: async () => ({ sub: "Uabc123", aud: "9999999" }),
    });
    expect(await verifyLineIdToken("id.jwt.token", CHANNEL, f)).toBeNull();
  });

  it("HTTP ไม่ ok (400 จาก LINE) → null", async () => {
    const f = fakeFetch({ ok: false, json: async () => ({ error: "invalid_request" }) });
    expect(await verifyLineIdToken("bad.token", CHANNEL, f)).toBeNull();
  });

  it("ไม่มี sub ในผลลัพธ์ → null", async () => {
    const f = fakeFetch({ ok: true, json: async () => ({ aud: CHANNEL }) });
    expect(await verifyLineIdToken("id.jwt.token", CHANNEL, f)).toBeNull();
  });

  it("idToken/channelId ว่าง → null (ไม่เรียก network)", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ sub: "x" }) };
    }) as unknown as typeof fetch;
    expect(await verifyLineIdToken("", CHANNEL, f)).toBeNull();
    expect(await verifyLineIdToken("t", "", f)).toBeNull();
    expect(called).toBe(false);
  });

  it("network/parse error → null (fail-closed)", async () => {
    const f = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await verifyLineIdToken("id.jwt.token", CHANNEL, f)).toBeNull();
  });
});
