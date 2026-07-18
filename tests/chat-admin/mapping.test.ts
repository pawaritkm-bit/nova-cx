import { describe, it, expect } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { mapGroupToCustomer, setChatMember } from "@/lib/chat-admin/mapping";

const T = "tenant-1";
const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUST = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MEMBER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const EMP = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ACTOR = "99999999-9999-9999-9999-999999999999";

describe("mapGroupToCustomer — set customer_id + เขียน audit history", () => {
  it("จับคู่ลูกค้า → update chat_groups + insert customer_group_mapping (audit)", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { id: GROUP } };
      if (q.table === "customers" && q.terminal === "maybeSingle") return { data: { id: CUST } };
      if (q.table === "chat_groups" && q.op === "update") return { data: [{ id: GROUP }] };
      if (q.table === "customer_group_mapping" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    await expect(mapGroupToCustomer(db, T, { chat_group_id: GROUP, customer_id: CUST }, ACTOR)).resolves.toBeUndefined();
    const upd = cap.updates.find((u) => u.table === "chat_groups") as { payload: { customer_id: string } };
    expect(upd.payload.customer_id).toBe(CUST);
    const audit = cap.inserts.find((i) => i.table === "customer_group_mapping") as { payload: Record<string, unknown> };
    expect(audit.payload.tenant_id).toBe(T);
    expect(audit.payload.customer_id).toBe(CUST);
    expect(audit.payload.mapped_by).toBe(ACTOR);
  });

  it("ยกเลิกจับคู่ (customer_id null) → update customer_id=null แต่ไม่เขียน audit", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { id: GROUP } };
      if (q.table === "chat_groups" && q.op === "update") return { data: [{ id: GROUP }] };
      return { data: null };
    }, cap);

    await mapGroupToCustomer(db, T, { chat_group_id: GROUP, customer_id: null }, ACTOR);
    expect(cap.inserts.find((i) => i.table === "customer_group_mapping")).toBeUndefined();
  });

  it("กลุ่มอยู่นอก tenant → throw (ไม่แตะ update)", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);
    await expect(mapGroupToCustomer(db, T, { chat_group_id: GROUP, customer_id: CUST }, ACTOR)).rejects.toThrow(/กลุ่ม/);
    expect(cap.updates.length).toBe(0);
  });

  it("update match 0 แถว → throw ไม่พบรายการ", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { id: GROUP } };
      if (q.table === "customers" && q.terminal === "maybeSingle") return { data: { id: CUST } };
      if (q.table === "chat_groups" && q.op === "update") return { data: [] };
      return { data: null };
    }, cap);
    await expect(mapGroupToCustomer(db, T, { chat_group_id: GROUP, customer_id: CUST }, ACTOR)).rejects.toThrow(/ไม่พบรายการ/);
  });
});

describe("setChatMember — จับคู่พนักงาน + audit_logs", () => {
  it("accountant + employee → update chat_members + insert audit_logs", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: { id: EMP } };
      if (q.table === "chat_members" && q.op === "update") return { data: [{ id: MEMBER }] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    await setChatMember(db, T, { chat_member_id: MEMBER, member_kind: "accountant", employee_id: EMP }, ACTOR);
    const upd = cap.updates.find((u) => u.table === "chat_members") as { payload: Record<string, unknown> };
    expect(upd.payload.member_kind).toBe("accountant");
    expect(upd.payload.employee_id).toBe(EMP);
    const audit = cap.inserts.find((i) => i.table === "audit_logs") as { payload: Record<string, unknown> };
    expect(audit.payload.action).toBe("chat_member_mapped");
    expect(audit.payload.tenant_id).toBe(T);
  });

  it("customer → ล้างการผูกพนักงาน (employee_id=null) แม้ส่ง employee มา", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_members" && q.op === "update") return { data: [{ id: MEMBER }] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);
    await setChatMember(db, T, { chat_member_id: MEMBER, member_kind: "customer", employee_id: null }, ACTOR);
    const upd = cap.updates.find((u) => u.table === "chat_members") as { payload: Record<string, unknown> };
    expect(upd.payload.employee_id).toBeNull();
  });

  it("update match 0 แถว (id ผิด/ข้าม tenant) → throw", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: { id: EMP } };
      if (q.table === "chat_members" && q.op === "update") return { data: [] };
      return { data: null };
    }, cap);
    await expect(
      setChatMember(db, T, { chat_member_id: MEMBER, member_kind: "accountant", employee_id: EMP }, ACTOR)
    ).rejects.toThrow(/ไม่พบรายการ/);
  });
});
