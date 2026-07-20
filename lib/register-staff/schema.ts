/**
 * Zod schema ของ payload หน้า /reg/staff → POST /api/register-staff
 * validate ทุก input จากภายนอกก่อนใช้ (idToken/code เป็น secret จึงไม่ log)
 */
import { z } from "zod";

const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const registerStaffSchema = z.object({
  // idToken (JWT จาก LIFF) — ไม่จำกัดรูปแบบเป๊ะ แค่ไม่ว่าง/ไม่ยาวเกินเหตุ
  idToken: z.string().trim().min(1, "ไม่พบ idToken").max(8000, "idToken ไม่ถูกต้อง"),
  // รหัสลงทะเบียน (secret) — เทียบ constant-time ที่ route
  code: z.string().min(1, "กรุณากรอกรหัสลงทะเบียน").max(200, "รหัสลงทะเบียนไม่ถูกต้อง"),
  name: z.string().trim().min(1, "กรุณากรอกชื่อ-นามสกุล").max(200, "ชื่อยาวเกินไป"),
  nickname: z.preprocess(
    emptyToUndef,
    z.string().trim().max(200, "ชื่อเล่นยาวเกินไป").optional()
  ),
  teamName: z.preprocess(
    emptyToUndef,
    z.string().trim().max(200, "ชื่อทีมยาวเกินไป").optional()
  ),
  teamId: z.preprocess(
    emptyToUndef,
    z.string().uuid("รหัสทีมไม่ถูกต้อง").optional()
  ),
});

export type RegisterStaffPayload = z.infer<typeof registerStaffSchema>;
