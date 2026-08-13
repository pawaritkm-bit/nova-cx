/**
 * ช่วยพิมพ์ข้อความไทยผสมอังกฤษ/ตัวเลขใน pdfkit ให้ถูกต้อง (wishlist ข้อ 6 — สลิปเงินเดือน PDF)
 *
 * ★★★ ปัญหาที่ต้องแก้: @fontsource/sarabun แจกไฟล์ฟอนต์แยกเป็น "subset" ตาม unicode-range แบบ Google Fonts
 *   — ไฟล์ "thai" (sarabun-thai-400-normal.woff) มีแค่ตัวอักษรไทย (U+0E00–U+0E7F) เท่านั้น ไม่มีเลขอารบิก/
 *   จุด/จุลภาค/ทวิภาค/ขีด/วงเล็บ/em-dash เลย — ถ้าโหลดไฟล์นี้ไฟล์เดียวลง pdfkid ตัวเลขเงินเดือน+เครื่องหมาย
 *   วรรคตอนในสลิปจะหายไปเป็นช่องว่างเงียบ ๆ ไม่ error (verified ด้วย prototype: pdftotext + pdf-parse)
 * ★ วิธีแก้: ตัดข้อความเป็น "run" ต่อเนื่องตามว่าเป็นอักษรไทยหรือไม่ (splitRuns) แล้ววาดแต่ละ run ด้วยฟอนต์
 *   ที่ตรงกัน (sarabun-thai vs sarabun-latin) เลื่อน cursor เองด้วย widthOfString (pdfkit ไม่มี API สลับ
 *   ฟอนต์กลางสตริงเดียว)
 * ★★★ ห้าม require.resolve()/require() ไฟล์ .woff ตรง ๆ เด็ดขาด — webpack เห็น require.resolve(literal)
 *   แล้วพยายาม parse เนื้อไฟล์ปลายทางเป็นโมดูล JS ทันที (build พังจริง: "Module parse failed: Unexpected
 *   character" เพราะ .woff เป็นไบนารี ไม่มี loader) แก้โดย require.resolve() แค่ package.json (JSON ไฟล์ที่
 *   webpack มี loader ในตัวอยู่แล้ว ปลอดภัย) เพื่อหาโฟลเดอร์ราก แล้วประกอบ path ไฟล์ฟอนต์ด้วย path.join ธรรมดา
 *   — pdfkit เป็นคนอ่านไฟล์จริงตอน runtime ผ่าน fs.readFileSync ของมันเอง (ไม่ใช่ require) จึง webpack ไม่แตะเลย
 * ★★★ ยืนยันจริงด้วย browser QA (2026-08-13) — แค่ require.resolve() package.json ยังไม่พอ: webpack แปลง
 *   require.resolve(literal) เป็น __webpack_require__.resolve(...) เสมอไม่ว่า target จะเป็นไฟล์ประเภทไหน
 *   ซึ่งคืน "module id ภายใน" (เช่น "(rsc)/node_modules/...woff") ไม่ใช่ path จริงในระบบไฟล์ — ทำให้
 *   fs.readFileSync ของ pdfkit หา path ไม่พบ (ENOENT) แม้ build ผ่านเงียบ ๆ ก็ตาม ต้องใช้
 *   `__non_webpack_require__` (global พิเศษของ webpack ที่ตั้งใจให้ "ไม่ถูก webpack แปลง" อ้าง Node
 *   require จริงตรง ๆ) แทน — fallback เป็น require ปกติเมื่อรันนอก webpack (เช่น vitest/tsx)
 * ★ path ไฟล์ฟอนต์ที่ได้ต้องตรงกับที่ประกาศไว้ใน next.config.mjs::outputFileTracingIncludes เสมอ (Vercel
 *   serverless bundler @vercel/nft ใช้รายการนั้น copy ไฟล์ .woff ไปลง deployment จริง — ไม่ได้ trace จากที่นี่)
 */
import type PDFDocument from "pdfkit";
import path from "path";

declare const __non_webpack_require__: NodeRequire | undefined;
const nodeRequire: NodeRequire = typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : require;

const THAI_RE = /[฀-๿]/;

const SARABUN_FILES_DIR = path.join(path.dirname(nodeRequire.resolve("@fontsource/sarabun/package.json")), "files");

export const THAI_FONT_PATH = path.join(SARABUN_FILES_DIR, "sarabun-thai-400-normal.woff");
export const LATIN_FONT_PATH = path.join(SARABUN_FILES_DIR, "sarabun-latin-400-normal.woff");

export const FONT_THAI = "sarabun-thai";
export const FONT_LATIN = "sarabun-latin";

type Doc = InstanceType<typeof PDFDocument>;

/** ลงทะเบียนฟอนต์ไทย+ละตินทั้งคู่กับ doc — เรียกครั้งเดียวต่อ doc ก่อนใช้ drawMixedText/widthOfMixedText */
export function registerThaiFonts(doc: Doc): void {
  doc.registerFont(FONT_THAI, THAI_FONT_PATH);
  doc.registerFont(FONT_LATIN, LATIN_FONT_PATH);
}

type TextRun = { text: string; font: string };

/** ตัดข้อความเป็น run ต่อเนื่องตามอักษรไทย/ไม่ไทย (ไม่รวม whitespace เข้ากลุ่มไทยเสมอ — จัดตามฟอนต์ละตินร่วม) */
export function splitRuns(text: string): TextRun[] {
  if (!text) return [];
  const runs: TextRun[] = [];
  let current = "";
  let currentIsThai: boolean | null = null;
  for (const ch of text) {
    const isThai = THAI_RE.test(ch);
    if (currentIsThai === null || isThai === currentIsThai) {
      current += ch;
    } else {
      runs.push({ text: current, font: currentIsThai ? FONT_THAI : FONT_LATIN });
      current = ch;
    }
    currentIsThai = isThai;
  }
  if (current) runs.push({ text: current, font: currentIsThai ? FONT_THAI : FONT_LATIN });
  return runs;
}

/** ความกว้างข้อความไทยผสม ณ ขนาดฟอนต์ที่กำหนด (ต้อง registerThaiFonts มาก่อน) */
export function widthOfMixedText(doc: Doc, text: string, size: number): number {
  let width = 0;
  for (const run of splitRuns(text)) {
    doc.font(run.font).fontSize(size);
    width += doc.widthOfString(run.text);
  }
  return width;
}

/** วาดข้อความไทยผสม 1 บรรทัดที่ (x,y) — ชิดซ้ายเสมอ (จัดชิดขวา/กึ่งกลางให้ผู้เรียกคำนวณ x เองจาก widthOfMixedText) */
export function drawMixedText(doc: Doc, text: string, x: number, y: number, size: number): void {
  let cursorX = x;
  for (const run of splitRuns(text)) {
    doc.font(run.font).fontSize(size);
    doc.text(run.text, cursorX, y, { lineBreak: false });
    cursorX += doc.widthOfString(run.text);
  }
}

/** วาดข้อความไทยผสมชิดขวาที่ขอบ x=right (คำนวณความกว้างก่อนแล้ววาดชิดซ้ายจากจุดที่เลื่อนมา) */
export function drawMixedTextRightAligned(doc: Doc, text: string, right: number, y: number, size: number): void {
  const width = widthOfMixedText(doc, text, size);
  drawMixedText(doc, text, right - width, y, size);
}
