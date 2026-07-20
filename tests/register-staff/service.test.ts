import { describe, it, expect } from "vitest";
import {
  registerStaff,
  resolveRegisterTenantId,
  listAccountingTeamsWithLeader,
  type RegisterStaffInput,
} from "@/lib/register-staff/service";
import { makeFakeDb, type ResolverArg, type Capture } from "../helpers/fake-supabase";

/**
 * registerStaff — ผูก LINE userId ↔ พนักงาน แบบ idempotent
 *   ครอบคลุม: สร้างพนักงานใหม่, มีอยู่แล้ว→อัปเดตไม่ insert (idempotent),
 *   propagate ไป chat_members, resolve team ตามชื่อ (พอดี1=ผูก, กำกวม=ไม่ผูก),
 *   audit_logs, tenant resolve
 */

const TENANT = "t-1";

function baseInput(over: Partial<RegisterStaffInput> = {}): RegisterStaffInput {
  return { userId: "Uacc1", name: "สมชาย ใจดี", nickname: "ชาย", ...over };
}

/** resolver ที่กำหนดผลต่อ (table, op) — ค่าเริ่มต้น degrade ปลอดภัย */
function makeResolver(opts: {
  existingEmployee?: { id: string } | null;
  newEmployeeId?: string;
  teams?: { id: string; name: string }[];
  existingTeamMember?: { id: string } | null;
  propagatedIds?: { id: string }[];
}) {
  return (q: ResolverArg): { data?: unknown; error?: unknown } => {
    if (q.table === "employees") {
      if (q.op === "insert") return { data: { id: opts.newEmployeeId ?? "emp-new" } };
      // select existing by line_user_id
      return { data: opts.existingEmployee ?? null };
    }
    if (q.table === "teams") {
      if (q.terminal === "await") return { data: opts.teams ?? [] };
      // teamId maybeSingle
      return { data: (opts.teams ?? [])[0] ?? null };
    }
    if (q.table === "team_members") {
      if (q.op === "insert") return { data: null };
      return { data: opts.existingTeamMember ?? null };
    }
    if (q.table === "chat_members") {
      // update ... select("id") → await
      return { data: opts.propagatedIds ?? [] };
    }
    if (q.table === "audit_logs") return { data: null };
    if (q.table === "tenants") return { data: { id: TENANT } };
    return { data: null };
  };
}

describe("registerStaff", () => {
  it("พนักงานใหม่ → insert employees (accountant, line_user_id) + audit + คืน created=true", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({ existingEmployee: null, newEmployeeId: "emp-9" }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput());

    expect(res.created).toBe(true);
    expect(res.employeeId).toBe("emp-9");
    expect(res.employeeName).toBe("ชาย"); // ใช้ชื่อเล่นถ้ามี

    const empInsert = capture.inserts.find((i) => i.table === "employees");
    expect(empInsert).toBeDefined();
    const payload = empInsert!.payload as Record<string, unknown>;
    expect(payload.employee_type).toBe("accountant");
    expect(payload.line_user_id).toBe("Uacc1");
    expect(payload.tenant_id).toBe(TENANT);

    // audit เขียนเสมอ
    expect(capture.inserts.find((i) => i.table === "audit_logs")).toBeDefined();
  });

  it("พนักงานมีอยู่แล้ว (line_user_id ตรง) → update ไม่ insert (idempotent) + created=false", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({ existingEmployee: { id: "emp-exist" } }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ name: "สมชาย ใหม่" }));

    expect(res.created).toBe(false);
    expect(res.employeeId).toBe("emp-exist");
    expect(capture.inserts.find((i) => i.table === "employees")).toBeUndefined();
    const empUpdate = capture.updates.find((u) => u.table === "employees");
    expect(empUpdate).toBeDefined();
    const upd = empUpdate!.payload as Record<string, unknown>;
    expect(upd.first_name).toBe("สมชาย ใหม่");
    // ★ [M3] ลงทะเบียนซ้ำต้องไม่ reactivate — update ต้อง "ไม่มี" is_active
    //   (คงค่าเดิม; ถ้าแอดมินปิดพนักงานคนนี้ไว้ ต้องปิดต่อ)
    expect("is_active" in upd).toBe(false);
  });

  it("[M3] create ใหม่ยังตั้ง is_active=true ตามปกติ", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({ existingEmployee: null, newEmployeeId: "emp-new" }),
      capture
    );
    await registerStaff(db, TENANT, baseInput());
    const empInsert = capture.inserts.find((i) => i.table === "employees");
    expect((empInsert!.payload as Record<string, unknown>).is_active).toBe(true);
  });

  it("propagate → update chat_members (employee_id + member_kind=accountant)", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({
        existingEmployee: { id: "emp-1" },
        propagatedIds: [{ id: "cm-1" }, { id: "cm-2" }, { id: "cm-3" }],
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput());

    expect(res.propagatedGroups).toBe(3);
    const cmUpdate = capture.updates.find((u) => u.table === "chat_members");
    expect(cmUpdate).toBeDefined();
    const p = cmUpdate!.payload as Record<string, unknown>;
    expect(p.employee_id).toBe("emp-1");
    expect(p.member_kind).toBe("accountant");
  });

  it("teamName match ทีมบัญชีพอดี 1 ทีม → ผูก team_members + teamLinked=true", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({
        existingEmployee: { id: "emp-1" },
        teams: [{ id: "team-A", name: "ทีมบัญชี A" }],
        existingTeamMember: null,
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ teamName: "  ทีมบัญชี a " }));

    expect(res.teamLinked).toBe(true);
    expect(res.teamName).toBe("ทีมบัญชี A");
    const tmInsert = capture.inserts.find((i) => i.table === "team_members");
    expect(tmInsert).toBeDefined();
    expect((tmInsert!.payload as Record<string, unknown>).team_id).toBe("team-A");
  });

  it("ระบุ teamId (จาก dropdown) → ผูก team_members ตาม teamId + teamLinked=true", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({
        existingEmployee: { id: "emp-1" },
        // teamId path ใช้ maybeSingle → resolver คืน teams[0]
        teams: [{ id: "team-X", name: "ทีมพี่ทัช" }],
        existingTeamMember: null,
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ teamId: "team-X" }));

    expect(res.teamLinked).toBe(true);
    expect(res.teamName).toBe("ทีมพี่ทัช");
    const tmInsert = capture.inserts.find((i) => i.table === "team_members");
    expect((tmInsert!.payload as Record<string, unknown>).team_id).toBe("team-X");
    // ★ teamId path ต้อง scope type=accounting (sec-a) → มี filter type=accounting
    const teamFilters = capture.filters.filter((f) => f.table === "teams");
    expect(teamFilters.some((f) => f.column === "type" && f.value === "accounting")).toBe(true);
  });

  it("teamName กำกวม (>1 ทีมชื่อเดียวกัน) → ไม่ผูกทีม (degrade) ไม่ throw", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({
        existingEmployee: { id: "emp-1" },
        teams: [
          { id: "team-A", name: "ทีมบัญชี A" },
          { id: "team-B", name: "ทีมบัญชี A" },
        ],
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ teamName: "ทีมบัญชี A" }));

    expect(res.teamLinked).toBe(false);
    expect(capture.inserts.find((i) => i.table === "team_members")).toBeUndefined();
  });

  it("ไม่ระบุทีม → ไม่ผูกทีม (teamLinked=false)", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeResolver({ existingEmployee: { id: "emp-1" } }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ teamName: undefined }));
    expect(res.teamLinked).toBe(false);
  });
});

