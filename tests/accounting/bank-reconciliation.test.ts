import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import type { JournalLine } from "@/lib/accounting/journal";

/**
 * เทสต์ lib/accounting/bank-reconciliation.ts (เฟส 6 ส่วน T, T50/T51/T53)
 *   - parseBankStatementCsv: ทุก edge case ของ 0.13 (BOM/CRLF/quoted comma/แถวว่าง/แถวผิดรูปแบบ/header)
 *   - buildBookLines/bookLineKeyOf: คีย์ไม่ชนกัน (0.15)
 *   - suggestMatches: ขอบเขต 7-8 วันพอดี + ไม่แนะนำคู่ที่จับคู่แล้ว (0.17)
 *   - buildReconciliationSummary: book/statement balance + unmatched diff (0.18)
 *   - isMatchStale: เทียบ snapshot (0.16)
 *   - data layer (fake DB in-memory mirror pattern เทสต์อื่นในเฟส 6): import/confirm/unmatch/delete/list
 *   - listBookLines: wrap buildJournalEntries+loadCombinedJournalLines (mock ชั้น DB ของทั้งสอง — 0.14)
 */

// ---------------------------------------------------------------------
// mock listEntries (queries.ts) + loadCombinedJournalLines (statement-inputs.ts) — ใช้เฉพาะ describe
// "listBookLines" ท้ายไฟล์ (ฟังก์ชันอื่นทั้งหมด import ของจริง)
// ---------------------------------------------------------------------
const { listEntriesMock, loadCombinedMock } = vi.hoisted(() => ({
  listEntriesMock: vi.fn(),
  loadCombinedMock: vi.fn(),
}));

vi.mock("@/lib/accounting/queries", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/queries")>();
  return { ...actual, listEntries: (...args: unknown[]) => listEntriesMock(...args) };
});

vi.mock("@/lib/accounting/statement-inputs", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/statement-inputs")>();
  return { ...actual, loadCombinedJournalLines: (...args: unknown[]) => loadCombinedMock(...args) };
});

import {
  parseBankStatementCsv,
  buildBookLines,
  bookLineKeyOf,
  suggestMatches,
  buildReconciliationSummary,
  isMatchStale,
  validateStatementLineInput,
  STATEMENT_CSV_TEMPLATE,
  importBatchFromCsv,
  addManualStatementLine,
  deleteStatementLine,
  deleteBatch,
  confirmMatch,
  unmatch,
  listStatementLines,
  listBatches,
  getBatchScope,
  getStatementLineScope,
  listBookLines,
  type BookLine,
  type BankStatementLine,
} from "@/lib/accounting/bank-reconciliation";

