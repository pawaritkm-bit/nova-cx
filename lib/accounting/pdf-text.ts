/**
 * pdf-text.ts — ดึง text จาก PDF ด้วย unpdf (pdfjs build สำหรับ serverless — ไม่พึ่ง DOM)
 *   ★ แทน pdf-parse/pdfjs-dist ที่ crash บน Vercel serverless ("DOMMatrix is not defined")
 *   unpdf ใช้ pdfjs รุ่น serverless ในตัว → ไม่ต้อง polyfill DOMMatrix/Path2D
 *
 * layout reconstruction: getTextContent ให้ text items พร้อมตำแหน่ง (transform[4]=x, [5]=y)
 *   → เรียงตาม y(บนลงล่าง) แล้ว x(ซ้ายไปขวา) → จับกลุ่มเป็น "บรรทัด" ตามระยะ y ใกล้กัน
 *   ทำให้ได้ layout ใกล้เคียงสายตา (สำคัญมากกับ parser สเตทเมนต์ที่ยึดตำแหน่งคอลัมน์)
 *
 * ★ PDPA: ไม่ log เนื้อ text/รหัส — โยน error สั้น ๆ เท่านั้น
 */
import { getDocumentProxy } from "unpdf";

/** ระยะ y ที่ถือว่าเป็นคนละบรรทัด (หน่วย pdf point) */
const LINE_Y_THRESHOLD = 2.5;

type PdfTextItem = { str: string; transform: number[] };

/** true ถ้า error คือ "ต้องใส่รหัส/รหัสผิด" ของ pdfjs (unpdf ไม่ได้ re-export class → เช็คด้วย name) */
export function isPdfPasswordError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  const msg = String((e as { message?: unknown } | null)?.message ?? "");
  return name === "PasswordException" || /password/i.test(msg);
}

/**
 * ดึง text แบบรักษา layout — ใส่ password ได้ (สเตทเมนต์ติดรหัส)
 *   - PDF ติดรหัสแต่ไม่ใส่/ใส่ผิด → โยน error (name=PasswordException) ให้ caller จัดการ
 *   - error อื่น → โยนต่อ
 */
export async function extractPdfLayoutText(buffer: Buffer, password?: string): Promise<string> {
  const data = new Uint8Array(buffer);
  const opts = (password ? { password } : {}) as Record<string, unknown>;
  const pdf = await getDocumentProxy(data, opts);
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as PdfTextItem[]).filter(
      (i) => typeof i?.str === "string" && i.str.length > 0
    );
    // เรียง: y มากก่อน (บนสุดของหน้า) → x น้อยก่อน (ซ้ายไปขวา)
    items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    const lines: string[] = [];
    let cur = "";
    let lastY: number | null = null;
    for (const it of items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > LINE_Y_THRESHOLD) {
        lines.push(cur);
        cur = "";
      }
      cur += (cur ? "\t" : "") + it.str;
      lastY = y;
    }
    if (cur) lines.push(cur);
    pages.push(lines.join("\n"));
  }
  return pages.join("\n");
}
