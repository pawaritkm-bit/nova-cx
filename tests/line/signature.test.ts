import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyLineSignature } from "@/lib/line/signature";

const SECRET = "test-channel-secret";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyLineSignature", () => {
  it("signature ถูกต้อง → true", () => {
    const body = JSON.stringify({ events: [{ type: "follow" }] });
    expect(verifyLineSignature(SECRET, body, sign(SECRET, body))).toBe(true);
  });

  it("secret ผิด → false", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(SECRET, body, sign("wrong-secret", body))).toBe(false);
  });

  it("body ถูกแก้หลังเซ็น → false (ตรวจ integrity)", () => {
    const body = JSON.stringify({ events: [{ type: "follow" }] });
    const sig = sign(SECRET, body);
    const tampered = JSON.stringify({ events: [{ type: "unfollow" }] });
    expect(verifyLineSignature(SECRET, tampered, sig)).toBe(false);
  });

  it("ไม่มี signature header → false", () => {
    expect(verifyLineSignature(SECRET, "{}", null)).toBe(false);
    expect(verifyLineSignature(SECRET, "{}", undefined)).toBe(false);
    expect(verifyLineSignature(SECRET, "{}", "")).toBe(false);
  });

  it("ไม่มี secret → false (ไม่ throw)", () => {
    const body = "{}";
    expect(verifyLineSignature("", body, sign(SECRET, body))).toBe(false);
  });

  it("signature ความยาวไม่เท่ากัน → false (ไม่ throw จาก timingSafeEqual)", () => {
    expect(verifyLineSignature(SECRET, "{}", "short")).toBe(false);
  });
});