// =======================================================================
// parseBankStatementCsv (0.13)
// =======================================================================
describe("parseBankStatementCsv", () => {
  it("ไฟล์ปกติ (มี header) → parse ครบทุกแถว", () => {
    const csv = "date,description,amount\n2026-01-05,รับโอนจากลูกค้า,15000.00\n2026-01-07,ค่าธรรมเนียมธนาคาร,-50.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]).toEqual({ date: "2026-01-05", description: "รับโอนจากลูกค้า", amount: 15000 });
      expect(res.rows[1].amount).toBe(-50);
    }
  });

  it("ไม่มี header (เริ่มด้วยแถวข้อมูลเลย) → parse ได้เหมือนกัน (ไม่บังคับต้องมี header)", () => {
    const csv = "2026-01-05,รับโอนจากลูกค้า,15000.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toHaveLength(1);
  });

  it("★ มี BOM UTF-8 นำหน้าไฟล์ → parse ผ่านปกติ (ลอก BOM ออกก่อน)", () => {
    const csv = "﻿date,description,amount\n2026-01-05,รับโอน,100.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toEqual([{ date: "2026-01-05", description: "รับโอน", amount: 100 }]);
  });

  it("★ CRLF (\\r\\n) คั่นบรรทัด → parse ผ่านปกติ", () => {
    const csv = "date,description,amount\r\n2026-01-05,รับโอน,100.00\r\n2026-01-06,จ่ายค่าเช่า,-2000.00\r\n";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(2);
      expect(res.rows[1].amount).toBe(-2000);
    }
  });

  it("★ quoted field ที่มี comma ในคำอธิบาย → ไม่ถูกตัดกลาง comma นั้น", () => {
    const csv = 'date,description,amount\n2026-01-05,"บริษัท เอบีซี, จำกัด",5000.00';
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0].description).toBe("บริษัท เอบีซี, จำกัด");
  });

  it("quoted field ที่มี \"\" (escape quote ตัวจริง) → ได้ \" ตัวเดียวในผลลัพธ์", () => {
    const csv = 'date,description,amount\n2026-01-05,"ร้าน ""เอบีซี""",100.00';
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0].description).toBe('ร้าน "เอบีซี"');
  });

  it("แถวว่างกลางไฟล์ → ข้าม (ไม่ใช่ error)", () => {
    const csv = "date,description,amount\n2026-01-05,รับโอน,100.00\n\n2026-01-06,จ่ายเงิน,-50.00\n";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toHaveLength(2);
  });

  it("★ แถวมีคอลัมน์ไม่ครบ 3 → ปฏิเสธพร้อมเลขบรรทัดที่ผิด", () => {
    const csv = "date,description,amount\n2026-01-05,รับโอน,100.00\n2026-01-06,ขาดจำนวนเงิน";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].line).toBe(3);
    }
  });

  it("★ วันที่ผิดรูปแบบ (ไม่ใช่ YYYY-MM-DD) → ปฏิเสธพร้อมเลขบรรทัด", () => {
    const csv = "date,description,amount\n05/01/2026,รับโอน,100.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toEqual({ line: 2, message: expect.stringContaining("บรรทัดที่ 2") });
  });

  it("★ วันที่ไม่มีจริงในปฏิทิน (เช่น 30 ก.พ.) → ปฏิเสธ", () => {
    const csv = "2026-02-30,รับโอน,100.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].line).toBe(1);
  });

  it("★ amount ไม่ใช่ตัวเลข → ปฏิเสธพร้อมเลขบรรทัด", () => {
    const csv = "date,description,amount\n2026-01-05,รับโอน,abc";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].line).toBe(2);
  });

  it("amount ว่าง → ปฏิเสธ", () => {
    const csv = "2026-01-05,รับโอน,";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
  });

  it("★ all-or-nothing: มีแถวผิดแม้แถวเดียว → ไม่คืนแถวที่ถูกเลย (ok:false เท่านั้น)", () => {
    const csv = "2026-01-05,ok,100.00\n2026-01-06,bad,xx\n2026-01-07,ok,200.00";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toHaveLength(1);
  });

  it("รวม error หลายบรรทัดในไฟล์เดียว → ได้ error ครบทุกบรรทัดที่ผิด (ไม่ใช่แค่บรรทัดแรก)", () => {
    const csv = "2026-01-05,bad-date,xx\nbad,bad-date-2,yy";
    const res = parseBankStatementCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toHaveLength(2);
  });

  it("STATEMENT_CSV_TEMPLATE (ปุ่มดาวน์โหลด template) ต้อง parse ผ่านด้วย parser ของตัวเองเสมอ", () => {
    const res = parseBankStatementCsv(STATEMENT_CSV_TEMPLATE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toHaveLength(2);
  });

  it("★★ [tester] ไฟล์มีบรรทัดเดียวและผิดรูปแบบทั้งหมด (ไม่มี comma เลย เช่นอัปโหลดไฟล์ .txt/เอกสารอื่นผิดไฟล์) → ปฏิเสธทั้งไฟล์ (ok:false) ไม่ silent-skip", () => {
    const res = parseBankStatementCsv("นี่ไม่ใช่ไฟล์ CSV เลย");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].line).toBe(1);
      expect(res.errors[0].message).toContain("3 คอลัมน์");
    }
  });

  it("★★ [tester] บรรทัดเดียว มี 3 คอลัมน์ครบแต่ผิดทุกฟิลด์ (วันที่ผิด+amount ผิด) → ปฏิเสธพร้อมเลขบรรทัด (รายงานปัญหาแรกที่เจอ ไม่ throw ไม่เดา)", () => {
    const res = parseBankStatementCsv("ไม่ใช่วันที่,คำอธิบาย,ไม่ใช่ตัวเลข");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].line).toBe(1);
    }
  });

  it("★★ [tester] ไฟล์ว่างเปล่าสนิท (0 ไบต์/มีแต่ whitespace) → ปฏิเสธ ไม่มีข้อมูลให้นำเข้า (ok:true rows:[] — ไม่ error แต่ก็ไม่มีอะไรให้ import ต่อ)", () => {
    const res = parseBankStatementCsv("   \n\n  ");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toHaveLength(0);
  });
});

// =======================================================================
// validateStatementLineInput (กรอกมือ)
// =======================================================================
describe("validateStatementLineInput", () => {
  it("input ถูกต้อง → ผ่าน", () => {
    const res = validateStatementLineInput({ date: "2026-01-05", description: "รับโอน", amount: 100.567 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ date: "2026-01-05", description: "รับโอน", amount: 100.57 });
  });
  it("วันที่ผิดรูปแบบ → ปฏิเสธ", () => {
    expect(validateStatementLineInput({ date: "05-01-2026", amount: 100 }).ok).toBe(false);
  });
  it("amount ไม่ใช่ตัวเลข → ปฏิเสธ", () => {
    expect(validateStatementLineInput({ date: "2026-01-05", amount: "abc" }).ok).toBe(false);
  });
  it("amount = 0 → ปฏิเสธ (รายการธนาคารจริงต้องไม่เป็นศูนย์)", () => {
    expect(validateStatementLineInput({ date: "2026-01-05", amount: 0 }).ok).toBe(false);
  });
  it("amount ติดลบ (เงินออก) → ผ่านปกติ", () => {
    expect(validateStatementLineInput({ date: "2026-01-05", amount: -50 }).ok).toBe(true);
  });
});

// =======================================================================
// buildBookLines / bookLineKeyOf (0.14/0.15)
// =======================================================================
function mkJournalLine(p: Partial<JournalLine> & { entryId: string; accountCode: string }): JournalLine {
  return {
    entryId: p.entryId,
    date: p.date ?? "2026-07-10",
    docNo: p.docNo ?? null,
    accountCode: p.accountCode,
    accountName: p.accountName ?? "เงินฝากธนาคาร #1",
    debit: p.debit ?? 0,
    credit: p.credit ?? 0,
    side: p.side ?? "debit",
    customerId: p.customerId ?? "c1",
    counterparty: p.counterparty ?? null,
  };
}

describe("bookLineKeyOf", () => {
  it("คีย์ผสมตามรูปแบบ entryId:accountCode:side:amount:occurrence", () => {
    expect(bookLineKeyOf("e1", "1020", "debit", 1000, 0)).toBe("e1:1020:debit:1000:0");
  });
});

