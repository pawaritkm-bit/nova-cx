import { getStaffRegLiffId, getStaffRegisterCode } from "@/lib/env";
import RegisterClient from "./RegisterClient";

export const dynamic = "force-dynamic";

/**
 * หน้า LIFF "ลงทะเบียนนักบัญชีผ่าน QR" (/reg/staff)
 *   - นักบัญชีสแกน QR (ลิงก์ LIFF) → เปิดหน้านี้ → login LINE → กรอกชื่อ/ทีม/รหัส
 *   - client ดึง idToken + profile ส่งไป /api/register-staff (verify ฝั่ง server)
 *
 * ต่างจากหน้า survey: หน้านี้ "ต้อง" login (ไม่มี token param ให้หลุด) เพื่อยืนยันตัวตน
 *
 * ฟีเจอร์เปิดเมื่อ: ตั้ง STAFF_REGISTER_CODE + มี LIFF id (ไม่ครบ = โชว์ข้อความปิดฟีเจอร์)
 */
export default function StaffRegisterPage() {
  const liffId = getStaffRegLiffId() ?? null;
  const featureOn = !!getStaffRegisterCode();

  return <RegisterClient liffId={liffId} featureOn={featureOn} />;
}
