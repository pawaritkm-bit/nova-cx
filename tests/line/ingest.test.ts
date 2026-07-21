import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import type { QueuedLineEvent } from "@/lib/line/webhook";
import { ingestGroupMessage, ingestDirectMessage, ingestGroupJoin } from "@/lib/line/ingest";
import { decryptField } from "@/lib/crypto/field";
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
    async getGroupSummary() {
      return null;
    },
  };
}

/** client ปลอมที่คืนชื่อกลุ่ม (best-effort) + นับจำนวนครั้งที่ถูกเรียก getGroupSummary */
function clientWithSummary(groupName: string | null): LineClient & { summaryCalls: number } {
  const c = {
    oa: "care" as LineOa,
    summaryCalls: 0,
    async push() {
      return { ok: true as const };
    },
    async reply() {
      return { ok: true as const };
    },
    async getProfile() {
      return null;
    },
    async getGroupMemberProfile() {
      return null;
    },
    async getGroupSummary() {
      c.summaryCalls += 1;
      return groupName ? { groupName } : null;
    },
  };
  return c;
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

describe("ingestGroupMessage — auto-resolve พนักงานจากการจับคู่ที่ยืนยันแล้ว (ตัวช่วย 1C)", () => {
  it("มี chat_member ยืนยันแล้ว (employee_id ไม่ null) คน line_user เดียวกัน → สืบทอด employee_id + member_kind", async () => {
    // line_users ไม่รู้จัก แต่มีการจับคู่ยืนยันแล้ว (accountant) ในกลุ่มอื่น
    const store = baseStore({
      chat_members: { employee_id: "emp-7", member_kind: "accountant" },
    });
    const res = await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    expect(res.status).toBe("stored");
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.employee_id).toBe("emp-7");
    expect(member?.row.member_kind).toBe("accountant");
  });

  it("ไม่มีการจับคู่ยืนยันแล้ว → member_kind 'unknown' และไม่ผูกพนักงาน (ของเดิมไม่พัง)", async () => {
    const store = baseStore(); // chat_members ไม่ตั้งค่า → ไม่มีที่ยืนยันแล้ว
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("unknown");
    expect((member?.row as Record<string, unknown>).employee_id).toBeUndefined();
  });

  it("line_user เป็นลูกค้าที่รู้จัก (line_users ผูก customer) → คง 'customer' ไม่สืบทอดพนักงาน", async () => {
    const store = baseStore({
      line_users: { id: "lu-1", customer_id: "cust-9" },
      chat_members: { employee_id: "emp-7", member_kind: "accountant" },
    });
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("customer");
    expect((member?.row as Record<string, unknown>).employee_id).toBeUndefined();
  });

  it("Y1: แอดมินตั้งเป็น 'system' → ข้อความใหม่ (resolve unknown) ไม่เขียนทับ member_kind (คงป้ายเดิม)", async () => {
    const store = baseStore({ chat_members: { member_kind: "system", employee_id: null } });
    const res = await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    expect(res.status).toBe("stored");
    const member = store.upserts.find((u) => u.table === "chat_members");
    // ต้อง "ไม่ใส่" member_kind ลง payload → upsert จะคงค่า 'system' เดิม (ไม่ downgrade เป็น unknown)
    expect((member?.row as Record<string, unknown>).member_kind).toBeUndefined();
  });

  it("Y1: แอดมินตั้งเป็น 'customer' (ไม่มี employee) → ไม่ถูก revert เป็น unknown", async () => {
    const store = baseStore({ chat_members: { member_kind: "customer", employee_id: null } });
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect((member?.row as Record<string, unknown>).member_kind).toBeUndefined();
  });

  it("Y1: สมาชิกใหม่ (ไม่มีแถวเดิม) resolve unknown → ยังใส่ member_kind 'unknown' ตามปกติ", async () => {
    const store = baseStore(); // chat_members ไม่ตั้งค่า → ไม่มีแถวเดิม
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("unknown");
  });

  it("idempotent: สืบทอดซ้ำได้ผลเดิม (เรียก 2 ครั้ง employee_id คงเดิม)", async () => {
    const mk = () => baseStore({ chat_members: { employee_id: "emp-7", member_kind: "accountant" } });
    const s1 = mk();
    await ingestGroupMessage({ db: makeDb(s1), now: NOW }, "t-1", "care", groupTextEvent());
    const s2 = mk();
    await ingestGroupMessage({ db: makeDb(s2), now: NOW }, "t-1", "care", groupTextEvent());
    expect(s1.upserts.find((u) => u.table === "chat_members")?.row.employee_id).toBe("emp-7");
    expect(s2.upserts.find((u) => u.table === "chat_members")?.row.employee_id).toBe("emp-7");
  });
});

