import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import type { QueuedLineEvent } from "@/lib/line/webhook";
import { ingestGroupMessage } from "@/lib/line/ingest";
import { makeDb, makeStore, type Store } from "./fake-db";

/**
 * ingestGroupMessage (Phase 1) — เก็บแชตกลุ่ม LINE ลง chat_* (เข้ารหัสแล้ว)
 *   ครอบคลุม: persist + content_enc, idempotency (pre-check + 23505 race),
 *   resolve member→customer, group→customer, กลุ่มใหม่ insert (ไม่ทับ is_active),
 *   display_name เข้ารหัส, media→attachment (upsert), resolver >1 แถวไม่ throw, skip 1:1
 */

const NOW = () => new Date("2026-07-18T10:00:00Z");
const ENC_KEY = "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";

function groupTextEvent(overrides: Partial<QueuedLineEvent> = {}): QueuedLineEvent {
  return {
    type: "message",
    timestamp: Date.parse("2026-07-18T09:59:00Z"),
    source: { type: "group", groupId: "Cgroup1", userId: "Uabc" },
    message: { id: "msg-1", type: "text", contentEnc: "v1:enc.abc.def" },
    ...overrides,
  };
}

/** client ปลอมที่คืนชื่อสมาชิกกลุ่ม (best-effort) */
function clientWithName(displayName: string | null): LineClient {
  return {
    oa: "care" as LineOa,
    async push() {
      return { ok: true };
    },
    async reply() {
      return { ok: true };
    },
    async getProfile() {
      return null;
    },
    async getGroupMemberProfile(_type, _sourceId, userId) {
      return displayName ? { userId, displayName } : { userId };
    },
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
    // สมาชิกถูก upsert
    expect(store.upserts.find((u) => u.table === "chat_members")).toBeDefined();
  });

  it("กลุ่มใหม่ → insert chat_groups (ไม่ upsert เพื่อไม่ทับ is_active/tenant_id ของแอดมิน)", async () => {
    const store = baseStore({ chat_groups: null }); // ยังไม่มีกลุ่ม → ต้อง insert
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    expect(res.status).toBe("stored");
    expect(store.inserts.find((i) => i.table === "chat_groups")).toBeDefined();
    // ★ ต้องไม่ใช้ upsert กับ chat_groups (กันเขียนทับ flag)
    expect(store.upserts.find((u) => u.table === "chat_groups")).toBeUndefined();
  });

  it("idempotency (pre-check): line_message_id ซ้ำ → duplicate + ไม่ insert chat_message ซ้ำ", async () => {
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

  it("idempotency (race 23505): insert ชน unique → duplicate ไม่ throw (H1)", async () => {
    const store = baseStore();
    // จำลอง insert chat_messages ชน unique(line_message_id)
    store.errors = { chat_messages: { message: "duplicate key" } };
    (store.errors.chat_messages as { code?: string }).code = "23505";

    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    expect(res.status).toBe("duplicate");
  });

  it("resolve member→customer: line_user รู้จัก + ผูกลูกค้า → member_kind 'customer' + line_user_ref", async () => {
    const store = baseStore({ line_users: { id: "lu-1", customer_id: "cust-9" } });
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());

    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("customer");
    expect(member?.row.line_user_ref).toBe("lu-1");
  });

  it("resolver เจอ >1 แถว → ไม่ throw + หยิบตัวแรก (rev-M2)", async () => {
    const store = baseStore({
      chat_channels: [{ id: "chan-a" }, { id: "chan-b" }],
      line_users: [
        { id: "lu-1", customer_id: "cust-1" },
        { id: "lu-2", customer_id: "cust-2" },
      ],
    });
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    expect(res.status).toBe("stored");
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.line_user_ref).toBe("lu-1"); // ตัวแรก
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

  it("media (image) → upsert message_attachments (pending, line_content_id = message.id, idempotent)", async () => {
    const store = baseStore();
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent({
      message: { id: "img-9", type: "image", contentEnc: null },
    }));

    const att = store.upserts.find((u) => u.table === "message_attachments");
    expect(att).toBeDefined();
    expect(att!.row.attachment_type).toBe("image");
    expect(att!.row.line_content_id).toBe("img-9");
    expect(att!.row.status).toBe("pending");
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
    const store = baseStore({ chat_groups: null });
    const res = await ingestGroupMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      groupTextEvent({ source: { type: "room", roomId: "Rroom1", userId: "Uabc" } })
    );
    expect(res.status).toBe("stored");
    const grp = store.inserts.find((i) => i.table === "chat_groups");
    expect(grp?.rows[0].group_ref).toBe("Rroom1");
    expect(grp?.rows[0].group_kind).toBe("room");
  });
});

describe("ingestGroupMessage — display_name เข้ารหัส (PDPA, sec-M2)", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("มีคีย์ + ได้ชื่อสมาชิก → เก็บ display_name_enc เป็น ciphertext (ไม่มี plaintext)", async () => {
    const store = baseStore();
    await ingestGroupMessage(
      { db: makeDb(store), client: clientWithName("คุณสมชาย"), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    const member = store.upserts.find((u) => u.table === "chat_members");
    const enc = member?.row.display_name_enc as string | undefined;
    expect(enc).toBeDefined();
    expect(enc!.startsWith("v1:")).toBe(true);
    // ★ ต้องไม่มีชื่อจริงหลงเหลือใน row ที่จะเก็บ
    expect(JSON.stringify(member?.row)).not.toContain("คุณสมชาย");
    // ★ ไม่มีคอลัมน์ display_name (plaintext) เด็ดขาด
    expect((member?.row as Record<string, unknown>).display_name).toBeUndefined();
  });

  it("ไม่มีคีย์ → ไม่เก็บชื่อเลย (display_name_enc undefined, ไม่มี plaintext)", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const store = baseStore();
    await ingestGroupMessage(
      { db: makeDb(store), client: clientWithName("คุณสมชาย"), now: NOW },
      "t-1",
      "care",
      groupTextEvent()
    );
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect((member?.row as Record<string, unknown>).display_name_enc).toBeUndefined();
    expect(JSON.stringify(member?.row)).not.toContain("คุณสมชาย");
  });
});
