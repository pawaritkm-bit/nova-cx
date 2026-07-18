import { describe, it, expect } from "vitest";
import { redactChatText, hasResidualChatPii } from "@/lib/ai/chat-redact";

describe("chat-redact — เสริม pattern แชต (เลขบัญชี/ยอดเงิน/ที่อยู่)", () => {
  it("เลขบัญชี 10 หลัก → [เลขบัญชี]", () => {
    const out = redactChatText("โอนมาบัญชี 1234567890 นะครับ");
    expect(out).not.toContain("1234567890");
    expect(out).toContain("[เลขบัญชี]");
  });

  it("ยอดเงินมีหน่วยบาท → [จำนวนเงิน]", () => {
    const out = redactChatText("ยอด 12,500 บาท ค้างชำระ");
    expect(out).not.toContain("12,500");
    expect(out).toContain("[จำนวนเงิน]");
  });

  it("ที่อยู่ → [ที่อยู่]", () => {
    const out = redactChatText("บ้านเลขที่ 99/1 หมู่ 2 ถนนสุขุมวิท.");
    expect(out).toContain("[ที่อยู่]");
    expect(out).not.toContain("99/1");
  });

  it("ยัง redact base เดิม (เบอร์โทร) ได้", () => {
    const out = redactChatText("โทรมาที่ 0812345678 ได้เลย");
    expect(out).not.toContain("0812345678");
    expect(out).toContain("[เบอร์โทร]");
  });

  it("ข้อความปกติ (ไม่มี PII/คำนำหน้าชื่อ) ไม่ถูกแตะ", () => {
    const out = redactChatText("รับทราบครับ เดี๋ยวส่งเอกสารให้ภายในวันนี้");
    expect(out).toBe("รับทราบครับ เดี๋ยวส่งเอกสารให้ภายในวันนี้");
  });
});

describe("chat-redact — residual gate", () => {
  it("เลขยาว 10+ หลักที่หลุด → residual = true (จะถูกบล็อก)", () => {
    // 15 หลักติดกัน = base redact + bank pattern จับไม่ได้ (ไม่มี word-boundary กลาง)
    expect(hasResidualChatPii("รหัสลับ 987654321012345")).toBe(true);
  });

  it("ข้อความสะอาดหลัง redact → residual = false", () => {
    const clean = redactChatText("ยอด 5,000 บาท โอนบัญชี 1234567890");
    expect(hasResidualChatPii(clean)).toBe(false);
  });
});
