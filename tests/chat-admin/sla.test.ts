import { describe, it, expect } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { createSlaRule, updateSlaRule, deleteSlaRule, setSlaRuleActive } from "@/lib/chat-admin/sla";
import type { SlaRuleInput } from "@/lib/chat-admin/schema";

const T = "tenant-1";
const RULE = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";

const baseInput: SlaRuleInput = {
  name: "ขอเอกสาร (VIP)",
  customer_type: "VIP",
  urgency: "high",
  work_type: "ขอเอกสาร",
  team_id: undefined,
  first_response_minutes: 30,
  resolution_minutes: 240,
  priority: 200,
  is_active: true,
};

describe("createSlaRule — inject tenant + payload ครบ", () => {
  it("insert payload มี tenant_id จาก session + คืน id", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "sla_rules" && q.op === "insert" && q.terminal === "single") return { data: { id: RULE } };
      return { data: null };
    }, cap);
    const out = await createSlaRule(db, T, baseInput);
    expect(out.id).toBe(RULE);
    const ins = cap.inserts.find((i) => i.table === "sla_rules") as { payload: Record<string, unknown> };
    expect(ins.payload.tenant_id).toBe(T);
    expect(ins.payload.first_response_minutes).toBe(30);
    expect(ins.payload.priority).toBe(200);
  });

  it("team_id นอก tenant → throw ก่อน insert", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "teams" && q.terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);
    await expect(createSlaRule(db, T, { ...baseInput, team_id: TEAM })).rejects.toThrow(/ทีม/);
    expect(cap.inserts.length).toBe(0);
  });
});

describe("updateSlaRule — ไม่แก้ tenant_id + assertAffected", () => {
  it("พบ 1 แถว → payload ไม่มี tenant_id", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "sla_rules" && q.op === "update") return { data: [{ id: RULE }] };
      return { data: null };
    }, cap);
    await updateSlaRule(db, T, RULE, baseInput);
    const upd = cap.updates.find((u) => u.table === "sla_rules") as { payload: Record<string, unknown> };
    expect("tenant_id" in upd.payload).toBe(false);
    expect(upd.payload.name).toBe(baseInput.name);
  });

  it("0 แถว (id ผิด/ข้าม tenant) → throw", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ data: [] }), cap);
    await expect(updateSlaRule(db, T, RULE, baseInput)).rejects.toThrow(/ไม่พบเงื่อนไข/);
  });
});

describe("deleteSlaRule / setSlaRuleActive — soft-delete + toggle", () => {
  it("deleteSlaRule พบ → set deleted_at", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ data: [{ id: RULE }] }), cap);
    await deleteSlaRule(db, T, RULE);
    const upd = cap.updates.find((u) => u.table === "sla_rules") as { payload: Record<string, unknown> };
    expect(upd.payload.deleted_at).toBeTruthy();
  });

  it("deleteSlaRule 0 แถว → throw", async () => {
    const { db } = makeFakeDb(() => ({ data: [] }));
    await expect(deleteSlaRule(db, T, RULE)).rejects.toThrow(/ไม่พบเงื่อนไข/);
  });

  it("setSlaRuleActive → update is_active", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ data: [{ id: RULE }] }), cap);
    await setSlaRuleActive(db, T, RULE, false);
    const upd = cap.updates.find((u) => u.table === "sla_rules") as { payload: Record<string, unknown> };
    expect(upd.payload.is_active).toBe(false);
  });
});
