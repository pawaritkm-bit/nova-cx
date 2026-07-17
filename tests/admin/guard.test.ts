import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAdminRole,
  resolveAdminContext,
  requireAdminContext,
  AdminAuthError,
} from "@/lib/admin/guard";

/**
 * fake db เท่าที่ resolveAdminContext ใช้:
 *   auth.getUser() + from("users").select().eq().is().maybeSingle()
 */
function fakeDb(opts: {
  user: { id: string } | null;
  row?: { tenant_id?: string | null; roles?: unknown } | null;
  throwOnAuth?: boolean;
}): SupabaseClient {
  const builder = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    is() {
      return this;
    },
    async maybeSingle() {
      return { data: opts.row === undefined ? null : opts.row };
    },
  };
  return {
    auth: {
      async getUser() {
        if (opts.throwOnAuth) throw new Error("no auth");
        return { data: { user: opts.user } };
      },
    },
    from() {
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("isAdminRole — allow-list (default deny)", () => {
  it("admin / executive → true", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("executive")).toBe(true);
  });
  it("บทบาทอื่น → false", () => {
    for (const r of ["acc_lead", "accountant", "sales_lead", "sales", "cs"]) {
      expect(isAdminRole(r)).toBe(false);
    }
  });
  it("null / undefined / ค่ามั่ว → false (fail-closed)", () => {
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole("superadmin")).toBe(false);
    expect(isAdminRole("")).toBe(false);
  });
});

describe("resolveAdminContext", () => {
  it("admin + tenant → isAdmin true พร้อม tenantId/role", async () => {
    const res = await resolveAdminContext(
      fakeDb({ user: { id: "u1" }, row: { tenant_id: "t1", roles: { code: "admin" } } })
    );
    expect(res).toEqual({
      hasSession: true,
      role: "admin",
      tenantId: "t1",
      isAdmin: true,
    });
  });

  it("executive (roles เป็น array) → isAdmin true", async () => {
    const res = await resolveAdminContext(
      fakeDb({ user: { id: "u1" }, row: { tenant_id: "t1", roles: [{ code: "executive" }] } })
    );
    expect(res.isAdmin).toBe(true);
    expect(res.role).toBe("executive");
  });

  it("accountant → มี session แต่ isAdmin false", async () => {
    const res = await resolveAdminContext(
      fakeDb({ user: { id: "u1" }, row: { tenant_id: "t1", roles: { code: "accountant" } } })
    );
    expect(res.hasSession).toBe(true);
    expect(res.isAdmin).toBe(false);
    expect(res.role).toBe("accountant");
  });

  it("ไม่มี session → deny ทั้งหมด", async () => {
    const res = await resolveAdminContext(fakeDb({ user: null }));
    expect(res).toEqual({
      hasSession: false,
      role: null,
      tenantId: null,
      isAdmin: false,
    });
  });

  it("มี session แต่ไม่มี users row → hasSession true, isAdmin false", async () => {
    const res = await resolveAdminContext(fakeDb({ user: { id: "u1" }, row: null }));
    expect(res.hasSession).toBe(true);
    expect(res.isAdmin).toBe(false);
  });

  it("admin แต่ไม่มี tenant_id → ปฏิเสธ (isAdmin false)", async () => {
    const res = await resolveAdminContext(
      fakeDb({ user: { id: "u1" }, row: { tenant_id: null, roles: { code: "admin" } } })
    );
    expect(res.isAdmin).toBe(false);
  });

  it("auth throw → fail-closed (deny)", async () => {
    const res = await resolveAdminContext(fakeDb({ user: null, throwOnAuth: true }));
    expect(res.isAdmin).toBe(false);
    expect(res.hasSession).toBe(false);
  });
});

describe("requireAdminContext", () => {
  it("admin → คืน context", async () => {
    const ctx = await requireAdminContext(
      fakeDb({ user: { id: "u1" }, row: { tenant_id: "t1", roles: { code: "admin" } } })
    );
    expect(ctx).toEqual({ tenantId: "t1", role: "admin" });
  });

  it("บทบาทไม่ผ่าน → throw AdminAuthError", async () => {
    await expect(
      requireAdminContext(
        fakeDb({ user: { id: "u1" }, row: { tenant_id: "t1", roles: { code: "sales" } } })
      )
    ).rejects.toBeInstanceOf(AdminAuthError);
  });

  it("ไม่มี session → throw AdminAuthError", async () => {
    await expect(
      requireAdminContext(fakeDb({ user: null }))
    ).rejects.toBeInstanceOf(AdminAuthError);
  });
});
