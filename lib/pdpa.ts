/**
 * ค่าคงที่ PDPA consent (FR-PD / FR-SC-04c)
 *   - บังคับมี consent จริงก่อนบันทึกแบบประเมิน (ไม่ hardcode true ฝั่ง server)
 *   - เก็บ policy_version + purpose_json ลง consent_records ผ่าน RPC atomic
 */
export const CONSENT_POLICY_VERSION = "2026-07-15";

/** วัตถุประสงค์การเก็บ/ใช้ข้อมูล (แสดงในหน้า consent + บันทึกลง purpose_json) */
export const CONSENT_PURPOSE = {
  collect: "ความเห็น/คะแนนความพึงพอใจต่อบริการ",
  use: "ปรับปรุงคุณภาพบริการ + วิเคราะห์ด้วย AI (ผ่านการ redact ข้อมูลอ่อนไหว)",
  access: "ทีมดูแลลูกค้า/หัวหน้า/ผู้บริหารตามสิทธิ์",
  retention: "ตามระยะเวลาที่นโยบายบริษัทกำหนด",
} as const;

export type ConsentPayload = {
  policy_version: string;
  purpose: typeof CONSENT_PURPOSE;
};

/** ประกอบ payload consent มาตรฐาน (ใช้เขียน consent_records) */
export function buildConsentPayload(): ConsentPayload {
  return { policy_version: CONSENT_POLICY_VERSION, purpose: CONSENT_PURPOSE };
}
