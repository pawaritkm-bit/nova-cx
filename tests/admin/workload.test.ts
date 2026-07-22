import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTeamWorkload, assembleTeamWorkload } from "@/lib/admin/workload";

const T = "tenant-1";

type FilterLog = { fn: string; args: unknown[] };
type Capture = { calls: { table: string; filters: FilterLog[] }[] };

/**
 * fake db สำหรับ getTeamWorkload
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

/** แถว teams */
function teamRow(
  id: string,
  name: string,
  opts: { type?: string | null; leadId?: string | null } = {}
) {
  return {
    id,
    name,
    handles_customer_type: opts.type ?? null,
    lead_employee_id: opts.leadId ?? null,
  };
}

/** แถว team_members (+ ชื่อพนักงาน) */
function memberRow(
  teamId: string,
  employeeId: string,
  opts: { role?: string | null; first?: string; nick?: string | null } = {}
) {
  return {
    team_id: teamId,
    employee_id: employeeId,
    role_in_team: opts.role ?? "member",
    employees: { first_name: opts.first ?? "ชื่อ", nickname: opts.nick ?? null },
  };
}

/** แถว chat_groups (linkage กลุ่ม → ลูกค้า + นักบัญชีผู้ดูแล) */
function groupRow(
  employeeId: string,
  customerId: string,
  opts: {
    first?: string;
    nick?: string | null;
    code?: string | null;
    custName?: string;
    customerType?: string | null;
    customerDeleted?: boolean;
  } = {}
) {
  return {
    responsible_employee_id: employeeId,
    customer_id: customerId,
    responsible: { first_name: opts.first ?? "ชื่อ", nickname: opts.nick ?? null },
    customers: {
      customer_code: opts.code ?? null,
      name: opts.custName ?? "ลูกค้า",
      customer_type: opts.customerType ?? null,
      deleted_at: opts.customerDeleted ? "2026-01-01" : null,
    },
  };
}

