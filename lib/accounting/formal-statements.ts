/**
 * ประกอบงบการเงิน "ฉบับทางการ" — compose (pure, ไม่แตะ DB) — แก้บั๊ก correctness ของงบแสดงฐานะการเงิน
 * (0.3) โดยไม่แก้ engine เดิมแม้แต่บรรทัดเดียว + ประกอบงบกระแสเงินสด (O3)
 *
 * บริบท: เฟส 4 ส่วน M (docs/06-accounting-features-roadmap.md, หมวด 0.3) — `buildStatements()` เดิม
 *   (เฟส 1-3) สร้าง `ledger`/`trialBalance`/`incomeStatement`/`balanceSheet` จาก entries ชุดเดียวกันหมด
 *   ที่กรองด้วย `{from,to}` — ถูกต้องสำหรับงบกำไรขาดทุน (flow statement) แต่ผิดสำหรับงบแสดงฐานะการเงิน
 *   (ต้องเป็น stock/point-in-time statement = ยอดยกมา + ความเคลื่อนไหว "ทั้งหมด" ตั้งแต่ต้นจนถึง `to`
 *   เท่านั้น ไม่ขึ้นกับ `from`)
 *
 * วิธีแก้ (ไม่แตะ `buildStatements`/`buildLedger`/`buildTrialBalance`/`buildBalanceSheet` เลย): เรียก
 *   `buildStatements()` เดิม 2 รอบต่องวด —
 *     1. รอบ "flow"       — entries กรองด้วย {from, to} ตามที่ผู้ใช้เลือกจริง → ใช้ .journal/.ledger/
 *                            .trialBalance/.incomeStatement (ทั้งหมดถูกต้องอยู่แล้วในฐานะ flow)
 *     2. รอบ "cumulative" — entries กรองด้วย {from:"", to} (ตัด from ทิ้ง ใช้แค่ to เดิม) → ใช้เฉพาะ
 *                            .balanceSheet (สะสมถูกต้องตั้งแต่ยอดยกมาแรกสุดถึง to)
 *   ★ [แก้บั๊กรอบตรวจโค้ด — 2026] เดิมทั้ง 2 รอบใช้ `journalLines` (จาก `combinedLines` ชุดเดียว) ร่วมกัน
 *     แต่ caller ทุกจุดโหลด `combinedLines` ผ่าน `loadCombinedJournalLines(db, tenantId, entries, period,
 *     chartByCode)` ที่กรอง manual JE/bill_payments/CN-DN ด้วย `period` ของรอบ "flow" (มี `from` จำกัดไว้)
 *     เท่านั้น — ทำให้รอบ "cumulative" ขาดผลกระทบของ 3 แหล่งข้อมูลนี้ที่เกิด "ก่อน" `from` ไปเงียบ ๆ (รวมถึง
 *     `openingCash` ของ O3 ที่ใช้ journalLines ชุดเดียวกัน) — แก้โดยรับ `combinedLines` 2 ชุดแยกกัน:
 *       - `flowCombinedLines`       — โหลดด้วย period ของรอบ flow (เดิม) → ใช้กับรอบ "flow" เท่านั้น
 *       - `cumulativeCombinedLines` — โหลดด้วย period ตัด from ทิ้ง {from:"", to} → ใช้กับรอบ "cumulative"
 *                                     (balanceSheet) และ openingCash (O3) ทั้งหมด
 *     (backward-compatible: caller เดิมที่ยังส่งชุดเดียวจะได้ผลลัพธ์เหมือนเดิมทุกกรณีที่ manual JE/payment/
 *     note อยู่ในช่วง from-to พอดี หรือไม่ได้ตั้ง from เลย — ต่างเฉพาะเคสที่มีรายการก่อน from ซึ่งเป็นบั๊กเดิม)
 *
 * O3 (เฟส 4 ส่วน O, หมวด 0.9) — เพิ่ม `cashFlow` (direct method):
 *   - แหล่งข้อมูล = `JournalLine[]` ของรอบ "flow" เท่านั้น (bill journal ของ flowEntries + flowCombinedLines
 *     ที่ caller โหลดมาเฉพาะงวด `period` แล้ว — flow statement เหมือนงบกำไรขาดทุน ไม่ใช่สะสม)
 *   - `openingCash` = ผลรวมยอดบัญชีกลุ่มเงินสด (cashPoolCodesOf) จาก TrialBalance สะสม ณ สิ้นเดือน
 *     ก่อนหน้า `from` (ใช้ pipeline เดียวกับ 0.3: filterEntriesForReport(entries, {from:"", to: เดือน
 *     ก่อน from}) + `cumulativeCombinedLines` — สะสมจริงเหมือน balanceSheet) — ถ้าไม่ได้ตั้ง `from` เลย
 *     (ดูตั้งแต่ต้น) ไม่มี "เดือนก่อนหน้า" ให้คำนวณ → ใช้ยอดยกมาดิบ (`opening`) ของบัญชีกลุ่มเงินสดตรง ๆ แทน
 *     (เทียบเท่า "ก่อนเริ่มมีรายการใด ๆ ในระบบ")
 */
