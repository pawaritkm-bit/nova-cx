/**
 * pdf-unlock.ts — ตรวจ/ปลดล็อก PDF ที่ติดรหัส (สเตทเมนต์ธนาคารไทยมักติดรหัส)
 *   ใช้ pdf-parse (pdfjs) ที่รองรับ LoadParameters.password + throw PasswordException เมื่อรหัสผิด
 *
 * แนวคิด: ลองรหัสจากแชทลูกค้าทีละตัวจน "เปิดได้จริง" (getText สำเร็จ) → ตัวนั้นคือรหัสที่ถูก
 *   ★ ทนที่สุด: ไม่ต้องเดาว่า "ข้อความไหนคือรหัส" — ลองจนเปิดได้เอง
 * ★ degrade ปลอดภัย: ปลดไม่ได้/อ่านไม่ได้ → คืน null (caller ตกไปหน้า "รอตรวจสอบ")
 * ★ PDPA: ห้าม log รหัส/เนื้อไฟล์ — log แค่ error สั้น ๆ
 */
import "@/lib/accounting/pdfjs-polyfill"; // ★ ต้องมาก่อน pdf-parse (polyfill DOMMatrix ให้ pdfjs โหลดได้บน serverless)
import { PDFParse, PasswordException } from "pdf-parse";

/** ลองดึง text ด้วย (อาจใส่รหัส) — สำเร็จคืน string · PasswordException โยนต่อ (รหัสผิด/ต้องรหัส) · error อื่น → null */
async function getTextWith(buffer: Buffer, password?: string): Promise<string | null> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse(password ? { data: buffer, password } : { data: buffer });
    const res = await parser.getText();
    return String((res as { text?: unknown })?.text ?? "");
  } catch (e) {
    if (e instanceof PasswordException) throw e;
    return null;
  } finally {
    try {
      await (parser as unknown as { destroy?: () => Promise<void> })?.destroy?.();
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** อ่าน text จาก PDF ที่ไม่ติดรหัส (digital) — ไว้ให้ classify · ติดรหัส/อ่านไม่ได้ → null */
export async function readPdfPlainText(buffer: Buffer): Promise<string | null> {
  try {
    return await getTextWith(buffer);
  } catch {
    return null; // PasswordException = ติดรหัส (ต้องใช้ unlockPdfToText แทน)
  }
}

/** true ถ้า PDF ติดรหัส (เปิดโดยไม่มีรหัสแล้วเจอ PasswordException) */
export async function isPdfEncrypted(buffer: Buffer): Promise<boolean> {
  try {
    await getTextWith(buffer);
    return false;
  } catch (e) {
    return e instanceof PasswordException;
  }
}

/**
 * ลองรหัสทีละตัวจนเปิดได้ → คืน { text, password } (text = เนื้อ PDF ที่ปลดแล้ว)
 *   เปิดไม่ได้ทุกตัว / รหัสว่าง → null
 */
export async function unlockPdfToText(
  buffer: Buffer,
  candidatePasswords: string[]
): Promise<{ text: string; password: string } | null> {
  const seen = new Set<string>();
  for (const raw of candidatePasswords) {
    const pw = (raw ?? "").trim();
    if (!pw || seen.has(pw)) continue;
    seen.add(pw);
    try {
      const text = await getTextWith(buffer, pw);
      if (text && text.trim().length > 0) return { text, password: pw };
    } catch {
      // PasswordException = รหัสตัวนี้ผิด → ลองตัวถัดไป
    }
  }
  return null;
}
