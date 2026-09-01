/**
 * pdf-page-images.ts — เรนเดอร์ PDF เป็นรูป PNG รายหน้า (server-only)
 *
 * ใช้กับฟีเจอร์ "ตัดรูปจากไฟล์ PDF: 1 รูปต่อ 1 บิล" (requirement 2026-09-01):
 *   ไฟล์สแกนหลายบิล (1 บิล/หน้า) → AI แยกบิล → เมื่อจำนวนบิล = จำนวนหน้า ให้แต่ละบิล
 *   ได้ "รูปหน้าของตัวเอง" แทนการแชร์ PDF ทั้งไฟล์ → หน้าตรวจบิลโชว์รูป + ซูม/หมุน/OCR ได้
 *
 * ★ ใช้ unpdf (pdfjs) + @napi-rs/canvas (มากับ pdf-parse — binary ครบทุก platform รวม Vercel)
 * ★ import แบบ dynamic ในฟังก์ชัน — ไม่โหลด pdfjs/canvas ตอน cold start ถ้าไม่ได้ใช้
 * ★ best-effort ล้วน: พลาด/ไฟล์แปลก → คืน null (ผู้เรียกใช้ PDF เดิมต่อ) ไม่ throw
 */

/** เพดานจำนวนหน้า (กันไฟล์ผิดปกติกิน CPU/เวลา serverless) */
const MAX_PAGES = 40;
/** scale การเรนเดอร์ — 2 = ~1200x1700px ต่อหน้า A4 (คมพอสำหรับซูม/OCR, ~0.5-0.8MB/หน้า) */
const RENDER_SCALE = 2;

/** นับจำนวนหน้าของ PDF — null = อ่านไม่ได้ */
export async function pdfPageCount(buf: Buffer): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    return pdf.numPages;
  } catch {
    return null;
  }
}

/**
 * เรนเดอร์ทุกหน้าเป็น PNG (เรียงตามหน้า) — null = เรนเดอร์ไม่ได้/หน้าเกินเพดาน
 *   ★ ส่งสำเนา buffer ใหม่ต่อหน้า (pdfjs transfer buffer ทิ้งหลังใช้ — ใช้ซ้ำแล้ว DataCloneError)
 */
export async function renderPdfPagesToPng(buf: Buffer): Promise<Buffer[] | null> {
  try {
    const pages = await pdfPageCount(buf);
    if (!pages || pages < 1 || pages > MAX_PAGES) return null;
    const { renderPageAsImage } = await import("unpdf");
    const out: Buffer[] = [];
    for (let p = 1; p <= pages; p++) {
      const img = await renderPageAsImage(new Uint8Array(buf), p, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: RENDER_SCALE,
      });
      out.push(Buffer.from(img));
    }
    return out;
  } catch {
    return null;
  }
}
