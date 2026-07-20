import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountantWorkload } from "@/lib/admin/workload";

const T = "tenant-1";

/**
 * fake db สำหรับ getAccountantWorkload — รองรับ chain เดียว:
 *   from("customer_assignments").select(...).eq().is().is().lte() → await(then)
 * capture: เก็บ filter ที่ถูกเรียก (ตรวจ scope tenant / active)
 */
function makeDb(
  rows: unknown[],
  capture: { filters: { fn: string; args: unknown[] }[]; table?: string }
): SupabaseClient {
  const query = {
    select() {
      return this;
    },
    eq(...args: unknown[]) {
      capture.filters.push({ fn: "eq", args });
      return this;
    },
    is(...args: unknown[]) {
      capture.filters.push({ fn: "is", args });
      return this;
    },
    lte(...args: unknown[]) {
      capture.filters.push({ fn: "lte", args });
      return this;
    },
    then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(onF, onR);
    },
  };
  return {
    from(table: string) {
      capture.table = table;
      return query;
    },
  } as unknown as SupabaseClient;
}

/** ช่วยสร้างแถว assignment ดิบ (จาก join) */
function row(
  employeeId: string,
  opts: {
    name?: string;
    nickname?: string | null;
    teamName?: string | null;
    customerType?: string | null;
    customerDeleted?: boolean;
  } = {}
) {
  return {
    employee_id: employeeId,
    team_id: opts.teamName ? "team-x" : null,
    employees: { first_name: opts.name ?? "ชื่อ", nickname: opts.nickname ?? null },
    teams: opts.teamName ? { name: opts.teamName } : null,
    customers: {
      customer_type: opts.customerType ?? null,
      deleted_at: opts.customerDeleted ? "2026-01-01" : null,
    },
  };
}

describe("getAccountantWorkload — นับภาระงานนักบัญชี", () => {
  it("นับรวม + แยกประเภท (company/individual/unspecified) ต่อพนักงาน", async () => {
    const cap = { filters: [] as { fn: string; args: unknown[] }[] };
    const db = makeDb(
      [
        row("emp-1", { name: "เอ", teamName: "ทีม A", customerType: "company" }),
        row("emp-1", { name: "เอ", teamName: "ทีม A", customerType: "individual" }),
        row("emp-1", { name: "เอ", teamName: "ทีม A", customerType: null }),
        row("emp-2", { name: "บี", customerType: "company" }),
      ],
      cap
    );

    const out = await getAccountantWorkload(db, T);

    // เรียงมาก→น้อย: emp-1 (3) มาก่อน emp-2 (1)
    expect(out.map((r) => r.employee_id)).toEqual(["emp-1", "emp-2"]);

    const a = out[0];
    expect(a.total).toBe(3);
    expect(a.company).toBe(1);
    expect(a.individual).toBe(1);
    expect(a.unspecified).toBe(1);
    expect(a.employee_name).toBe("เอ");
    expect(a.team_name).toBe("ทีม A");

    const b = out[1];
    expect(b.total).toBe(1);
    expect(b.company).toBe(1);
    expect(b.individual).toBe(0);
    expect(b.unspecified).toBe(0);
  });

  it("ข้ามลูกค้าที่ถูกปิดใช้งาน (customer.deleted_at) ไม่นับเป็นภาระงาน", async () => {
    const cap = { filters: [] as { fn: string; args: unknown[] }[] };
    const db = makeDb(
      [
        row("emp-1", { customerType: "company" }),
        row("emp-1", { customerType: "company", customerDeleted: true }), // ต้องถูกข้าม
      ],
      cap
    );

    const out = await getAccountantWorkload(db, T);
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(1);
    expect(out[0].company).toBe(1);
  });

  it("scope ด้วย tenant + นับเฉพาะ active (valid_to null, deleted_at null, valid_from ≤ วันนี้)", async () => {
    const cap = {
      filters: [] as { fn: string; args: unknown[] }[],
      table: undefined as string | undefined,
    };
    const db = makeDb([], cap);
    await getAccountantWorkload(db, T);

    expect(cap.table).toBe("customer_assignments");
    // eq('tenant_id', T) ต้องถูกเรียก → scope tenant จาก session
    expect(
      cap.filters.some((f) => f.fn === "eq" && f.args[0] === "tenant_id" && f.args[1] === T)
    ).toBe(true);
    // is('valid_to', null) → เฉพาะผู้ดูแลปัจจุบัน
    expect(
      cap.filters.some((f) => f.fn === "is" && f.args[0] === "valid_to" && f.args[1] === null)
    ).toBe(true);
    // is('deleted_at', null)
    expect(
      cap.filters.some((f) => f.fn === "is" && f.args[0] === "deleted_at" && f.args[1] === null)
    ).toBe(true);
    // lte('valid_from', วันนี้)
    const today = new Date().toISOString().slice(0, 10);
    expect(
      cap.filters.some((f) => f.fn === "lte" && f.args[0] === "valid_from" && f.args[1] === today)
    ).toBe(true);
  });

  it("ไม่มี assignment → คืน [] (ไม่ throw)", async () => {
    const cap = { filters: [] as { fn: string; args: unknown[] }[] };
    const out = await getAccountantWorkload(makeDb([], cap), T);
    expect(out).toEqual([]);
  });

  it("query error → throw", async () => {
    const errDb = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          is() {
            return this;
          },
          lte() {
            return this;
          },
          then(onF: (v: unknown) => unknown) {
            return Promise.resolve({ data: null, error: { message: "boom" } }).then(onF);
          },
        };
      },
    } as unknown as SupabaseClient;
    await expect(getAccountantWorkload(errDb, T)).rejects.toThrow(/boom/);
  });
});
