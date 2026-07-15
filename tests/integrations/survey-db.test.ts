/**
 * Integration test (ต้องมี Postgres ของ Supabase จริงผ่าน DATABASE_URL)
 *   ตรวจ constraint สำคัญของ M2:
 *     - survey_invitations UNIQUE(customer_id, survey_type, cycle_period) กันตอบซ้ำ (FR-SC-05)
 *     - survey_invitations UNIQUE(tenant_id, idempotency_key) กัน integration ยิงซ้ำ
 *     - customers.external_ref idempotent (0019)
 *   ถ้าไม่มี DATABASE_URL → skip (unit test อื่นยังรันได้)
 *
 *   วิธีรัน: supabase db reset && DATABASE_URL=postgres://... npm test
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

const TENANT = "11111111-1111-1111-1111-111111111111";
const CUST = "70000000-0000-0000-0000-000000000001";
const VERSION_C = "d0000000-0000-0000-0000-00000000000c"; // survey_versions Form C (seed)

describe.skipIf(!hasDb)("M2 integration — constraints (ต้องมี DATABASE_URL)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end();
  });

  it("survey_invitations กันซ้ำต่อ (customer, type, cycle)", async () => {
    await client.query("begin");
    try {
      const ins = (key: string, cycle: string) =>
        client.query(
          `insert into public.survey_invitations
             (tenant_id, customer_id, survey_type, survey_version_id, cycle_period, token, idempotency_key)
           values ($1,$2,'C',$3,$4,$5,$6)`,
          [TENANT, CUST, VERSION_C, cycle, `tok-${key}`, `idem-${key}`]
        );

      await ins("a", "deal:X1");
      // cycle เดียวกัน + customer/type เดียวกัน → ชน unique
      await expect(ins("b", "deal:X1")).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("rollback");
    }
  });

  it("customers.external_ref idempotent (unique index 0019)", async () => {
    await client.query("begin");
    try {
      const ins = () =>
        client.query(
          `insert into public.customers (tenant_id, name, external_ref)
           values ($1,'ทดสอบ','NS-DUP-1')`,
          [TENANT]
        );
      await ins();
      await expect(ins()).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("rollback");
    }
  });

  it("submit_survey_response: atomic — response/answers/scores ครบใน tx เดียว", async () => {
    await client.query("begin");
    try {
      // สร้าง invitation ชั่วคราวสำหรับตอบ
      const inv = await client.query(
        `insert into public.survey_invitations
           (tenant_id, customer_id, survey_type, survey_version_id, cycle_period, token, idempotency_key, status)
         values ($1,$2,'C',$3,'deal:RPC1','tok-rpc-1','idem-rpc-1','pending')
         returning id`,
        [TENANT, CUST, VERSION_C]
      );
      const invId = inv.rows[0].id;

      const rid = await client.query(
        `select public.submit_survey_response(
            $1,
            $2::jsonb,
            $3::numeric,
            $4::jsonb,
            $5::jsonb,
            $6::jsonb
         ) as response_id`,
        [
          invId,
          JSON.stringify({ sale_overall: 5, note: null }),
          4.5,
          JSON.stringify([{ dimension: "sale_overall", score: 5 }]),
          null,
          JSON.stringify({ policy_version: "2026-07-15", purpose: {} }),
        ]
      );
      const responseId = rid.rows[0].response_id;
      expect(responseId).toBeTruthy();

      // answers + scores + consent + ปิด invitation ต้องเกิดครบ
      const ans = await client.query(
        "select count(*)::int c from public.survey_answers where response_id=$1",
        [responseId]
      );
      expect(ans.rows[0].c).toBe(2);

      const csat = await client.query(
        "select count(*)::int c from public.satisfaction_scores where response_id=$1",
        [responseId]
      );
      expect(csat.rows[0].c).toBe(2); // 1 รายข้อ + overall

      const st = await client.query(
        "select status from public.survey_invitations where id=$1",
        [invId]
      );
      expect(st.rows[0].status).toBe("responded");

      // ตอบซ้ำ invitation เดิม → error (already_responded / unique)
      await expect(
        client.query(
          `select public.submit_survey_response($1,'{}'::jsonb,null,null,null,null)`,
          [invId]
        )
      ).rejects.toBeTruthy();
    } finally {
      await client.query("rollback");
    }
  });
});
