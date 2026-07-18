import { describe, it, expect, beforeAll } from "vitest";

/**
 * ทดสอบ guard พารามิเตอร์ของ API export (L2) — employeeId ต้องเป็น uuid, period YYYY-MM
 *   ★ ลำดับใน route: getSupabaseEnv() → validate params → (ค่อย) createClient
 *     จึงทดสอบ 400 ได้โดยไม่แตะ DB จริง (ตั้ง env ให้ผ่านด่านแรก)
 */
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "test-anon-key";
});

async function callGet(url: string): Promise<Response> {
  const { GET } = await import("@/app/api/reports/accountant/export/route");
  return GET(new Request(url));
}

describe("GET /api/reports/accountant/export — validate params", () => {
  it("employeeId ไม่ใช่ uuid → 400", async () => {
    const res = await callGet("http://x/api/reports/accountant/export?employeeId=not-a-uuid&period=2026-07");
    expect(res.status).toBe(400);
  });

  it("period ผิดรูปแบบ → 400", async () => {
    const res = await callGet(
      "http://x/api/reports/accountant/export?employeeId=11111111-1111-1111-1111-111111111111&period=2026-13"
    );
    expect(res.status).toBe(400);
  });

  it("employeeId ว่าง → 400", async () => {
    const res = await callGet("http://x/api/reports/accountant/export?period=2026-07");
    expect(res.status).toBe(400);
  });
});
