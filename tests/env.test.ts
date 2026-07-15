import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSupabaseEnv, hasSupabaseEnv } from "@/lib/env";

describe("lib/env — getSupabaseEnv / hasSupabaseEnv", () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("คืน null เมื่อไม่มี env (deny-friendly, ไม่ throw)", () => {
    expect(getSupabaseEnv()).toBeNull();
    expect(hasSupabaseEnv()).toBe(false);
  });

  it("คืน config เมื่อมี url + anon key ครบ", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const env = getSupabaseEnv();
    expect(env).not.toBeNull();
    expect(env?.url).toBe("https://x.supabase.co");
    expect(env?.anonKey).toBe("anon-key");
    expect(env?.serviceRoleKey).toBeUndefined();
    expect(hasSupabaseEnv()).toBe(true);
  });

  it("คืน null เมื่อมี url แต่ขาด anon key", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    expect(getSupabaseEnv()).toBeNull();
  });

  it("แนบ serviceRoleKey เมื่อมี", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    expect(getSupabaseEnv()?.serviceRoleKey).toBe("service-key");
  });
});
