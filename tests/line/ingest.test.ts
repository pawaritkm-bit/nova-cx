import { describe, it, expect } from "vitest";
import type { QueuedLineEvent } from "@/lib/line/webhook";
import { ingestGroupMessage } from "@/lib/line/ingest";
import { makeDb, makeStore, type Store } from "./fake-db";

/**
 * ingestGroupMessage (Phase 1) — เก็บแชตกลุ่ม LINE ลง chat_* (เข้ารหัสแล้ว)
 *   ครอบคลุม: persist + content_enc, idempotency (line_message_id ซ้ำ),
 *   resolve member→customer, resolve group→customer, media→attachment, skip 1:1
 */

const NOW = () => new Date("2026-07-18T10:00:00Z");

function groupTextEvent(overrides: Partial<QueuedLineEvent> = {}): QueuedLineEvent {
  return {
    type: "message",
    timestamp: Date.parse("2026-07-18T09:59:00Z"),
    source: { type: "group", groupId: "Cgroup1", userId: "Uabc" },
    message: { id: "msg-1", type: "text", contentEnc: "v1:enc.abc.def" },
    ...overrides,
  };
}

/** store พื้นฐาน: กลุ่มมีอยู่แล้ว (มี id), ยังไม่มีข้อความซ้ำ, ไม่รู้จัก line_user */
function baseStore(extra: Record<string, unknown> = {}): Store {
  return makeStore({
    chat_channels: { id: "chan-1" },
    chat_groups: { id: "g-1", customer_id: null },
    line_users: null,
    chat_messages: null,
    ...extra,
  });
}

describe("ingestGroupMessage", () => {
  it("group text → persist chat_message พร้อม content_enc (ciphertext) ไม่มี plaintext", async () => {
    const store = baseStore();
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );

    expect(res.status).toBe("stored");
    const msg = store.inserts.find((i) => i.table === "chat_messages");
    expect(msg).toBeDefined();
    const row = msg!.rows[0];
    expect(row.line_message_id).toBe("msg-1");
    expect(row.content_enc).toBe("v1:enc.abc.def");
    expect(row.message_type).toBe("text");
    expect(row.tenant_id).toBe("t-1");
    expect(row.sent_at).toBe("2026-07-18T09:59:00.000Z");
    // raw_meta ต้องไม่มีเนื้อหาข้อความดิบ
    expect(JSON.stringify(row.raw_meta)).not.toContain("v1:enc");
    // upsert กลุ่ม + สมาชิก
    expect(store.upserts.find((u) => u.table === "chat_groups")).toBeDefined();
    expect(store.upserts.find((u) => u.table === "chat_members")).toBeDefined();
  });

  it("idempotency: line_message_id ซ้ำ → duplicate + ไม่ insert chat_message ซ้ำ", async () => {
    const store = baseStore({ chat_messages: { id: "existing-msg" } });
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );

    expect(res.status).toBe("duplicate");
    expect(store.inserts.find((i) => i.table === "chat_messages")).toBeUndefined();
  });

  it("resolve member→customer: line_user รู้จัก + ผูกลูกค้า → member_kind 'customer' + line_user_ref", async () => {
    const store = baseStore({ line_users: { id: "lu-1", customer_id: "cust-9" } });
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());

    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("customer");
    expect(member?.row.line_user_ref).toBe("lu-1");
  });

  it("resolve group→customer: chat_groups.customer_id → คืนใน result.customerId", async () => {
    const store = baseStore({ chat_groups: { id: "g-1", customer_id: "cust-42" } });
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    expect(res.status).toBe("stored");
    if (res.status === "stored") expect(res.customerId).toBe("cust-42");
  });

  it("media (image) → สร้าง message_attachments (pending, line_content_id = message.id)", async () => {
    const store = baseStore();
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent({
      message: { id: "img-9", type: "image", contentEnc: null },
    }));

    const att = store.inserts.find((i) => i.table === "message_attachments");
    expect(att).toBeDefined();
    expect(att!.rows[0].attachment_type).toBe("image");
    expect(att!.rows[0].line_content_id).toBe("img-9");
    expect(att!.rows[0].status).toBe("pending");
  });

  it("1:1 (source.type=user) → skip ไม่เก็บ (survey/follow domain เดิม)", async () => {
    const store = baseStore();
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent({ source: { type: "user", userId: "Uabc" } })
    );
    expect(res.status).toBe("skipped");
    expect(store.inserts.find((i) => i.table === "chat_messages")).toBeUndefined();
    expect(store.upserts).toHaveLength(0);
  });

  it("room event รองรับ (roomId) → เก็บได้", async () => {
    const store = baseStore();
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent({ source: { type: "room", roomId: "Rroom1", userId: "Uabc" } })
    );
    expect(res.status).toBe("stored");
    const grp = store.upserts.find((u) => u.table === "chat_groups");
    expect(grp?.row.group_ref).toBe("Rroom1");
    expect(grp?.row.group_kind).toBe("room");
  });
});
