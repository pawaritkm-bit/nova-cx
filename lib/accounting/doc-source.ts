/**
 * doc-source.ts — แยกชนิด/คุณภาพเอกสาร เพื่อ route ไปโมเดลที่ถูกสุดที่อ่านได้แม่น
 *   - excel_csv     → parse ตรง (ฟรี ไม่ใช้ AI)          [จัดการที่ path text/parse]
 *   - digital_pdf   → PDF มี text layer → gpt-5-mini (ถูก) พิสูจน์แล้วว่าแม่นกับ text สะอาด
 *   - scan_or_image → สแกน/รูปถ่าย (ไม่มี text) → Claude Sonnet 5 (OCR แม่นกว่า)
 *
 * วิธีตรวจ digital vs scan: ลองดึง text layer จาก PDF ด้วย unpdf (serverless-native)
 *   - ดึงตัวอักษรได้มากพอ (>= DIGITAL_TEXT_MIN_CHARS) = ดิจิทัล
 *   - ดึงไม่ได้/ว่าง = สแกนเป็นภาพ (ต้อง OCR)
 * ★ PDPA: ไม่ log เนื้อ text ที่ดึงได้ — ใช้แค่ "ความยาว" ตัดสิน
 */
import { extractPdfLayoutText } from "@/lib/accounting/pdf-text";

export type DocSource = "excel_csv" | "digital_pdf" | "scan_or_image";

/** ต่ำกว่านี้ถือว่าไม่มี text layer (เป็นสแกน) — เผื่อ PDF สแกนที่มี metadata/ตัวอักษรปนนิดหน่อย */
const DIGITAL_TEXT_MIN_CHARS = 100;

export async function classifyDocSource(mime: string, buffer: Buffer): Promise<DocSource> {
  const m = (mime || "").toLowerCase();

  // Excel / CSV → parse ตรง
  if (
    m.includes("excel") ||
    m.includes("spreadsheet") ||
    m.includes("sheet") ||
    m.includes("csv") ||
    m.includes("ms-excel")
  ) {
    return "excel_csv";
  }

  // ไฟล์รูป → สแกนเสมอ
  if (m.startsWith("image/")) return "scan_or_image";

  // PDF → ตรวจ text layer
  if (m.includes("pdf")) {
    try {
      const raw = await extractPdfLayoutText(buffer);
      const text = String(raw ?? "").replace(/\s+/g, " ").trim();
      return text.length >= DIGITAL_TEXT_MIN_CHARS ? "digital_pdf" : "scan_or_image";
    } catch {
      // ติดรหัส/อ่าน text layer ไม่ได้ → ปลอดภัยไว้ก่อน ถือเป็นสแกน (ให้ Claude OCR / ไป unlock ต่อ)
      return "scan_or_image";
    }
  }

  // อื่น ๆ ที่ไม่รู้จัก → ให้ Claude ลองอ่านแบบภาพ
  return "scan_or_image";
}