describe("ingestGroupMessage — match นักบัญชีที่ลงทะเบียน QR (employees.line_user_id, 0038)", () => {
  it("sender line_user_id ตรง employees.line_user_id → ผูก employee ทันที + member_kind accountant", async () => {
    // ไม่รู้จักใน line_users, ไม่มี chat_members ยืนยัน — แต่เป็นพนักงานที่ลงทะเบียนแล้ว
    const store = baseStore({ employees: { id: "emp-reg" } });
    const res = await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    expect(res.status).toBe("stored");
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.employee_id).toBe("emp-reg");
    expect(member?.row.member_kind).toBe("accountant");
  });

  it("ไม่มี employees ที่ลงทะเบียน → ตกไปใช้ทางเดิม (unknown) ไม่พังของเดิม", async () => {
    const store = baseStore(); // employees ไม่ตั้งค่า
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("unknown");
    expect((member?.row as Record<string, unknown>).employee_id).toBeUndefined();
  });

  it("เป็นลูกค้า (line_users ผูก customer) → คง customer ไม่ผูกพนักงาน แม้มี employees match", async () => {
    const store = baseStore({
      line_users: { id: "lu-1", customer_id: "cust-9" },
      employees: { id: "emp-reg" },
    });
    await ingestGroupMessage({ db: makeDb(store), now: NOW }, "t-1", "care", groupTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member?.row.member_kind).toBe("customer");
    expect((member?.row as Record<string, unknown>).employee_id).toBeUndefined();
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

describe("ingestGroupMessage — fetch-if-missing ชื่อกลุ่ม (display_name_enc)", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("กลุ่มยังไม่มีชื่อ (display_name_enc null) + มีคีย์ → ดึงชื่อ + เก็บ ciphertext (ถอดได้ = ชื่อจริง)", async () => {
    const store = baseStore(); // chat_groups: { id, customer_id:null } → ไม่มี display_name_enc
    const client = clientWithSummary("บจ.นอร่า299 [สนง.บัญชี Finovas]");
    const res = await ingestGroupMessage({ db: makeDb(store), client, now: NOW }, "t-1", "care", groupTextEvent());
    expect(res.status).toBe("stored");
    expect(client.summaryCalls).toBe(1);

    const upd = store.updates.find(
      (u) => u.table === "chat_groups" && "display_name_enc" in u.payload
    );
    expect(upd).toBeDefined();
    const enc = upd!.payload.display_name_enc as string;
    expect(enc.startsWith("v1:")).toBe(true);
    // ★ ไม่มี plaintext ชื่อกลุ่มหลงเหลือใน payload
    expect(JSON.stringify(upd!.payload)).not.toContain("นอร่า");
    // ถอดกลับได้เป็นชื่อจริง
    expect(decryptField(enc)).toBe("บจ.นอร่า299 [สนง.บัญชี Finovas]");
  });

  it("กลุ่มมีชื่อแล้ว (display_name_enc ไม่ null) → skip ไม่ยิง getGroupSummary (ไม่ยิงซ้ำทุกข้อความ)", async () => {
    const store = baseStore({ chat_groups: { id: "g-1", customer_id: null, display_name_enc: "v1:existing.abc.def" } });
    const client = clientWithSummary("ชื่อใหม่");
    await ingestGroupMessage({ db: makeDb(store), client, now: NOW }, "t-1", "care", groupTextEvent());
    expect(client.summaryCalls).toBe(0);
    const upd = store.updates.find((u) => u.table === "chat_groups" && "display_name_enc" in u.payload);
    expect(upd).toBeUndefined();
  });

  it("ไม่มีคีย์เข้ารหัส → ไม่ดึง/ไม่เก็บชื่อกลุ่ม (ตาม pattern เดิม)", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const store = baseStore();
    const client = clientWithSummary("บจ.นอร่า299");
    await ingestGroupMessage({ db: makeDb(store), client, now: NOW }, "t-1", "care", groupTextEvent());
    expect(client.summaryCalls).toBe(0);
    expect(store.updates.find((u) => u.table === "chat_groups")).toBeUndefined();
  });

  it("getGroupSummary คืน null (ดึงไม่ได้) → ไม่ throw, ไม่เขียน display_name_enc (คงว่างไว้)", async () => {
    const store = baseStore();
    const client = clientWithSummary(null);
    const res = await ingestGroupMessage({ db: makeDb(store), client, now: NOW }, "t-1", "care", groupTextEvent());
    expect(res.status).toBe("stored"); // ingest ยังทำงานปกติ
    expect(store.updates.find((u) => u.table === "chat_groups" && "display_name_enc" in u.payload)).toBeUndefined();
  });

  it("room → ไม่ยิง getGroupSummary (LINE ไม่มี summary API สำหรับ room)", async () => {
    const store = baseStore({ chat_groups: null });
    const client = clientWithSummary("ชื่อห้อง");
    await ingestGroupMessage(
      { db: makeDb(store), client, now: NOW },
      "t-1",
      "care",
      groupTextEvent({ source: { type: "room", roomId: "Rroom1", userId: "Uabc" } })
    );
    expect(client.summaryCalls).toBe(0);
  });
});

describe("ingestGroupJoin — บอทถูกเชิญเข้ากลุ่ม → สร้างกลุ่ม + ดึงชื่อทันที", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  function joinEvent(overrides: Partial<QueuedLineEvent> = {}): QueuedLineEvent {
    return {
      type: "join",
      timestamp: Date.parse("2026-07-18T09:59:00Z"),
      source: { type: "group", groupId: "Cnew1" },
      ...overrides,
    };
  }

  it("กลุ่มใหม่ → insert chat_groups + ดึงชื่อเก็บ ciphertext", async () => {
    const store = baseStore({ chat_groups: null }); // ยังไม่มีกลุ่มนี้
    const client = clientWithSummary("บจ.ทดสอบ");
    const res = await ingestGroupJoin({ db: makeDb(store), client, now: NOW }, "t-1", "care", joinEvent());
    expect(res.status).toBe("created");
    // สร้างกลุ่มใหม่ (insert ไม่ใช่ upsert — กันทับ flag)
    const grp = store.inserts.find((i) => i.table === "chat_groups");
    expect(grp?.rows[0].group_ref).toBe("Cnew1");
    // ดึงชื่อ + เก็บ ciphertext
    expect(client.summaryCalls).toBe(1);
    const upd = store.updates.find((u) => u.table === "chat_groups" && "display_name_enc" in u.payload);
    expect(upd).toBeDefined();
    expect(decryptField(upd!.payload.display_name_enc as string)).toBe("บจ.ทดสอบ");
  });

  it("กลุ่มเก่าที่มีชื่ออยู่แล้ว → ไม่ยิง getGroupSummary ซ้ำ", async () => {
    const store = baseStore({ chat_groups: { id: "g-1", customer_id: null, display_name_enc: "v1:x.y.z" } });
    const client = clientWithSummary("ชื่อใหม่");
    const res = await ingestGroupJoin({ db: makeDb(store), client, now: NOW }, "t-1", "care", joinEvent());
    expect(res.status).toBe("created");
    expect(client.summaryCalls).toBe(0);
  });

  it("ไม่ใช่กลุ่ม/ห้อง (source.type=user) → skip", async () => {
    const store = baseStore();
    const res = await ingestGroupJoin(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      joinEvent({ source: { type: "user", userId: "Uabc" } })
    );
    expect(res.status).toBe("skipped");
  });
});