describe("resolveRegisterTenantId", () => {
  it("env override → ใช้ค่านั้นเลย (ไม่ query)", async () => {
    const { db } = makeFakeDb(() => ({ data: null }));
    expect(await resolveRegisterTenantId(db, "t-env")).toBe("t-env");
  });

  it("ไม่มี override → tenant แรกที่ active", async () => {
    const { db } = makeFakeDb((q) =>
      q.table === "tenants" ? { data: { id: "t-first" } } : { data: null }
    );
    expect(await resolveRegisterTenantId(db)).toBe("t-first");
  });
});

describe("listAccountingTeamsWithLeader", () => {
  it("คืน teamId/teamName/leaderName (ชื่อเล่นก่อนชื่อจริง) + scope type=accounting", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      (q) =>
        q.table === "teams"
          ? {
              data: [
                { id: "team-A", name: "ทีม A", employees: { first_name: "ธัช ก.", nickname: "พี่ทัช" } },
                { id: "team-B", name: "ทีม B", employees: { first_name: "สมหญิง", nickname: null } },
                { id: "team-C", name: "ทีม C", employees: null },
              ],
            }
          : { data: null },
      capture
    );
    const teams = await listAccountingTeamsWithLeader(db, TENANT);

    expect(teams).toEqual([
      { teamId: "team-A", teamName: "ทีม A", leaderName: "พี่ทัช" },
      { teamId: "team-B", teamName: "ทีม B", leaderName: "สมหญิง" },
      { teamId: "team-C", teamName: "ทีม C", leaderName: null }, // ยังไม่ตั้งหัวหน้า
    ]);
    // scope: tenant + type=accounting
    const tf = capture.filters.filter((f) => f.table === "teams");
    expect(tf.some((f) => f.column === "tenant_id" && f.value === TENANT)).toBe(true);
    expect(tf.some((f) => f.column === "type" && f.value === "accounting")).toBe(true);
  });

  it("รองรับ join ที่คืนเป็น array (Supabase to-one shape) → หยิบตัวแรก", async () => {
    const { db } = makeFakeDb((q) =>
      q.table === "teams"
        ? { data: [{ id: "team-A", name: "ทีม A", employees: [{ first_name: "ธัช", nickname: "พี่ทัช" }] }] }
        : { data: null }
    );
    const teams = await listAccountingTeamsWithLeader(db, TENANT);
    expect(teams[0].leaderName).toBe("พี่ทัช");
  });
});
