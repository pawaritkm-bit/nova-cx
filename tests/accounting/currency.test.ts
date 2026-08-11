import { describe, it, expect } from "vitest";
import {
  isValidCurrencyCode,
  validateFxRate,
  fxRatePlausibilityWarning,
  deriveThbAmount,
  COMMON_CURRENCIES,
  DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE,
} from "@/lib/accounting/currency";

/**
 * currency.ts — เฟส 10 (docs/06-accounting-features-roadmap.md, 0.3/0.4/0.6/0.11) — building block ที่ทุก
 *   จุด derive/validate FX ใช้ร่วมกัน (T79)
 */

describe("isValidCurrencyCode", () => {
  it("ตัวพิมพ์ใหญ่ 3 ตัวอักษร → true", () => {
    expect(isValidCurrencyCode("USD")).toBe(true);
    expect(isValidCurrencyCode("EUR")).toBe(true);
  });
  it("ตัวพิมพ์เล็ก/สั้น-ยาวเกิน/มีตัวเลข/ว่าง/ไม่ใช่ string → false", () => {
    expect(isValidCurrencyCode("usd")).toBe(false);
    expect(isValidCurrencyCode("US")).toBe(false);
    expect(isValidCurrencyCode("USDD")).toBe(false);
    expect(isValidCurrencyCode("US1")).toBe(false);
    expect(isValidCurrencyCode("")).toBe(false);
    expect(isValidCurrencyCode(null)).toBe(false);
    expect(isValidCurrencyCode(undefined)).toBe(false);
    expect(isValidCurrencyCode(123)).toBe(false);
  });
});

describe("COMMON_CURRENCIES", () => {
  it("มีสกุลที่พบบ่อยครบ (~20 สกุล) และทุกรหัสผ่าน isValidCurrencyCode", () => {
    expect(COMMON_CURRENCIES.length).toBeGreaterThanOrEqual(15);
    for (const c of COMMON_CURRENCIES) {
      expect(isValidCurrencyCode(c.code)).toBe(true);
    }
  });
});

describe("validateFxRate — hard-block (0.11)", () => {
  it("ค่าปกติ → ผ่าน", () => {
    const r = validateFxRate(35.5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(35.5);
  });
  it("string ตัวเลขก็ผ่าน (parse ให้)", () => {
    const r = validateFxRate("36.75");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(36.75);
  });
  it("ขอบเขต: 100000 ผ่าน, 0.0001 ผ่าน", () => {
    expect(validateFxRate(100000).ok).toBe(true);
    expect(validateFxRate(0.0001).ok).toBe(true);
  });
  it("★ 0 / ลบ / เกิน 100000 / NaN / ไม่ใช่ตัวเลข → ปฏิเสธเสมอ (เทสต์บังคับ)", () => {
    expect(validateFxRate(0).ok).toBe(false);
    expect(validateFxRate(-1).ok).toBe(false);
    expect(validateFxRate(100001).ok).toBe(false);
    expect(validateFxRate(NaN).ok).toBe(false);
    expect(validateFxRate("abc").ok).toBe(false);
    expect(validateFxRate(null).ok).toBe(false);
    expect(validateFxRate(undefined).ok).toBe(false);
  });
});

describe("fxRatePlausibilityWarning — soft-warn (0.11)", () => {
  it("USD สูงผิดปกติ (พิมพ์เกินหลักสิบเท่า) → มีข้อความเตือน", () => {
    expect(fxRatePlausibilityWarning("USD", 3650)).not.toBeNull();
  });
  it("USD ค่าปกติ → null (ไม่เตือน)", () => {
    expect(fxRatePlausibilityWarning("USD", 36.5)).toBeNull();
  });
  it("★ สกุลที่ไม่มีในตารางอ้างอิง → null เสมอ (ไม่มีข้อมูล ไม่เดา)", () => {
    expect(fxRatePlausibilityWarning("XYZ", 999999)).toBeNull();
    expect(fxRatePlausibilityWarning("AED", 3.6)).toBeNull(); // AED ไม่มีในตารางอ้างอิงที่ implement (นอกลิสต์)
  });
  it("ค่าติดลบ/ไม่ใช่ตัวเลข → null (ไม่เดา ปล่อยให้ hard-block จัดการ)", () => {
    expect(fxRatePlausibilityWarning("USD", -5)).toBeNull();
    expect(fxRatePlausibilityWarning("USD", NaN)).toBeNull();
  });
  it("JPY ช่วงต่ำกว่า 1 (0.15-0.35) → เกินช่วง = เตือน, ในช่วง = ไม่เตือน", () => {
    expect(fxRatePlausibilityWarning("JPY", 0.25)).toBeNull();
    expect(fxRatePlausibilityWarning("JPY", 35)).not.toBeNull(); // เผลอพิมพ์เหมือน USD
  });
});

describe("deriveThbAmount — 0.6/0.8 (จุดเดียวที่ derive THB จาก fx ทุกไฟล์ใช้ร่วมกัน)", () => {
  it("คำนวณถูกต้อง + ปัด 2 ตำแหน่ง", () => {
    expect(deriveThbAmount(100, 35.5)).toBe(3550);
  });
  it("เศษสตางค์ยาว → ปัดถูกต้อง", () => {
    expect(deriveThbAmount(33.333, 3)).toBe(100);
  });
  it("ค่าติดลบ/ไม่ใช่ตัวเลข → ปฏิบัติเป็น 0", () => {
    expect(deriveThbAmount(-100, 35)).toBe(0);
    expect(deriveThbAmount(100, -35)).toBe(0);
    expect(deriveThbAmount(NaN, 35)).toBe(0);
  });
});

describe("DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE", () => {
  it("= '4025' (ตาม 0.4 ของแผน)", () => {
    expect(DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE).toBe("4025");
  });
});