/* =====================================================================
 * ingestDirectMessage (Phase A) — เก็บแชต 1-1 ฝั่งลูกค้า (group_kind='user')
 *   ★ กันปน: member_kind='customer' เสมอ, ห้ามผูก employee, group_ref = userId
 * ===================================================================== */

/** client ปลอมที่คืนโปรไฟล์ผู้ใช้ 1-1 (getProfile) */
function clientWithProfile(displayName: string | null): LineClient {
  return {
    oa: "care" as LineOa,
    async push() {
      return { ok: true };
    },
    async reply() {
      return { ok: true };
    },
    async getProfile(userId) {
      return displayName ? { userId, displayName } : { userId };
    },
    async getGroupMemberProfile() {
      return null;
    },
    async getGroupSummary() {
      return null;
    },
  };
}

function directTextEvent(overrides: Partial<QueuedLineEvent> = {}): QueuedLineEvent {
  return {
    type: "message",
    timestamp: Date.parse("2026-07-18T09:59:00Z"),
    source: { type: "user", userId: "Ucust1" },
    message: { id: "dm-1", type: "text", contentEnc: "v1:enc.dm.one" },
    ...overrides,
  };
}

describe("ingestDirectMessage (แชต 1-1 ฝั่งลูกค้า)", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    delete process.env.CREDENTIAL_ENC_KEY;
  });

  it("1-1 ใหม่ → insert chat_groups group_kind='user' + group_ref=userId (ไม่ upsert)", async () => {
    const store = baseStore({ chat_groups: null });
    const res = await ingestDirectMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      directTextEvent()
    );
    expect(res.status).toBe("stored");
    const grp = store.inserts.find((i) => i.table === "chat_groups");
    expect(grp).toBeDefined();
    expect(grp!.rows[0].group_kind).toBe("user");
    expect(grp!.rows[0].group_ref).toBe("Ucust1");
    // ห้าม upsert chat_groups (กันทับ flag)
    expect(store.upserts.find((u) => u.table === "chat_groups")).toBeUndefined();
  });

  it("member ถูกบังคับเป็น 'customer' และไม่มี employee_id เสมอ", async () => {
    // แม้ line_users จะไม่ผูกลูกค้า (customer_id null) ก็ต้องเป็น customer
    const store = baseStore({ line_users: { id: "lu-1", customer_id: null } });
    await ingestDirectMessage({ db: makeDb(store), now: NOW }, "t-1", "care", directTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member).toBeDefined();
    expect(member!.row.member_kind).toBe("customer");
    expect(member!.row.employee_id).toBeUndefined();
    expect(member!.row.line_user_ref).toBe("lu-1");
  });

  it("★ ห้ามผูก employee แม้ line_user_id ตรงกับ employees (นี่คือฝั่งลูกค้า)", async () => {
    // employees table มีแถวที่ line_user_id ตรง — แต่ ingestDirectMessage ต้องไม่ query/ผูก
    const store = baseStore({
      line_users: null,
      employees: { id: "emp-99" }, // ถ้าเผลอ resolve employee จะได้ค่านี้
    });
    await ingestDirectMessage({ db: makeDb(store), now: NOW }, "t-1", "care", directTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    expect(member!.row.member_kind).toBe("customer");
    expect(member!.row.employee_id).toBeUndefined();
  });

  it("เก็บข้อความ content_enc (ciphertext) sender=userId ไม่มี plaintext", async () => {
    const store = baseStore({ chat_groups: { id: "g-dm", customer_id: null } });
    const res = await ingestDirectMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      directTextEvent()
    );
    expect(res.status).toBe("stored");
    const msg = store.inserts.find((i) => i.table === "chat_messages");
    const row = msg!.rows[0];
    expect(row.content_enc).toBe("v1:enc.dm.one");
    expect(row.sender_line_user_id).toBe("Ucust1");
    expect(row.raw_meta).toMatchObject({ source_type: "user" });
    expect(JSON.stringify(row.raw_meta)).not.toContain("v1:enc");
  });

  it("resolve ลูกค้าที่รู้จัก → คืน customerId ใน result", async () => {
    const store = baseStore({
      chat_groups: { id: "g-dm", customer_id: null },
      line_users: { id: "lu-1", customer_id: "cust-7" },
    });
    const res = await ingestDirectMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      directTextEvent()
    );
    expect(res.status).toBe("stored");
    if (res.status === "stored") expect(res.customerId).toBe("cust-7");
  });

  it("ชื่อโปรไฟล์ (getProfile) → เก็บ display_name_enc เป็น ciphertext (ถอดกลับได้)", async () => {
    const store = baseStore({ chat_groups: { id: "g-dm", customer_id: null } });
    const client = clientWithProfile("คุณลูกค้า A");
    await ingestDirectMessage({ db: makeDb(store), client, now: NOW }, "t-1", "care", directTextEvent());
    const member = store.upserts.find((u) => u.table === "chat_members");
    const enc = member!.row.display_name_enc as string;
    expect(enc).toBeDefined();
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptField(enc)).toBe("คุณลูกค้า A");
  });

  it("ไม่มี userId → skip (degrade ไม่ throw)", async () => {
    const store = baseStore();
    const res = await ingestDirectMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      directTextEvent({ source: { type: "user" } })
    );
    expect(res.status).toBe("skipped");
  });

  it("idempotency: line_message_id ซ้ำ → duplicate ไม่ insert ซ้ำ", async () => {
    const store = baseStore({
      chat_groups: { id: "g-dm", customer_id: null },
      chat_messages: { id: "existing-dm" },
    });
    const res = await ingestDirectMessage(
      { db: makeDb(store), now: NOW },
      "t-1",
      "care",
      directTextEvent()
    );
    expect(res.status).toBe("duplicate");
    expect(store.inserts.find((i) => i.table === "chat_messages")).toBeUndefined();
  });
});
