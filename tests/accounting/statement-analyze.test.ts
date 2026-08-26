import { describe, it, expect } from "vitest";
import {
  normalizeCounterparty,
  normalizeAccountNo,
  bkkMonthKey,
  summarizeByMonth,
  findRepeatCounterparties,
  MIN_REPEAT,
  type StatementTxn,
} from "@/lib/accounting/statement-analyze";
import { isUsableStatementExtraction, normalizeStatementExtraction } from "@/lib/accounting/statement-extract";

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
  counterparty_account_no: null,
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

describe("normalizeAccountNo", () => {
  it("เก็บเฉพาะตัวเลข/x ตัดขีด/วรรคทิ้ง", () => {
    expect(normalizeAccountNo("x-xxxx-x1234-x")).toBe("xxxxxx1234x");
    expect(normalizeAccountNo("123-4-56789-0")).toBe("1234567890");
  });
  it("สั้นกว่า 6 ตัว (หลัง normalize) → '' (ไม่น่าเชื่อถือพอจะจับคู่)", () => {
    expect(normalizeAccountNo("12-3")).toBe("");
    expect(normalizeAccountNo("")).toBe("");
    expect(normalizeAccountNo(null)).toBe("");
  });
  it("ตัวพิมพ์ใหญ่ X → ตัวพิมพ์เล็ก", () => {
    expect(normalizeAccountNo("XXX-123456")).toBe(normalizeAccountNo("xxx-123456"));
  });
});