describe("buildBookLines", () => {
  it("กรองเฉพาะ accountCode ที่เลือก", () => {
    const lines = [
      mkJournalLine({ entryId: "e1", accountCode: "1020", side: "debit", debit: 1000 }),
      mkJournalLine({ entryId: "e2", accountCode: "4010", side: "credit", credit: 500 }),
    ];
    const result = buildBookLines(lines, "1020");
    expect(result).toHaveLength(1);
    expect(result[0].accountCode).toBe("1020");
  });

  it("debit → signed amount เป็นบวก (เงินเข้า) · credit → signed amount เป็นลบ (เงินออก)", () => {
    const lines = [
      mkJournalLine({ entryId: "e1", accountCode: "1020", side: "debit", debit: 1000 }),
      mkJournalLine({ entryId: "e2", accountCode: "1020", side: "credit", credit: 300 }),
    ];
    const result = buildBookLines(lines, "1020");
    expect(result.find((r) => r.entryId === "e1")?.amount).toBe(1000);
    expect(result.find((r) => r.entryId === "e2")?.amount).toBe(-300);
  });

  it("★ 2 บรรทัดยอด/side เท่ากันเป๊ะใน entry เดียวกัน → คีย์ไม่ชนกัน (occurrence ต่างกัน)", () => {
    const lines = [
      mkJournalLine({ entryId: "e1", accountCode: "1020", side: "debit", debit: 500 }),
      mkJournalLine({ entryId: "e1", accountCode: "1020", side: "debit", debit: 500 }),
    ];
    const result = buildBookLines(lines, "1020");
    expect(result).toHaveLength(2);
    expect(result[0].key).not.toBe(result[1].key);
    expect(result[0].key).toBe("e1:1020:debit:500:0");
    expect(result[1].key).toBe("e1:1020:debit:500:1");
  });

  it("คนละ entry ยอดเท่ากัน → คีย์ต่างกันอยู่แล้วจาก entryId (ไม่ต้องพึ่ง occurrence)", () => {
    const lines = [
      mkJournalLine({ entryId: "e1", accountCode: "1020", side: "debit", debit: 500 }),
      mkJournalLine({ entryId: "e2", accountCode: "1020", side: "debit", debit: 500 }),
    ];
    const result = buildBookLines(lines, "1020");
    expect(result[0].key).toBe("e1:1020:debit:500:0");
    expect(result[1].key).toBe("e2:1020:debit:500:0");
  });
});

// =======================================================================
// suggestMatches (0.17)
// =======================================================================
function mkBookLine(p: Partial<BookLine> & { key: string }): BookLine {
  return {
    key: p.key,
    entryId: p.entryId ?? p.key,
    accountCode: p.accountCode ?? "1020",
    date: "date" in p ? (p.date as string | null) : "2026-01-05",
    docNo: p.docNo ?? null,
    counterparty: p.counterparty ?? null,
    amount: p.amount ?? 1000,
  };
}
function mkStmtLine(p: Partial<BankStatementLine> & { id: string }): BankStatementLine {
  return {
    id: p.id,
    batchId: p.batchId ?? null,
    date: p.date ?? "2026-01-05",
    description: p.description ?? null,
    amount: p.amount ?? 1000,
    matchedBookLineKey: p.matchedBookLineKey ?? null,
    matchedEntryId: p.matchedEntryId ?? null,
    matchedDate: p.matchedDate ?? null,
    matchedAmount: p.matchedAmount ?? null,
    matchedAt: p.matchedAt ?? null,
  };
}

