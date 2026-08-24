/**
 * image-prep.ts — เตรียมรูปก่อนส่งเข้า vision (server-only)
 *
 * ปัญหา: รูปสแกน/ถ่ายบิล-สเตทเมนต์ความละเอียดสูงมาก (หลาย MB / หลายพัน px) ทำให้ส่ง vision
 *   ช้า/แพง/ล้ม · และ OpenAI ย่อภาพภายในเหลือ ~2048px อยู่แล้ว → ส่งใหญ่กว่านั้นไม่ได้ความละเอียดเพิ่ม
 * วิธี: ถ้ารูปใหญ่เกินเกณฑ์ → downscale ให้ขอบยาวสุด ≤ MAX_EDGE + re-encode JPEG (คงความคมพออ่านเลข)
 *   + auto-orient จาก EXIF (รูปถ่ายมือถือมักตะแคง) — สำคัญกับการอ่านตัวเลข
 * ★ degrade ปลอดภัย: ไม่ใช่รูป / sharp พัง → คืนต้นฉบับ (ไม่ทำให้ flow ล้ม)
 */
import sharp from "sharp";

/** เกินขนาดนี้ค่อย downscale (รูปเล็กปล่อยผ่าน) */
const IMG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB (เดิม 4MB) — จับรูปหนักมาย่อมากขึ้น = ประหยัด token
/** ขอบยาวสุดหลังย่อ — ★ ลด 3000→1600px เพื่อคุมต้นทุน Gemini (image tokens ต่อใบลดครึ่ง)
 *   1600px ยังอ่านเลขบิล/ยอด/วันที่ชัด (ตัวเลขบิลใหญ่พอ) · สเตทเมนต์ส่วนใหญ่เป็น PDF (ไม่ผ่านฟังก์ชันนี้) */
const IMG_MAX_EDGE = 1600;

function isImageMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m.startsWith("image/") && !m.includes("pdf");
}

/** ขอบยาวสุดที่ "เล็กเกินกว่าจะเป็นบิลอ่านได้" — สติกเกอร์/emoji/ธัมบ์เนล LINE มัก ≤370px
 *   บิลจริง (ถ่าย/สแกน/สกรีนช็อต) ขอบยาว >1000px เสมอ · ถ้า <350px ต่อให้ยิง vision ก็อ่านตัวเลขไม่ออก
 *   → ปลอดภัยที่จะข้าม (ไม่เสีย flash call ทิ้งกับสติกเกอร์) */
const IMG_MIN_BILL_EDGE = 350;

/**
 * รูปนี้ "เล็กเกินกว่าจะเป็นบิล" ไหม (สติกเกอร์/emoji/ธัมบ์เนล) — ไว้กรองก่อนยิง vision (ประหยัด)
 * ★ conservative: true เฉพาะเมื่ออ่านขนาดได้จริง "และ" ขอบยาวสุด < เกณฑ์ · อ่านไม่ได้/PDF → false (ไม่กล้าข้าม)
 */
export async function isTooSmallToBeBill(data: Buffer, mime: string): Promise<boolean> {
  if (!isImageMime(mime)) return false;
  try {
    const meta = await sharp(data).metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    return longEdge > 0 && longEdge < IMG_MIN_BILL_EDGE;
  } catch {
    return false; // อ่าน metadata ไม่ได้ → ไม่กล้าข้าม (ปล่อยไป vision ตามเดิม)
  }
}

/**
 * ย่อรูปถ้าใหญ่เกินเกณฑ์ (ไม่ใช่รูป/เล็กพอ → คืนเดิม)
 * @returns { data, mime } พร้อมส่งเข้า vision
 */
export async function downscaleImageIfLarge(
  data: Buffer,
  mime: string,
): Promise<{ data: Buffer; mime: string }> {
  if (!isImageMime(mime)) return { data, mime };
  try {
    const meta = await sharp(data).metadata();
    const tooBig = data.length > IMG_MAX_BYTES;
    const tooWide = (meta.width ?? 0) > IMG_MAX_EDGE || (meta.height ?? 0) > IMG_MAX_EDGE;
    if (!tooBig && !tooWide) return { data, mime };

    const out = await sharp(data)
      .rotate() // auto-orient ตาม EXIF (รูปถ่ายมือถือตะแคง)
      .resize({ width: IMG_MAX_EDGE, height: IMG_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 }) // คมพออ่านตัวเลข + ลดขนาดมาก
      .toBuffer();
    return { data: out, mime: "image/jpeg" };
  } catch {
    return { data, mime }; // sharp พัง → ใช้ต้นฉบับ
  }
}