describe("findRepeatCounterparties — จับกลุ่มด้วยเลขบัญชี (แก้บั๊ก B, 2026-08-12)", () => {
  it("เลขบัญชีตรงกัน ชื่อสะกดต่างกัน → จับกลุ่มเดียวกัน (แม่นกว่าจับด้วยชื่ออย่างเดียว)", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "รับโอนจาก นายสมชาย ใจดี", counterparty_account_no: "1-2345-67890-1", direction: "in", amount: 100 }),
      t({ counterparty_name: "SOMCHAI J.", counterparty_account_no: "1-2345-67890-1", direction: "in", amount: 200 }),
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(1);
    expect(r[0].accountNo).toBe("1-2345-67890-1");
    expect(r[0].count).toBe(2);
    expect(r[0].total).toBe(300);
  });
  it("เลขบัญชีเดียวกัน แต่บางแถวไม่มีเลขบัญชี (มีแค่ชื่อ) → ยังผูกเข้ากลุ่มเดียวกันได้ (link ผ่านชื่อ)", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "สมชาย ใจดี", counterparty_account_no: "1-2345-67890-1", direction: "in", amount: 100 }),
      t({ counterparty_name: "สมชาย ใจดี", counterparty_account_no: "1-2345-67890-1", direction: "in", amount: 100 }),
      // แถวนี้ไม่มีเลขบัญชี — ต้องผูกเข้ากลุ่มเดิมผ่านชื่อที่เคยเห็นคู่กับเลขบัญชีนี้มาก่อน
      t({ counterparty_name: "สมชาย ใจดี", counterparty_account_no: null, direction: "in", amount: 50 }),
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(1);
    expect(r[0].count).toBe(3);
    expect(r[0].total).toBe(250);
    expect(r[0].accountNo).toBe("1-2345-67890-1");
  });
  it("ชื่อเดียวกันแต่เลขบัญชีต่างกันจริง → แยกกลุ่มกัน (เลขบัญชีตรงมาก่อนชื่อเสมอ)", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "111-1-11111-1", direction: "out", amount: 10 }),
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "111-1-11111-1", direction: "out", amount: 10 }),
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "222-2-22222-2", direction: "out", amount: 20 }),
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "222-2-22222-2", direction: "out", amount: 20 }),
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(2);
    expect(r.every((x) => x.count === 2)).toBe(true);
  });
  it("ไม่มีเลขบัญชีเลยในทั้งไฟล์ → fallback กลับไปจับกลุ่มด้วยชื่ออย่างเดียว (backward compatible, accountNo=null)", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "นายสมชาย ใจดี", direction: "in", amount: 100 }),
      t({ counterparty_name: "สมชาย ใจดี", direction: "in", amount: 200 }),
    ];
    const r = findRepeatCounterparties(rows);
    expect(r.length).toBe(1);
    expect(r[0].accountNo).toBeNull();
    expect(r[0].count).toBe(2);
  });

  /** ★ 2026-08-12 — แก้ตาม independent review: ชื่อกำกวม (เคยจับคู่ 2 เลขบัญชีต่างกันจริง) ต้องไม่เดา/ไม่ผูก
   *   อัตโนมัติ (เดิมใช้วิธี "โหวตเลือกเลขที่พบบ่อยสุด" ซึ่งเสี่ยงเชื่อมผิดกลุ่มเงียบ ๆ เมื่อกำกวมจริง) */
  it("ชื่อเดียวกันเคยจับคู่ 2 เลขบัญชีต่างกันจริง (กำกวม) → แถวไม่มีเลขบัญชี ต้องไม่ถูกผูกเดา แยกเป็นกลุ่มชื่ออย่างเดียวของตัวเอง", () => {
    const rows: StatementTxn[] = [
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "111-1-11111-1", direction: "out", amount: 10 }),
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: "222-2-22222-2", direction: "out", amount: 20 }),
      // แถวนี้ไม่มีเลขบัญชี — ชื่อ "ร้านค้า A" กำกวม (เจอคู่กับ 2 เลขบัญชีต่างกันแล้ว) ต้องไม่เดาว่าเป็นเลขไหน
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: null, direction: "out", amount: 30 }),
      t({ counterparty_name: "ร้านค้า A", counterparty_account_no: null, direction: "out", amount: 30 }),
    ];
    const r = findRepeatCounterparties(rows);
    // ต้องได้ 1 กลุ่ม: "ร้านค้า A" (ชื่ออย่างเดียว, accountNo=null) จาก 2 แถวที่ไม่มีเลขบัญชี — MIN_REPEAT=2
    // ส่วน 2 แถวที่มีเลขบัญชี (111.../222...) คนละกลุ่ม คนละแถวเดียว ไม่ถึง MIN_REPEAT จึงไม่ติดผลลัพธ์
    expect(r.length).toBe(1);
    expect(r[0].accountNo).toBeNull();
    expect(r[0].name).toBe("ร้านค้า A");
    expect(r[0].count).toBe(2);
    expect(r[0].total).toBe(60);
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
  it("ข้ามแถวขยะ (ไม่มีวันที่/ยอด/ชื่อ/เลขบัญชี)", () => {
    const out = normalizeStatementExtraction({ transactions: [{ description: "ยอดยกมา" }] });
    expect(out.length).toBe(0);
  });
  it("null → []", () => {
    expect(normalizeStatementExtraction(null)).toEqual([]);
  });

  /** ★ 2026-08-12 (แก้บั๊ก B) — อ่านเลขบัญชีคู่ค้าเป็นฟิลด์แยกจากชื่อ */
  it("อ่าน counterparty_account_no (รองรับชื่อ field สำรอง account_no/account_number/accountNo ด้วย)", () => {
    const out = normalizeStatementExtraction({
      transactions: [
        { date: "2026-07-01", amount: 1, counterparty_account_no: "1-2345-67890-1" },
        { date: "2026-07-02", amount: 1, account_no: "111-222-333" },
        { date: "2026-07-03", amount: 1, account_number: "444-555-666" },
        { date: "2026-07-04", amount: 1, accountNo: "777-888-999" },
      ],
    });
    expect(out.map((x) => x.counterparty_account_no)).toEqual([
      "1-2345-67890-1",
      "111-222-333",
      "444-555-666",
      "777-888-999",
    ]);
  });
  it("แถวที่มีแค่เลขบัญชี (ไม่มีวันที่/ยอด/ชื่อ) → ไม่ถูกข้ามเป็นแถวขยะ", () => {
    const out = normalizeStatementExtraction({ transactions: [{ counterparty_account_no: "1-2345-67890-1" }] });
    expect(out.length).toBe(1);
  });

  it("quality gate รับผลที่ช่องหลักครบ และปฏิเสธผล OCR ที่ขาดข้อมูล", () => {
    expect(isUsableStatementExtraction([
      { date: "2026-07-01", description: null, counterparty_name: null, counterparty_account_no: null, direction: "in", amount: 100 },
    ])).toBe(true);
    expect(isUsableStatementExtraction([
      { date: "2026-07-01", description: null, counterparty_name: null, counterparty_account_no: null, direction: null, amount: 100 },
    ])).toBe(false);
  });
});
