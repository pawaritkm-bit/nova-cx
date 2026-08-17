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
const IMG_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
/** ขอบยาวสุดหลังย่อ — พอสำหรับอ่านเลขบิล/สเตทเมนต์ (สอดคล้องเพดาน tiling ~2048 ของ OpenAI + เผื่อ) */
const IMG_MAX_EDGE = 3000;

function isImageMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m.startsWith("image/") && !m.includes("pdf");
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
