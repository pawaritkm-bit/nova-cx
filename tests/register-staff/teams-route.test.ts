import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * POST /api/register-staff/teams — ด่าน gate (verify code ก่อนคืนรายชื่อ)
 *   ★ ลำดับใน route: getStaffRegisterCode() → parse body → constant-time compare code
 *     → (ค่อย) createServiceRoleClient — จึงทดสอบเคส 503/400/403 ได้โดยไม่แตะ DB จริง
 *   คืนรายชื่อทีม "เฉพาะเมื่อ code ถูก" (code ผิด/ไม่ตั้ง = ไม่ leak ชื่อหัวหน้า)
 */

const CODE = "s3cret-register-code";

const prevCode = process.env.STAFF_REGISTER_CODE;
beforeEach(() => {
  process.env.STAFF_REGISTER_CODE = CODE;
});
afterEach(() => {
  if (prevCode === undefined) delete process.env.STAFF_REGISTER_CODE;
  else process.env.STAFF_REGISTER_CODE = prevCode;
});

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/register-staff/teams/route");
  return POST(
    new Request("http://x/api/register-staff/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

describe("POST /api/register-staff/teams — code gate", () => {
  it("ไม่ตั้ง STAFF_REGISTER_CODE → 503 (ปิดฟีเจอร์)", async () => {
    delete process.env.STAFF_REGISTER_CODE;
    const res = await callPost({ code: CODE });
    expect(res.status).toBe(503);
  });

  it("ไม่ส่ง code → 400", async () => {
    const res = await callPost({});
    expect(res.status).toBe(400);
  });

  it("code ผิด → 403 (ไม่คืนรายชื่อ)", async () => {
    const res = await callPost({ code: "wrong-code" });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.teams).toBeUndefined();
  });
});
