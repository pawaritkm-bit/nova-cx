import { describe, it, expect } from "vitest";
import { validateLoginInput, loginErrorMessage } from "@/lib/auth/login";

describe("lib/auth/login — validateLoginInput", () => {
  it("ผ่านเมื่ออีเมล+รหัสผ่านครบและอีเมลถูกฟอร์แมต", () => {
    expect(validateLoginInput("exec@finovas.demo", "secret123")).toEqual({
      ok: true,
    });
  });

  it("ปฏิเสธเมื่อไม่กรอกอีเมล", () => {
    const r = validateLoginInput("   ", "secret123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("อีเมล");
  });

  it("ปฏิเสธเมื่ออีเมลผิดฟอร์แมต", () => {
    const r = validateLoginInput("not-an-email", "secret123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ถูกต้อง");
  });

  it("ปฏิเสธเมื่อไม่กรอกรหัสผ่าน", () => {
    const r = validateLoginInput("exec@finovas.demo", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("รหัสผ่าน");
  });
});

describe("lib/auth/login — loginErrorMessage (ไม่รั่วรายละเอียดภายใน)", () => {
  it("credentials ผิด → ข้อความสุภาพ", () => {
    expect(loginErrorMessage("Invalid login credentials")).toBe(
      "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
    );
  });

  it("อีเมลยังไม่ยืนยัน → แจ้งให้ติดต่อผู้ดูแล", () => {
    expect(loginErrorMessage("Email not confirmed")).toContain("ยืนยันอีเมล");
  });

  it("error อื่น → ข้อความกลางไม่เปิดเผยระบบภายใน", () => {
    expect(loginErrorMessage("some internal db failure xyz")).toBe(
      "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
    );
  });
});
