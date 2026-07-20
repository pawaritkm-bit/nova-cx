import { describe, it, expect, vi } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { deleteChatGroup } from "@/lib/chat-admin/group";

const T = "tenant-1";
const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR = "99999999-9999-9999-9999-999999999999";

describe("deleteChatGroup — soft-delete กลุ่ม + ข้อมูลในกลุ่ม + audit", () => {
  it("สำเร็จ → set deleted_at ให้กลุ่ม + members + messages (scope tenant) + audit", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "update") return { data: [{ id: GROUP }] };
      if (q.op === "update") return { error: null }; // ตารางลูก best-effort
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    await expect(deleteChatGroup(db, T, GROUP, ACTOR)).resolves.toBeUndefined();

    // กลุ่มถูก soft-delete (set deleted_at, ไม่ hard-delete)
    const groupUpd = cap.updates.find((u) => u.table === "chat_groups") as { payload: Record<string, unknown> };
    expect(groupUpd).toBeTruthy();
    expect(groupUpd.payload.deleted_at).toBeTruthy();

    // ตารางลูกถูก soft-delete ด้วย
    for (const table of ["chat_members", "chat_messages", "ai_chat_analysis", "conversation_cases"]) {
      const childUpd = cap.updates.find((u) => u.table === table) as { payload: Record<string, unknown> };
      expect(childUpd, `ต้อง soft-delete ${table}`).toBeTruthy();
      expect(childUpd.payload.deleted_at).toBeTruthy();
    }

    // scope tenant: ทุก update ของกลุ่ม/ลูกต้องกรอง tenant_id = T
    for (const table of ["chat_groups", "chat_members", "chat_messages"]) {
      const tenantFilter = cap.filters.find((f) => f.table === table && f.column === "tenant_id");
      expect(tenantFilter?.value, `${table} ต้อง scope tenant`).toBe(T);
    }
    // ตารางลูก scope ด้วย chat_group_id
    const grpFilter = cap.filters.find((f) => f.table === "chat_members" && f.column === "chat_group_id");
    expect(grpFilter?.value).toBe(GROUP);

    // audit
    const audit = cap.inserts.find((i) => i.table === "audit_logs") as { payload: Record<string, unknown> };
    expect(audit.payload.action).toBe("chat_group_deleted");
    expect(audit.payload.tenant_id).toBe(T);
    expect(audit.payload.resource_id).toBe(GROUP);
    expect(audit.payload.actor_user_id).toBe(ACTOR);
  });

  it("กลุ่ม id ผิด/ข้าม tenant (update 0 แถว) → throw + ไม่แตะลูก/audit", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "update") return { data: [] }; // assertAffected fail
      return { data: null };
    }, cap);

    await expect(deleteChatGroup(db, T, GROUP, ACTOR)).rejects.toThrow(/ไม่พบกลุ่ม/);
    // assertAffected ล้ม → ไม่ควรแตะตารางลูกหรือ audit
    expect(cap.updates.find((u) => u.table === "chat_members")).toBeUndefined();
    expect(cap.inserts.find((i) => i.table === "audit_logs")).toBeUndefined();
  });

  it("ตารางลูกมี error (best-effort) → ยังลบกลุ่มสำเร็จ + เขียน audit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "update") return { data: [{ id: GROUP }] };
      if (q.op === "update") return { error: { message: "trigger ป้องกัน update" } };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    await expect(deleteChatGroup(db, T, GROUP, ACTOR)).resolves.toBeUndefined();
    expect(cap.inserts.find((i) => i.table === "audit_logs")).toBeTruthy();
    expect(warn).toHaveBeenCalled(); // best-effort log
    warn.mockRestore();
  });
});
