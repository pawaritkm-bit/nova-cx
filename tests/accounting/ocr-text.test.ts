import { describe, expect, it } from "vitest";
import { joinOcrWords, type OcrTextWord } from "@/lib/accounting/ocr-text";

function words(parts: Array<[string, number, number]>): OcrTextWord[] {
  return parts.map(([text, x0, x1]) => ({ text, bbox: { x0, x1, y0: 0, y1: 20 } }));
}

describe("joinOcrWords", () => {
  it("รวมตัวอักษรและสระไทยที่ OCR แยกเป็นคำย่อย", () => {
    expect(joinOcrWords(words([
      ["ส", 0, 8], ["ิ", 8, 10], ["ง", 11, 19], ["ห", 21, 29],
      ["า", 30, 38], ["ค", 39, 47], ["ม", 48, 56],
    ]), 20)).toBe("สิงหาคม");
  });

  it("คงช่องว่างจริงระหว่างคำไทย", () => {
    expect(joinOcrWords(words([
      ["บางโคล่", 0, 55], ["บางคอแหลม", 64, 140],
    ]), 20)).toBe("บางโคล่ บางคอแหลม");
  });

  it("ไม่เติมช่องว่างก่อนเครื่องหมาย และคงช่องว่างอังกฤษ/ตัวเลข", () => {
    expect(joinOcrWords(words([
      ["ก", 0, 8], ["ท", 9, 17], ["ม", 18, 26], [".", 26, 29], ["10120", 38, 78],
    ]), 20)).toBe("กทม. 10120");
    expect(joinOcrWords(words([
      ["104", 0, 24], ["U", 30, 38], ["House", 44, 84],
    ]), 20)).toBe("104 U House");
  });
});
