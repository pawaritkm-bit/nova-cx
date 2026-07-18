import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  HIDDEN_CONTENT,
  UNDECRYPTABLE_CONTENT,
  type RawTimelineInput,
} from "@/lib/chat-dashboard/decrypt";

// decrypt จำลอง: "enc:<x>" → "<x>", อย่างอื่น throw (เหมือน decryptField เมื่อ ciphertext เพี้ยน)
function fakeDecrypt(token: string): string {
  if (token.startsWith("enc:")) return token.slice(4);
  throw new Error("invalid ciphertext");
}

const msg = (over: Partial<RawTimelineInput> = {}): RawTimelineInput => ({
  id: "m1",
  memberKind: "customer",
  displayNameEnc: null,
  senderLineUserId: "U1",
  contentEnc: "enc:สวัสดีครับ",
  messageType: "text",
  sentAt: "2026-07-18T09:00:00Z",
  ...over,
});

describe("buildTimeline — ★ decrypt เฉพาะเมื่อมีสิทธิ์ (gate)", () => {
  it("มีสิทธิ์ → ถอดเนื้อหาได้จริง", () => {
    const t = buildTimeline([msg()], true, fakeDecrypt);
    expect(t[0].content).toBe("สวัสดีครับ");
    expect(t[0].redacted).toBe(false);
  });

  it("★ ไม่มีสิทธิ์ (เช่น hr) → เนื้อหาถูกซ่อน ไม่รั่ว plaintext", () => {
    const t = buildTimeline([msg()], false, fakeDecrypt);
    expect(t[0].content).toBe(HIDDEN_CONTENT);
    expect(t[0].redacted).toBe(true);
    // ต้องไม่มี plaintext/ciphertext หลุดออกมา
    expect(t[0].content).not.toContain("สวัสดี");
    expect(t[0].content).not.toContain("enc:");
  });

  it("มีสิทธิ์แต่ ciphertext เพี้ยน → placeholder (ไม่ throw ทำหน้าพัง)", () => {
    const t = buildTimeline([msg({ contentEnc: "corrupted" })], true, fakeDecrypt);
    expect(t[0].content).toBe(UNDECRYPTABLE_CONTENT);
  });

  it("ชื่อผู้ส่ง: เห็นชื่อจริงเฉพาะเมื่อมีสิทธิ์ decrypt", () => {
    const withName = msg({ displayNameEnc: "enc:คุณสมชาย" });
    const allowed = buildTimeline([withName], true, fakeDecrypt);
    expect(allowed[0].senderLabel).toContain("คุณสมชาย");
    const denied = buildTimeline([withName], false, fakeDecrypt);
    // ไม่มีสิทธิ์ → เห็นแค่ป้ายชนิด (ลูกค้า) ไม่เห็นชื่อจริง
    expect(denied[0].senderLabel).toBe("ลูกค้า");
    expect(denied[0].senderLabel).not.toContain("สมชาย");
  });

  it("ข้อความไม่ใช่ text (รูป/ไฟล์) → แสดงชนิดแทน ไม่พยายาม decrypt", () => {
    const img = msg({ messageType: "image", contentEnc: null });
    const t = buildTimeline([img], true, fakeDecrypt);
    expect(t[0].content).toBe("[image]");
    expect(t[0].redacted).toBe(false);
  });

  it("map ชนิดสมาชิก → senderKind ที่ถูกต้อง (ค่าแปลก → unknown)", () => {
    const rows = [
      msg({ id: "a", memberKind: "accountant" }),
      msg({ id: "b", memberKind: "weird" }),
    ];
    const t = buildTimeline(rows, true, fakeDecrypt);
    expect(t[0].senderKind).toBe("accountant");
    expect(t[1].senderKind).toBe("unknown");
  });
});
