import { describe, it, expect } from "vitest";
import { escapeCsvValue, buildCsv, type CsvColumn } from "@/lib/reports/csv";

describe("CSV export", () => {
  it("escape ค่าที่มี , \" หรือ newline (RFC 4180)", () => {
    expect(escapeCsvValue("abc")).toBe("abc");
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
    expect(escapeCsvValue('a"b')).toBe('"a""b"');
    expect(escapeCsvValue("a\nb")).toBe('"a\nb"');
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(4.5)).toBe("4.5");
  });

  it("buildCsv ใส่ BOM + หัวตาราง + แถวข้อมูล", () => {
    type Row = { team: string; score: number | null };
    const cols: CsvColumn<Row>[] = [
      { header: "ทีม", value: (r) => r.team },
      { header: "คะแนน", value: (r) => r.score },
    ];
    const out = buildCsv(
      [
        { team: "ทีม A", score: 4.5 },
        { team: "ทีม, B", score: null },
      ],
      cols
    );
    expect(out.charCodeAt(0)).toBe(0xfeff); // BOM
    const lines = out.slice(1).split("\r\n");
    expect(lines[0]).toBe("ทีม,คะแนน");
    expect(lines[1]).toBe("ทีม A,4.5");
    expect(lines[2]).toBe('"ทีม, B",'); // มี comma → คลุมด้วย quote; null → ว่าง
  });
});
