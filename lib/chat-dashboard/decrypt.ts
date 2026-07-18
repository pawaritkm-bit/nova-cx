/**
 * Chat Audit — ถอดรหัสไทม์ไลน์บทสนทนา (Phase 5a)
 *   ★ กติกา: decrypt ทำ "ฝั่ง server เท่านั้น" และ "เฉพาะ tier ที่มีสิทธิ์"
 *     - ห้ามส่ง ciphertext/plaintext เกินสิทธิ์ไป client
 *     - buildTimeline เป็นฟังก์ชันบริสุทธิ์ (รับ canDecrypt + decryptFn) → unit test ได้
 *       และเป็นด่านสุดท้ายที่ตัดสินว่าจะ "ถอด" หรือ "ซ่อน" เนื้อหา/ชื่อ
 */
import type { TimelineMessage } from "./types";

/** ป้ายผู้ส่งตามชนิดสมาชิก (ใช้เมื่อไม่มีสิทธิ์เห็นชื่อจริง หรือไม่มีชื่อ) */
const KIND_LABEL: Record<string, string> = {
  customer: "ลูกค้า",
  accountant: "นักบัญชี",
  lead: "หัวหน้า",
  system: "ระบบ",
  unknown: "ไม่ระบุ",
};

function normalizeKind(kind: string | null | undefined): TimelineMessage["senderKind"] {
  switch (kind) {
    case "customer":
    case "accountant":
    case "lead":
    case "system":
      return kind;
    default:
      return "unknown";
  }
}

export type RawTimelineInput = {
  id: string;
  memberKind: string | null;
  displayNameEnc: string | null;
  senderLineUserId: string | null;
  contentEnc: string | null;
  messageType: string;
  sentAt: string | null;
};

/** placeholder เมื่อไม่มีสิทธิ์เห็นเนื้อหาแชตดิบ (hr/cs/นอก scope) */
export const HIDDEN_CONTENT = "[ซ่อนเนื้อหาแชต — ไม่มีสิทธิ์]";
/** placeholder เมื่อถอดรหัสไม่สำเร็จ (คีย์ผิด/ciphertext เพี้ยน) */
export const UNDECRYPTABLE_CONTENT = "[ถอดรหัสไม่สำเร็จ]";

/**
 * ประกอบไทม์ไลน์บทสนทนาจากแถวข้อความดิบ
 *   ★ canDecrypt=false → เนื้อหา/ชื่อถูกซ่อนทั้งหมด (ไม่มีทาง leak plaintext)
 *   ★ canDecrypt=true  → ถอดรหัสผ่าน decryptFn (ล้อม try/catch กัน throw ทำหน้าพัง)
 */
export function buildTimeline(
  rows: RawTimelineInput[],
  canDecrypt: boolean,
  decryptFn: (token: string) => string
): TimelineMessage[] {
  return rows.map((r) => {
    const senderKind = normalizeKind(r.memberKind);
    const kindLabel = KIND_LABEL[senderKind] ?? KIND_LABEL.unknown;

    // ชื่อผู้ส่ง: เห็นชื่อจริงได้เฉพาะเมื่อมีสิทธิ์ decrypt
    let senderLabel = kindLabel;
    if (canDecrypt && r.displayNameEnc) {
      try {
        const name = decryptFn(r.displayNameEnc);
        if (name) senderLabel = `${name} (${kindLabel})`;
      } catch {
        // ถอดชื่อไม่ได้ → ใช้ป้ายชนิดเฉย ๆ
      }
    }

    // เนื้อหา
    let content: string;
    let redacted = false;
    if (r.messageType !== "text" || !r.contentEnc) {
      // ไม่ใช่ข้อความตัวอักษร (รูป/ไฟล์) หรือไม่มีเนื้อหา → แสดงชนิดแทน
      content = r.contentEnc ? `[${r.messageType}]` : `[${r.messageType === "text" ? "ไม่มีข้อความ" : r.messageType}]`;
    } else if (!canDecrypt) {
      content = HIDDEN_CONTENT;
      redacted = true;
    } else {
      try {
        content = decryptFn(r.contentEnc);
      } catch {
        content = UNDECRYPTABLE_CONTENT;
      }
    }

    return {
      id: r.id,
      senderKind,
      senderLabel,
      content,
      sentAt: r.sentAt,
      redacted,
    };
  });
}