describe("suggestMatches — ขอบเขตวันที่ 7 วัน (0.17)", () => {
  it("ห่างกัน 0 วัน + ยอดตรง → แนะนำ", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(1);
    expect(res[0].daysApart).toBe(0);
  });

  it("ห่างกัน 3 วัน + ยอดตรง → แนะนำ", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-08", amount: 1000 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(1);
    expect(res[0].daysApart).toBe(3);
  });

  it("★ ห่างกันพอดี 7 วัน + ยอดตรง → แนะนำ (ขอบเขตพอดี ต้องผ่าน)", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-01", amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-08", amount: 1000 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(1);
    expect(res[0].daysApart).toBe(7);
  });

  it("★ ห่างกัน 8 วัน + ยอดตรง → ไม่แนะนำ (ขอบเขตพอดี ต้องไม่ผ่าน)", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-01", amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-09", amount: 1000 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(0);
  });

  it("ยอดไม่ตรงกัน (ห่างกันเกิน EPSILON) → ไม่แนะนำแม้วันที่ตรงกัน", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-05", amount: 999 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(0);
  });

  it("★ book line ที่จับคู่ไปแล้ว (มี statement อื่นชี้ key นี้) → ไม่ถูกแนะนำอีก", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 })];
    const s = [
      mkStmtLine({ id: "s0", date: "2026-01-05", amount: 1000, matchedBookLineKey: "b1" }), // จับคู่แล้ว
      mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000 }), // ยังไม่จับคู่ แต่ book หมดแล้ว
    ];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(0);
  });

  it("★ statement line ที่จับคู่ไปแล้ว → ไม่ถูกแนะนำอีก", () => {
    const b = [
      mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 }),
      mkBookLine({ key: "b2", date: "2026-01-05", amount: 1000 }),
    ];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000, matchedBookLineKey: "b0" })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(0);
  });

  it("เรียงจากวันที่ใกล้กันที่สุดก่อน", () => {
    const b = [
      mkBookLine({ key: "b1", date: "2026-01-01", amount: 500 }),
      mkBookLine({ key: "b2", date: "2026-01-05", amount: 1000 }),
    ];
    const s = [
      mkStmtLine({ id: "s1", date: "2026-01-06", amount: 500 }), // ห่าง b1 5 วัน
      mkStmtLine({ id: "s2", date: "2026-01-05", amount: 1000 }), // ห่าง b2 0 วัน
    ];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(2);
    expect(res[0].daysApart).toBe(0);
    expect(res[1].daysApart).toBe(5);
  });

  it("★ greedy dedup: book/statement line เดียวปรากฏได้แค่คู่เดียวในผลลัพธ์ (ไม่แนะนำซ้ำแย่งกัน)", () => {
    const b = [mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 })];
    const s = [
      mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000 }), // ห่าง 0 วัน — ควรถูกจับคู่
      mkStmtLine({ id: "s2", date: "2026-01-06", amount: 1000 }), // ห่าง 1 วัน — ตัวเลือกสำรอง
    ];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(1);
    expect(res[0].statementLine.id).toBe("s1");
  });

  it("ไม่มีวันที่ฝั่งบัญชี (date=null) → ข้าม ไม่แนะนำ", () => {
    const b = [mkBookLine({ key: "b1", date: null as unknown as string, amount: 1000 })];
    const s = [mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000 })];
    const res = suggestMatches(b, s);
    expect(res).toHaveLength(0);
  });

  it("★★ [tester] คู่ยอด/วันห่างเท่ากันเป๊ะ 2 คู่พร้อมกัน (ambiguous — เช่นค่าเช่า 2 สาขาโอนยอดเท่ากันวันเดียวกัน) → เลือกแบบ deterministic ตามลำดับที่พบก่อน (ไม่สุ่ม/ไม่พังทั้งสองคู่แนะนำถูกต้องคนละคู่)", () => {
    const b = [
      mkBookLine({ key: "b1", entryId: "e1", date: "2026-01-05", amount: 1000 }),
      mkBookLine({ key: "b2", entryId: "e2", date: "2026-01-05", amount: 1000 }),
    ];
    const s = [
      mkStmtLine({ id: "s1", date: "2026-01-05", amount: 1000 }),
      mkStmtLine({ id: "s2", date: "2026-01-05", amount: 1000 }),
    ];
    const res = suggestMatches(b, s);
    // ★ ทั้ง 4 คู่ที่เป็นไปได้ (b1-s1,b1-s2,b2-s1,b2-s2) ยอด/วันห่างเท่ากันหมด (0 วัน) — ไม่มีทางบอกได้ว่า
    //   "คู่ไหนถูกจริง" จากข้อมูลที่มี (เป็น ambiguous จริง ๆ) — ระบบต้องยังคง "แนะนำครบทุก book/statement
    //   line ที่มี คนละคู่กัน" (greedy ตามลำดับที่พบในอาร์เรย์) ไม่ทิ้งคู่ไหนไปเงียบ ๆ และไม่แนะนำ book/
    //   statement line ซ้ำในผลลัพธ์เดียวกัน (0.17)
    expect(res).toHaveLength(2);
    const usedBookKeys = new Set(res.map((r) => r.bookLine.key));
    const usedStmtIds = new Set(res.map((r) => r.statementLine.id));
    expect(usedBookKeys.size).toBe(2); // b1,b2 ถูกใช้คนละคู่ ไม่ซ้ำกัน
    expect(usedStmtIds.size).toBe(2); // s1,s2 ถูกใช้คนละคู่ ไม่ซ้ำกัน
    // ★ documented behavior: greedy ตามลำดับเดิมของอาร์เรย์ (stable sort เมื่อ daysApart เท่ากัน) →
    //   b1 จับกับ s1 (ตัวแรกที่เจอ), b2 จับกับ s2 ที่เหลือ — ผู้ใช้ยังกดยืนยันเองได้ทีละคู่อยู่ดี (ไม่ auto-confirm)
    expect(res.find((r) => r.bookLine.key === "b1")?.statementLine.id).toBe("s1");
    expect(res.find((r) => r.bookLine.key === "b2")?.statementLine.id).toBe("s2");
  });
});

// =======================================================================
// buildReconciliationSummary (0.18)
// =======================================================================
describe("buildReconciliationSummary", () => {
  it("สรุปยอด book/statement balance + unmatched total ถูกต้อง", () => {
    const b = [
      mkBookLine({ key: "b1", amount: 1000 }),
      mkBookLine({ key: "b2", amount: -300 }),
    ];
    const s = [
      mkStmtLine({ id: "s1", amount: 1000, matchedBookLineKey: "b1" }), // จับคู่แล้ว
      mkStmtLine({ id: "s2", amount: -50 }), // ยังไม่จับคู่ (เช่น ค่าธรรมเนียม)
    ];
    const summary = buildReconciliationSummary(b, s);
    expect(summary.bookBalance).toBe(700); // 1000-300
    expect(summary.statementBalance).toBe(950); // 1000-50
    expect(summary.unmatchedBookCount).toBe(1); // b2
    expect(summary.unmatchedBookTotal).toBe(-300);
    expect(summary.unmatchedStatementCount).toBe(1); // s2
    expect(summary.unmatchedStatementTotal).toBe(-50);
    expect(summary.unmatchedDiff).toBe(250); // -50 - (-300)
  });

  it("ไม่มีรายการเลย → ไม่ throw ทุกยอดเป็น 0", () => {
    expect(() => buildReconciliationSummary([], [])).not.toThrow();
    const summary = buildReconciliationSummary([], []);
    expect(summary.bookBalance).toBe(0);
    expect(summary.statementBalance).toBe(0);
    expect(summary.unmatchedDiff).toBe(0);
  });
});

