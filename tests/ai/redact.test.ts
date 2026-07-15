import { describe, it, expect } from "vitest";
import {
  redactText,
  redactDeep,
  hasResidualPii,
  PII_PLACEHOLDER,
} from "@/lib/ai/redact";

describe("ai/redact — เบอร์โทรไทย", () => {
  it("มือถือ 10 หลักติดกัน", () => {
    const r = redactText("โทรกลับที่ 0812345678 นะครับ");
    expect(r.text).toContain(PII_PLACEHOLDER.phone);
    expect(r.text).not.toContain("0812345678");
    expect(r.counts.phone).toBe(1);
  });
  it("มือถือมีขีดคั่น", () => {
    const r = redactText("เบอร์ 081-234-5678");
    expect(r.text).toContain(PII_PLACEHOLDER.phone);
    expect(r.counts.phone).toBe(1);
  });
  it("เบอร์บ้าน 02", () => {
    const r = redactText("ออฟฟิศ 02-123-4567");
    expect(r.text).toContain(PII_PLACEHOLDER.phone);
  });
  it("+66 format", () => {
    const r = redactText("call +66 81 234 5678");
    expect(r.text).toContain(PII_PLACEHOLDER.phone);
  });
});

describe("ai/redact — อีเมล", () => {
  it("อีเมลทั่วไป", () => {
    const r = redactText("ส่งเมลมาที่ john.doe@example.co.th ได้เลย");
    expect(r.text).toContain(PII_PLACEHOLDER.email);
    expect(r.text).not.toContain("john.doe@example.co.th");
    expect(r.counts.email).toBe(1);
  });
});

describe("ai/redact — เลขประจำตัวผู้เสียภาษี 13 หลัก", () => {
  it("13 หลักติดกัน", () => {
    const r = redactText("เลขภาษี 1234567890123");
    expect(r.text).toContain(PII_PLACEHOLDER.taxId);
    expect(r.text).not.toContain("1234567890123");
    expect(r.counts.taxId).toBe(1);
  });
  it("13 หลักมีขีดคั่น (รูปแบบบัตร ปชช.)", () => {
    const r = redactText("เลข 1-2345-67890-12-3 ครับ");
    expect(r.text).toContain(PII_PLACEHOLDER.taxId);
  });
  it("เลขภาษี match ก่อน (ไม่โดนเบอร์กินบางส่วน)", () => {
    const r = redactText("1234567890123");
    expect(r.counts.taxId).toBe(1);
    expect(r.counts.phone).toBe(0);
  });
});

describe("ai/redact — ชื่อ", () => {
  it("ชื่อที่ระบบรู้ (knownNames) แทนตรงตัว", () => {
    const r = redactText("ลูกค้าชื่อบริษัท วันวานาช จำกัด ติดต่อมา", [
      "บริษัท วันวานาช จำกัด",
    ]);
    expect(r.text).toContain(PII_PLACEHOLDER.name);
    expect(r.text).not.toContain("วันวานาช");
  });
  it("คำนำหน้าไทย + ชื่อ", () => {
    const r = redactText("คุณสมชาย บอกว่าดี");
    expect(r.text).toContain(PII_PLACEHOLDER.name);
    expect(r.text).not.toContain("สมชาย");
  });
  it("นางสาว + ชื่อ", () => {
    const r = redactText("นางสาวมาลี ประทับใจมาก");
    expect(r.text).toContain(PII_PLACEHOLDER.name);
  });
});

describe("ai/redact — รวมหลาย PII + residual", () => {
  it("ปิดครบทุกชนิดในข้อความเดียว", () => {
    const r = redactText(
      "คุณสมชาย โทร 0812345678 เมล a@b.com เลขภาษี 1234567890123",
      []
    );
    expect(r.counts.phone).toBe(1);
    expect(r.counts.email).toBe(1);
    expect(r.counts.taxId).toBe(1);
    expect(r.counts.name).toBeGreaterThanOrEqual(1);
    expect(hasResidualPii(r.text)).toBe(false);
  });

  it("hasResidualPii จับ PII ที่ยังหลงเหลือ", () => {
    expect(hasResidualPii("โทร 0812345678")).toBe(true);
    expect(hasResidualPii("ปลอดภัยแล้ว")).toBe(false);
  });
});

describe("ai/redact — redactDeep (recursive)", () => {
  it("redact ค่าใน object/array คงชนิดอื่นไว้", () => {
    const out = redactDeep(
      {
        note: "โทร 0812345678",
        score: 5,
        tags: ["เมล a@b.com", "ปกติ"],
        flag: true,
      },
      []
    ) as Record<string, unknown>;
    expect(out.note).toContain(PII_PLACEHOLDER.phone);
    expect(out.score).toBe(5);
    expect(out.flag).toBe(true);
    expect((out.tags as string[])[0]).toContain(PII_PLACEHOLDER.email);
    expect((out.tags as string[])[1]).toBe("ปกติ");
  });
});
