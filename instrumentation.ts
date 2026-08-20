/**
 * instrumentation.ts — รันครั้งเดียวตอนเซิร์ฟเวอร์บูต (ก่อนรับ request)
 *   ★ ตั้ง polyfill DOMMatrix/Path2D/ImageData ให้ globalThis "ก่อน" ที่ route ใดจะ dynamic-import
 *     pdf-parse (pdfjs) ตอน runtime → กัน "ReferenceError: DOMMatrix is not defined" บน serverless
 *   (เชื่อถือได้กว่าการวาง import ตามลำดับในไฟล์ เพราะ pdf-parse เป็น external ESM)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/accounting/pdfjs-polyfill");
  }
}
