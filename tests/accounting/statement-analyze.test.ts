import { describe, it, expect } from "vitest";
import {
  normalizeCounterparty,
  bkkMonthKey,
  summarizeByMonth,
  findRepeatCounterparties,
  MIN_REPEAT,
  type StatementTxn,
} from "@/lib/accounting/statement-analyze";
import { normalizeStatementExtraction } from "@/lib/accounting/statement-extract";

/**
 * เทสต์ helper pure ของฟีเจอร์ "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (Phase 1):
 *   1) normalizeCounterparty — ตัดคำนำหน้า/ยุบช่องว่าง ให้ชื่อคนเดียวกันจับกลุ่มเดียว
 *   2) bkkMonthKey — ตัดเดือนตามเวลาไทย (วันที่ล้วน + timestamp คร่อมวัน)
 *   3) summarizeByMonth — รวมยอดเข้า/ออก + จำนวนต่อเดือน
 *   4) findRepeatCounterparties — จับคนโอนซ้ำ (>= MIN_REPEAT) แยกทิศทาง
 *   5) normalizeStatementExtraction — แปลงผลดิบจากโมเดล (in/out, พ.ศ.→ค.ศ., amount บวก)
 */

const t = (o: Partial<StatementTxn>): StatementTxn => ({
  date: null,
  description: null,
  counterparty_name: null,
  direction: null,
  amount: null,
  ...o,
});

describe("normalizeCounterparty", () => {
  it("ตัดคำนำหน้าชื่อไทย → 'นายสมชาย ใจดี' == 'สมชาย ใจดี'", () => {
    expect(normalizeCounterparty("นายสมชาย ใจดี")).toBe(normalizeCounterparty("สมชาย ใจดี"));
  });
  it("ตัดกริยาโอน + ยุบช่องว่าง", () => {
    expect(normalizeCounterparty("โอนเงินจาก   นางสาว  มาลี")).toBe("มาลี");
  });
  it("latin → ตัวพิมพ์เล็ก", () => {
    expect(normalizeCounterparty("John SHOP")).toBe("john shop");
  });
  it("ค่าว่าง/null → ''", () => {
    expect(normalizeCounterparty(null)).toBe("");
    expect(normalizeCounterparty("   ")).toBe("");
  });
});

describe("bkkMonthKey (เวลาไทย)", () => {
  it("วันที่ล้วน → ตัด YYYY-MM ตรง ๆ", () => {
    expect(bkkMonthKey("2026-07-15")).toBe("2026-07");
  });
  it("timestamp ก่อนเที่ยงคืน UTC → ขยับเป็นวันไทยถัดไป (คร่อมเดือน)", () => {
    // 2026-06-30 18:00 UTC = 2026-07-01 01:00 เวลาไทย → เดือน 07
    expect(bkkMonthKey("2026-06-30T18:00:00Z")).toBe("2026-07");
  });
  it("parse ไม่ได้ → null", () => {
    expect(bkkMonthKey("ไม่ใช่วันที่")).toBeNull();
    expect(bkkMonthKey(null)).toBeNull();
  });
});

describe("summarizeByMonth", () => {
  it("รวมยอดเข้า/ออก + จำนวน แยกเดือน เรียงใหม่→เก่า", () => {
    const rows: StatementTxn[] = [
      t({ date: "2026-07-01", direction: "in", amount: 1000 }),
      t({ date: "2026-07-05", direction: "in", amount: 500 }),
      t({ date: "2026-07-10", direction: "out", amount: 300 }),
      t({ date: "2026-06-20", direction: "out", amount: 200 }),
    ];
    const s = summarizeByMonth(rows);
    expect(s.map((m) => m.month)).toEqual(["2026-07", "2026-06"]);
    const jul = s[0];
    expect(jul.inTotal).toBe(1500);
    expect(jul.inCount).toBe(2);
    expect(jul.outTotal).toBe(300);
    expect(jul.count).toBe(3);
  });
  it("รายการไม่มีวันที่ → กลุ่ม '' อยู่ท้ายสุด", () => {
    const s = summarizeByMonth([
      t({ date: "2026-07-01", direction: "in", amount: 1 }),
      t({ date: null, direction: "in", amount: 9 }),
    ]);
    expect(s[s.length - 1].month).toBe("");
  });
});

