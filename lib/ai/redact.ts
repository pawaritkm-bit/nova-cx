/**
 * PII Redaction (C-15) — ตัดข้อมูลอ่อนไหวออกก่อนส่งเข้า AI เสมอ
 *   redact: เบอร์โทร / อีเมล / เลขประจำตัวผู้เสียภาษี (13 หลัก) / ชื่อ
 *
 * หลักการ:
 *   - แทนที่ด้วย placeholder ที่สื่อความหมาย (AI ยังเข้าใจว่าตรงนั้นเคยมี PII)
 *   - ลำดับสำคัญ: อีเมล → เลขภาษี(13 หลัก) → เบอร์โทร → ชื่อ
 *     (เลขภาษี 13 หลักต้อง match ก่อนเบอร์ เพื่อไม่ให้เบอร์กินตัวเลขบางส่วน)
 *   - "ชื่อ" ตรวจได้ยากในภาษาไทย → ใช้ 2 วิธีร่วมกัน
 *       (ก) แทนที่ชื่อที่ระบบรู้จริง (ชื่อลูกค้า/ธุรกิจ/พนักงานจาก snapshot) แบบตรงตัว
 *       (ข) คำนำหน้าไทย (คุณ/นาย/นาง/นางสาว/ด.ช./ด.ญ.) + คำถัดไป
 */

export const PII_PLACEHOLDER = {
  email: "[อีเมล]",
  taxId: "[เลขภาษี]",
  phone: "[เบอร์โทร]",
  name: "[ชื่อ]",
} as const;

export type RedactResult = {
  text: string;
  counts: { email: number; taxId: number; phone: number; name: number };
};

// อีเมล (ครอบ subdomain + tld ทั่วไป)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// เลขประจำตัวผู้เสียภาษี/บัตร ปชช. 13 หลัก — รองรับทั้งติดกันและมีขีด/เว้นวรรคคั่น
//   เช่น 1234567890123 หรือ 1-2345-67890-12-3
const TAX_ID_RE = /\b\d(?:[-\s]?\d){12}\b/g;

// เบอร์โทรไทย: +66 หรือขึ้นต้น 0 ตามด้วยเลข 8–9 ตัว (มีขีด/เว้นวรรคคั่นได้)
//   เช่น 0812345678, 081-234-5678, 02-123-4567, +66 81 234 5678
const PHONE_RE = /(?:\+66|0)(?:[-\s]?\d){8,9}\b/g;

// คำนำหน้าชื่อไทย + คำถัดไป (จับชื่อที่ตามหลังคำนำหน้า)
//   ครอบ: คุณ นาย นาง นางสาว ด.ช. ด.ญ. เด็กชาย เด็กหญิง
const THAI_TITLE_RE =
  /(?:คุณ|นายจ้าง|นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง|ด\.?ช\.?|ด\.?ญ\.?)\s?[ก-๙A-Za-z]+/g;

/** escape สตริงให้ใช้ใน RegExp ได้อย่างปลอดภัย */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * redact PII ออกจากข้อความ
 * @param input ข้อความดิบ
 * @param knownNames รายชื่อที่ระบบรู้ว่าเป็น PII (ชื่อลูกค้า/ธุรกิจ/พนักงาน) — แทนแบบตรงตัว
 */
export function redactText(input: string, knownNames: string[] = []): RedactResult {
  const counts = { email: 0, taxId: 0, phone: 0, name: 0 };
  if (typeof input !== "string" || input.length === 0) {
    return { text: input ?? "", counts };
  }

  let text = input;

  text = text.replace(EMAIL_RE, () => {
    counts.email += 1;
    return PII_PLACEHOLDER.email;
  });

  text = text.replace(TAX_ID_RE, () => {
    counts.taxId += 1;
    return PII_PLACEHOLDER.taxId;
  });

  text = text.replace(PHONE_RE, () => {
    counts.phone += 1;
    return PII_PLACEHOLDER.phone;
  });

  // (ก) ชื่อที่ระบบรู้จริง — แทนตรงตัว (เรียงยาว→สั้น กันชื่อสั้นตัดชื่อยาว)
  const names = [...new Set(knownNames.filter((n) => n && n.trim().length >= 2))].sort(
    (a, b) => b.length - a.length
  );
  for (const name of names) {
    const re = new RegExp(escapeRegExp(name.trim()), "g");
    text = text.replace(re, () => {
      counts.name += 1;
      return PII_PLACEHOLDER.name;
    });
  }

  // (ข) คำนำหน้าชื่อไทย + คำถัดไป
  text = text.replace(THAI_TITLE_RE, () => {
    counts.name += 1;
    return PII_PLACEHOLDER.name;
  });

  return { text, counts };
}

/** true เมื่อยังพบ PII เด่นๆ (เบอร์/อีเมล/เลขภาษี) หลง redact — ใช้ตรวจซ้ำก่อนส่ง AI */
export function hasResidualPii(text: string): boolean {
  if (typeof text !== "string") return false;
  // สร้าง regex ใหม่ (ไม่ใช้ /g ตัว module-level เพื่อเลี่ยงบั๊ก lastIndex ของ .test())
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const taxId = /\b\d(?:[-\s]?\d){12}\b/;
  const phone = /(?:\+66|0)(?:[-\s]?\d){8,9}\b/;
  return email.test(text) || taxId.test(text) || phone.test(text);
}

/**
 * redact ค่าใน object/array แบบ recursive (ใช้กับ answers map)
 *   - string → redactText
 *   - ค่าชนิดอื่น (number/boolean/null) คงเดิม
 */
export function redactDeep(value: unknown, knownNames: string[] = []): unknown {
  if (typeof value === "string") return redactText(value, knownNames).text;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownNames));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, knownNames);
    }
    return out;
  }
  return value;
}
