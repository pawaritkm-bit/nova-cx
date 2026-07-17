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

  it("หน้า /dashboard และ /admin เป็น protected (ต้อง login)", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/dashboard/anything")).toBe(true);
    expect(isProtectedPath("/admin")).toBe(true);
    expect(isProtectedPath("/admin/teams")).toBe(true);
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/api/dashboard/executive")).toBe(false);
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