describe("findRepeatCounterparties", () => {
  it("จับคนโอนเข้าซ้ำ >= MIN_REPEAT + รวมยอด + เลือกชื่อแสดง", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "นายสมชาย ใจดี", direction: "in", amount: 100 }),
      t({ counterparty_name: "สมชาย ใจดี", direction: "in", amount: 200 }),
      t({ counterparty_name: "มาลี", direction: "in", amount: 50 }), // ครั้งเดียว → ไม่ติด
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(1);
    expect(r[0].direction).toBe("in");
    expect(r[0].count).toBe(2);
    expect(r[0].total).toBe(300);
  });
  it("แยกทิศทาง — คนเดียวโอนเข้า/ออก นับแยกกัน", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "ร้าน A", direction: "in", amount: 10 }),
      t({ counterparty_name: "ร้าน A", direction: "in", amount: 20 }),
      t({ counterparty_name: "ร้าน A", direction: "out", amount: 30 }),
      t({ counterparty_name: "ร้าน A", direction: "out", amount: 40 }),
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(2);
    expect(r.find((x) => x.direction === "in")?.total).toBe(30);
    expect(r.find((x) => x.direction === "out")?.total).toBe(70);
  });
  it("ข้ามรายการที่ไม่มีชื่อ/ไม่ระบุทิศทาง", () => {
    const r = findRepeatCounterparties([
      t({ counterparty_name: null, direction: "in", amount: 1 }),
      t({ counterparty_name: null, direction: "in", amount: 1 }),
      t({ counterparty_name: "X", direction: null, amount: 1 }),
      t({ counterparty_name: "X", direction: null, amount: 1 }),
    ]);
    expect(r.length).toBe(0);
  });
  it("MIN_REPEAT = 2", () => {
    expect(MIN_REPEAT).toBe(2);
  });
});

describe("normalizeStatementExtraction (ผลดิบจากโมเดล)", () => {
  it("รองรับ {transactions:[...]} + map direction + amount บวก", () => {
    const out = normalizeStatementExtraction({
      transactions: [
        { date: "2026-07-01", description: "โอนเข้า", counterparty_name: "สมชาย", direction: "in", amount: 1000 },
        { date: "2026-07-02", description: "ถอน", counterparty_name: null, direction: "out", amount: 500 },
      ],
    });
    expect(out.length).toBe(2);
    expect(out[0].direction).toBe("in");
    expect(out[1].direction).toBe("out");
  });
  it("แปลงปี พ.ศ. → ค.ศ. (2569 → 2026)", () => {
    const out = normalizeStatementExtraction({ transactions: [{ date: "2569-07-15", amount: 5 }] });
    expect(out[0].date).toBe("2026-07-15");
  });
  it("amount ติดลบ → เดา direction=out + เก็บค่าบวก", () => {
    const out = normalizeStatementExtraction({ transactions: [{ date: "2026-07-01", amount: -300, counterparty_name: "ร้าน" }] });
    expect(out[0].direction).toBe("out");
    expect(out[0].amount).toBe(300);
  });
  it("map คำไทย/อังกฤษ (deposit/ฝาก/ถอน) → in/out", () => {
    const out = normalizeStatementExtraction({
      transactions: [
        { date: "2026-07-01", amount: 1, direction: "deposit" },
        { date: "2026-07-01", amount: 1, direction: "ถอน" },
        { date: "2026-07-01", amount: 1, direction: "Credit" },
      ],
    });
    expect(out.map((x) => x.direction)).toEqual(["in", "out", "in"]);
  });
  it("ตัดลูกน้ำหลักพันใน amount ที่เป็น string", () => {
    const out = normalizeStatementExtraction({ transactions: [{ date: "2026-07-01", amount: "12,500.50", counterparty_name: "x" }] });
    expect(out[0].amount).toBe(12500.5);
  });
  it("ข้ามแถวขยะ (ไม่มีวันที่/ยอด/ชื่อ)", () => {
    const out = normalizeStatementExtraction({ transactions: [{ description: "ยอดยกมา" }] });
    expect(out.length).toBe(0);
  });
  it("null → []", () => {
    expect(normalizeStatementExtraction(null)).toEqual([]);
  });
});
