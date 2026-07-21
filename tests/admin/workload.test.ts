import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountantWorkload } from "@/lib/admin/workload";

const T = "tenant-1";

type FilterLog = { fn: string; args: unknown[] };
type Capture = { calls: { table: string; filters: FilterLog[] }[] };

/**
 * fake db สำหรับ getAccountantWorkload (แหล่งข้อมูล chat_groups + team_members)
 *   - รองรับ chain: select / eq / not / in / is / limit → await(then)
 *   - คืน rows แยกตามชื่อตาราง (rowsByTable) — default = []
 *   - capture: เก็บ filter ต่อการเรียก from() แต่ละครั้ง (ตรวจ scope/เงื่อนไข)
 */
function makeDb(
  rowsByTable: Record<string, unknown[]>,
  capture: Capture,
  errorTable?: string
): SupabaseClient {
  return {
    from(table: string) {
      const filters: FilterLog[] = [];
      capture.calls.push({ table, filters });
      const query = {
        select() {
          return this;
        },
        eq(...args: unknown[]) {
          filters.push({ fn: "eq", args });
          return this;
        },
        not(...args: unknown[]) {
          filters.push({ fn: "not", args });
          return this;
        },
        in(...args: unknown[]) {
          filters.push({ fn: "in", args });
          return this;
        },
        is(...args: unknown[]) {
          filters.push({ fn: "is", args });
          return this;
        },
        limit() {
          return this;
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const result =
            errorTable === table
              ? { data: null, error: { message: "boom" } }
              : { data: rowsByTable[table] ?? [], error: null };
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

/** แถว chat_groups (linkage กลุ่ม → ลูกค้า + นักบัญชีผู้ดูแล) */
function groupRow(
  employeeId: string,
  customerId: string,
  opts: {
    name?: string;
    nickname?: string | null;
    customerType?: string | null;
    customerDeleted?: boolean;
  } = {}
) {
  return {
    responsible_employee_id: employeeId,
    customer_id: customerId,
    responsible: { first_name: opts.name ?? "ชื่อ", nickname: opts.nickname ?? null },
    customers: {
      customer_type: opts.customerType ?? null,
      deleted_at: opts.customerDeleted ? "2026-01-01" : null,
    },
  };
}

describe("getAccountantWorkload — นับภาระงานนักบัญชีจากกลุ่มแชต (chat_groups)", () => {
  it("นับ distinct customer + แยกประเภท (company/individual/unspecified) ต่อนักบัญชี + เติมชื่อทีม", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        chat_groups: [
          groupRow("emp-1", "cust-A", { name: "เอ", customerType: "company" }),
          groupRow("emp-1", "cust-B", { name: "เอ", customerType: "individual" }),
          groupRow("emp-1", "cust-C", { name: "เอ", customerType: null }),
          groupRow("emp-2", "cust-D", { name: "บี", customerType: "company" }),
        ],
        team_members: [{ employee_id: "emp-1", teams: { name: "ทีม A" } }],
      },
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
    expect(b.team_name).toBeNull(); // ไม่มี membership → null
  });

  it("ลูกค้าเดียวหลายกลุ่ม → นับครั้งเดียว (distinct customer)", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        chat_groups: [
          groupRow("emp-1", "cust-A", { customerType: "company" }),
          groupRow("emp-1", "cust-A", { customerType: "company" }), // ซ้ำ → นับครั้งเดียว
        ],
      },
      cap
    );
    const out = await getAccountantWorkload(db, T);
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(1);
    expect(out[0].company).toBe(1);
  });

  it("ข้ามลูกค้าที่ถูกปิดใช้งาน (customer.deleted_at) ไม่นับเป็นภาระงาน", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        chat_groups: [
          groupRow("emp-1", "cust-A", { customerType: "company" }),
          groupRow("emp-1", "cust-Z", { customerType: "company", customerDeleted: true }),
        ],
      },
      cap
    );
    const out = await getAccountantWorkload(db, T);
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(1);
  });

  it("scope tenant + เงื่อนไข chat_groups (มีนักบัญชี+ลูกค้า, group/room, ไม่ลบ)", async () => {
    const cap: Capture = { calls: [] };
    await getAccountantWorkload(makeDb({ chat_groups: [] }, cap), T);

    const call = cap.calls.find((c) => c.table === "chat_groups")!;
    expect(call).toBeTruthy();
    // eq('tenant_id', T)
    expect(
      call.filters.some((f) => f.fn === "eq" && f.args[0] === "tenant_id" && f.args[1] === T)
    ).toBe(true);
    // not('responsible_employee_id','is',null) + not('customer_id','is',null)
    expect(
      call.filters.some((f) => f.fn === "not" && f.args[0] === "responsible_employee_id")
    ).toBe(true);
    expect(call.filters.some((f) => f.fn === "not" && f.args[0] === "customer_id")).toBe(true);
    // in('group_kind', ['group','room'])
    expect(
      call.filters.some(
        (f) =>
          f.fn === "in" &&
          f.args[0] === "group_kind" &&
          Array.isArray(f.args[1]) &&
          (f.args[1] as string[]).includes("group") &&
          (f.args[1] as string[]).includes("room")
      )
    ).toBe(true);
    // is('deleted_at', null)
    expect(
      call.filters.some((f) => f.fn === "is" && f.args[0] === "deleted_at" && f.args[1] === null)
    ).toBe(true);
  });

  it("ไม่มีกลุ่ม → คืน [] (ไม่ throw + ไม่ query team_members)", async () => {
    const cap: Capture = { calls: [] };
    const out = await getAccountantWorkload(makeDb({ chat_groups: [] }, cap), T);
    expect(out).toEqual([]);
    // ไม่มีนักบัญชี → ไม่ต้องไปดึงทีม
    expect(cap.calls.some((c) => c.table === "team_members")).toBe(false);
  });

  it("query chat_groups error → throw", async () => {
    const cap: Capture = { calls: [] };
    await expect(
      getAccountantWorkload(makeDb({}, cap, "chat_groups"), T)
    ).rejects.toThrow(/boom/);
  });
});
