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
 *        (4) ★ C1 non-linkability: v_feedback_for_evaluatee "ไม่มี" response_id +
 *            v_dashboard_response_facts / v_dashboard_case_facts ถูก gate ด้วย is_privileged()
 *            (member โยงคะแนน→ลูกค้าไม่ได้ + query 2 view นั้นได้ 0 แถว)
 *        (5) ★ v_customer_tracking ไม่มีคอลัมน์คะแนน (call-list ล้วน)
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

// คอลัมน์ PII/linkage ที่ "ห้าม" ปรากฏใน view ผู้ถูกประเมิน
//   ★ response_id = key ที่ join กลับไปหา customer_id ได้ → ต้องไม่มี (C1)
const FORBIDDEN_PII_COLS = [
  "customer_id",
  "customer_name",
  "name",
  "business_name",
  "phone",
  "phone_enc",
  "email",
  "email_enc",
  "response_id",
];

// คอลัมน์ "คะแนน" ที่ห้ามอยู่ใน v_customer_tracking (tracking = ชื่อ+สถานะตอบ ไม่มีคะแนน)
const SCORE_COLS = ["avg_score", "csat_overall", "nps_score", "score", "post_resolution_csat"];

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
    // team_score เป็นคะแนนพนักงานผูกทีม → มี avg_score ได้ แต่ห้ามมี customer_id/response_id/PII
    for (const forbidden of FORBIDDEN_PII_COLS) {
      expect(cols, `ต้องไม่มี ${forbidden}`).not.toContain(forbidden);
    }
    expect(cols).toContain("avg_score");
  });

  it("★ C1 non-linkability: v_customer_tracking ไม่มีคอลัมน์คะแนน (ชื่อ+สถานะตอบเท่านั้น)", async () => {
    const cols = await viewColumns("v_customer_tracking");
    for (const s of SCORE_COLS) {
      expect(cols, `v_customer_tracking ต้องไม่มีคอลัมน์คะแนน ${s}`).not.toContain(s);
    }
    // ต้องมีชื่อ + สถานะตอบ (call-list)
    expect(cols).toContain("customer_name");
    expect(cols).toContain("is_responded");
  });

  async function viewDef(view: string): Promise<string> {
    const { rows } = await client.query(
      "select pg_get_viewdef($1::regclass, true) as def",
      [`public.${view}`]
    );
    return (rows[0].def as string).toLowerCase();
  }

  it("★ C1: v_dashboard_response_facts + v_dashboard_case_facts gate ด้วย is_privileged() (member เข้าไม่ได้)", async () => {
    for (const v of ["v_dashboard_response_facts", "v_dashboard_case_facts"]) {
      const def = await viewDef(v);
      expect(def, `${v} ต้อง gate ด้วย is_privileged()`).toContain("is_privileged()");
      // ★ ต้องไม่เปิดทางลูกค้าให้ member (ตัด can_access_customer ออกจาก WHERE แล้ว)
      expect(def, `${v} ต้องไม่ให้ member เข้าผ่าน can_access_customer`).not.toContain(
        "can_access_customer"
      );
    }
  });

  it("★ C1: member (accountant) query response_facts/case_facts ได้ 0 แถว + join กับ feedback โยงชื่อลูกค้าไม่ได้", async () => {
    // หา user บทบาท accountant จริงในระบบ (seed) — ถ้าไม่มีก็ข้ามเคสนี้
    const { rows: members } = await client.query(
      `select u.auth_user_id
         from public.users u
         join public.roles r on r.id = u.role_id
        where r.code = 'accountant' and u.is_active and u.deleted_at is null
          and u.auth_user_id is not null
        limit 1`
    );
    if (members.length === 0) {
      // ไม่มี seed accountant — โครงสร้าง gate ถูกยืนยันในเคสก่อนหน้าแล้ว
      return;
    }
    const authId = members[0].auth_user_id as string;

    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: authId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");

      // member query 2 view ที่ผูก customer ต้องได้ 0 แถว
      for (const v of ["v_dashboard_response_facts", "v_dashboard_case_facts"]) {
        const { rows } = await client.query(
          `select count(*)::int as c from public.${v}`
        );
        expect(rows[0].c, `member ต้อง query ${v} ได้ 0 แถว`).toBe(0);
      }

      // ★ non-linkability: feedback ของตน (มี) แต่ไม่มี key ใด join ไปหา response_facts (0 แถว)
      //   → โยง "คะแนน → ลูกค้า" ผ่าน view ไม่ได้
      const { rows: linkRows } = await client.query(
        `select count(*)::int as c
           from public.v_feedback_for_evaluatee f
           join public.v_dashboard_response_facts rf
             on rf.tenant_id = f.tenant_id`
      );
      expect(linkRows[0].c, "member join feedback×response_facts ต้องได้ 0 (โยงชื่อลูกค้าไม่ได้)").toBe(0);
    } finally {
      await client.query("rollback");
    }
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

  // -------------------------------------------------------------------
  // ★ 0027 — งาน A: ปิด base-table linkage (ต้นตอจริงของ Critical pseudonymity)
  //   member ยิงตารางฐานตรง: employee_evaluations (ได้ response_id ของตน)
  //     → join survey_responses ต้อง "อ่าน customer_id/invitation_id ไม่ได้"
  //       (column-level REVOKE) → โยงคะแนน→ลูกค้าจาก base table ไม่ได้
  // -------------------------------------------------------------------
  it("★ 0027-A: member join employee_evaluations × survey_responses อ่าน customer_id/invitation_id ไม่ได้ (permission denied)", async () => {
    const { rows: members } = await client.query(
      `select u.auth_user_id
         from public.users u
         join public.roles r on r.id = u.role_id
        where r.code = 'accountant' and u.is_active and u.deleted_at is null
          and u.auth_user_id is not null
        limit 1`
    );
    if (members.length === 0) return; // ไม่มี seed accountant — ข้าม
    const authId = members[0].auth_user_id as string;

    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: authId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");

      // อ่าน customer_id ตรง ๆ ต้องโดนปฏิเสธที่ระดับคอลัมน์
      await expect(
        client.query("select customer_id from public.survey_responses limit 1"),
        "authenticated ต้องอ่าน survey_responses.customer_id ไม่ได้"
      ).rejects.toThrow(/permission denied/i);

      // hop key: invitation_id ก็ต้องโดนปฏิเสธ (กันต่อไป survey_invitations.customer_id)
      await expect(
        client.query("select invitation_id from public.survey_responses limit 1"),
        "authenticated ต้องอ่าน survey_responses.invitation_id ไม่ได้"
      ).rejects.toThrow(/permission denied/i);

      // การ join จริงเพื่อโยง "คะแนนของฉัน → ชื่อลูกค้า" ต้องพัง
      await expect(
        client.query(
          `select ee.response_id, sr.customer_id
             from public.employee_evaluations ee
             join public.survey_responses sr on sr.id = ee.response_id
            limit 1`
        ),
        "member join แล้วดึง customer_id ต้องโดนปฏิเสธ (linkage ปิด)"
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("rollback");
    }
  });

  it("★ 0027-A: คอลัมน์ที่ไม่โยงตัวตน (id/submitted_at) authenticated ยังอ่านได้ (ไม่ over-revoke)", async () => {
    const { rows: members } = await client.query(
      `select u.auth_user_id
         from public.users u
         join public.roles r on r.id = u.role_id
        where r.code = 'accountant' and u.is_active and u.deleted_at is null
          and u.auth_user_id is not null
        limit 1`
    );
    if (members.length === 0) return;
    const authId = members[0].auth_user_id as string;

    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: authId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
      // ไม่ควร throw — id/submitted_at ไม่ถูก revoke
      await expect(
        client.query("select id, submitted_at from public.survey_responses limit 1")
      ).resolves.toBeDefined();
    } finally {
      await client.query("rollback");
    }
  });

  // -------------------------------------------------------------------
  // ★ 0027 — งาน B: คืนสิทธิ์ cs ให้เห็น v_dashboard_case_facts
  //   (v_dashboard_response_facts ยัง privileged-only — cs เห็น 0)
  // -------------------------------------------------------------------
  it("★ 0027-B: cs เห็น v_dashboard_case_facts (>0 เมื่อ tenant มีเคส) แต่ response_facts ยัง 0", async () => {
    const { rows: csUsers } = await client.query(
      `select u.auth_user_id, u.tenant_id
         from public.users u
         join public.roles r on r.id = u.role_id
        where r.code = 'cs' and u.is_active and u.deleted_at is null
          and u.auth_user_id is not null
        limit 1`
    );
    if (csUsers.length === 0) return; // ไม่มี seed cs — ข้าม
    const authId = csUsers[0].auth_user_id as string;
    const tenantId = csUsers[0].tenant_id as string;

    // มีเคสใน tenant ของ cs ไหม (นับด้วย service-role connection ปัจจุบัน)
    const { rows: caseCount } = await client.query(
      `select count(*)::int as c from public.complaint_cases
        where tenant_id = $1 and deleted_at is null`,
      [tenantId]
    );

    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: authId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");

      const { rows: cf } = await client.query(
        "select count(*)::int as c from public.v_dashboard_case_facts"
      );
      if (caseCount[0].c > 0) {
        expect(cf[0].c, "cs ต้องเห็นเคสใน v_dashboard_case_facts (>0)").toBeGreaterThan(0);
      }

      // cs ยังต้องเข้าไม่ถึง score-analytics ผูกลูกค้า
      const { rows: rf } = await client.query(
        "select count(*)::int as c from public.v_dashboard_response_facts"
      );
      expect(rf[0].c, "cs ต้อง query v_dashboard_response_facts ได้ 0 แถว").toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});
