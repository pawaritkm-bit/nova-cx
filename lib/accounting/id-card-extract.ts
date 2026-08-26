/**
 * id-card-extract.ts — อ่าน "บัตรประชาชนไทย" จากรูป → ข้อมูล KYC (ตัวอักษรล้วน · ไม่เก็บรูป)
 *   ใช้เติมชีต "ประวัติลูกค้า" + ตั้งชื่อไฟล์/หัวไฟล์ตามชื่อในบัตร
 *   ★ PDPA: ไม่ log ชื่อ/เลขบัตร/ที่อยู่ · คืน null ถ้าไม่ใช่บัตรประชาชน (ไม่เดามั่ว)
 */
import { downscaleImageIfLarge } from "@/lib/accounting/image-prep";
import { extractJsonWithGemini } from "@/lib/ai/gemini-extract";

export type IdCardData = {
  /** ชื่อ-สกุล (ผู้เสียภาษี) ตามบัตร */
  name: string | null;
  /** เลขประจำตัวประชาชน 13 หลัก (= เลขภาษีบุคคลธรรมดา) */
  idNo: string | null;
  address: string | null;
  /** วันเกิด (ตามที่อ่านได้) */
  dob: string | null;
  /** วันออกบัตร */
  cardIssue: string | null;
  /** วันหมดอายุบัตร */
  cardExpiry: string | null;
  /** เลขหลังบัตร (laser code) — จากด้านหลังบัตร ถ้ามี */
  laserCode: string | null;
};

const SYSTEM_PROMPT =
  "คุณอ่าน 'บัตรประชาชนไทย' (Thai National ID Card) จากรูป แล้วสกัดข้อมูลเป็น JSON เท่านั้น. " +
  "รูปแบบ {\"is_id_card\": true/false, \"name\": \"<ชื่อ-สกุล ภาษาไทย เช่น นาย/นาง/น.ส. ...>\", \"id_no\": \"<เลข 13 หลัก>\", " +
  "\"address\": \"<ที่อยู่ตามบัตร>\", \"dob\": \"<วันเกิด>\", \"card_issue\": \"<วันออกบัตร>\", \"card_expiry\": \"<วันบัตรหมดอายุ>\", \"laser_code\": \"<เลขหลังบัตร JxxNNNNNNNNNN ถ้าเป็นด้านหลัง>\"}. " +
  "ถ้ารูปไม่ใช่บัตรประชาชน (เช่นสเตทเมนต์/บิล/รูปอื่น) ให้ is_id_card=false และช่องอื่น null. " +
  "อ่านไม่ชัดช่องไหนให้ช่องนั้น null (ห้ามเดา). ★ เลข 13 หลักอ่านให้ครบทุกหลัก.";

/** เก็บเฉพาะเลข → คืน 13 หลักถ้าครบ ไม่งั้น null */
function norm13(s: string | null): string | null {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 13 ? d : null;
}
function clean(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t && !/^(null|-|n\/?a|ไม่ระบุ|ไม่ทราบ)$/i.test(t) ? t : null;
}

/**
 * อ่านบัตรประชาชนจากรูป — best-effort · 1 Gemini vision call
 *   คืน null เมื่อ: ไม่ใช่บัตร / อ่านไม่ได้ / ไม่มี key / ไม่มีทั้งชื่อและเลขบัตร (กันเก็บขยะ)
 */
export async function extractIdCardData(fileData: Buffer, mime: string): Promise<IdCardData | null> {
  try {
    const prepped = await downscaleImageIfLarge(fileData, mime);
    const raw = await extractJsonWithGemini({
      source: "id_card_extract",
      system: SYSTEM_PROMPT,
      userPrompt: "อ่านบัตรประชาชนนี้ ตอบ JSON.",
      fileData: prepped.data,
      mime: prepped.mime || mime,
    });
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (o.is_id_card === false) return null;
    const name = clean(o.name);
    const idNo = norm13(clean(o.id_no));
    // ต้องมีอย่างน้อย ชื่อ หรือ เลขบัตร 13 หลัก ไม่งั้นถือว่าไม่ใช่บัตร/อ่านไม่ได้
    if (!name && !idNo) return null;
    return {
      name,
      idNo,
      address: clean(o.address),
      dob: clean(o.dob),
      cardIssue: clean(o.card_issue),
      cardExpiry: clean(o.card_expiry),
      laserCode: clean(o.laser_code),
    };
  } catch {
    return null;
  }
}
