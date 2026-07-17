import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSalesEmployeeId } from "@/lib/integrations/nova-sales-service";

/**
 * ทดสอบ resolveSalesEmployeeId:
 *   - มี uuid ตรง (อยู่ tenant) → matched
 *   - ชื่อตรง 1 คน (nickname/first_name, case-insensitive, มีช่องว่างเกิน) → matched
 *   - ชื่อไม่เจอ → not_found (null)
 *   - ชื่อซ้ำ >1 คน → ambiguous (null) ; ถ้าแยกได้ด้วย employee_type='sales' พอดี 1 → matched
 *
 * mock Supabase รองรับ filter .eq() จริง (จำเป็นต่อ uuid path + name query)
 */

const TENANT = "11111111-1111-1111-1111-111111111111";

type Emp = {
  id: string;
  tenant_id: string;
  first_name: string;
  nickname?: string | null;
  employee_type?: string;
  is_active?: boolean;
  deleted_at?: string | null;
};

class EmployeeQB {
  private filters: { col: string; val: unknown }[] = [];
  constructor(private rows: Emp[]) {}

  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }
  private apply(): Emp[] {
    return this.rows.filter((r) =>
      this.filters.every((f) => (r as Record<string, unknown>)[f.col] === f.val)
    );
  }
  maybeSingle() {
    const rows = this.apply();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve({ data: this.apply(), error: null }).then(onF);
  }
}

function makeDb(rows: Emp[]): SupabaseClient {
  return {
    from() {
      return new EmployeeQB(rows);
    },
  } as unknown as SupabaseClient;
}

const base = (over: Partial<Emp>): Emp => ({
  id: "e1",
  tenant_id: TENANT,
  first_name: "สมชาย",
  nickname: null,
  employee_type: "sales",
  is_active: true,
  deleted_at: null,
  ...over,
});

describe("resolveSalesEmployeeId — uuid path", () => {
  it("มี uuid อยู่ tenant → matched + คืนชื่อ", async () => {
    const db = makeDb([base({ id: "u1", nickname: "โจ", first_name: "สมชาย" })]);
    const r = await resolveSalesEmployeeId(db, TENANT, { id: "u1" });
    expect(r.reason).toBe("matched");
    expect(r.employeeId).toBe("u1");
    expect(r.name).toBe("โจ"); // prefer nickname
  });
});

describe("resolveSalesEmployeeId — by name", () => {
  it("nickname ตรง 1 คน (case-insensitive + ช่องว่างเกิน) → matched", async () => {
    const db = makeDb([
      base({ id: "e1", nickname: "Joe", first_name: "สมชาย" }),
      base({ id: "e2", nickname: "แอน", first_name: "สมหญิง" }),
    ]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "  joe  " });
    expect(r.reason).toBe("matched");
    expect(r.employeeId).toBe("e1");
  });

  it("first_name ตรง 1 คน → matched", async () => {
    const db = makeDb([base({ id: "e9", nickname: "โจ", first_name: "ปิติ" })]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "ปิติ" });
    expect(r.employeeId).toBe("e9");
  });

  it("ไม่เจอชื่อ → not_found + null", async () => {
    const db = makeDb([base({ id: "e1", nickname: "โจ" })]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "ไม่มีจริง" });
    expect(r.reason).toBe("not_found");
    expect(r.employeeId).toBeNull();
  });

  it("ชื่อว่าง/undefined → not_found", async () => {
    const db = makeDb([base({ id: "e1", nickname: "โจ" })]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "   " });
    expect(r.reason).toBe("not_found");
    expect(r.employeeId).toBeNull();
  });

  it("ชื่อซ้ำ >1 คน แยกไม่ได้ → ambiguous + null", async () => {
    const db = makeDb([
      base({ id: "a", nickname: "บอย", employee_type: "sales" }),
      base({ id: "b", nickname: "บอย", employee_type: "sales" }),
    ]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "บอย" });
    expect(r.reason).toBe("ambiguous");
    expect(r.employeeId).toBeNull();
  });

  it("ชื่อซ้ำ >1 คน แต่มี sales พอดี 1 → prefer sales → matched", async () => {
    const db = makeDb([
      base({ id: "a", nickname: "บอย", employee_type: "cs" }),
      base({ id: "b", nickname: "บอย", employee_type: "sales" }),
    ]);
    const r = await resolveSalesEmployeeId(db, TENANT, { name: "บอย" });
    expect(r.reason).toBe("matched");
    expect(r.employeeId).toBe("b");
  });
});
