import { describe, it, expect } from "vitest";
import {
  registerStaff,
  resolveRegisterTenantId,
  listAccountingTeamsWithLeader,
  listRegisterableEmployees,
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

// =====================================================================
// ★ [เลือกจากรายชื่อ] registerStaff แบบส่ง employeeId → ผูก/re-link record เดิม
// =====================================================================
describe("registerStaff — เลือก employeeId (ผูก record เดิม / re-link)", () => {
  /** resolver สำหรับเส้น employeeId: employees(select)=record, employees(update)=ok */
  function makeLinkResolver(opts: {
    record: Record<string, unknown> | null;
    /** ผล eligibility (teams maybeSingle) เมื่อ record ไม่ใช่ accountant */
    leadOfTeam?: { id: string } | null;
  }) {
    return (q: ResolverArg): { data?: unknown; error?: unknown } => {
      if (q.table === "employees") {
        if (q.op === "update") return { data: null };
        return { data: opts.record }; // select maybeSingle → record ที่เลือก
      }
      if (q.table === "teams") {
        // eligibility ใช้ maybeSingle; resolveTeam (teamName) ใช้ await → []
        if (q.terminal === "await") return { data: [] };
        return { data: opts.leadOfTeam ?? null };
      }
      if (q.table === "chat_members") return { data: [] };
      if (q.table === "audit_logs") return { data: null };
      if (q.table === "tenants") return { data: { id: TENANT } };
      return { data: null };
    };
  }

  it("เลือก record accountant ที่ยังไม่ผูก → update line_user_id (ไม่ insert) + created=false + ใช้ชื่อเดิม", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-5",
          first_name: "พิมพ์ใจ",
          nickname: null,
          line_user_id: null,
          employee_type: "accountant",
          is_active: true,
        },
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ employeeId: "emp-5", userId: "Unew" }));

    expect(res.created).toBe(false);
    expect(res.employeeId).toBe("emp-5");
    expect(res.employeeName).toBe("พิมพ์ใจ"); // คงชื่อเดิมในระบบ ไม่ใช่ชื่อจากฟอร์ม
    // ไม่สร้างพนักงานใหม่
    expect(capture.inserts.find((i) => i.table === "employees")).toBeUndefined();
    // link update: set line_user_id = userId ปัจจุบัน
    const empUpdates = capture.updates.filter((u) => u.table === "employees");
    expect(
      empUpdates.some((u) => (u.payload as Record<string, unknown>).line_user_id === "Unew")
    ).toBe(true);
  });

  it("re-link: record มี line_user_id เก่า (stale) → ทับด้วย userId ปัจจุบัน (ไม่ error)", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-7",
          first_name: "เก่ง",
          nickname: null,
          line_user_id: "Uold-channel", // ผูกไว้ด้วย userId เก่า (login ไม่ได้)
          employee_type: "accountant",
          is_active: true,
        },
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ employeeId: "emp-7", userId: "Unew" }));

    expect(res.created).toBe(false);
    expect(res.employeeId).toBe("emp-7");
    const empUpdates = capture.updates.filter((u) => u.table === "employees");
    // ต้องมี update ที่ทับ line_user_id เป็น userId ปัจจุบัน
    expect(
      empUpdates.some((u) => (u.payload as Record<string, unknown>).line_user_id === "Unew")
    ).toBe(true);
  });

  it("ย้าย userId: ปลด line_user_id ออกจาก record อื่นที่ userId ปัจจุบันเคยผูก (update line_user_id=null filter by userId)", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-8",
          first_name: "นก",
          nickname: null,
          line_user_id: null,
          employee_type: "accountant",
          is_active: true,
        },
      }),
      capture
    );
    await registerStaff(db, TENANT, baseInput({ employeeId: "emp-8", userId: "Umove" }));

    // มี update employees ที่ set line_user_id=null (unlink อันเก่า)
    const empUpdates = capture.updates.filter((u) => u.table === "employees");
    expect(
      empUpdates.some((u) => (u.payload as Record<string, unknown>).line_user_id === null)
    ).toBe(true);
    // และ filter unlink ยิงด้วย line_user_id = userId ปัจจุบัน (ปลดเฉพาะของ userId นี้)
    const empFilters = capture.filters.filter((f) => f.table === "employees");
    expect(
      empFilters.some((f) => f.column === "line_user_id" && f.value === "Umove")
    ).toBe(true);
  });

  it("record ไม่ใช่ accountant และไม่ใช่หัวหน้าทีมบัญชี → throw (กันคนนอก)", async () => {
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-9",
          first_name: "ขาย",
          nickname: null,
          line_user_id: null,
          employee_type: "sales",
          is_active: true,
        },
        leadOfTeam: null, // ไม่ได้เป็นหัวหน้าทีมบัญชี
      })
    );
    await expect(
      registerStaff(db, TENANT, baseInput({ employeeId: "emp-9" }))
    ).rejects.toThrow();
  });

  it("record เป็นหัวหน้าทีมบัญชี (type อื่น) → ผูกได้", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-10",
          first_name: "หัวหน้า",
          nickname: null,
          line_user_id: null,
          employee_type: "other",
          is_active: true,
        },
        leadOfTeam: { id: "team-1" }, // เป็นหัวหน้าทีมบัญชี → eligible
      }),
      capture
    );
    const res = await registerStaff(db, TENANT, baseInput({ employeeId: "emp-10", userId: "Ux" }));
    expect(res.created).toBe(false);
    expect(res.employeeId).toBe("emp-10");
  });

  it("record ที่เลือกถูกปิดใช้งาน (is_active=false) → throw", async () => {
    const { db } = makeFakeDb(
      makeLinkResolver({
        record: {
          id: "emp-11",
          first_name: "ปิด",
          nickname: null,
          line_user_id: null,
          employee_type: "accountant",
          is_active: false,
        },
      })
    );
    await expect(
      registerStaff(db, TENANT, baseInput({ employeeId: "emp-11" }))
    ).rejects.toThrow();
  });
});

