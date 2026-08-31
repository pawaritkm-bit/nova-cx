import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSupabaseEnv, hasSupabaseEnv, getSmtpConfig, hasSmtpConfig } from "@/lib/env";

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

/** getSmtpConfig — wishlist ข้อ 6 (ส่งสลิปเงินเดือนทางอีเมล) — SMTP ของบริษัทเอง, inert-by-default */
describe("lib/env — getSmtpConfig / hasSmtpConfig", () => {
  const original = { ...process.env };
  const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const;

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("ไม่ตั้ง env เลย → null (ไม่ throw, ปิดฟีเจอร์)", () => {
    expect(getSmtpConfig()).toBeNull();
    expect(hasSmtpConfig()).toBe(false);
  });

  it("ขาดตัวใดตัวหนึ่ง (เช่น password) → null", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    expect(getSmtpConfig()).toBeNull();
  });

  it("PORT ไม่ใช่ตัวเลข → null", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "abc";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASSWORD = "secret";
    expect(getSmtpConfig()).toBeNull();
  });

  it("ครบทุกตัว → คืน config, secure default false, from fallback = user", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASSWORD = "secret";
    const cfg = getSmtpConfig();
    expect(cfg).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user@example.com",
      password: "secret",
      from: "user@example.com",
    });
    expect(hasSmtpConfig()).toBe(true);
  });

  it("SMTP_SECURE=true + SMTP_FROM ตั้งไว้ → ใช้ค่าที่ตั้ง", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SMTP_FROM = "payroll@example.com";
    const cfg = getSmtpConfig();
    expect(cfg?.secure).toBe(true);
    expect(cfg?.from).toBe("payroll@example.com");
  });
});
