import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveViewer,
  dashboardViewForRole,
} from "@/lib/dashboard/session";

/**
 * fake Supabase client เท่าที่ resolveViewer ใช้:
 *   - auth.getUser()
 *   - from("users").select(...).eq(...).maybeSingle()
 * roleRel = shape ของ roles(code) ที่ join กลับมา (object หรือ array)
 */
function fakeDb(opts: {
  user: { id: string } | null;
  roleRel?: unknown;
  throwOnAuth?: boolean;
}): SupabaseClient {
  const builder = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: opts.roleRel === undefined ? null : { roles: opts.roleRel } };
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

describe("resolveViewer — บทบาทมาจาก session ก่อนเสมอ", () => {
  it("มี session + role (object shape) → fromSession=true, role ตาม DB", async () => {
    const v = await resolveViewer(
      fakeDb({ user: { id: "u1" }, roleRel: { code: "executive" } })
    );
    expect(v).toEqual({ role: "executive", fromSession: true, hasSession: true });
  });

  it("มี session + role (array shape) → อ่าน code ตัวแรกได้", async () => {
    const v = await resolveViewer(
      fakeDb({ user: { id: "u1" }, roleRel: [{ code: "sales_lead" }] })
    );
    expect(v.role).toBe("sales_lead");
    expect(v.fromSession).toBe(true);
  });

  it("★ session ชนะ param: มี session แล้ว ต่อให้ส่ง ?role=admin ก็ใช้ role จาก session", async () => {
    const v = await resolveViewer(
      fakeDb({ user: { id: "u1" }, roleRel: { code: "accountant" } }),
      "admin"
    );
    expect(v.role).toBe("accountant");
    expect(v.fromSession).toBe(true);
  });

  it("มี session แต่ไม่มี users row/บทบาท → hasSession=true, role=null", async () => {
    const v = await resolveViewer(
      fakeDb({ user: { id: "u1" }, roleRel: undefined })
    );
    expect(v).toEqual({ role: null, fromSession: false, hasSession: true });
  });

  it("ไม่มี session + ส่ง param ถูกต้อง (dev fallback) → role จาก param, fromSession=false", async () => {
    const v = await resolveViewer(fakeDb({ user: null }), "cs");
    expect(v).toEqual({ role: "cs", fromSession: false, hasSession: false });
  });

  it("ไม่มี session + param ไม่ถูกต้อง → role=null", async () => {
    const v = await resolveViewer(fakeDb({ user: null }), "not-a-role");
    expect(v.role).toBeNull();
    expect(v.hasSession).toBe(false);
  });

  it("auth ล้ม (throw) → ตกไป fallback param ได้ ไม่ crash", async () => {
    const v = await resolveViewer(
      fakeDb({ user: null, throwOnAuth: true }),
      "sales"
    );
    expect(v.role).toBe("sales");
    expect(v.hasSession).toBe(false);
  });
});

describe("dashboardViewForRole — map บทบาท → กลุ่มหน้า", () => {
  it("exec/admin/cs → exec", () => {
    expect(dashboardViewForRole("executive")).toBe("exec");
    expect(dashboardViewForRole("admin")).toBe("exec");
    expect(dashboardViewForRole("cs")).toBe("exec");
  });
  it("acc_lead/sales_lead → lead", () => {
    expect(dashboardViewForRole("acc_lead")).toBe("lead");
    expect(dashboardViewForRole("sales_lead")).toBe("lead");
  });
  it("accountant/sales → member", () => {
    expect(dashboardViewForRole("accountant")).toBe("member");
    expect(dashboardViewForRole("sales")).toBe("member");
  });
});
