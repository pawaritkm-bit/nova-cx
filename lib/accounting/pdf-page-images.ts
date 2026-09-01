/**
 * pdf-page-images.ts — เรนเดอร์ PDF เป็นรูป PNG รายหน้า (server-only)
 *
 * ใช้กับฟีเจอร์ "ตัดรูปจากไฟล์ PDF: 1 รูปต่อ 1 บิล" (requirement 2026-09-01):
 *   ไฟล์สแกนหลายบิล (1 บิล/หน้า) → แต่ละบิลได้ "รูปหน้าของตัวเอง" → โชว์รูป/ซูม/หมุน/OCR ได้
 *
 * ★ ใช้ pdfjs-dist (legacy build) ตรง ๆ + @napi-rs/canvas — ห้ามใช้ unpdf เรนเดอร์:
 *   บิลสแกนจากเครื่องถ่ายเอกสารมักบีบอัดแบบ JBIG2 ซึ่ง build ของ unpdf ถอดไม่ได้
 *   ("JBig2 failed to initialize" → ได้หน้าขาวเปล่า — เจอจริงกับสแกนของลูกค้า 2026-09-01)
 *   ส่วน pdfjs-dist ตัวเต็มมี JBIG2 decoder ในตัว (ทั้งคู่อยู่ใน serverExternalPackages แล้ว)
 * ★ กันภาพเปล่า: สุ่มพิกเซลตรวจ "ความขาว" — ทั้งไฟล์ขาวล้วน = ถือว่าเรนเดอร์ไม่ได้ (คืน null
 *   ให้ผู้เรียกใช้ PDF เดิม) กันบิลรูปขาวหลุดไปหน้าตรวจ
 * ★ import แบบ dynamic ในฟังก์ชัน — ไม่โหลด pdfjs/canvas ตอน cold start ถ้าไม่ได้ใช้
 * ★ best-effort ล้วน: พลาด/ไฟล์แปลก → คืน null ไม่ throw
 */

/** เพดานจำนวนหน้า (กันไฟล์ผิดปกติกิน CPU/เวลา serverless) */
const MAX_PAGES = 40;
/** scale การเรนเดอร์ — 2 = ~1200x1700px ต่อหน้า A4 (คมพอสำหรับซูม/OCR/AI) */
const RENDER_SCALE = 2;
/** สัดส่วนพิกเซล "ไม่ขาว" ขั้นต่ำที่นับว่าหน้ามีเนื้อหา (0.2% ของจุดที่สุ่ม) */
const MIN_INK_RATIO = 0.002;

/* eslint-disable @typescript-eslint/no-explicit-any */

async function loadPdfjs(): Promise<any> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** นับจำนวนหน้าของ PDF — null = อ่านไม่ได้ */
export async function pdfPageCount(buf: Buffer): Promise<number | null> {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const n = doc.numPages as number;
    await doc.destroy();
    return n;
  } catch {
    return null;
  }
}

/**
 * เรนเดอร์ทุกหน้าเป็น PNG (เรียงตามหน้า) — null = เรนเดอร์ไม่ได้/หน้าเกินเพดาน/ได้แต่หน้าขาวล้วน
 */
export async function renderPdfPagesToPng(buf: Buffer): Promise<Buffer[] | null> {
  try {
    const pdfjs = await loadPdfjs();
    const { createCanvas } = await import("@napi-rs/canvas");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
    const pages = doc.numPages as number;
    if (!pages || pages < 1 || pages > MAX_PAGES) {
      await doc.destroy();
      return null;
    }

    const out: Buffer[] = [];
    let anyInk = false;
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      // พื้นหลังขาว (หน้า PDF โปร่งใส → PNG ดำทั้งหน้า)
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as any, viewport: vp }).promise;

      // ตรวจความขาว (สุ่ม grid ~40x40 จุด)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const stepX = Math.max(1, Math.floor(canvas.width / 40));
      const stepY = Math.max(1, Math.floor(canvas.height / 40));
      let ink = 0;
      let total = 0;
      for (let y = 0; y < canvas.height; y += stepY) {
        for (let x = 0; x < canvas.width; x += stepX) {
          const i = (y * canvas.width + x) * 4;
          total++;
          if (img.data[i] < 235 || img.data[i + 1] < 235 || img.data[i + 2] < 235) ink++;
        }
      }
      if (total > 0 && ink / total >= MIN_INK_RATIO) anyInk = true;

      out.push(canvas.toBuffer("image/png"));
    }
    await doc.destroy();

    // ทุกหน้าขาวล้วน = decoder อ่านเนื้อไม่ออก (เช่น codec แปลก) → อย่าใช้รูปเปล่า
    if (!anyInk) return null;
    return out;
  } catch {
    return null;
  }
}
