import { describe, it, expect } from "vitest";
import {
  classifyOldSummaryFile,
  parseCsvGrid,
  parseFlatStatementCsv,
  parseDeterministicSummaryCsv,
  parseOldSummary,
} from "@/lib/accounting/statement-cleanup";
import { buildStatementSummaryCsv } from "@/lib/accounting/statement-summary-csv";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

function tx(o: Partial<StatementTxn>): StatementTxn {
  return { date: null, description: null, counterparty_name: null, counterparty_account_no: null, direction: null, amount: null, ...o };
}

describe("classifyOldSummaryFile", () => {
  it("จับไฟล์สรุปเก่า 3 ชนิด", () => {
    expect(classifyOldSummaryFile("1699999999_abc-ผลอ่าน-statement.csv")).toBe("image");
    expect(classifyOldSummaryFile("สเตทเมนต์รวม 2026-08-24.csv")).toBe("albumV1");
    expect(classifyOldSummaryFile("นายสมชาย - สรุป.csv")).toBe("det");
  });
  it("เก็บไฟล์ที่ต้องไม่ลบ → null", () => {
    expect(classifyOldSummaryFile("ทดสอบ - สรุปสเตทเมนต์.xlsx")).toBeNull(); // ไฟล์รวมใหม่
    expect(classifyOldSummaryFile("นายเอ - วิเคราะห์รายรับ 2569.xlsx")).toBeNull(); // prospect
    expect(classifyOldSummaryFile("ร้านบี - ยอดขาย.csv")).toBeNull(); // platform
    expect(classifyOldSummaryFile("1699999999_x.jpg")).toBeNull(); // ต้นฉบับ
  });
});

describe("parseCsvGrid", () => {
  it("รองรับ quote/ลูกน้ำใน cell + escape", () => {
    const g = parseCsvGrid('a,"b,c","d""e"\r\n1,2,3');
    expect(g[0]).toEqual(["a", "b,c", 'd"e']);
    expect(g[1]).toEqual(["1", "2", "3"]);
  });
  it("ตัด BOM", () => {
    expect(parseCsvGrid("﻿a,b")[0]).toEqual(["a", "b"]);
  });
});

describe("parseFlatStatementCsv (รูป v0/v1)", () => {
  it("อ่าน txns จากตารางแบน + ข้ามบรรทัดจุดประสงค์ข้างบน", () => {
    const csv = [
      "จุดประสงค์ที่ลูกค้าส่ง: ขอวิเคราะห์รายรับ",
      "",
      "วันที่,รายละเอียด,คู่ค้า,ทิศทาง(in/out),จำนวนเงิน",
      "2026-08-01,รับโอน,นายเอ,in,1000",
      "2026-08-02,โอนออก,ร้านบี,out,250.5",
    ].join("\r\n");
    const t = parseFlatStatementCsv(csv);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ date: "2026-08-01", direction: "in", amount: 1000, counterparty_name: "นายเอ" });
    expect(t[1]).toMatchObject({ direction: "out", amount: 250.5 });
  });
});

describe("parseDeterministicSummaryCsv (สรุป.csv) — round-trip กับ buildStatementSummaryCsv", () => {
  it("ดึงชื่อธนาคาร + รายการทั้งหมดกลับมาได้", () => {
    const txns: StatementTxn[] = [
      tx({ date: "2026-08-01", description: "รับโอนจากเอ", direction: "in", amount: 5000 }),
      tx({ date: "2026-08-03", description: "จ่ายค่าของ", direction: "out", amount: 1200.75 }),
    ];
    const csv = buildStatementSummaryCsv(txns, "กสิกรไทย", null);
    const { bank, txns: parsed } = parseDeterministicSummaryCsv(csv);
    expect(bank).toBe("กสิกรไทย");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ date: "2026-08-01", direction: "in", amount: 5000 });
    expect(parsed[1]).toMatchObject({ date: "2026-08-03", direction: "out", amount: 1200.75 });
  });
});

describe("parseOldSummary dispatch", () => {
  it("det → มี bank · image → bank null", () => {
    const detCsv = buildStatementSummaryCsv([tx({ date: "2026-08-01", direction: "in", amount: 10 })], "ไทยพาณิชย์", null);
    expect(parseOldSummary("det", detCsv).bank).toBe("ไทยพาณิชย์");
    const flat = "วันที่,รายละเอียด,คู่ค้า,ทิศทาง(in/out),จำนวนเงิน\r\n2026-08-01,x,y,in,10";
    const r = parseOldSummary("image", flat);
    expect(r.bank).toBeNull();
    expect(r.txns).toHaveLength(1);
  });
});
