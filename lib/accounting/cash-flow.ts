/**
 * O. งบกระแสเงินสด (Cash Flow Statement) — Direct Method แบบไล่เส้นเงินจาก double-entry จริง
 *
 * ★ pure function ล้วน (ไม่แตะ DB/network) — unit test ได้เต็ม
 * บริบท: เฟส 4 ส่วน O (docs/06-accounting-features-roadmap.md, หมวด 0.5–0.9) — เหตุผลที่เลือก direct
 *   method (ไม่ใช่ indirect) อยู่ที่ 0.5: ผังบัญชีของระบบนี้ไม่มี flag แยก "รายการไม่ใช่เงินสด" (tenant
 *   แก้ผังเองได้ตั้งแต่เฟส 1) — indirect method จึงต้องเดากติกาเพิ่มจำนวนมาก เสี่ยงผิดเงียบ ๆ สูง
 *   ในทางกลับกัน `JournalLine[]` ที่มีอยู่แล้วทุกแหล่งข้อมูล (journal.ts/bill-payments.ts/
 *   manual-journal.ts/credit-debit-notes.ts) จับกลุ่มตาม `entryId` ได้ตรง ๆ และรู้ accountCode ชัดเจน
 *   ว่ากระทบเงินสด/ธนาคารหรือไม่ (เทียบ `cashPoolCodesOf(chart)`) → ไล่ "อีกขา" (contra) ของธุรกรรม
 *   เดียวกันเพื่อจัดกิจกรรม (ดำเนินงาน/ลงทุน/จัดหาเงิน) ได้ตรงจากข้อมูลจริง ไม่ต้องเดา
 *
 * วิธีคำนวณต่อ 1 posting (group ตาม entryId เสมอ, 0.6):
 *   - แยกบรรทัดเป็น cashLegs (accountCode อยู่ใน cash pool) / nonCashLegs (ไม่อยู่)
 *   - cashLegs ว่าง (ไม่กระทบเงินสดเลย เช่น CN/DN ที่ contra คงที่ AR/AP เสมอ, 0.5) → ไม่เข้า CF
 *   - nonCashLegs ว่าง (ทั้ง 2 ขาอยู่ใน cash pool หมด เช่น ฝากเงินสดเข้าธนาคาร) → ตัดออกจาก CF ทั้งหมด (0.6)
 *   - ปกติ (มีทั้งคู่): แต่ละ nonCashLeg จัดกิจกรรมของตัวเอง (classifyCashFlowActivity) ด้วยยอดจริงของ
 *     ตัวเอง amount = −(debit−credit) — ไม่หารเฉลี่ย ไม่ต้องคำนวณสัดส่วนพิเศษ (0.8): เพราะผลรวมของ
 *     nonCashLegs ทั้งหมดของ 1 posting จะเท่ากับ −Σ(cashLegs debit−credit) เสมอโดยธรรมชาติของ
 *     double-entry (Σdebit=Σcredit ต่อ entry) ไม่ว่า posting นั้นจะมีกี่ cashLeg/nonCashLeg ก็ตาม
 *     (ครอบคลุมทั้งเคส "1 cashLeg + หลาย nonCashLeg" และเคส manual JE ที่มีหลาย cashLeg พร้อมกัน, 0.8)
 */
