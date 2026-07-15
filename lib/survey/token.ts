import { randomBytes } from "node:crypto";

/**
 * จัดการ invitation token ของลูกค้า (FR-LN-05, R-token)
 *   - token สุ่มยาว (URL-safe) ผูก 1 invitation
 *   - ตรวจ: เจ้าของ (line_user) + หมดอายุ + single-use (ตอบแล้ว lock)
 */

/** สร้าง token สุ่ม URL-safe (base64url ~43 ตัวอักษร) */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export type InvitationAccessInput = {
  /** ข้อมูล invitation จาก DB (null = ไม่พบ token) */
  invitation: {
    status: string;
    token_expires_at: string | null;
    line_user_id: string | null;
  } | null;
  /** เวลาปัจจุบัน (ISO) */
  now?: Date;
  /**
   * ★ ต้องเป็น line_users.id ภายใน ที่ resolve + verify จาก LINE ID token แล้วเท่านั้น
   *   ห้ามส่งค่า LINE userId ดิบจาก client เข้ามา (spoof ได้ — Reviewer 🟠#5)
   *   null/undefined = ยังไม่ verify → ข้ามการตรวจเจ้าของ (พึ่งความลับของ token ชั่วคราว)
   *   TODO(chunk LINE env): resolve LINE ID token → line_users.id แล้วส่งค่านี้เพื่อบังคับ owner-binding
   */
  requesterLineUserId?: string | null;
  /** โหมด dev (ไม่มี LINE env) → ข้ามการตรวจเจ้าของ */
  devMode?: boolean;
};

export type AccessReason =
  | "not_found"
  | "already_responded"
  | "expired"
  | "forbidden";

export type InvitationAccessResult =
  | { ok: true }
  | { ok: false; reason: AccessReason };

/**
 * ตรวจสิทธิ์เปิด/ตอบ invitation
 * ลำดับ: มีอยู่จริง → ยังไม่ตอบ → ยังไม่หมดอายุ → เป็นเจ้าของ
 */
export function verifyInvitationAccess(
  input: InvitationAccessInput
): InvitationAccessResult {
  const { invitation, requesterLineUserId, devMode } = input;
  const now = input.now ?? new Date();

  if (!invitation) return { ok: false, reason: "not_found" };

  if (invitation.status === "responded") {
    return { ok: false, reason: "already_responded" };
  }
  if (invitation.status === "expired") {
    return { ok: false, reason: "expired" };
  }

  if (invitation.token_expires_at) {
    const exp = new Date(invitation.token_expires_at);
    if (Number.isFinite(exp.getTime()) && exp.getTime() < now.getTime()) {
      return { ok: false, reason: "expired" };
    }
  }

  // ตรวจเจ้าของ: เฉพาะเมื่อ invitation ผูก line_user + รู้ผู้เปิด + ไม่ใช่ dev
  if (!devMode && invitation.line_user_id && requesterLineUserId) {
    if (invitation.line_user_id !== requesterLineUserId) {
      return { ok: false, reason: "forbidden" };
    }
  }

  return { ok: true };
}

/** ข้อความสุภาพภาษาไทยตามสาเหตุ (แสดงให้ลูกค้า) */
export function accessReasonMessage(reason: AccessReason): string {
  switch (reason) {
    case "not_found":
      return "ไม่พบแบบประเมินนี้ ลิงก์อาจไม่ถูกต้อง";
    case "already_responded":
      return "แบบประเมินนี้ถูกส่งเรียบร้อยแล้ว ขอบคุณค่ะ";
    case "expired":
      return "ลิงก์แบบประเมินหมดอายุแล้ว";
    case "forbidden":
      return "ลิงก์นี้เป็นของลูกค้าท่านอื่น ไม่สามารถเปิดได้";
  }
}
