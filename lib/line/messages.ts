/**
 * สร้างข้อความ LINE (Flex / text) สำหรับส่ง invitation + reminder
 *   - บุคลิกน้อง NOVA: เป็นมิตร สั้น กระชับ ไม่กดดันให้คะแนนดี (FR-AI-07, C-06)
 *   - ปุ่มเปิด LIFF ตาม token → หน้าแบบประเมินในแอป
 * pure function (ไม่พึ่ง env/network) → test ได้
 */

/** LINE message object (หลวม — ส่งเข้า Messaging API ตรง ๆ) */
export type LineMessage = Record<string, unknown>;

/**
 * สร้าง URL เปิด LIFF สำหรับ token หนึ่ง ๆ
 *   รูปแบบ https://liff.line.me/{liffId}?token={token}
 *   (ตั้ง LIFF endpoint URL ใน LINE console = {APP_URL}/liff/survey
 *    → LINE เปิด {APP_URL}/liff/survey?token={token} → หน้า base อ่าน ?token= ได้ตรง ๆ)
 *
 *   เดิมใช้ path-style (.../{token}) แต่ LINE เปิด endpoint base ก่อนแล้วส่ง extra path
 *   ผ่าน query liff.state ทำให้ /liff/survey (base) โดน 404 — เลี่ยงด้วย query-style
 *   (หน้า base ยังรองรับ liff.state อยู่ เผื่อข้อความ path-style ที่ส่งไปก่อนหน้า)
 */
export function buildLiffSurveyUrl(liffId: string, token: string): string {
  return `https://liff.line.me/${liffId}?token=${encodeURIComponent(token)}`;
}

export type InvitationMessageParams = {
  /** ชื่อลูกค้า/กิจการ ใส่ทักทาย (optional) */
  displayName?: string | null;
  /** ลิงก์เปิด LIFF (ได้จาก buildLiffSurveyUrl) */
  liffUrl: string;
  /** true = ข้อความเตือน (reminder) ; false = ส่งครั้งแรก */
  isReminder?: boolean;
  /** จำนวนนาทีโดยประมาณที่ใช้ตอบ */
  estimatedMinutes?: number | null;
};

/** หัวข้อ/คำอธิบายตามโหมด (ส่งครั้งแรก vs เตือน) */
function copy(isReminder: boolean, minutes: number | null | undefined) {
  const mins = minutes && minutes > 0 ? `ใช้เวลาประมาณ ${minutes} นาที` : "ใช้เวลาไม่นาน";
  if (isReminder) {
    return {
      title: "ขอรบกวนอีกนิดนะคะ 🙏",
      body: `แบบประเมินบริการยังรอความเห็นจากคุณอยู่ค่ะ ${mins} ความเห็นของคุณช่วยให้เราดูแลได้ดีขึ้น`,
      button: "ทำแบบประเมิน",
    };
  }
  return {
    title: "ขอความเห็นเรื่องบริการค่ะ 💬",
    body: `น้อง NOVA อยากรบกวนขอความเห็นเรื่องบริการที่ผ่านมา ${mins} ทุกความเห็นมีค่าต่อการพัฒนาบริการค่ะ`,
    button: "ทำแบบประเมิน",
  };
}

/**
 * สร้าง Flex Message (การ์ด + ปุ่มเปิด LIFF)
 * altText ใช้ตอนแสดงใน notification/รายการแชต
 */
export function buildInvitationFlex(params: InvitationMessageParams): LineMessage {
  const { title, body, button } = copy(!!params.isReminder, params.estimatedMinutes);
  const greeting = params.displayName
    ? `สวัสดีค่ะ คุณ${params.displayName}`
    : "สวัสดีค่ะ";

  return {
    type: "flex",
    altText: `${title} ${body}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", size: "lg", wrap: true },
          { type: "text", text: greeting, size: "sm", color: "#8A8A8A", wrap: true },
          { type: "text", text: body, size: "sm", wrap: true, color: "#333333" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "uri", label: button, uri: params.liffUrl },
          },
        ],
      },
    },
  };
}

/** ข้อความ text ล้วน (fallback / กรณีไม่อยากใช้ Flex) */
export function buildInvitationText(params: InvitationMessageParams): LineMessage {
  const { title, body } = copy(!!params.isReminder, params.estimatedMinutes);
  return {
    type: "text",
    text: `${title}\n${body}\n\nเปิดแบบประเมิน: ${params.liffUrl}`,
  };
}
