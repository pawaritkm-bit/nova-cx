/**
 * RLS / Permission test (E1 DoD)
 * ต้องมี Postgres ของ Supabase จริง (auth.uid() ต้องมี) ผ่าน env DATABASE_URL
 *   วิธีรัน:
 *     supabase db reset                 # apply migration + base seed
 *     DATABASE_URL=postgres://... npm test
 * ถ้าไม่มี DATABASE_URL → กลุ่มนี้ถูก skip (unit test อื่นยังรันได้)
 *
 * เทคนิค: impersonate แต่ละ role ด้วยการตั้ง request.jwt.claims.sub = auth_user_id
 *          แล้ว `set local role authenticated` (RLS บังคับตาม auth.uid())
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// โหลด .env.local ถ้ามี (ไม่บังคับ)
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: ".env.local" });
  dotenv.config();
} catch {
  /* ไม่มี dotenv ก็ข้าม */
}

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = !!DATABASE_URL;

// auth_user_id (placeholder) จาก seed/fixtures
const AUTH = {
  executiveT1: "60000000-0000-0000-0000-000000000001",
  accountantT1: "60000000-0000-0000-0000-000000000003",
  accountantT2: "6a000000-0000-0000-0000-000000000003",
  unknown: "00000000-0000-0000-0000-0000000000ff",
};

const CUST = {
  c1: "70000000-0000-0000-0000-000000000001",
  c2: "70000000-0000-0000-0000-000000000002",
  c3_unassigned: "70000000-0000-0000-0000-000000000003",
  t2: "7a000000-0000-0000-0000-000000000001",
};

describe.skipIf(!hasDb)("RLS / permission (ต้องมี DATABASE_URL)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    // apply fixtures (idempotent)
    const fixturesPath = fileURLToPath(new URL("./fixtures.sql", import.meta.url));
    await client.query(readFileSync(fixturesPath, "utf8"));
  });

  afterAll(async () => {
    await client?.end();
  });

  /** รัน query ในบริบทของ user (auth.uid()=authUserId) ด้วย role authenticated */
  async function asUser<T = any>(authUserId: string | null, sql: string): Promise<T[]> {
    await client.query("begin");
    try {
      if (authUserId) {
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: authUserId, role: "authenticated" }),
        ]);
      } else {
        await client.query("select set_config('request.jwt.claims', '', true)");
      }
      await client.query("set local role authenticated");
      const res = await client.query(sql);
      return res.rows as T[];
    } finally {
      await client.query("rollback");
    }
  }

  it("executive เห็นลูกค้าทุกรายใน tenant ตน (รวมรายที่ไม่มีผู้ดูแล)", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.executiveT1,
      "select id from public.customers"
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(CUST.c1);
    expect(ids).toContain(CUST.c2);
    expect(ids).toContain(CUST.c3_unassigned);
  });

  it("นักบัญชีเห็นเฉพาะลูกค้าที่ตนดูแลปัจจุบัน (C-10) — ไม่เห็นรายที่ไม่มีผู้ดูแล", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.accountantT1,
      "select id from public.customers"
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(CUST.c1);
    expect(ids).toContain(CUST.c2);
    expect(ids).not.toContain(CUST.c3_unassigned);
  });

  it("tenant isolation — นักบัญชี T2 เห็นเฉพาะลูกค้า T2 ไม่เห็นของ T1", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.accountantT2,
      "select id from public.customers"
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(CUST.t2);
    expect(ids).not.toContain(CUST.c1);
    expect(ids).not.toContain(CUST.c2);
  });

  it("deny-by-default — user ที่ไม่มีในระบบเห็น 0 แถว", async () => {
    const rows = await asUser(AUTH.unknown, "select id from public.customers");
    expect(rows.length).toBe(0);
  });

  it("anon ถูกปฏิเสธสิทธิ์ตาราง (revoke ชั้น GRANT)", async () => {
    await client.query("begin");
    try {
      await client.query("set local role anon");
      await expect(
        client.query("select id from public.customers")
      ).rejects.toThrow();
    } finally {
      await client.query("rollback");
    }
  });

  it("case_activity_logs — นักบัญชีอ่าน timeline เคสของลูกค้าที่ไม่ได้ดูแลไม่ได้ (0018 cross-scope)", async () => {
    const sql =
      "select id from public.case_activity_logs where case_id = 'e0000000-0000-0000-0000-000000000003'";
    const acc = await asUser(AUTH.accountantT1, sql);
    expect(acc.length).toBe(0);
    const exec = await asUser(AUTH.executiveT1, sql);
    expect(exec.length).toBeGreaterThanOrEqual(1);
  });

  it("audit_logs — พนักงานทั่วไปอ่านไม่ได้ (0018 privileged-only)", async () => {
    const acc = await asUser(AUTH.accountantT1, "select id from public.audit_logs");
    expect(acc.length).toBe(0);
    const exec = await asUser(AUTH.executiveT1, "select id from public.audit_logs");
    expect(exec.length).toBeGreaterThanOrEqual(1);
  });

  it("นักบัญชีแก้ไข tenant ไม่ได้ (MEDIUM#5 — เฉพาะ admin/exec)", async () => {
    // update ต้องไม่กระทบแถวใด (RLS restrictive กัน) → rowCount = 0
    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: AUTH.accountantT1, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
      const res = await client.query(
        "update public.tenants set name = 'hacked' where id = '11111111-1111-1111-1111-111111111111'"
      );
      expect(res.rowCount).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});
