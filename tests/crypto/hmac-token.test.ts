import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "@/lib/crypto/hmac-token";

/**
 * signToken/verifyToken — โทเค็น signed (HMAC) สำหรับ session/state
 *   ครอบคลุม: round-trip, ลายเซ็นผิด/ปลอม → null, หมดอายุ → null, payload เพี้ยน → null
 */
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

describe("hmac-token", () => {
  it("round-trip: sign แล้ว verify ได้ payload กลับ", () => {
    const token = signToken({ a: 1, b: "x", exp: 9999999999 }, SECRET);
    const p = verifyToken<{ a: number; b: string }>(token, SECRET, 1000);
    expect(p).toMatchObject({ a: 1, b: "x" });
  });

  it("secret ผิด → null", () => {
    const token = signToken({ a: 1, exp: 9999999999 }, SECRET);
    expect(verifyToken(token, "wrong-secret", 1000)).toBeNull();
  });

  it("ปลอม payload (แก้ body ไม่แก้ sig) → null", () => {
    const token = signToken({ a: 1, exp: 9999999999 }, SECRET);
    const [, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ a: 999, exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${forgedBody}.${sig}`, SECRET, 1000)).toBeNull();
  });

  it("หมดอายุ (now >= exp) → null", () => {
    const token = signToken({ a: 1, exp: 1000 }, SECRET);
    expect(verifyToken(token, SECRET, 1000)).toBeNull();
    expect(verifyToken(token, SECRET, 999)).not.toBeNull();
  });

  it("รูปแบบผิด/ว่าง → null", () => {
    expect(verifyToken("", SECRET)).toBeNull();
    expect(verifyToken("nodot", SECRET)).toBeNull();
    expect(verifyToken(".onlysig", SECRET)).toBeNull();
    expect(verifyToken(null, SECRET)).toBeNull();
  });
});