describe("getTeamWorkload — ผังภาระงานแบบทีม (chat_groups + teams/team_members)", () => {
  it("จัดกลุ่มตามทีม + หัวหน้าบนสุด + นับ distinct + แยกประเภท + ลิสต์ลูกค้าต่อคน", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        teams: [teamRow("team-A", "ทีม A", { type: "company", leadId: "emp-lead" })],
        team_members: [
          memberRow("team-A", "emp-lead", { role: "lead", first: "หัวหน้า" }),
          memberRow("team-A", "emp-1", { first: "สมาชิก" }),
        ],
        chat_groups: [
          groupRow("emp-lead", "cust-L", { customerType: "company", code: "C001", custName: "ลูกค้าหัวหน้า" }),
          groupRow("emp-1", "cust-A", { customerType: "company", code: "C002", custName: "เอ" }),
          groupRow("emp-1", "cust-B", { customerType: "individual", code: "C003", custName: "บี" }),
          groupRow("emp-1", "cust-C", { customerType: null, code: "C004", custName: "ซี" }),
        ],
        employees: [{ id: "emp-lead", first_name: "หัวหน้า", nickname: null }],
      },
      cap
    );

    const out = await getTeamWorkload(db, T);

    expect(out.teams).toHaveLength(1);
    expect(out.unassigned).toHaveLength(0);

    const team = out.teams[0];
    expect(team.name).toBe("ทีม A");
    expect(team.handles_customer_type).toBe("company");
    // ลูกค้ารวมทีม = 1 (หัวหน้า) + 3 (สมาชิก) = 4 distinct
    expect(team.total).toBe(4);
    expect(team.company).toBe(2);
    expect(team.individual).toBe(1);
    expect(team.unspecified).toBe(1);
    expect(team.lead_name).toContain("หัวหน้า");

    // หัวหน้าอยู่บนสุด (แม้ลูกค้าน้อยกว่า)
    expect(team.members[0].is_lead).toBe(true);
    expect(team.members[0].employee_id).toBe("emp-lead");
    expect(team.members[0].total).toBe(1);

    // สมาชิกคนที่สอง — ลิสต์ลูกค้าครบ + เรียงตามชื่อ
    const mem = team.members[1];
    expect(mem.is_lead).toBe(false);
    expect(mem.total).toBe(3);
    expect(mem.company).toBe(1);
    expect(mem.individual).toBe(1);
    expect(mem.unspecified).toBe(1);
    expect(mem.customers.map((c) => c.name)).toEqual(["ซี", "บี", "เอ"]);
    expect(mem.customers[2].code).toBe("C002");
  });

  it("ลูกค้าเดียวหลายกลุ่ม → นับครั้งเดียว (distinct customer)", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        teams: [teamRow("team-A", "ทีม A")],
        team_members: [memberRow("team-A", "emp-1")],
        chat_groups: [
          groupRow("emp-1", "cust-A", { customerType: "company" }),
          groupRow("emp-1", "cust-A", { customerType: "company" }), // ซ้ำ
        ],
      },
      cap
    );
    const out = await getTeamWorkload(db, T);
    expect(out.teams[0].members[0].total).toBe(1);
    expect(out.teams[0].total).toBe(1);
  });

  it("ข้ามลูกค้าที่ถูกปิดใช้งาน (customer.deleted_at)", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        teams: [teamRow("team-A", "ทีม A")],
        team_members: [memberRow("team-A", "emp-1")],
        chat_groups: [
          groupRow("emp-1", "cust-A", { customerType: "company" }),
          groupRow("emp-1", "cust-Z", { customerType: "company", customerDeleted: true }),
        ],
      },
      cap
    );
    const out = await getTeamWorkload(db, T);
    expect(out.teams[0].members[0].total).toBe(1);
    expect(out.teams[0].total).toBe(1);
  });

  it("นักบัญชีที่ไม่สังกัดทีม → กลุ่ม unassigned ท้ายสุด", async () => {
    const cap: Capture = { calls: [] };
    const db = makeDb(
      {
        teams: [teamRow("team-A", "ทีม A")],
        team_members: [memberRow("team-A", "emp-1")],
        chat_groups: [
          groupRow("emp-1", "cust-A", { customerType: "company" }),
          // emp-solo ไม่ได้อยู่ทีมใด แต่มีลูกค้าดูแล
          groupRow("emp-solo", "cust-X", { first: "โดด", customerType: "individual" }),
          groupRow("emp-solo", "cust-Y", { first: "โดด", customerType: "company" }),
        ],
      },
      cap
    );
    const out = await getTeamWorkload(db, T);
    expect(out.teams).toHaveLength(1);
    expect(out.unassigned).toHaveLength(1);
    expect(out.unassigned[0].employee_id).toBe("emp-solo");
    expect(out.unassigned[0].is_lead).toBe(false);
    expect(out.unassigned[0].total).toBe(2);
    expect(out.unassigned[0].name).toContain("โดด");
  });

  it("scope tenant + เงื่อนไข chat_groups (มีนักบัญชี+ลูกค้า, group/room, ไม่ลบ)", async () => {
    const cap: Capture = { calls: [] };
    await getTeamWorkload(makeDb({ teams: [] }, cap), T);

    const call = cap.calls.find((c) => c.table === "chat_groups")!;
    expect(call).toBeTruthy();
    expect(
      call.filters.some((f) => f.fn === "eq" && f.args[0] === "tenant_id" && f.args[1] === T)
    ).toBe(true);
    expect(
      call.filters.some((f) => f.fn === "not" && f.args[0] === "responsible_employee_id")
    ).toBe(true);
    expect(call.filters.some((f) => f.fn === "not" && f.args[0] === "customer_id")).toBe(true);
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
    expect(
      call.filters.some((f) => f.fn === "is" && f.args[0] === "deleted_at" && f.args[1] === null)
    ).toBe(true);

    // teams query ก็ scope tenant + soft-delete
    const teamCall = cap.calls.find((c) => c.table === "teams")!;
    expect(
      teamCall.filters.some((f) => f.fn === "eq" && f.args[0] === "tenant_id" && f.args[1] === T)
    ).toBe(true);
    expect(
      teamCall.filters.some((f) => f.fn === "is" && f.args[0] === "deleted_at" && f.args[1] === null)
    ).toBe(true);
  });

  it("ไม่มีทีม + ไม่มีกลุ่ม → { teams: [], unassigned: [] } (ไม่ query team_members/employees)", async () => {
    const cap: Capture = { calls: [] };
    const out = await getTeamWorkload(makeDb({ teams: [], chat_groups: [] }, cap), T);
    expect(out).toEqual({ teams: [], unassigned: [] });
    // ไม่มีทีม → ไม่ต้องดึงสมาชิก/ชื่อหัวหน้า
    expect(cap.calls.some((c) => c.table === "team_members")).toBe(false);
    expect(cap.calls.some((c) => c.table === "employees")).toBe(false);
  });

  it("query teams error → throw", async () => {
    const cap: Capture = { calls: [] };
    await expect(getTeamWorkload(makeDb({}, cap, "teams"), T)).rejects.toThrow(/boom/);
  });

  it("query chat_groups error → throw", async () => {
    const cap: Capture = { calls: [] };
    await expect(
      getTeamWorkload(makeDb({ teams: [] }, cap, "chat_groups"), T)
    ).rejects.toThrow(/boom/);
  });
});

describe("assembleTeamWorkload — ตรรกะประกอบ (ฟังก์ชันบริสุทธิ์)", () => {
  it("หัวหน้าจาก lead_employee_id ที่ไม่อยู่ใน team_members → แสดงบนสุดด้วยชื่อจาก leadNames", () => {
    const out = assembleTeamWorkload(
      [teamRow("team-A", "ทีม A", { type: "individual", leadId: "emp-lead" })],
      [memberRow("team-A", "emp-1", { first: "สมาชิก" })], // ไม่มี emp-lead ใน members
      [groupRow("emp-1", "cust-A", { customerType: "individual" })],
      new Map([["emp-lead", { first_name: "บอส", nickname: "บี" }]])
    );
    const team = out.teams[0];
    expect(team.members[0].is_lead).toBe(true);
    expect(team.members[0].employee_id).toBe("emp-lead");
    expect(team.members[0].name).toBe("บอส (บี)");
    expect(team.lead_name).toBe("บอส (บี)");
  });

  it("เรียงทีมตามประเภท: บริษัท → บุคคลธรรมดา → ไม่ระบุ", () => {
    const out = assembleTeamWorkload(
      [
        teamRow("t3", "ทีมไม่ระบุ", { type: null }),
        teamRow("t2", "ทีมบุคคล", { type: "individual" }),
        teamRow("t1", "ทีมบริษัท", { type: "company" }),
      ],
      [],
      []
    );
    expect(out.teams.map((t) => t.team_id)).toEqual(["t1", "t2", "t3"]);
  });
});
