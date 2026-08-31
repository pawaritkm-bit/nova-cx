export type OcrTextWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

const THAI = /[\u0E00-\u0E7F]/u;
const THAI_MARK_ONLY = /^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+$/u;
const NO_SPACE_BEFORE = /^[.,:;!?%\)\]\}]/u;
const NO_SPACE_AFTER = /[\(\[\{]$/u;

/**
 * ต่อคำจาก Tesseract โดยอิงทั้งตัวอักษรและระยะจริงบนภาพ
 *
 * OCR ภาษาไทยมักคืนพยัญชนะ/สระเป็น word แยกกัน ถ้า join ด้วยช่องว่างเสมอ
 * จะได้ข้อความแบบ "ส ิ ง ห า ค ม" ฟังก์ชันนี้ลบเฉพาะช่องว่างเล็กระดับตัวอักษร
 * แต่ยังเก็บช่องว่างจริงระหว่างคำ รวมถึงข้อความอังกฤษและตัวเลขไว้
 */
export function joinOcrWords(words: OcrTextWord[], medianHeight: number): string {
  const clean = words
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text);
  if (clean.length === 0) return "";

  const thaiLetterGap = Math.max(2, medianHeight * 0.24);
  let result = clean[0].text;

  for (let index = 1; index < clean.length; index += 1) {
    const previous = clean[index - 1];
    const current = clean[index];
    const gap = Math.max(0, current.bbox.x0 - previous.bbox.x1);
    const bothThai = THAI.test(previous.text) && THAI.test(current.text);
    const noSpace = THAI_MARK_ONLY.test(current.text)
      || NO_SPACE_BEFORE.test(current.text)
      || NO_SPACE_AFTER.test(previous.text)
      || (bothThai && gap <= thaiLetterGap);

    result += `${noSpace ? "" : " "}${current.text}`;
  }

  return result.normalize("NFC");
}
