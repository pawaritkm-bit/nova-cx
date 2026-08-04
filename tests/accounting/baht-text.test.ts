import { describe, it, expect } from "vitest";
import { bahtText } from "@/lib/accounting/baht-text";

/**
 * bahtText — แปลงจำนวนเงินเป็นตัวอักษรภาษาไทย (ใบรับรองแทนใบเสร็จ)
 *   ครอบเคสหลัก: เอ็ด/ยี่สิบ/หลักล้าน/สตางค์/ปัดเศษ/ค่าพัง
 */
describe("bahtText — จำนวนเต็ม (บาทถ้วน)", () => {
  it("ศูนย์", () => {
    expect(bahtText(0)).toBe("ศูนย์บาทถ้วน");
  });
  it("หลักหน่วย/สิบ/ร้อย/พัน", () => {
    expect(bahtText(1)).toBe("หนึ่งบาทถ้วน");
    expect(bahtText(9)).toBe("เก้าบาทถ้วน");
    expect(bahtText(10)).toBe("สิบบาทถ้วน");
    expect(bahtText(100)).toBe("หนึ่งร้อยบาทถ้วน");
    expect(bahtText(1500)).toBe("หนึ่งพันห้าร้อยบาทถ้วน");
  });
  it("เอ็ด (หลักหน่วย=1 และมีหลักนำหน้า)", () => {
    expect(bahtText(11)).toBe("สิบเอ็ดบาทถ้วน");
    expect(bahtText(21)).toBe("ยี่สิบเอ็ดบาทถ้วน");
    expect(bahtText(101)).toBe("หนึ่งร้อยเอ็ดบาทถ้วน");
    expect(bahtText(1001)).toBe("หนึ่งพันเอ็ดบาทถ้วน");
  });
  it("ยี่สิบ (หลักสิบ=2)", () => {
    expect(bahtText(20)).toBe("ยี่สิบบาทถ้วน");
    expect(bahtText(25)).toBe("ยี่สิบห้าบาทถ้วน");
  });
  it("หมื่น/แสน", () => {
    expect(bahtText(10000)).toBe("หนึ่งหมื่นบาทถ้วน");
    expect(bahtText(123456)).toBe("หนึ่งแสนสองหมื่นสามพันสี่ร้อยห้าสิบหกบาทถ้วน");
  });
  it("หลักล้าน (รวมล้านซ้อน)", () => {
    expect(bahtText(1000000)).toBe("หนึ่งล้านบาทถ้วน");
    expect(bahtText(2000000)).toBe("สองล้านบาทถ้วน");
    expect(bahtText(1234567)).toBe(
      "หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ดบาทถ้วน"
    );
    // เกินล้าน → "สิบล้าน…"
    expect(bahtText(21000000)).toBe("ยี่สิบเอ็ดล้านบาทถ้วน");
  });
});

describe("bahtText — มีสตางค์", () => {
  it("สตางค์ปกติ", () => {
    expect(bahtText(1234.5)).toBe("หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์");
    expect(bahtText(0.25)).toBe("ยี่สิบห้าสตางค์");
    expect(bahtText(1.01)).toBe("หนึ่งบาทหนึ่งสตางค์");
    expect(bahtText(1.21)).toBe("หนึ่งบาทยี่สิบเอ็ดสตางค์");
  });
  it("ปัดเศษทศนิยมเกิน 2 ตำแหน่ง + กัน floating error", () => {
    expect(bahtText(0.294)).toBe("ยี่สิบเก้าสตางค์");
    expect(bahtText(0.295)).toBe("สามสิบสตางค์");
    expect(bahtText(19.99)).toBe("สิบเก้าบาทเก้าสิบเก้าสตางค์");
  });
});

describe("bahtText — edge/ค่าพัง", () => {
  it("ค่าติดลบ → นำหน้า 'ลบ'", () => {
    expect(bahtText(-50)).toBe("ลบห้าสิบบาทถ้วน");
  });
  it("NaN / Infinity / null / undefined → ศูนย์บาทถ้วน", () => {
    expect(bahtText(NaN)).toBe("ศูนย์บาทถ้วน");
    expect(bahtText(Infinity)).toBe("ศูนย์บาทถ้วน");
    expect(bahtText(null)).toBe("ศูนย์บาทถ้วน");
    expect(bahtText(undefined)).toBe("ศูนย์บาทถ้วน");
  });
});