// =======================================================================
// isMatchStale (0.16)
// =======================================================================
describe("isMatchStale", () => {
  it("ไม่ได้จับคู่ → ไม่ stale", () => {
    const s = mkStmtLine({ id: "s1" });
    expect(isMatchStale(s, new Map())).toBe(false);
  });

  it("จับคู่แล้ว + bookLine เดิมยังอยู่ ยอด/วันที่ตรง snapshot → ไม่ stale", () => {
    const bookLine = mkBookLine({ key: "b1", date: "2026-01-05", amount: 1000 });
    const s = mkStmtLine({ id: "s1", matchedBookLineKey: "b1", matchedDate: "2026-01-05", matchedAmount: 1000 });
    expect(isMatchStale(s, new Map([["b1", bookLine]]))).toBe(false);
  });

  it("★ จับคู่แล้ว + bookLine เดิมหาไม่เจอ (ถูกลบ/แก้จนคีย์เปลี่ยน) → stale", () => {
    const s = mkStmtLine({ id: "s1", matchedBookLineKey: "b1", matchedDate: "2026-01-05", matchedAmount: 1000 });
    expect(isMatchStale(s, new Map())).toBe(true);
  });

  it("★ จับคู่แล้ว + bookLine เดิมยังอยู่ แต่ยอดไม่ตรง snapshot (ถูกแก้ยอด) → stale", () => {
    const bookLine = mkBookLine({ key: "b1", date: "2026-01-05", amount: 9999 });
    const s = mkStmtLine({ id: "s1", matchedBookLineKey: "b1", matchedDate: "2026-01-05", matchedAmount: 1000 });
    expect(isMatchStale(s, new Map([["b1", bookLine]]))).toBe(true);
  });

  it("★ จับคู่แล้ว + bookLine เดิมยังอยู่ แต่วันที่ไม่ตรง snapshot → stale", () => {
    const bookLine = mkBookLine({ key: "b1", date: "2026-02-01", amount: 1000 });
    const s = mkStmtLine({ id: "s1", matchedBookLineKey: "b1", matchedDate: "2026-01-05", matchedAmount: 1000 });
    expect(isMatchStale(s, new Map([["b1", bookLine]]))).toBe(true);
  });
});

// =======================================================================
// data layer — fake DB in-memory (mirror pattern เทสต์อื่นในเฟส 6)
// =======================================================================
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in" | "is" | "gte" | "lt"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "in") return (f.val as unknown[]).includes(v);
    if (f.op === "is") return f.val === null ? v === null || v === undefined : v === f.val;
    if (f.op === "gte") return (v as string) >= (f.val as string);
    if (f.op === "lt") return (v as string) < (f.val as string);
    return v === f.val;
  });
}

function makeFakeDb(): { db: SupabaseClient; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {};
  let seq = 1;

  function qb(table: string) {
    if (!tables[table]) tables[table] = [];
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown;
    let single = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => { filters.push({ col: c, op: "eq", val: v }); return api; };
    api.in = (c: string, v: unknown[]) => { filters.push({ col: c, op: "in", val: v }); return api; };
    api.is = (c: string, v: unknown) => { filters.push({ col: c, op: "is", val: v }); return api; };
    api.gte = (c: string, v: unknown) => { filters.push({ col: c, op: "gte", val: v }); return api; };
    api.lt = (c: string, v: unknown) => { filters.push({ col: c, op: "lt", val: v }); return api; };
    const orders: { col: string; ascending: boolean }[] = [];
    api.order = (c: string, opts?: { ascending?: boolean }) => {
      orders.push({ col: c, ascending: opts?.ascending !== false });
      return api;
    };
    api.limit = () => api;
    api.insert = (p: unknown) => { mode = "insert"; payload = p; return api; };
    api.update = (p: unknown) => { mode = "update"; payload = p; return api; };
    api.delete = () => { mode = "delete"; return api; };
    api.maybeSingle = () => { single = true; return api; };
    function applyOrder(rows: Row[]): Row[] {
      if (orders.length === 0) return rows;
      return [...rows].sort((a, b) => {
        for (const o of orders) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av === bv) continue;
          if (av == null) return o.ascending ? -1 : 1;
          if (bv == null) return o.ascending ? 1 : -1;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return o.ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      if (mode === "insert") {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = (items as Row[]).map((r) => ({ id: `row-${seq++}`, deleted_at: null, ...r }));
        tables[table].push(...inserted);
        data = single ? inserted[0] ?? null : inserted;
      } else if (mode === "update") {
        const updated: Row[] = [];
        tables[table] = tables[table].map((r) => {
          if (matchRow(r, filters)) {
            const nr = { ...r, ...(payload as Row) };
            updated.push(nr);
            return nr;
          }
          return r;
        });
        data = single ? updated[0] ?? null : updated;
      } else if (mode === "delete") {
        const removed: Row[] = [];
        const remaining: Row[] = [];
        for (const r of tables[table]) {
          if (matchRow(r, filters)) removed.push(r);
          else remaining.push(r);
        }
        tables[table] = remaining;
        // ★ mirror FK on delete cascade ของ migration 0075 (bank_statement_lines.batch_id → batches.id)
        if (table === "bank_statement_import_batches" && removed.length > 0) {
          const removedIds = new Set(removed.map((r) => r.id));
          tables["bank_statement_lines"] = (tables["bank_statement_lines"] ?? []).filter(
            (r) => !removedIds.has(r.batch_id)
          );
        }
      } else {
        const found = applyOrder(tables[table].filter((r) => matchRow(r, filters)).map((r) => ({ ...r })));
        data = single ? found[0] ?? null : found;
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, tables };
}

const TENANT = "t1";
const CUSTOMER = "c1";
const BANK_ACCOUNT = "ba1";

describe("importBatchFromCsv", () => {
  it("นำเข้า CSV → สร้าง batch + bulk insert ตรงจำนวนแถว (line_count ตรง)", async () => {
    const { db, tables } = makeFakeDb();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      date: "2026-01-01",
      description: `รายการที่ ${i + 1}`,
      amount: 100 + i,
    }));
    const res = await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "statement.csv", rows);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lineCount).toBe(100);
    expect(tables["bank_statement_import_batches"]).toHaveLength(1);
    expect(tables["bank_statement_import_batches"][0].line_count).toBe(100);
    expect(tables["bank_statement_lines"]).toHaveLength(100);
    expect(tables["bank_statement_lines"].every((r) => r.batch_id === tables["bank_statement_import_batches"][0].id)).toBe(true);
  });

  it("ไม่มีแถวเลย → ปฏิเสธ ไม่สร้าง batch", async () => {
    const { db, tables } = makeFakeDb();
    const res = await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "x.csv", []);
    expect(res.ok).toBe(false);
    expect(tables["bank_statement_import_batches"] ?? []).toHaveLength(0);
  });
});

