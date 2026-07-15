import { describe, it, expect } from "vitest";
import {
  isPiiKey,
  redactFeedbackRow,
  redactFeedbackRows,
  hasPii,
  PII_KEYS,
} from "@/lib/dashboard/redact";

describe("redact — ผู้ถูกประเมินต้องไม่เห็นชื่อลูกค้า/PII (FR-DB-02/03, §16)", () => {
  it("ระบุคีย์ PII ถูกต้อง (case-insensitive)", () => {
    expect(isPiiKey("customer_name")).toBe(true);
    expect(isPiiKey("Customer_Name")).toBe(true);
    expect(isPiiKey("phone_enc")).toBe(true);
    expect(isPiiKey("avg_score")).toBe(false);
    expect(isPiiKey("summary")).toBe(false);
  });

  it("ตัดคีย์ PII ออก คงคีย์คะแนน/สรุปไว้", () => {
    const row = {
      evaluation_id: "e1",
      avg_score: 4.5,
      summary: "บริการดี",
      customer_name: "บริษัท ก",
      customer_id: "c-123",
      phone_enc: "xxxx",
      email: "a@b.co",
    };
    const out = redactFeedbackRow(row);
    expect(out).toEqual({
      evaluation_id: "e1",
      avg_score: 4.5,
      summary: "บริการดี",
    });
    expect(hasPii(out as Record<string, unknown>)).toBe(false);
  });

  it("redact ทั้ง array + ครอบทุกคีย์ใน PII_KEYS", () => {
    const leak = Object.fromEntries(PII_KEYS.map((k) => [k, "x"]));
    const rows = redactFeedbackRows([{ ...leak, avg_score: 3 }]);
    expect(rows[0]).toEqual({ avg_score: 3 });
    expect(hasPii(rows[0] as Record<string, unknown>)).toBe(false);
  });
});
