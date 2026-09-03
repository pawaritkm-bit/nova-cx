import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "@/lib/crypto/hmac-token";
import { signTokenEdge, verifyTokenEdge } from "@/lib/crypto/hmac-token-edge";
import { staffSessionNeedsRenewal, STAFF_SESSION_TTL_SEC } from "@/lib/staff/cookie";

/**
 * ★ 2026-09-03 ผู้ใช้: "กดยืนยันบิลแล้วโปรแกรมเด้งออก" — session นักบัญชี 12 ชม. หมดกลางงาน
 * แก้: middleware (edge) verify + ต่ออายุเอง → ต้องมี HMAC ฝั่ง Web Crypto ที่ "เข้ากันได้ 100%"
 * กับฝั่ง node (เซ็นฝั่งไหน อีกฝั่งต้อง verify ได้) — เทสต์นี้คุม cross-compat + กติกาต่ออายุ
 */

const SECRET = "test-secret-อย่างน้อยก็ยาวพอ";
const payload = { employeeId: "emp-1", tenantId: "t1", role: "accountant", name: "สวย", exp: 9999999999 };

describe("hmac-token-edge — cross-compat กับฝั่ง node", () => {
  it("เซ็นฝั่ง node → verify ฝั่ง edge ได้ (payload ตรงทุกฟิลด์)", async () => {
    const token = signToken(payload, SECRET);
    const out = await verifyTokenEdge<typeof payload>(token, SECRET);
    expect(out).toEqual(payload);
  });

  it("เซ็นฝั่ง edge → verify ฝั่ง node ได้", async () => {
    const token = await signTokenEdge(payload, SECRET);
    const out = verifyToken<typeof payload>(token, SECRET);
    expect(out).toEqual(payload);
  });

  it("secret ผิด/โทเค็นถูกแก้ → null (fail-closed)", async () => {
    const token = signToken(payload, SECRET);
    expect(await verifyTokenEdge(token, "wrong-secret")).toBeNull();
    expect(await verifyTokenEdge(token.slice(0, -2) + "xx", SECRET)).toBeNull();
    expect(await verifyTokenEdge("", SECRET)).toBeNull();
    expect(await verifyTokenEdge("ไม่มีจุด", SECRET)).toBeNull();
  });

  it("exp เลยเวลา → null (เหมือนฝั่ง node)", async () => {
    const expired = signToken({ ...payload, exp: 1000 }, SECRET);
    expect(await verifyTokenEdge(expired, SECRET, 2000)).toBeNull();
    expect(verifyToken(expired, SECRET, 2000)).toBeNull();
  });

  it("payload ไทย/อักขระพิเศษ round-trip ถูกต้อง (base64url ฝั่ง edge ใช้ TextEncoder)", async () => {
    const thai = { name: "พี่สวย — บัญชี #1 (ทดสอบ)", exp: 9999999999 };
    const token = await signTokenEdge(thai, SECRET);
    expect(await verifyTokenEdge<typeof thai>(token, SECRET)).toEqual(thai);
    expect(verifyToken<typeof thai>(token, SECRET)).toEqual(thai);
  });
});

describe("staffSessionNeedsRenewal — sliding session", () => {
  const now = 1_000_000;
  it("เหลือน้อยกว่าครึ่งอายุ → ต่ออายุ", () => {
    expect(staffSessionNeedsRenewal(now + STAFF_SESSION_TTL_SEC / 2 - 1, now)).toBe(true);
    expect(staffSessionNeedsRenewal(now + 60, now)).toBe(true);
  });
  it("ยังเหลือเกินครึ่งอายุ → ไม่ต่อ (กัน re-sign ทุก request)", () => {
    expect(staffSessionNeedsRenewal(now + STAFF_SESSION_TTL_SEC / 2 + 1, now)).toBe(false);
    expect(staffSessionNeedsRenewal(now + STAFF_SESSION_TTL_SEC, now)).toBe(false);
  });
  it("อายุ session = 7 วัน (แก้เด้งออกกลางงานจากเดิม 12 ชม.)", () => {
    expect(STAFF_SESSION_TTL_SEC).toBe(7 * 24 * 60 * 60);
  });
});
