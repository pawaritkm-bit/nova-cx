import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveOaTenantId } from "@/lib/line/webhook";
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
