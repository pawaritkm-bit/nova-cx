import { describe, it, expect } from "vitest";
import {
  registerStaff,
  resolveRegisterTenantId,
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
    expect((empUpdate!.payload as Record<string, unknown>).first_name).toBe("สมชาย ใหม่");
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
