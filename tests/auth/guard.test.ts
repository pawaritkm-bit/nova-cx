import { describe, it, expect } from "vitest";
import {
  isPublicPath,
  isProtectedPath,
  isStaticPath,
  shouldRedirectToLogin,
} from "@/lib/auth/guard";

describe("lib/auth/guard — เส้นทางสาธารณะ/ป้องกัน", () => {
  it("เส้นทาง static ถูกมองเป็น public", () => {
    expect(isStaticPath("/_next/static/chunk.js")).toBe(true);
    expect(isStaticPath("/favicon.ico")).toBe(true);
    expect(isStaticPath("/logo.svg")).toBe(true);
    expect(isStaticPath("/dashboard")).toBe(false);
  });

  it("LIFF/survey/integration/cron/health/line เป็น public (ห้าม redirect)", () => {
    for (const p of [
      "/login",
      "/liff/survey",
      "/api/liff/survey",
      "/api/survey/submit",
      "/api/integrations/nova-sales/customer",
      "/api/cron/scan-invitations",
      "/api/health",
      "/api/line/webhook",
    ]) {
      expect(isPublicPath(p), `${p} ต้องเป็น public`).toBe(true);
    }
  });

  it("หน้าหลังบ้าน (dashboard/admin/cases/reports/surveys/settings) เป็น protected", () => {
    for (const p of [
      "/dashboard",
      "/dashboard/anything",
      "/admin",
      "/admin/teams",
      "/cases",
      "/cases?level=critical",
      "/reports",
      "/surveys",
      "/settings",
    ]) {
      // ตัด query string ออกก่อน (middleware ส่ง pathname ล้วน) — เทียบเฉพาะ path
      const path = p.split("?")[0];
      expect(isProtectedPath(path), `${path} ต้อง protected`).toBe(true);
    }
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/api/dashboard/executive")).toBe(false);
    // ★ /api/reports/export ต้องไม่ถูกจับเป็น protected (API gate สิทธิ์เอง)
    expect(isProtectedPath("/api/reports/export")).toBe(false);
  });
});

describe("lib/auth/guard — shouldRedirectToLogin", () => {
  it("ไม่มี session + เข้า /dashboard → ต้อง redirect", () => {
    expect(shouldRedirectToLogin("/dashboard", false)).toBe(true);
    expect(shouldRedirectToLogin("/dashboard/x", false)).toBe(true);
  });

  it("มี session + เข้า /dashboard → ไม่ redirect", () => {
    expect(shouldRedirectToLogin("/dashboard", true)).toBe(false);
  });

  it("ไม่มี session แต่เป็น public/ไม่ใช่ protected → ไม่ redirect", () => {
    expect(shouldRedirectToLogin("/login", false)).toBe(false);
    expect(shouldRedirectToLogin("/", false)).toBe(false);
    expect(shouldRedirectToLogin("/api/liff/survey", false)).toBe(false);
    expect(shouldRedirectToLogin("/api/dashboard/executive", false)).toBe(false);
  });
});
