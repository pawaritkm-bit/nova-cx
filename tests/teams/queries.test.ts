import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "@/lib/evaluation/access";
import {
  canSeeTeamStructure,
  assembleTeamStructure,
  getTeamStructure,
} from "@/lib/teams/queries";

// ---------------------------------------------------------------------
// canSeeTeamStructure — allow-list / default-deny
// ---------------------------------------------------------------------
describe("canSeeTeamStructure — ขอบเขตบทบาทที่เข้าหน้าได้", () => {
  it("privileged (admin/executive/acc_lead) + accountant = true", () => {
    for (const r of ["admin", "executive", "acc_lead", "accountant"]) {
      expect(canSeeTeamStructure(r)).toBe(true);
    }
  });
  it("บทบาทอื่น/null = false (default deny)", () => {
    for (const r of ["cs", "hr", "sales", "sales_lead", "auditor_qa", null, undefined, "unknown"]) {
      expect(canSeeTeamStructure(r as string | null)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------
// assembleTeamStructure (pure)
// ---------------------------------------------------------------------
type TeamRow = { id: string; name: string; handles_customer_type: string | null; lead_employee_id: string | null };

function team(p: Partial<TeamRow> & { id: string }): TeamRow {
  return {
    id: p.id,
    name: p.name ?? `ทีม ${p.id}`,
    handles_customer_type: p.handles_customer_type ?? null,
    lead_employee_id: p.lead_employee_id ?? null,
  };
}
function member(teamId: string, empId: string, roleInTeam: string, first: string, nick?: string | null) {
  return {
    team_id: teamId,
    employee_id: empId,
    role_in_team: roleInTeam,
    employees: { first_name: first, nickname: nick ?? null, deleted_at: null },
  };
}
/** แถวจับคู่กลุ่ม→ลูกค้า+ผู้ดูแล (chat_groups linkage) — แหล่งข้อมูลใหม่ของหน้านี้ */
function link(empId: string, custId: string, code: string | null, name: string, deleted = false) {
  return {
    responsible_employee_id: empId,
    customer_id: custId,
    customers: { customer_code: code, name, deleted_at: deleted ? "2026-01-01" : null },
  };
}

describe("assembleTeamStructure — ประกอบผังทีม", () => {
  it("หัวหน้าอยู่บนสุด + นับ/ลิสต์ลูกค้าต่อคน + ลูกค้ารวมของทีม", () => {
    const out = assembleTeamStructure(
      [team({ id: "t1", name: "ทีม A", handles_customer_type: "company", lead_employee_id: "e-lead" })],
      [
        member("t1", "e-a", "member", "เอ"),
        member("t1", "e-lead", "lead", "ลีดเดอร์", "ลี"),
      ],
      [
        link("e-lead", "c1", "C001", "บริษัท ก"),
        link("e-a", "c2", "C002", "บริษัท ข"),
        link("e-a", "c3", "C003", "บริษัท ค"),
      ]
    );

    expect(out).toHaveLength(1);
    const t = out[0];
    expect(t.handlesCustomerType).toBe("company");
    // หัวหน้าอยู่แถวแรก (แม้ลูกค้าน้อยกว่า)
    expect(t.members[0].isLead).toBe(true);
    expect(t.members[0].employeeId).toBe("e-lead");
    expect(t.leaderName).toBe("ลีดเดอร์ (ลี)");
    // ลูกค้าต่อคน
    expect(t.members[0].customerCount).toBe(1);
    expect(t.members[1].employeeId).toBe("e-a");
    expect(t.members[1].customerCount).toBe(2);
    expect(t.members[1].customers.map((c) => c.code)).toEqual(["C002", "C003"]);
    // ลูกค้ารวมทั้งทีม = distinct 3
    expect(t.totalCustomers).toBe(3);
  });

  it("ข้ามลูกค้าที่ถูกปิดใช้งาน (customers.deleted_at) + dedup customer_id (ลูกค้าเดียวหลายกลุ่ม)", () => {
    const out = assembleTeamStructure(
      [team({ id: "t1", lead_employee_id: "e1" })],
      [member("t1", "e1", "lead", "เอ")],
      [
        link("e1", "c1", "C001", "ลูกค้า 1"),
        link("e1", "c1", "C001", "ลูกค้า 1"), // ลูกค้าเดิมจากอีกกลุ่ม → นับครั้งเดียว
        link("e1", "c2", "C002", "ลูกค้าปิด", true), // ปิดใช้งาน → ไม่นับ
      ]
    );
    expect(out[0].members[0].customerCount).toBe(1);
    expect(out[0].totalCustomers).toBe(1);
  });

  it("totalCustomers นับ distinct ระดับทีม (ลูกค้าเดียวถูกดูแลโดยหลายคน → นับครั้งเดียว)", () => {
    const out = assembleTeamStructure(
      [team({ id: "t1", lead_employee_id: "e1" })],
      [member("t1", "e1", "lead", "เอ"), member("t1", "e2", "member", "บี")],
      [
        link("e1", "c1", "C001", "ลูกค้าร่วม"),
        link("e2", "c1", "C001", "ลูกค้าร่วม"), // คนละคนดูแลลูกค้าเดียวกัน
        link("e2", "c2", "C002", "ลูกค้าเดี่ยว"),
      ]
    );
    // สมาชิกแต่ละคนนับลูกค้าของตัวเอง
    const e1 = out[0].members.find((m) => m.employeeId === "e1");
    const e2 = out[0].members.find((m) => m.employeeId === "e2");
    expect(e1?.customerCount).toBe(1);
    expect(e2?.customerCount).toBe(2);
    // ทีมนับ distinct = c1, c2 = 2 (ไม่ใช่ 1+2)
    expect(out[0].totalCustomers).toBe(2);
  });

  it("หัวหน้าจาก lead_employee_id แม้ role_in_team ไม่ใช่ 'lead'", () => {
    const out = assembleTeamStructure(
      [team({ id: "t1", lead_employee_id: "e2" })],
      [member("t1", "e1", "member", "เอ"), member("t1", "e2", "member", "บี")],
      []
    );
    const lead = out[0].members.find((m) => m.isLead);
    expect(lead?.employeeId).toBe("e2");
    expect(out[0].members[0].employeeId).toBe("e2"); // หัวหน้าขึ้นก่อน
  });

  it("เรียงทีม: บริษัท → บุคคลธรรมดา → ไม่ระบุ", () => {
    const out = assembleTeamStructure(
      [
        team({ id: "t-none", name: "ทีมไม่ระบุ", handles_customer_type: null }),
        team({ id: "t-ind", name: "ทีมบุคคล", handles_customer_type: "individual" }),
        team({ id: "t-com", name: "ทีมบริษัท", handles_customer_type: "company" }),
      ],
      [],
      []
    );
    expect(out.map((t) => t.teamId)).toEqual(["t-com", "t-ind", "t-none"]);
  });
});

// ---------------------------------------------------------------------
// getTeamStructure — fake db (ยืนยัน tenant scope + ขอบเขต accountant)
// ---------------------------------------------------------------------
type Filter = [string, string, unknown];
type CallRec = { table: string; filters: Filter[] };

function makeDb(dataByTable: Record<string, unknown[]>, calls: CallRec[]): SupabaseClient {
  const make = (table: string) => {
    const rec: CallRec = { table, filters: [] };
    calls.push(rec);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => {
      rec.filters.push(["eq", c, v]);
      return b;
    };
    b.in = (c: string, v: unknown) => {
      rec.filters.push(["in", c, v]);
      return b;
    };
    b.lte = (c: string, v: unknown) => {
      rec.filters.push(["lte", c, v]);
      return b;
    };
    b.not = (c: string, op: string, v: unknown) => {
      rec.filters.push(["not", c, [op, v]]);
      return b;
    };
    b.is = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: dataByTable[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

function hasFilter(calls: CallRec[], table: string, kind: string, col: string, val: unknown): boolean {
  return calls.some(
    (c) =>
      c.table === table &&
      c.filters.some(([k, cc, vv]) => k === kind && cc === col && JSON.stringify(vv) === JSON.stringify(val))
  );
}

const viewerOf = (p: Partial<Viewer>): Viewer => ({
  role: p.role ?? null,
  employeeId: p.employeeId ?? null,
  tenantId: p.tenantId ?? "t1",
  teamMemberIds: p.teamMemberIds ?? new Set(),
});

describe("getTeamStructure — tenant scope + ขอบเขตบทบาท", () => {
  it("role ที่ไม่มีสิทธิ์ (cs/null) → คืน [] โดยไม่ query", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({}, calls);
    expect(await getTeamStructure(db, "t1", viewerOf({ role: "cs" }))).toEqual([]);
    expect(await getTeamStructure(db, "t1", viewerOf({ role: null }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("privileged (executive) → กรอง tenant ทุกตาราง + ไม่จำกัด team ด้วย in(id)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        teams: [{ id: "t-1", name: "ทีม", handles_customer_type: "company", lead_employee_id: "e1" }],
        team_members: [
          { team_id: "t-1", employee_id: "e1", role_in_team: "lead", employees: { first_name: "เอ", nickname: null, deleted_at: null } },
        ],
        chat_groups: [
          { responsible_employee_id: "e1", customer_id: "c1", customers: { customer_code: "C1", name: "ลูกค้า", deleted_at: null } },
        ],
      },
      calls
    );

    const out = await getTeamStructure(db, "t1", viewerOf({ role: "executive", employeeId: "eX" }));

    // ทุก query กรอง tenant_id = t1
    expect(hasFilter(calls, "teams", "eq", "tenant_id", "t1")).toBe(true);
    expect(hasFilter(calls, "team_members", "eq", "tenant_id", "t1")).toBe(true);
    expect(hasFilter(calls, "chat_groups", "eq", "tenant_id", "t1")).toBe(true);
    // executive ไม่ query team_members ของตัวเองเพื่อจำกัดทีม (ไม่มี eq employee_id=eX บน team_members)
    expect(hasFilter(calls, "team_members", "eq", "employee_id", "eX")).toBe(false);
    // chat_groups ต้องผูกนักบัญชี (in responsible_employee_id) + กรองกลุ่มจริง + มีลูกค้าจับคู่
    expect(hasFilter(calls, "chat_groups", "in", "responsible_employee_id", ["e1"])).toBe(true);
    expect(hasFilter(calls, "chat_groups", "in", "group_kind", ["group", "room"])).toBe(true);
    expect(hasFilter(calls, "chat_groups", "not", "customer_id", ["is", null])).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].members[0].customerCount).toBe(1);
  });

  it("accountant → query ทีมของตัวเองก่อน แล้วจำกัด teams ด้วย in(id)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        team_members: [
          // ★ ผลลัพธ์ตารางเดียวกันถูก reuse ทั้ง query "ทีมของฉัน" และ "สมาชิกทีม"
          //   สำหรับเทสนี้สนใจแค่ว่า query แรกคืน team_id ที่ accountant สังกัด
          { team_id: "t-mine", employee_id: "acc-1", role_in_team: "member", employees: { first_name: "ฉัน", nickname: null, deleted_at: null } },
        ],
        teams: [{ id: "t-mine", name: "ทีมฉัน", handles_customer_type: "individual", lead_employee_id: null }],
        chat_groups: [],
      },
      calls
    );

    const out = await getTeamStructure(db, "t1", viewerOf({ role: "accountant", employeeId: "acc-1" }));

    // ต้อง query team_members กรอง employee_id = ตัวเอง (หาทีมที่สังกัด)
    expect(hasFilter(calls, "team_members", "eq", "employee_id", "acc-1")).toBe(true);
    // teams ต้องถูกจำกัดด้วย in("id", [...]) — ไม่หลุดไปทีมอื่น
    expect(hasFilter(calls, "teams", "in", "id", ["t-mine"])).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].teamId).toBe("t-mine");
  });

  it("accountant ไม่มี employeeId → คืน [] (ไม่ leak)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({}, calls);
    const out = await getTeamStructure(db, "t1", viewerOf({ role: "accountant", employeeId: null }));
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("ไม่มีทีม → คืน [] (ไม่ throw)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({ teams: [] }, calls);
    const out = await getTeamStructure(db, "t1", viewerOf({ role: "admin" }));
    expect(out).toEqual([]);
  });
});
