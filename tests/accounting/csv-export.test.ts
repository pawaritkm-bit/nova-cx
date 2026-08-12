import { describe, it, expect } from "vitest";
import { toCsv } from "@/lib/accounting/csv-export";

describe("toCsv", () => {
  it("ต่อ header + rows ด้วย comma และ CRLF ตามปกติ", () => {
    const csv = toCsv(["a", "b"], [["1", "2"], ["3", "4"]]);
    expect(csv.replace(/^﻿/, "")).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("prepend UTF-8 BOM (U+FEFF) เสมอ ให้ Excel เปิดภาษาไทยไม่เพี้ยน", () => {
    const csv = toCsv(["a"], [["ทดสอบ"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("quote field ที่มี comma", () => {
    const csv = toCsv(["a"], [["1,000.00"]]);
    expect(csv).toContain('"1,000.00"');
  });

  it("quote field ที่มี double quote แล้ว escape เป็นสองตัว", () => {
    const csv = toCsv(["a"], [['say "hi"']]);
    expect(csv).toContain('"say ""hi"""');
  });

  it("quote field ที่มี newline", () => {
    const csv = toCsv(["a"], [["line1\nline2"]]);
    expect(csv).toContain('"line1\nline2"');
  });

  it("null → cell ว่าง (ไม่ใช่ข้อความ 'null')", () => {
    const csv = toCsv(["a"], [[null]]);
    expect(csv.replace(/^﻿/, "")).toBe("a\r\n");
  });

  it("number → แปลงเป็นข้อความตรง ๆ ไม่มี quote", () => {
    const csv = toCsv(["a"], [[1000]]);
    expect(csv.replace(/^﻿/, "")).toBe("a\r\n1000");
  });

  it("rows ว่าง → คืนแค่ header", () => {
    const csv = toCsv(["a", "b"], []);
    expect(csv.replace(/^﻿/, "")).toBe("a,b");
  });
});
