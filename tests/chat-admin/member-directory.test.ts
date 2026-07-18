import { describe, it, expect } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { listMemberDirectory, propagateMemberIdentity } from "@/lib/chat-admin/member-directory";

const T = "tenant-1";
const EMP = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ACTOR = "99999999-9999-9999-9999-999999999999";
const G1 = "11111111-1111-1111-1111-111111111111";
const G2 = "22222222-2222-2222-2222-222222222222";

describe("listMemberDirectory — รวม line_user_id ข้ามทุกกลุ่ม + group count", () => {
  it("distinct line_user_id, นับกลุ่มถูก, เรียง group count มาก→น้อย, สถานะผูก", async () => {
    // U1 อยู่ 3 กลุ่ม (g1 ผูก EMP=accountant, g2/g3 ยังไม่ผูก) · U2 อยู่ 1 กลุ่ม
    const memberRows = [
      { id: "m1", line_user_id: "U1", display_name_enc: null, member_kind: "accountant", employee_id: EMP, chat_group_id: G1 },
      { id: "m2", line_user_id: "U1", display_name_enc: null, member_kind: "unknown", employee_id: null, chat_group_id: G2 },
      { id: "m3", line_user_id: "U1", display_name_enc: null, member_kind: "unknown", employee_id: null, chat_group_id: "g3" },
      { id: "m4", line_user_id: "U2", display_name_enc: null, member_kind: "unknown", employee_id: null, chat_group_id: G1 },
    ];
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_members" && q.op === "select") return { data: memberRows };
      if (q.table === "chat_groups" && q.op === "select") return { data: [{ id: G1, display_name_enc: null }] };
      return { data: null };
    });

    const entries = await listMemberDirectory(db, T);
    expect(entries).toHaveLength(2); // distinct: U1, U2
    // เรียง group count มาก→น้อย → U1 (3) ก่อน U2 (1)
    expect(entries[0].lineUserId).toBe("U1");
    expect(entries[0].groupCount).toBe(3);
    expect(entries[0].isLinked).toBe(true);
    expect(entries[0].boundEmployeeId).toBe(EMP);
    expect(entries[0].memberKind).toBe("accountant"); // ตัวแทนจากแถวที่ผูกแล้ว
    expect(entries[0].groups).toHaveLength(3);
    expect(entries[1].lineUserId).toBe("U2");
    expect(entries[1].groupCount).toBe(1);
    expect(entries[1].isLinked).toBe(false);
    expect(entries[1].boundEmployeeId).toBeNull();
  });

  it("ไม่มีสมาชิก → คืน []", async () => {
    const { db } = makeFakeDb(() => ({ data: [] }));
    expect(await listMemberDirectory(db, T)).toEqual([]);
  });
});

describe("propagateMemberIdentity — ผูกข้ามกลุ่ม (review-first) + audit + count", () => {
  it("โหมดทั้งหมด (ไม่ส่ง groupIds) → update เฉพาะที่ยังไม่ผูก + audit group_count", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: { id: EMP } };
      if (q.table === "chat_members" && q.op === "update") return { data: [{ id: "m2" }, { id: "m3" }] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    const res = await propagateMemberIdentity(
      db, T,
      { lineUserId: "U1", employeeId: EMP, memberKind: "accountant" },
      ACTOR
    );
    expect(res.affected).toBe(2);
    const upd = cap.updates.find((u) => u.table === "chat_members") as { payload: Record<string, unknown> };
    expect(upd.payload.member_kind).toBe("accountant");
    expect(upd.payload.employee_id).toBe(EMP);
    // โหมดทั้งหมด → กรอง employee_id IS NULL (ไม่ใช่ .in chat_group_id)
    expect(cap.filters.find((f) => f.table === "chat_members" && f.kind === "in")).toBeUndefined();
    const audit = cap.inserts.find((i) => i.table === "audit_logs") as { payload: Record<string, unknown> };
    expect(audit.payload.action).toBe("chat_member_propagated");
    expect((audit.payload.meta as Record<string, unknown>).group_count).toBe(2);
    expect((audit.payload.meta as Record<string, unknown>).mode).toBe("unmapped");
    expect((audit.payload.meta as Record<string, unknown>).line_user_id).toBe("U1");
  });

  it("โหมดเลือกบางกลุ่ม (groupIds) → กรองด้วย chat_group_id IN + mode=selected", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: { id: EMP } };
      if (q.table === "chat_members" && q.op === "update") return { data: [{ id: "m2" }] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    const res = await propagateMemberIdentity(
      db, T,
      { lineUserId: "U1", employeeId: EMP, memberKind: "accountant", groupIds: [G1, G2] },
      ACTOR
    );
    expect(res.affected).toBe(1);
    const inFilter = cap.filters.find((f) => f.table === "chat_members" && f.kind === "in");
    expect(inFilter?.column).toBe("chat_group_id");
    expect(inFilter?.value).toEqual([G1, G2]);
    const audit = cap.inserts.find((i) => i.table === "audit_logs") as { payload: Record<string, unknown> };
    expect((audit.payload.meta as Record<string, unknown>).mode).toBe("selected");
  });

  it("บทบาท customer → ล้างการผูกพนักงาน (employee_id=null) แม้ส่ง employee มา", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_members" && q.op === "update") return { data: [{ id: "m1" }] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);
    await propagateMemberIdentity(db, T, { lineUserId: "U1", employeeId: EMP, memberKind: "customer" }, ACTOR);
    const upd = cap.updates.find((u) => u.table === "chat_members") as { payload: Record<string, unknown> };
    expect(upd.payload.employee_id).toBeNull();
    // ไม่ต้อง assert employee (บทบาทไม่ผูกพนักงาน)
    expect(cap.filters.find((f) => f.table === "employees")).toBeUndefined();
  });

  it("accountant แต่ไม่เลือกพนักงาน → throw (ไม่แตะ update)", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ data: null }), cap);
    await expect(
      propagateMemberIdentity(db, T, { lineUserId: "U1", employeeId: null, memberKind: "accountant" }, ACTOR)
    ).rejects.toThrow(/นักบัญชี|พนักงาน/);
    expect(cap.updates.length).toBe(0);
  });

  it("พนักงานอยู่นอก tenant → throw (ไม่แตะ update)", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);
    await expect(
      propagateMemberIdentity(db, T, { lineUserId: "U1", employeeId: EMP, memberKind: "accountant" }, ACTOR)
    ).rejects.toThrow(/พนักงาน/);
    expect(cap.updates.length).toBe(0);
  });
});
