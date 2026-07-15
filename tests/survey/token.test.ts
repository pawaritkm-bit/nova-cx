import { describe, it, expect } from "vitest";
import {
  generateInvitationToken,
  verifyInvitationAccess,
  accessReasonMessage,
} from "@/lib/survey/token";

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

describe("survey/token — generateInvitationToken", () => {
  it("สุ่ม + ยาวพอ (URL-safe base64url)", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("survey/token — verifyInvitationAccess", () => {
  it("ไม่พบ invitation = not_found", () => {
    const r = verifyInvitationAccess({ invitation: null });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("ตอบไปแล้ว = already_responded", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "responded", token_expires_at: future, line_user_id: null },
    });
    expect(r).toEqual({ ok: false, reason: "already_responded" });
  });

  it("หมดอายุ (token_expires_at ในอดีต) = expired", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "pending", token_expires_at: past, line_user_id: null },
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("status expired = expired", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "expired", token_expires_at: future, line_user_id: null },
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("คนอื่นเปิด (line_user ไม่ตรง) = forbidden", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "pending", token_expires_at: future, line_user_id: "owner-1" },
      requesterLineUserId: "intruder-2",
    });
    expect(r).toEqual({ ok: false, reason: "forbidden" });
  });

  it("dev mode ข้ามการตรวจเจ้าของ", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "pending", token_expires_at: future, line_user_id: "owner-1" },
      requesterLineUserId: "intruder-2",
      devMode: true,
    });
    expect(r.ok).toBe(true);
  });

  it("เจ้าของตรง = ok", () => {
    const r = verifyInvitationAccess({
      invitation: { status: "opened", token_expires_at: null, line_user_id: "owner-1" },
      requesterLineUserId: "owner-1",
    });
    expect(r.ok).toBe(true);
  });

  it("accessReasonMessage คืนข้อความไทยทุกสาเหตุ", () => {
    for (const reason of ["not_found", "already_responded", "expired", "forbidden"] as const) {
      expect(accessReasonMessage(reason)).toBeTypeOf("string");
    }
  });
});