describe("listRegisterableEmployees", () => {
  it("คืน staff ทั้งหมด (accountant + หัวหน้าทีมบัญชี) พร้อมธง linked, dedup, กรอง inactive/deleted", async () => {
    const capture: Capture = { inserts: [], updates: [], filters: [] };
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees") {
        return {
          data: [
            { id: "e1", first_name: "สมชาย", nickname: null, line_user_id: null },
            { id: "e2", first_name: "สมหญิง", nickname: "หญิง", line_user_id: "Ulinked" },
          ],
        };
      }
      if (q.table === "teams") {
        return {
          data: [
            {
              id: "t1",
              lead: { id: "e3", first_name: "หัวหน้าบัญชี", nickname: null, line_user_id: null, is_active: true, deleted_at: null },
            },
            // dedup: e2 เป็นหัวหน้าด้วย แต่มีในลิสต์ accountant แล้ว
            {
              id: "t2",
              lead: { id: "e2", first_name: "สมหญิง", nickname: "หญิง", line_user_id: "Ulinked", is_active: true, deleted_at: null },
            },
            // inactive → ตัดออก
            {
              id: "t3",
              lead: { id: "e4", first_name: "ปิด", nickname: null, line_user_id: null, is_active: false, deleted_at: null },
            },
          ],
        };
      }
      return { data: null };
    }, capture);

    const emps = await listRegisterableEmployees(db, TENANT);
    expect(emps).toEqual([
      { id: "e1", name: "สมชาย", linked: false },
      { id: "e2", name: "หญิง", linked: true }, // มี line_user_id → linked
      { id: "e3", name: "หัวหน้าบัญชี", linked: false },
    ]);
    // scope: employees ต้อง filter tenant + employee_type=accountant + is_active
    const ef = capture.filters.filter((f) => f.table === "employees");
    expect(ef.some((f) => f.column === "tenant_id" && f.value === TENANT)).toBe(true);
    expect(ef.some((f) => f.column === "employee_type" && f.value === "accountant")).toBe(true);
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
