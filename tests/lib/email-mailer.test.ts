import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * เทสต์ lib/email/mailer.ts (wishlist ข้อ 6) — mock nodemailer ทั้งหมด ไม่ยิง SMTP จริง
 *   ★ inert-by-default: ไม่ตั้ง env SMTP ครบ → sendEmail คืน {ok:false} ทันที ไม่แตะ nodemailer เลย
 */

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendMailMock.mockReset();
  createTransportMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("sendEmail", () => {
  it("ไม่ตั้ง env SMTP ครบ → คืน {ok:false} ทันที ไม่เรียก nodemailer", async () => {
    const { sendEmail } = await import("@/lib/email/mailer");
    const res = await sendEmail({ to: "a@example.com", subject: "s", text: "t" });
    expect(res.ok).toBe(false);
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("ตั้ง env ครบ + ส่งสำเร็จ → คืน {ok:true} ส่ง attachments ผ่านไปด้วย", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASSWORD = "secret";
    sendMailMock.mockResolvedValue({ messageId: "1" });

    const { sendEmail } = await import("@/lib/email/mailer");
    const res = await sendEmail({
      to: "b@example.com",
      subject: "สลิปเงินเดือน",
      text: "แนบสลิปมาด้วย",
      attachments: [{ filename: "payslip.pdf", content: Buffer.from("x") }],
    });

    expect(res.ok).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("b@example.com");
    expect(call.attachments[0].filename).toBe("payslip.pdf");
  });

  it("transport.sendMail throw → คืน {ok:false} ไม่ throw ให้ผู้เรียก", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASSWORD = "secret";
    sendMailMock.mockRejectedValue(new Error("connection refused"));

    const { sendEmail } = await import("@/lib/email/mailer");
    const res = await sendEmail({ to: "c@example.com", subject: "s", text: "t" });
    expect(res.ok).toBe(false);
  });
});
