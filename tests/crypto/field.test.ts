import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptField, decryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * field encryption (AES-256-GCM) ด้วย CREDENTIAL_ENC_KEY
 *   - round trip: encrypt → decrypt ได้ plaintext เดิม
 *   - ciphertext ต่างจาก plaintext + สุ่ม iv (เข้ารหัสซ้ำได้ token ไม่เหมือนกัน)
 *   - แก้ ciphertext แล้วถอดต้องล้ม (auth tag)
 *   - ไม่มีคีย์ → hasEncKey false + encrypt/decrypt throw
 */
describe("crypto/field", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY =
      "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("round trip: encrypt → decrypt คืน plaintext เดิม (รองรับภาษาไทย/อีโมจิ)", () => {
    const plain = "สวัสดีครับ ยอดเดือนนี้ 12,500 บาท 🙏";
    const token = encryptField(plain);
    expect(decryptField(token)).toBe(plain);
  });

  it("ciphertext ไม่ใช่ plaintext และมี prefix v1:", () => {
    const plain = "hello world";
    const token = encryptField(plain);
    expect(token).not.toContain(plain);
    expect(token.startsWith("v1:")).toBe(true);
  });

  it("เข้ารหัสข้อความเดิมสองครั้ง → token ต่างกัน (สุ่ม iv) แต่ถอดได้เท่ากัน", () => {
    const plain = "same message";
    const a = encryptField(plain);
    const b = encryptField(plain);
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(plain);
    expect(decryptField(b)).toBe(plain);
  });

  it("แก้ ciphertext แล้วถอด → throw (auth tag ไม่ผ่าน)", () => {
    const token = encryptField("secret");
    // สลับตัวอักษรท้าย token (ส่วน ciphertext)
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("ไม่มี CREDENTIAL_ENC_KEY → hasEncKey false + encrypt/decrypt throw", () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    expect(hasEncKey()).toBe(false);
    expect(() => encryptField("x")).toThrow(/CREDENTIAL_ENC_KEY/);
    expect(() => decryptField("v1:a.b.c")).toThrow(/CREDENTIAL_ENC_KEY/);
  });
});