import { buildStatements, type Statements } from "@/lib/accounting/statements";
import { filterEntriesForReport, validMonth, type ReportPeriod } from "@/lib/accounting/report-filter";
import { round2, type BillEntry } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";
import type { ChartAccount, ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { BalanceSheet } from "@/lib/accounting/financial-statements";
import { flattenCombinedJournalLines, type CombinedJournalLines } from "@/lib/accounting/statement-inputs";
import type { JournalLine } from "@/lib/accounting/journal";
import { buildCashFlowStatement, type CashFlowStatement } from "@/lib/accounting/cash-flow";
import { cashPoolCodesOf } from "@/lib/accounting/cash-flow-config";

/**
 * งบการเงินฉบับทางการ — ประกอบจาก 2 รอบของ buildStatements() (0.3) + งบกระแสเงินสด (O3):
 *   - flow        = journal/ledger/trialBalance/incomeStatement ของรอบที่กรองตาม {from,to} จริง
 *   - balanceSheet = ของรอบ cumulative (ตัด from ทิ้ง) เท่านั้น
 *   - cashFlow    = งบกระแสเงินสด (direct method) ของรอบ flow เดียวกัน
 */
export type FormalStatements = {
  flow: Pick<Statements, "journal" | "ledger" | "trialBalance" | "incomeStatement">;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlowStatement;
};

/** เดือนก่อนหน้า "YYYY-MM" ที่ระบุ (จัดการข้ามปีถูกต้อง) — คืน "" ถ้ารูปแบบผิด */
function monthBefore(m: string): string {
  const v = validMonth(m);
  if (!v) return "";
  const [y, mo] = v.split("-").map(Number);
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12 : mo - 1;
  return `${py.toString().padStart(4, "0")}-${pm.toString().padStart(2, "0")}`;
}

/**
 * กรอง JournalLine[] เอาเฉพาะรายการที่ "ลงวันที่ก่อน" เดือน `month` ที่ระบุ (< YYYY-MM-01)
 *   ★ จำเป็นเพราะ `buildStatements()` ไม่กรอง manualJournalLines ตามวันที่เอง (รับมาเชื่อว่ากรองมาแล้ว) —
 *     ใช้ตอนคำนวณ openingCash (สะสม ณ สิ้นเดือนก่อน from) เพื่อไม่ให้ manual JE/payment/note ที่ลงวันที่
 *     "ในงวด from-to" (ไม่ใช่ก่อนงวด) หลุดปนเข้ามานับซ้ำกับ cashFlow ของรอบ flow
 */
function journalLinesBeforeMonth(lines: JournalLine[], month: string): JournalLine[] {
  const startBound = `${month}-01`;
  return lines.filter((l) => l.date !== null && l.date < startBound);
}

export function buildFormalStatements(
  entries: BillEntry[],
  flowCombinedLines: CombinedJournalLines,
  cumulativeCombinedLines: CombinedJournalLines,
  opening: Pick<OpeningBalance, "accountCode" | "accountName" | "openingBalance">[] = [],
  chartByCode: ChartByCode = {},
  period: ReportPeriod,
  chart: ChartAccount[] = []
): FormalStatements {
  // ★ แก้บั๊ก (2026) — journalLines ของรอบ "flow" กับ "cumulative" ต้องมาจาก combinedLines คนละชุด
  //   (โหลดด้วย period คนละแบบ) มิฉะนั้นรอบ cumulative จะขาดผลกระทบของ manual JE/bill_payments/CN-DN
  //   ที่เกิด "ก่อน" from ไปเงียบ ๆ — ดูรายละเอียดที่คอมเมนต์หัวไฟล์
  const flowJournalLinesRaw = flattenCombinedJournalLines(flowCombinedLines);
  const cumulativeJournalLinesRaw = flattenCombinedJournalLines(cumulativeCombinedLines);

  // รอบ "flow" — entries กรองด้วย {from, to} ตามที่ผู้ใช้เลือกจริง
  const flowEntries = filterEntriesForReport(entries, period);
  const flow = buildStatements(flowEntries, opening, chartByCode, flowJournalLinesRaw);

  // รอบ "cumulative" — ตัด from ทิ้ง (0.3) ใช้เฉพาะ balanceSheet ของรอบนี้ — ใช้ cumulativeJournalLinesRaw
  // (สะสมจริง ครอบคลุมตั้งแต่ต้นถึง to) ไม่ใช่ flowJournalLinesRaw ที่ขาดรายการก่อน from
  const cumulativeEntries = filterEntriesForReport(entries, { ...period, from: "" });
  const cumulative = buildStatements(cumulativeEntries, opening, chartByCode, cumulativeJournalLinesRaw);

  // O3 (0.9) — openingCash: สะสม ณ สิ้นเดือนก่อนหน้า from (ถ้ามี from) หรือยอดยกมาดิบ (ถ้าไม่ได้ตั้ง from)
  //   ★ ใช้ cumulativeJournalLinesRaw เช่นกัน (ไม่ใช่ flowJournalLinesRaw) — มิฉะนั้น manual JE/payment/note
  //   ที่กระทบเงินสดก่อน from จะขาดหายจาก openingCash ไปด้วย (บั๊กเดียวกันกับ balanceSheet)
  const cashPool = new Set(cashPoolCodesOf(chart));
  const fromMonth = validMonth(period.from);
  let openingCash: number;
  if (fromMonth) {
    const beforeFromMonth = monthBefore(fromMonth);
    const beforeFromEntries = filterEntriesForReport(entries, {
      from: "",
      to: beforeFromMonth,
      includeDraft: period.includeDraft,
    });
    // ★ ตัด manual JE/payment/note ที่ลงวันที่ตั้งแต่ fromMonth เป็นต้นไปทิ้ง (อยู่ในงวด flow ไม่ใช่ "ก่อน from")
    const beforeFromJournalLines = journalLinesBeforeMonth(cumulativeJournalLinesRaw, fromMonth);
    const beforeFrom = buildStatements(beforeFromEntries, opening, chartByCode, beforeFromJournalLines);
    openingCash = round2(
      beforeFrom.trialBalance.rows
        .filter((r) => cashPool.has(r.code))
        .reduce((s, r) => s + r.balance, 0)
    );
  } else {
    openingCash = round2(
      opening
        .filter((o) => cashPool.has((o.accountCode ?? "").trim()))
        .reduce((s, o) => s + (Number.isFinite(o.openingBalance) ? o.openingBalance : 0), 0)
    );
  }

  // แหล่งข้อมูลของงบกระแสเงินสด = JournalLine[] ของรอบ "flow" เท่านั้น (bill journal + flowCombinedLines)
  const flowJournalLines = [...flow.journal.lines, ...flowJournalLinesRaw];
  const cashFlow = buildCashFlowStatement(flowJournalLines, openingCash, chartByCode, chart);

  return {
    flow: {
      journal: flow.journal,
      ledger: flow.ledger,
      trialBalance: flow.trialBalance,
      incomeStatement: flow.incomeStatement,
    },
    balanceSheet: cumulative.balanceSheet,
    cashFlow,
  };
}
