/**
 * DB integration — visibility views (0025)
 *   ต้องมี Postgres จริงที่ apply migration ถึง 0025 ผ่าน DATABASE_URL
 *     supabase db reset && DATABASE_URL=postgres://... npm test
 *   ไม่มี DATABASE_URL → skip (unit test อื่นยังรัน)
 *
 * โฟกัส: (1) view ครบ 5 ตัว
 *        (2) ★ v_feedback_for_evaluatee / v_team_score_facts ต้อง "ไม่มี" คอลัมน์ PII ลูกค้า
 *            (การซ่อนชื่อทำที่ระดับ column — §16, FR-DB-02/03)
 *        (3) scope: user ที่ไม่มีในระบบ (ไม่ล็อกอิน) เห็น 0 แถวจากทุก view
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: ".env.local" });
  dotenv.config();
} catch {
  /* ไม่มี dotenv ก็ข้าม */
}

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = !!DATABASE_URL;

const VIEWS = [
  "v_feedback_for_evaluatee",
  "v_dashboard_response_facts",
  "v_team_score_facts",
  "v_dashboard_case_facts",
  "v_customer_tracking",
];

// คอลัมน์ PII ที่ "ห้าม" ปรากฏใน view ผู้ถูกประเมิน
const FORBIDDEN_PII_COLS = [
  "customer_id",
  "customer_name",
  "name",
  "business_name",
  "phone",
  "phone_enc",
  "email",
  "email_enc",
];

describe.skipIf(!hasDb)("visibility views (ต้องมี DATABASE_URL)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function viewColumns(view: string): Promise<string[]> {
    const { rows } = await client.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name=$1`,
      [view]
    );
    return rows.map((r) => (r.column_name as string).toLowerCase());
  }

  it("มี view ครบทั้ง 5 ตัว", async () => {
    for (const v of VIEWS) {
      const cols = await viewColumns(v);
      expect(cols.length, `view ${v} ควรมีอยู่`).toBeGreaterThan(0);
    }
  });

  it("★ v_feedback_for_evaluatee ไม่มีคอลัมน์ชื่อลูกค้า/customer_id/PII", async () => {
    const cols = await viewColumns("v_feedback_for_evaluatee");
    for (const forbidden of FORBIDDEN_PII_COLS) {
      expect(cols, `ต้องไม่มี ${forbidden}`).not.toContain(forbidden);
    }
    // ยังต้องมีคะแนน+สรุป
    expect(cols).toContain("avg_score");
    expect(cols).toContain("summary");
  });

  it("★ v_team_score_facts ไม่มีชื่อลูกค้า/PII (มีได้แค่ชื่อพนักงาน)", async () => {
    const cols = await viewColumns("v_team_score_facts");
    for (const forbidden of FORBIDDEN_PII_COLS) {
      expect(cols, `ต้องไม่มี ${forbidden}`).not.toContain(forbidden);
    }
    expect(cols).toContain("avg_score");
  });

  it("scope: ผู้ที่ไม่มี users row (ไม่ล็อกอิน) เห็น 0 แถวทุก view", async () => {
    await client.query("begin");
    try {
      await client.query(
        "select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: "00000000-0000-0000-0000-0000000000ff", role: "authenticated" })]
      );
      await client.query("set local role authenticated");
      for (const v of VIEWS) {
        const { rows } = await client.query(`select count(*)::int as c from public.${v}`);
        expect(rows[0].c, `view ${v} ต้องคืน 0 แถวเมื่อไม่มีสิทธิ์`).toBe(0);
      }
    } finally {
      await client.query("rollback");
    }
  });
});
