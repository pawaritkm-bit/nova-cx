/**
 * ส่งอีเมลผ่าน SMTP ของบริษัทเอง (wishlist ข้อ 6 — ส่งสลิปเงินเดือนเป็นชุดทางอีเมล)
 *
 * ★ inert-by-default: getSmtpConfig() คืน null (ยังไม่ตั้ง env ครบ) → sendEmail คืน
 *   { ok: false, message: "..." } ทันที ไม่ throw ไม่กระทบ pipeline อื่น (มิเรอร์ pattern getLineOaCredentials)
 * ★ PDPA: ห้าม log email address/หัวข้อ/เนื้อหาที่นี่เด็ดขาด — error จาก transport อาจมี PII ติดมาด้วย
 *   (เช่น "user unknown: foo@bar.com") จึงคืนแค่ข้อความไทยทั่ว ๆ ไปให้ผู้เรียก ไม่ log ตัว error เต็ม ๆ
 */
import nodemailer from "nodemailer";
import { getSmtpConfig } from "@/lib/env";

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

export type SendEmailResult = { ok: true } | { ok: false; message: string };

/** ส่งอีเมล 1 ฉบับ — คืน {ok:false} เสมอถ้าส่งไม่สำเร็จ (ไม่ throw ให้ผู้เรียก catch ทุกจุด) */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const config = getSmtpConfig();
  if (!config) return { ok: false, message: "ยังไม่ได้ตั้งค่า SMTP (ปิดฟีเจอร์ส่งอีเมลอยู่)" };

  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });
    await transport.sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      attachments: input.attachments,
    });
    return { ok: true };
  } catch {
    return { ok: false, message: "ส่งอีเมลไม่สำเร็จ" };
  }
}
