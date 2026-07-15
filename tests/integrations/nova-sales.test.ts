import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  checkNovaSalesAuth,
  checkTenantAllowed,
  customerUpsertSchema,
  dealStatusSchema,
  dealStatusToSurveyType,
  dealInvitationIdempotencyKey,
  dealCyclePeriod,
  AUTH_HEADER,
} from "@/lib/integrations/nova-sales";

const TENANT = "11111111-1111-1111-1111-111111111111";

function headersWith(key?: string): Headers {
  const h = new Headers();
  if (key !== undefined) h.set(AUTH_HEADER, key);
  return h;
}

describe("nova-sales — auth", () => {
  it("constantTimeEqual: ตรง/ไม่ตรง/ยาวต่างกัน", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "sekret")).toBe(false);
    expect(constantTimeEqual("secret", "sec")).toBe(false);
  });

  it("env ไม่ตั้ง → 503", () => {
    const r = checkNovaSalesAuth(headersWith("x"), undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it("ไม่มี header / key ผิด → 401", () => {
    expect(checkNovaSalesAuth(headersWith(), "secret").ok).toBe(false);
    const r = checkNovaSalesAuth(headersWith("wrong"), "secret");
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("key ตรง → ok", () => {
    expect(checkNovaSalesAuth(headersWith("secret"), "secret").ok).toBe(true);
  });
});

describe("nova-sales — checkTenantAllowed (API key ↔ tenant)", () => {
  it("allowlist ตั้งไว้ + tenant ตรง → ผ่าน", () => {
    expect(checkTenantAllowed(TENANT, TENANT)).toBe(true);
  });
  it("allowlist ตั้งไว้ + tenant ไม่ตรง → reject", () => {
    expect(checkTenantAllowed("22222222-2222-2222-2222-222222222222", TENANT)).toBe(false);
  });
  it("ไม่ตั้ง allowlist (dev) → ผ่าน", () => {
    expect(checkTenantAllowed(TENANT, undefined)).toBe(true);
  });
});

describe("nova-sales — customerUpsertSchema", () => {
  it("ผ่านเมื่อครบขั้นต่ำ (tenant_id + name)", () => {
    const r = customerUpsertSchema.safeParse({
      tenant_id: TENANT,
      name: "บริษัท ก",
      external_customer_id: "NS-1",
    });
    expect(r.success).toBe(true);
  });
  it("ไม่ผ่านเมื่อขาด name", () => {
    expect(customerUpsertSchema.safeParse({ tenant_id: TENANT }).success).toBe(false);
  });
  it("ไม่ผ่านเมื่อ tenant_id ไม่ใช่ uuid", () => {
    expect(
      customerUpsertSchema.safeParse({ tenant_id: "x", name: "ก" }).success
    ).toBe(false);
  });
});

describe("nova-sales — dealStatusSchema + mapping", () => {
  it("ผ่านเมื่อ status valid + external_deal_id", () => {
    const r = dealStatusSchema.safeParse({
      tenant_id: TENANT,
      external_deal_id: "D-1",
      customer_code: "C-0001",
      status: "won",
      amount: 30000,
    });
    expect(r.success).toBe(true);
  });
  it("ไม่ผ่านเมื่อ status ไม่รู้จัก", () => {
    const r = dealStatusSchema.safeParse({
      tenant_id: TENANT,
      external_deal_id: "D-1",
      status: "pending",
    });
    expect(r.success).toBe(false);
  });

  it("won→C, lost→D, open→null", () => {
    expect(dealStatusToSurveyType("won")).toBe("C");
    expect(dealStatusToSurveyType("lost")).toBe("D");
    expect(dealStatusToSurveyType("open")).toBeNull();
  });

  it("idempotency key + cycle period คงที่ต่อดีล", () => {
    expect(dealInvitationIdempotencyKey("D-1", "C")).toBe("nova-sales:deal:D-1:C");
    expect(dealCyclePeriod("D-1")).toBe("deal:D-1");
  });
});