describe("deleteBatch — hard-delete cascade (T49)", () => {
  it("★ ลบ batch → บรรทัดที่ผูก batch นั้นหายไปจริงตาม FK cascade", async () => {
    const { db, tables } = makeFakeDb();
    const rows = [{ date: "2026-01-01", description: "a", amount: 100 }, { date: "2026-01-02", description: "b", amount: -50 }];
    const imported = await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "x.csv", rows);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // เพิ่มรายการกรอกมือ (ไม่ผูก batch) ให้แน่ใจว่าไม่ถูกลบตาม
    await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-03", description: "manual", amount: 10 });
    expect(tables["bank_statement_lines"]).toHaveLength(3);

    const res = await deleteBatch(db, TENANT, imported.batchId);
    expect(res.ok).toBe(true);
    expect(tables["bank_statement_import_batches"]).toHaveLength(0);
    expect(tables["bank_statement_lines"]).toHaveLength(1); // เหลือแค่รายการกรอกมือ
  });
});

describe("addManualStatementLine / deleteStatementLine (กรอกมือ, 0.13)", () => {
  it("เพิ่มรายการกรอกมือสำเร็จ", async () => {
    const { db, tables } = makeFakeDb();
    const res = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, {
      date: "2026-01-05",
      description: "รับโอน",
      amount: 500,
    });
    expect(res.ok).toBe(true);
    expect(tables["bank_statement_lines"]).toHaveLength(1);
    expect(tables["bank_statement_lines"][0].batch_id).toBeNull();
  });

  it("amount ผิดรูปแบบ → ปฏิเสธ ไม่เขียน DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: "abc" });
    expect(res.ok).toBe(false);
    expect(tables["bank_statement_lines"] ?? []).toHaveLength(0);
  });

  it("ลบรายการ (soft-delete) → ไม่โผล่ใน listStatementLines อีก", async () => {
    const { db } = makeFakeDb();
    const added = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: 100 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const del = await deleteStatementLine(db, TENANT, added.id);
    expect(del.ok).toBe(true);
    const list = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT);
    expect(list).toHaveLength(0);
  });
});

describe("confirmMatch / unmatch (0.15/0.16/0.17)", () => {
  it("★ confirmMatch เขียน snapshot ครบ 4 ฟิลด์ + matched_at", async () => {
    const { db, tables } = makeFakeDb();
    const added = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: 1000 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const bookLine = { key: "e1:1020:debit:1000:0", entryId: "e1", date: "2026-01-05", amount: 1000 };
    const res = await confirmMatch(db, TENANT, added.id, bookLine);
    expect(res.ok).toBe(true);

    const row = tables["bank_statement_lines"].find((r) => r.id === added.id)!;
    expect(row.matched_book_line_key).toBe("e1:1020:debit:1000:0");
    expect(row.matched_entry_id).toBe("e1");
    expect(row.matched_date).toBe("2026-01-05");
    expect(row.matched_amount).toBe(1000);
    expect(row.matched_at).not.toBeNull();
  });

  it("★ unmatch เคลียร์ snapshot กลับเป็น null ทั้งหมด", async () => {
    const { db, tables } = makeFakeDb();
    const added = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: 1000 });
    if (!added.ok) return;
    await confirmMatch(db, TENANT, added.id, { key: "k1", entryId: "e1", date: "2026-01-05", amount: 1000 });

    const res = await unmatch(db, TENANT, added.id);
    expect(res.ok).toBe(true);
    const row = tables["bank_statement_lines"].find((r) => r.id === added.id)!;
    expect(row.matched_book_line_key).toBeNull();
    expect(row.matched_entry_id).toBeNull();
    expect(row.matched_date).toBeNull();
    expect(row.matched_amount).toBeNull();
    expect(row.matched_at).toBeNull();
  });
});

describe("listStatementLines / listBatches / getBatchScope / getStatementLineScope", () => {
  it("listStatementLines เรียงวันที่เก่า→ใหม่ + กรองงวดได้", async () => {
    const { db } = makeFakeDb();
    await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-02-05", amount: 100 });
    await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: 200 });
    const all = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT);
    expect(all.map((r) => r.date)).toEqual(["2026-01-05", "2026-02-05"]);

    const janOnly = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT, { from: "2026-01", to: "2026-01" });
    expect(janOnly).toHaveLength(1);
    expect(janOnly[0].amount).toBe(200);
  });

  it("getBatchScope คืน customerId/bankAccountId ของ batch ที่ระบุ", async () => {
    const { db } = makeFakeDb();
    const imported = await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "x.csv", [{ date: "2026-01-01", description: "", amount: 1 }]);
    if (!imported.ok) return;
    const scope = await getBatchScope(db, TENANT, imported.batchId);
    expect(scope).toEqual({ customerId: CUSTOMER, bankAccountId: BANK_ACCOUNT });
  });

  it("getBatchScope: batchId ไม่พบ → null", async () => {
    const { db } = makeFakeDb();
    expect(await getBatchScope(db, TENANT, "no-such-id")).toBeNull();
  });

  it("getStatementLineScope คืน customerId/bankAccountId ของแถวที่ระบุ", async () => {
    const { db } = makeFakeDb();
    const added = await addManualStatementLine(db, TENANT, CUSTOMER, BANK_ACCOUNT, { date: "2026-01-05", amount: 100 });
    if (!added.ok) return;
    const scope = await getStatementLineScope(db, TENANT, added.id);
    expect(scope).toEqual({ customerId: CUSTOMER, bankAccountId: BANK_ACCOUNT });
  });

  it("listBatches เรียงล่าสุดก่อน", async () => {
    const { db } = makeFakeDb();
    await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "a.csv", [{ date: "2026-01-01", description: "", amount: 1 }]);
    await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "b.csv", [{ date: "2026-01-01", description: "", amount: 1 }]);
    const list = await listBatches(db, TENANT, CUSTOMER, BANK_ACCOUNT);
    expect(list).toHaveLength(2);
  });
});