import type { JournalLine } from "@/lib/accounting/journal";
import type { ChartAccount, ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import { cashPoolCodesOf, classifyCashFlowActivity } from "@/lib/accounting/cash-flow-config";
import type { StatementLine } from "@/lib/accounting/financial-statements";

/** 1 บรรทัดในงบกระแสเงินสด — อ้างอิงกลับต้นทางได้เสมอ (audit-friendly) */
export type CashFlowLine = {
  entryId: string;
  date: string | null;
  docNo: string | null;
  description: string | null;
  /** รหัส/ชื่อบัญชีที่ไม่ใช่เงินสด (contra) — ตัวขับกิจกรรม เช่น "1640 อุปกรณ์สำนักงาน" */
  accountCode: string;
  accountName: string;
  /** จำนวนเงิน (บวก = เงินสดรับ/เพิ่ม · ลบ = เงินสดจ่าย/ลด) */
  amount: number;
};

export type CashFlowStatement = {
  operating: CashFlowLine[];
  investing: CashFlowLine[];
  financing: CashFlowLine[];
  totalOperating: number;
  totalInvesting: number;
  totalFinancing: number;
  /** totalOperating + totalInvesting + totalFinancing */
  netChange: number;
  openingCash: number;
  /** openingCash + netChange */
  closingCash: number;
  /**
   * ตรวจสอบภายในว่าไม่มีบรรทัดเงินสดตกหล่นจาก allocation/classify logic (0.9 — มิเรอร์ BalanceSheet.balanced):
   *   เทียบ netChange กับผลรวมบรรทัดเงินสดทั้งหมดใน journalLines ที่ส่งเข้ามาตรง ๆ (ไม่ผ่านการตัด/กรองใด ๆ)
   *   ต้องเท่ากันเสมอถ้า classify ครบทุกบรรทัดเงินสดจริง (รายการโอนภายในกลุ่มหักล้างกันเป็น 0 อยู่แล้ว
   *   ไม่ว่าจะรวมหรือตัดออกจาก CF ก็ไม่กระทบผลรวมนี้)
   */
  reconciled: boolean;
};

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

/** คีย์เรียงตามวันที่ (null = ท้ายสุด) — mirror ledger.ts::dateKey */
function dateKey(d: string | null): string {
  return d ?? "9999-99-99";
}

function sortLines(lines: CashFlowLine[]): CashFlowLine[] {
  return [...lines].sort((a, b) => {
    const byDate = dateKey(a.date).localeCompare(dateKey(b.date));
    if (byDate !== 0) return byDate;
    return a.entryId.localeCompare(b.entryId);
  });
}

function sumAmount(lines: CashFlowLine[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}

/**
 * สร้างงบกระแสเงินสด (direct method) จาก JournalLine[] ของงวดหนึ่ง (0.5–0.9)
 *   @param journalLines สมุดรายวันรวมทุกแหล่งของ "งวด flow" ที่เลือกจริง (bill journal + manual JE +
 *     bill_payments + CN/DN ที่กรองงวดมาแล้ว) — ★ ไม่ใช่ยอดสะสมทั้งหมด (นี่เป็น flow statement เหมือน
 *     งบกำไรขาดทุน ไม่ใช่ point-in-time เหมือนงบแสดงฐานะการเงิน)
 *   @param openingCash ยอดเงินสด+เทียบเท่าเงินสด ณ ต้นงวด (0.9 — คำนวณจากรอบ cumulative "สิ้นเดือน
 *     ก่อนหน้า from" โดย caller เช่น formal-statements.ts)
 *   @param chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — ใช้ตั้งชื่อบัญชีให้ตรงผังปัจจุบัน
 *   @param chart ผังบัญชีของ tenant (array) — ใช้คำนวณ cash pool (cashPoolCodesOf)
 */
export function buildCashFlowStatement(
  journalLines: JournalLine[],
  openingCash: number,
  chartByCode: ChartByCode,
  chart: ChartAccount[]
): CashFlowStatement {
  const cashPool = new Set(cashPoolCodesOf(chart));

  // 0.6: group ตาม entryId ก่อนเสมอ (1 posting = ธุรกรรม 1 รายการ ไม่ว่าจะมีกี่บรรทัด)
  const byEntry = new Map<string, JournalLine[]>();
  for (const l of journalLines) {
    const arr = byEntry.get(l.entryId) ?? [];
    arr.push(l);
    byEntry.set(l.entryId, arr);
  }

  const operating: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];

  for (const lines of byEntry.values()) {
    const cashLegs = lines.filter((l) => cashPool.has(l.accountCode));
    const nonCashLegs = lines.filter((l) => !cashPool.has(l.accountCode));

    // ไม่กระทบเงินสดเลย (เช่น CN/DN, 0.5) → ไม่เข้า CF
    if (cashLegs.length === 0) continue;
    // ทั้ง 2 ขาอยู่ใน cash pool หมด (โอนภายในกลุ่ม เช่น ฝากเงินสดเข้าธนาคาร, 0.6) → ตัดออกจาก CF ทั้งหมด
    if (nonCashLegs.length === 0) continue;

    for (const leg of nonCashLegs) {
      const amount = round2(-(leg.debit - leg.credit));
      if (!nonZero(amount)) continue;

      const line: CashFlowLine = {
        entryId: leg.entryId,
        date: leg.date,
        docNo: leg.docNo,
        description: leg.counterparty,
        accountCode: leg.accountCode,
        accountName: chartByCode[leg.accountCode]?.name ?? leg.accountName,
        amount,
      };

      const activity = classifyCashFlowActivity(leg.accountCode);
      if (activity === "investing") investing.push(line);
      else if (activity === "financing") financing.push(line);
      else operating.push(line);
    }
  }

  const operatingSorted = sortLines(operating);
  const investingSorted = sortLines(investing);
  const financingSorted = sortLines(financing);

  const totalOperating = sumAmount(operatingSorted);
  const totalInvesting = sumAmount(investingSorted);
  const totalFinancing = sumAmount(financingSorted);
  const netChange = round2(totalOperating + totalInvesting + totalFinancing);
  const closingCash = round2(openingCash + netChange);

  // 0.9: reconciliation — เทียบกับผลรวมบรรทัดเงินสดทั้งหมดใน journalLines ตรง ๆ (ไม่ผ่านการตัด/กรอง)
  const totalCashLineMovement = round2(
    journalLines
      .filter((l) => cashPool.has(l.accountCode))
      .reduce((s, l) => s + (l.debit - l.credit), 0)
  );
  const reconciled = Math.abs(netChange - totalCashLineMovement) < EPSILON;

  return {
    operating: operatingSorted,
    investing: investingSorted,
    financing: financingSorted,
    totalOperating,
    totalInvesting,
    totalFinancing,
    netChange,
    openingCash,
    closingCash,
    reconciled,
  };
}

/**
 * รวม CashFlowLine[] เป็น StatementLine[] (รวมยอดต่อรหัสบัญชี) — ใช้กับ mergeCompareLines/
 *   sumCompareLines เดิม (statement-compare.ts) ให้จอ/หน้าพิมพ์/Excel export งบกระแสเงินสด (O4)
 *   ใช้ pattern เทียบงวดแบบเดียวกับงบกำไรขาดทุน/งบแสดงฐานะการเงิน (0.13 spirit)
 *   ★ ลำดับแถว: ตามลำดับรหัสบัญชีที่ปรากฏครั้งแรกใน lines (ตรงกับลำดับที่ sortLines จัดมาให้แล้ว)
 */
export function aggregateCashFlowLines(lines: CashFlowLine[]): StatementLine[] {
  const order: string[] = [];
  const byCode = new Map<string, StatementLine>();
  for (const l of lines) {
    let row = byCode.get(l.accountCode);
    if (!row) {
      row = { code: l.accountCode, name: l.accountName, amount: 0 };
      byCode.set(l.accountCode, row);
      order.push(l.accountCode);
    }
    row.amount = round2(row.amount + l.amount);
  }
  return order.map((code) => byCode.get(code)!);
}
