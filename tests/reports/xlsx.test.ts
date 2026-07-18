import { describe, it, expect } from "vitest";
import { buildXlsx, colLetter, escapeXml, XLSX_CONTENT_TYPE } from "@/lib/reports/xlsx";

describe("colLetter", () => {
  it("A..Z..AA", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
  });
});

describe("escapeXml", () => {
  it("escape อักขระพิเศษ", () => {
    expect(escapeXml('a & b < c > "d" \'e\'')).toBe("a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;");
  });
});

describe("buildXlsx — สร้างไฟล์ .xlsx จริง (zip)", () => {
  const buf = buildXlsx([
    { name: "รายงาน", rows: [["ตัวชี้วัด", "ค่า"], ["เคสทั้งหมด", 42], ["คะแนน", 89.5]] },
  ]);

  it("MIME type ถูกต้อง", () => {
    expect(XLSX_CONTENT_TYPE).toContain("spreadsheetml.sheet");
  });

  it("เป็น buffer เริ่มด้วย ZIP signature 'PK'", () => {
    expect(buf.length).toBeGreaterThan(200);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  it("มี End Of Central Directory signature (0x06054b50)", () => {
    // EOCD อยู่ท้ายไฟล์ (ไม่มี comment → 22 ไบต์สุดท้าย)
    const eocd = buf.readUInt32LE(buf.length - 22);
    expect(eocd).toBe(0x06054b50);
  });

  it("มี central directory + local file entries (นับ signature)", () => {
    const text = buf.toString("latin1");
    // local file header (PK\x03\x04) = 4 ส่วนหลัก + 1 sheet = 5 ส่วน
    const localCount = (text.match(/PK\x03\x04/g) ?? []).length;
    expect(localCount).toBe(5);
  });

  it("บรรจุ worksheet ที่มีข้อความไทย (inlineStr) + ตัวเลข", () => {
    const text = buf.toString("utf8");
    expect(text).toContain("เคสทั้งหมด");
    expect(text).toContain("<v>42</v>");
    expect(text).toContain("t=\"inlineStr\"");
  });

  it("ไม่ส่งชีต → สร้างชีตว่างได้ (ไม่ throw)", () => {
    const empty = buildXlsx([]);
    expect(empty[0]).toBe(0x50);
  });
});