// =======================================================================
// listBookLines — wrap buildJournalEntries + loadCombinedJournalLines (0.14)
// =======================================================================
describe("listBookLines", () => {
  let seq = 0;
  function mkLine(p: Partial<BillEntryLine> = {}): BillEntryLine {
    seq += 1;
    return {
      id: `l${seq}`,
      entryId: p.entryId ?? "e",
      lineNo: p.lineNo ?? 1,
      vatType: p.vatType ?? "novat",
      description: p.description ?? null,
      accountCode: p.accountCode ?? null,
      accountName: p.accountName ?? null,
      amount: p.amount ?? 0,
      vatAmount: p.vatAmount ?? 0,
      whtRate: p.whtRate ?? 0,
      whtAmount: p.whtAmount ?? 0,
      aiFilled: p.aiFilled ?? false,
      aiLowConfidence: p.aiLowConfidence ?? false,
    };
  }
  function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
    return {
      id: p.id,
      tenantId: p.tenantId ?? TENANT,
      attachmentId: null,
      customerId: p.customerId ?? CUSTOMER,
      customerName: null,
      attachmentObjectPath: null,
      uploadPath: null,
      uploadName: null,
      uploadMime: null,
      entryType: p.entryType ?? "sale",
      docDate: p.docDate ?? "2026-07-15",
      docNo: p.docNo ?? null,
      counterpartyName: p.counterpartyName ?? null,
      counterpartyTaxId: null,
      sellerName: null,
      sellerTaxId: null,
      buyerName: null,
      buyerTaxId: null,
      whtForm: null,
      paymentMethod: p.paymentMethod ?? "transfer",
      paymentBankAccountId: null,
      paymentBankAccountCode: p.paymentBankAccountCode ?? "1020",
      dueDate: null,
      status: p.status ?? "confirmed",
      source: p.source ?? "manual",
      aiConfidence: null,
      notes: null,
      createdAt: "2026-07-01T00:00:00Z",
      confirmedAt: null,
      inputTaxMonth: null,
      lines: p.lines ?? [],
    };
  }

  beforeEach(() => {
    listEntriesMock.mockReset();
    loadCombinedMock.mockReset();
    loadCombinedMock.mockResolvedValue({ manualJournalLines: [], paymentJournalLines: [], noteJournalLines: [] });
  });

  it("รวมฝั่งบิลที่กระทบบัญชีเงินฝากที่เลือก (โอนเข้าจากยอดขาย → debit 1020)", async () => {
    const entries = [
      mkEntry({
        id: "e1",
        entryType: "sale",
        paymentMethod: "transfer",
        paymentBankAccountCode: "1020",
        lines: [mkLine({ entryId: "e1", accountCode: "4010", amount: 10000 })],
      }),
    ];
    listEntriesMock.mockResolvedValue({ entries, summary: {} });

    const chartByCode = buildChartByCode(TEST_CHART);
    const lines = await listBookLines(
      {} as unknown as SupabaseClient,
      TENANT,
      CUSTOMER,
      "1020",
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(10000); // debit (เงินเข้า)
    expect(lines[0].entryId).toBe("e1");
  });

  it("รวมฝั่ง manual JE (จาก loadCombinedJournalLines) ที่กระทบบัญชีเดียวกัน", async () => {
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    loadCombinedMock.mockResolvedValue({
      manualJournalLines: [
        mkJournalLine({ entryId: "m1", accountCode: "1020", side: "credit", credit: 2000, date: "2026-07-05" }),
      ],
      paymentJournalLines: [],
      noteJournalLines: [],
    });

    const chartByCode = buildChartByCode(TEST_CHART);
    const lines = await listBookLines(
      {} as unknown as SupabaseClient,
      TENANT,
      CUSTOMER,
      "1020",
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(-2000); // credit (เงินออก)
    expect(lines[0].entryId).toBe("m1");
  });

  it("บัญชีที่ไม่ตรงกับที่เลือก (เช่น 4010) → ไม่โผล่ในผลลัพธ์", async () => {
    const entries = [
      mkEntry({
        id: "e1",
        entryType: "sale",
        paymentMethod: "credit",
        lines: [mkLine({ entryId: "e1", accountCode: "4010", amount: 10000 })],
      }),
    ];
    listEntriesMock.mockResolvedValue({ entries, summary: {} });

    const chartByCode = buildChartByCode(TEST_CHART);
    const lines = await listBookLines(
      {} as unknown as SupabaseClient,
      TENANT,
      CUSTOMER,
      "1020",
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );
    expect(lines).toHaveLength(0);
  });
});

// =======================================================================
// ★★ [tester] end-to-end flow เต็ม (mirror docs 06 หมวด 4.2 ข้อ 4-6): นำเข้า CSV → suggestMatches แนะนำคู่
//   ยอด/วันตรงกัน → confirmMatch → summary อัปเดตถูกต้อง → แก้ manual JE ที่จับคู่ไปแล้ว (เปลี่ยนยอด) →
//   isMatchStale ต้องเห็น badge เตือน (0.16) → unmatch → deleteBatch (hard-delete) → บรรทัดที่ผูก batch หายจริง
// =======================================================================
describe("★★ [tester] T — end-to-end: import CSV → suggest → confirm → summary → แก้ยอดต้นทาง → stale badge → unmatch → deleteBatch", () => {
  it("flow เต็ม", async () => {
    listEntriesMock.mockReset();
    loadCombinedMock.mockReset();
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });

    const chartByCode = buildChartByCode(TEST_CHART);
    const period = { from: "2026-01", to: "2026-01", includeDraft: true };

    // --- ฝั่ง book: manual JE 1 ใบ โอนเข้าบัญชี 1020 จำนวน 2,000 วันที่ 2026-01-05 ---
    loadCombinedMock.mockResolvedValue({
      manualJournalLines: [
        mkJournalLine({ entryId: "m1", accountCode: "1020", side: "debit", debit: 2000, date: "2026-01-05" }),
      ],
      paymentJournalLines: [],
      noteJournalLines: [],
    });

    const { db, tables } = makeFakeDb();

    // 1) นำเข้า CSV ตัวอย่าง 1 แถว (ยอด/วันตรงกับฝั่งบัญชีเป๊ะ)
    const parsed = parseBankStatementCsv("2026-01-05,รับโอนจากลูกค้า,2000.00");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imported = await importBatchFromCsv(db, TENANT, CUSTOMER, BANK_ACCOUNT, "statement-jan.csv", parsed.rows);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // 2) โหลดฝั่งบัญชี + ฝั่ง statement แล้วให้ระบบแนะนำคู่
    let bookLines = await listBookLines({} as unknown as SupabaseClient, TENANT, CUSTOMER, "1020", period, chartByCode);
    let statementLines = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT, period);
    expect(bookLines).toHaveLength(1);
    expect(statementLines).toHaveLength(1);

    const suggested = suggestMatches(bookLines, statementLines);
    expect(suggested).toHaveLength(1);
    expect(suggested[0].daysApart).toBe(0);

    // 3) ยืนยันจับคู่ตามที่ระบบแนะนำ
    const confirmRes = await confirmMatch(db, TENANT, suggested[0].statementLine.id, suggested[0].bookLine);
    expect(confirmRes.ok).toBe(true);

    statementLines = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT, period);
    expect(statementLines[0].matchedBookLineKey).toBe(bookLines[0].key);
    expect(statementLines[0].matchedAmount).toBe(2000);

    // สรุปยอดหลังจับคู่ — ไม่มีรายการค้างจับคู่เหลือ ยอด book/statement ตรงกัน ผลต่าง = 0
    const summaryAfterConfirm = buildReconciliationSummary(bookLines, statementLines);
    expect(summaryAfterConfirm.unmatchedBookCount).toBe(0);
    expect(summaryAfterConfirm.unmatchedStatementCount).toBe(0);
    expect(summaryAfterConfirm.bookBalance).toBe(2000);
    expect(summaryAfterConfirm.statementBalance).toBe(2000);
    expect(summaryAfterConfirm.unmatchedDiff).toBe(0);

    // 4) นักบัญชีแก้ manual JE ที่เคยจับคู่ไปแล้ว (เปลี่ยนยอดจาก 2000 → 2500)
    loadCombinedMock.mockResolvedValue({
      manualJournalLines: [
        mkJournalLine({ entryId: "m1", accountCode: "1020", side: "debit", debit: 2500, date: "2026-01-05" }),
      ],
      paymentJournalLines: [],
      noteJournalLines: [],
    });
    bookLines = await listBookLines({} as unknown as SupabaseClient, TENANT, CUSTOMER, "1020", period, chartByCode);
    const currentBookLinesByKey = new Map(bookLines.map((b) => [b.key, b]));

    // ★ 0.16: bookLineKey ผสมยอดเข้าไปด้วย (entryId:accountCode:side:amount:occurrence) — พอยอดเปลี่ยน
    //   คีย์เดิมหาไม่เจอในชุดที่ re-compute สดล่าสุด → ต้องเห็น badge เตือน "ตรวจสอบใหม่"
    const staleStatementLine = statementLines[0];
    expect(isMatchStale(staleStatementLine, currentBookLinesByKey)).toBe(true);

    // 5) ยกเลิกจับคู่ (ตามที่ badge แนะนำ) → snapshot เคลียร์กลับเป็น null ทั้งหมด
    const unmatchRes = await unmatch(db, TENANT, staleStatementLine.id);
    expect(unmatchRes.ok).toBe(true);
    statementLines = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT, period);
    expect(statementLines[0].matchedBookLineKey).toBeNull();
    expect(statementLines[0].matchedAmount).toBeNull();
    expect(isMatchStale(statementLines[0], currentBookLinesByKey)).toBe(false); // ไม่ได้จับคู่แล้ว = ไม่ stale

    // 6) ลบ batch นำเข้าที่ผิด (ยกเลิกทั้งชุด) → บรรทัดที่ผูก batch นี้ต้องหายไปจริง (hard-delete cascade)
    const delRes = await deleteBatch(db, TENANT, imported.batchId);
    expect(delRes.ok).toBe(true);
    expect(tables["bank_statement_import_batches"]).toHaveLength(0);
    expect(tables["bank_statement_lines"]).toHaveLength(0);
    const afterDelete = await listStatementLines(db, TENANT, CUSTOMER, BANK_ACCOUNT, period);
    expect(afterDelete).toHaveLength(0);
  });
});
