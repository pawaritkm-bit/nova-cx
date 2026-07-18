import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveOaTenantId, trimLineEvent, toQueuedEvent } from "@/lib/line/webhook";
import { makeStore, makeDb } from "./fake-db";

/**
 * resolveOaTenantId — OA→tenant mapping (Phase 0)
 *   ลำดับ: chat_channels (channel_ref) → env LINE_TENANT_ID → tenant แรก
 *   ต้องไม่ทำ webhook เดิมพัง: หา mapping ไม่เจอ = degrade ลง fallback เดิม
 */
describe("resolveOaTenantId", () => {
  const prevEnv = process.env.LINE_TENANT_ID;

  beforeEach(() => {
    // ไม่ให้ env override มาบังพฤติกรรม fallback ที่กำลังทดสอบ
    delete process.env.LINE_TENANT_ID;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.LINE_TENANT_ID;
    else process.env.LINE_TENANT_ID = prevEnv;
    vi.restoreAllMocks();
  });

  it("พบ mapping ใน chat_channels → คืน tenant ของ channel นั้น (แม้มีหลาย tenant)", async () => {
    const store = makeStore({
      chat_channels: { tenant_id: "T-MAPPED" },
      tenants: [{ id: "T-FIRST" }, { id: "T-SECOND" }],
    });
    const tenantId = await resolveOaTenantId(makeDb(store), "care", "Ubot123");
    expect(tenantId).toBe("T-MAPPED");
  });

  it("ไม่พบ mapping → fallback ไป tenant แรก (webhook เดิมไม่พัง)", async () => {
    const store = makeStore({
      chat_channels: null,
      tenants: [{ id: "T-FIRST" }],
    });
    const tenantId = await resolveOaTenantId(makeDb(store), "care", "Uunknown");
    expect(tenantId).toBe("T-FIRST");
  });

  it("ไม่ส่ง channelRef → ข้าม chat_channels แล้ว fallback tenant แรก", async () => {
    const store = makeStore({ tenants: [{ id: "T-FIRST" }] });
    const tenantId = await resolveOaTenantId(makeDb(store), "sale");
    expect(tenantId).toBe("T-FIRST");
  });

  it("ไม่มี tenant เลย → null", async () => {
    const store = makeStore({ chat_channels: null, tenants: [] });
    const tenantId = await resolveOaTenantId(makeDb(store), "care", "Uany");
    expect(tenantId).toBeNull();
  });

  it("env LINE_TENANT_ID ใช้เมื่อไม่พบ mapping (fallback ก่อน tenant แรก)", async () => {
    process.env.LINE_TENANT_ID = "T-ENV";
    const store = makeStore({
      chat_channels: null,
      tenants: [{ id: "T-FIRST" }],
    });
    const tenantId = await resolveOaTenantId(makeDb(store), "care", "Uunknown");
    expect(tenantId).toBe("T-ENV");
  });
});

/**
 * trimLineEvent + toQueuedEvent — เตรียม event ก่อนเข้าคิว
 *   ★ follow/unfollow เดิมต้องไม่พัง; message ต้องเข้ารหัสก่อนเก็บ (ไม่มี plaintext ในคิว)
 */
describe("trimLineEvent (follow/unfollow เดิมไม่พัง)", () => {
  it("follow → เก็บ type + source.userId (เหมือนเดิม)", () => {
    const trimmed = trimLineEvent({
      type: "follow",
      timestamp: 1000,
      source: { type: "user", userId: "Uxyz" },
    });
    expect(trimmed.type).toBe("follow");
    expect(trimmed.source?.userId).toBe("Uxyz");
    expect(trimmed.message).toBeUndefined();
  });

  it("message group → เก็บ message.id/type/text + groupId ไว้ส่งต่อ handler", () => {
    const trimmed = trimLineEvent({
      type: "message",
      source: { type: "group", groupId: "Cg1", userId: "Uabc" },
      message: { id: "m1", type: "text", text: "ยอดเดือนนี้" },
    });
    expect(trimmed.source?.groupId).toBe("Cg1");
    expect(trimmed.message?.id).toBe("m1");
    expect(trimmed.message?.text).toBe("ยอดเดือนนี้");
  });
});

describe("toQueuedEvent (เข้ารหัสก่อนเก็บ — ไม่มี plaintext ในคิว)", () => {
  const fakeEncrypt = (s: string) => `ENC(${s.length})`;

  it("message text + มีคีย์ → contentEnc = ciphertext, ตัด plaintext ทิ้ง", () => {
    const trimmed = trimLineEvent({
      type: "message",
      source: { type: "group", groupId: "Cg1", userId: "Uabc" },
      message: { id: "m1", type: "text", text: "ความลับ" },
    });
    const queued = toQueuedEvent(trimmed, fakeEncrypt);
    expect(queued.message?.contentEnc).toBe(fakeEncrypt("ความลับ"));
    // ★ ต้องไม่มี plaintext หลงเหลือใน object ที่จะเก็บลงคิว
    expect(JSON.stringify(queued)).not.toContain("ความลับ");
    expect((queued.message as Record<string, unknown>).text).toBeUndefined();
  });

  it("message text + ไม่มีคีย์ (encrypt=null) → ตัด text ทิ้ง (encSkipped) ไม่เก็บ plaintext", () => {
    const trimmed = trimLineEvent({
      type: "message",
      source: { type: "group", groupId: "Cg1", userId: "Uabc" },
      message: { id: "m1", type: "text", text: "ความลับ" },
    });
    const queued = toQueuedEvent(trimmed, null);
    expect(queued.message?.contentEnc).toBeNull();
    expect(queued.message?.encSkipped).toBe(true);
    expect(JSON.stringify(queued)).not.toContain("ความลับ");
  });

  it("follow → ไม่มี message เลย (ผ่านคิวได้เหมือนเดิม)", () => {
    const trimmed = trimLineEvent({ type: "follow", source: { userId: "Uxyz" } });
    const queued = toQueuedEvent(trimmed, fakeEncrypt);
    expect(queued.type).toBe("follow");
    expect(queued.source?.userId).toBe("Uxyz");
    expect(queued.message).toBeUndefined();
  });
});
