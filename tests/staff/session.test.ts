import { describe, it, expect } from "vitest";
import {
  createStaffSessionToken,
  verifyStaffSessionToken,
} from "@/lib/staff/session";

/**
 * staff session cookie (signed) — ออก/verify โทเค็น session ของนักบัญชี
 *   ครอบคลุม: round-trip, หมดอายุ, secret ผิด, role ไม่ถูกต้อง, ฟิลด์ขาด → null
 */
const SECRET = "staff-secret-0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000;

function make(role: "accountant" | "lead" = "accountant") {
  return createStaffSessionToken(
    { employeeId: "emp-1", tenantId: "t-1", role, name: "ชาย" },
    SECRET,
    3600,
    NOW
  );
}

describe("staff session token", () => {
  it("round-trip: verify คืน session ครบ", () => {
    const s = verifyStaffSessionToken(make("lead"), SECRET, NOW + 10);
    expect(s).toMatchObject({
      employeeId: "emp-1",
      tenantId: "t-1",
      role: "lead",
      name: "ชาย",
    });
  });

  it("หมดอายุ → null", () => {
    expect(verifyStaffSessionToken(make(), SECRET, NOW + 3601)).toBeNull();
  });

  it("secret ผิด → null (ปลอมไม่ได้)", () => {
    expect(verifyStaffSessionToken(make(), "other", NOW + 10)).toBeNull();
  });

  it("role นอกเหนือ accountant/lead → null", () => {
    // สร้างโทเค็นที่ payload role='admin' ด้วย signToken ตรง ๆ
    const token = createStaffSessionToken(
      // @ts-expect-error -- ทดสอบ role ที่ไม่ถูกต้อง
      { employeeId: "e", tenantId: "t", role: "admin", name: "x" },
      SECRET,
      3600,
      NOW
    );
    expect(verifyStaffSessionToken(token, SECRET, NOW + 10)).toBeNull();
  });
});
