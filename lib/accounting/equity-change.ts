/**
 * งบการเปลี่ยนแปลงส่วนของผู้ถือหุ้น + บรรทัดปิดบัญชีสิ้นงวด — ★ 2026-09-02 (ขั้น 8 ให้ครบ)
 *
 * ★ pure function ล้วน (ไม่แตะ DB) — unit test ได้เต็ม
 *
 * งบเปลี่ยนแปลงส่วนผู้ถือหุ้น (ต่อบัญชีหมวด 3 + แถวกำไรสะสมจากผลดำเนินงานที่ยังไม่ปิด):
 *   ต้นงวด → เปลี่ยนแปลงระหว่างงวด → ปลายงวด · ยอดปลายงวดรวม = totalEquityWithProfit
 *   ของงบแสดงฐานะการเงิน (พิสูจน์ความสอดคล้องได้)
 *
 * ปิดบัญชี (closing entries): โอนยอดสะสมของหมวด 4/5/6 ทุกบัญชี ณ วันปิด เข้า "กำไรสะสม"
 *   (RETAINED_EARNINGS 3020) — เดบิตรายได้/เครดิตค่าใช้จ่าย ให้เหลือศูนย์ ผลต่างเข้ากำไรสะสม
 */
import { round2 } from "@/lib/accounting/queries";
import { buildIncomeStatement } from "@/lib/accounting/financial-statements";
import type { TrialBalance } from "@/lib/accounting/trial-balance";
import { EPSILON, RETAINED_EARNINGS } from "@/lib/accounting/statement-config";

/** คีย์กันปิดงวดซ้ำใน memo ของ JE ปิดบัญชี (⚙close|YYYY-MM) */
export const CLOSE_MARK = "⚙close|";

export type EquityChangeRow = {
  code: string;
  name: string;
  /** ยอดต้นงวด (ค่าบวกตามธรรมชาติหมวดทุน = เครดิต) */
  opening: number;
  /** เปลี่ยนแปลงระหว่างงวด (เพิ่มทุน/ปันผล/ปิดงวด ฯลฯ) */
  change: number;
  closing: number;
};

export type EquityChangeStatement = {
  rows: EquityChangeRow[];
  /** แถวกำไร(ขาดทุน)สะสมจากผลดำเนินงานที่ยังไม่ปิดเข้าบัญชี */
  unclosedProfit: EquityChangeRow;
  openingTotal: number;
  changeTotal: number;
  /** ยอดปลายงวดรวม — ต้องเท่ากับ totalEquityWithProfit ของงบแสดงฐานะการเงิน */
  closingTotal: number;
};

/**
 * @param openingTb งบทดลองสะสม "ก่อนต้นงวด" (ไม่มี from = งบทดลองจากยอดยกมาล้วน)
 * @param closingTb งบทดลองสะสม ณ สิ้นงวด
 */
export function buildEquityChangeStatement(
  openingTb: TrialBalance,
  closingTb: TrialBalance
): EquityChangeStatement {
  // ทุน (หมวด 3) เครดิตปกติ → amount = −balance
  const openBy = new Map<string, { name: string; amount: number }>();
  for (const r of openingTb.rows) {
    if (r.digit === "3") openBy.set(r.code, { name: r.name, amount: round2(-r.balance) });
  }
  const closeBy = new Map<string, { name: string; amount: number }>();
  for (const r of closingTb.rows) {
    if (r.digit === "3") closeBy.set(r.code, { name: r.name, amount: round2(-r.balance) });
  }

  const codes = [...new Set([...openBy.keys(), ...closeBy.keys()])].sort();
  const rows: EquityChangeRow[] = codes.map((code) => {
    const o = openBy.get(code);
    const c = closeBy.get(code);
    const opening = o?.amount ?? 0;
    const closing = c?.amount ?? 0;
    return {
      code,
      name: c?.name ?? o?.name ?? code,
      opening,
      closing,
      change: round2(closing - opening),
    };
  });

  // กำไรสะสมจากผลดำเนินงาน (หมวด 4−5/6) ที่ยังไม่ปิดเข้าบัญชีทุน — ต้นงวด/ปลายงวดจากงบทดลองแต่ละชุด
  const openingNp = buildIncomeStatement(openingTb).netProfit;
  const closingNp = buildIncomeStatement(closingTb).netProfit;
  const unclosedProfit: EquityChangeRow = {
    code: "",
    name: "กำไร (ขาดทุน) สะสมจากผลการดำเนินงาน (ยังไม่ปิดเข้าบัญชี)",
    opening: openingNp,
    closing: closingNp,
    change: round2(closingNp - openingNp),
  };

  const openingTotal = round2(rows.reduce((s, r) => s + r.opening, 0) + unclosedProfit.opening);
  const closingTotal = round2(rows.reduce((s, r) => s + r.closing, 0) + unclosedProfit.closing);
  return {
    rows,
    unclosedProfit,
    openingTotal,
    changeTotal: round2(closingTotal - openingTotal),
    closingTotal,
  };
}

// ---------------------------------------------------------------------
// ปิดบัญชีสิ้นงวด — สร้างบรรทัด JE โอนรายได้/ค่าใช้จ่ายเข้ากำไรสะสม
// ---------------------------------------------------------------------

export type ClosingLine = {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
};

export type ClosingEntryPlan = {
  lines: ClosingLine[];
  /** กำไร (ขาดทุน) สุทธิที่โอนเข้ากำไรสะสม — บวก = กำไร */
  netProfit: number;
};

/**
 * สร้างบรรทัดปิดบัญชีจากงบทดลองสะสม ณ วันปิด:
 *   รายได้ (หมวด 4, ยอดเครดิตคงเหลือ)   → เดบิตล้างยอด
 *   ค่าใช้จ่าย (หมวด 5/6, ยอดเดบิตคงเหลือ) → เครดิตล้างยอด
 *   ผลต่าง (กำไรสุทธิ) → เครดิตกำไรสะสม (ขาดทุน → เดบิต)
 *   คืน null ถ้าไม่มียอดให้ปิด (ทุกบัญชี P&L เป็นศูนย์แล้ว)
 */
export function buildClosingEntryLines(
  tb: TrialBalance,
  retained: { code?: string; name?: string } = {}
): ClosingEntryPlan | null {
  const lines: ClosingLine[] = [];
  let net = 0; // debit-positive รวมของ P&L (ลบ = เครดิต = กำไร)
  for (const r of tb.rows) {
    if (r.digit !== "4" && r.digit !== "5" && r.digit !== "6") continue;
    const bal = round2(r.balance); // debit-positive
    if (Math.abs(bal) < EPSILON) continue;
    net = round2(net + bal);
    // ล้างยอด: balance เครดิต (ลบ) → เดบิตเท่ายอด · balance เดบิต (บวก) → เครดิตเท่ายอด
    lines.push({
      accountCode: r.code,
      accountName: r.name,
      debit: bal < 0 ? round2(-bal) : 0,
      credit: bal > 0 ? bal : 0,
    });
  }
  if (lines.length === 0) return null;

  const netProfit = round2(-net); // กำไร = เครดิตสุทธิของ P&L
  if (Math.abs(netProfit) >= EPSILON) {
    lines.push({
      accountCode: retained.code ?? RETAINED_EARNINGS,
      accountName: retained.name ?? "กำไรสะสม",
      debit: netProfit < 0 ? round2(-netProfit) : 0,
      credit: netProfit > 0 ? netProfit : 0,
    });
  }
  return { lines, netProfit };
}
