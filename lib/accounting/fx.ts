/**
 * กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่ "รับรู้แล้ว" (realized) ตอนรับ/จ่ายเงินบิล FX — pure ทั้งไฟล์
 *
 * บริบท: เฟส 10 ส่วน AA (docs/06-accounting-features-roadmap.md, 0.5/0.8/0.14) — บิล FX เก็บ `fx_rate`
 *   "ตอนออกบิล" ไว้คงที่ (bill_entries.fx_rate) แต่การรับ/จ่ายเงินจริงแต่ละงวดอาจใช้อัตรา ณ วันชำระ
 *   (bill_payments.fx_rate) ต่างกัน — ผลต่างนี้คือกำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่ "รับรู้แล้ว" ของงวดนั้น
 *
 * ★ Never-auto-confirm (0.5, mirror เฟส 6/7): ไฟล์นี้แค่ "คำนวณ + ประกอบ" ManualEntryInput draft ให้
 *   นักบัญชีตรวจ/ยืนยันเองผ่าน upsertManualEntry เดิม (server action ชั้นบนเป็นคนเรียก upsertManualEntry
 *   จริง — ไฟล์นี้ไม่แตะ DB เลย)
 * ★ ⚠️ ไม่ import จาก bill-payments.ts/journal.ts (รับพารามิเตอร์ที่จำเป็นตรง ๆ กันวนลูป import — pattern
 *   เดียวกับ dynamic import ที่ bill-payments.ts ใช้กับ credit-debit-notes.ts เดิม)
 */
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { EntryType } from "@/lib/accounting/queries";
import type { ManualEntryInput } from "@/lib/accounting/manual-journal";
import { AR, AP, EPSILON } from "@/lib/accounting/statement-config";

/** ปัดทศนิยม 2 ตำแหน่ง (เหมือน round2 ของ queries.ts — คัดลอกจุดเดียวกันเพื่อไม่ import ข้ามกลุ่ม pure) */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

function numLocal(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** ฝั่งบิลที่มีสิทธิ์รับรู้ FX ได้ (เหมือน BillPaymentScope) — unspecified ไม่มีทาง credit-eligible อยู่แล้ว */
export type FxEligibleEntryType = Extract<EntryType, "sale" | "purchase">;

/**
 * กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่รับรู้แล้วของงวดชำระ 1 งวด (0.8, pure) — เครื่องหมายอิงทิศทางธุรกรรม:
 *   - บิลขาย (ลด AR): realized = fxAmount × (settleFxRate − invoiceFxRate)
 *     (บาทอ่อนตัวลง = รับบาทมากกว่าที่ตั้งไว้ → กำไร บวก; บาทแข็งขึ้น → ขาดทุน ลบ)
 *   - บิลซื้อ (ลด AP): realized = fxAmount × (invoiceFxRate − settleFxRate)
 *     (ทิศตรงข้ามกับขาย เพราะเป็นฝั่งจ่าย)
 *   @param invoiceFxRate อัตรา "ตอนออกบิล" (bill_entries.fx_rate) — ★ ชื่อพารามิเตอร์ชัดเจน กันสลับกับ
 *     settleFxRate โดยไม่ตั้งใจ (ความเสี่ยงหลักของเฟสนี้ ดูหมวด 5 ของแผน)
 *   @param settleFxRate อัตรา "วันชำระ/settlement" ของงวดนี้ (bill_payments.fx_rate)
 */
export function realizedFxGainLoss(
  entryType: FxEligibleEntryType,
  fxAmount: number,
  invoiceFxRate: number,
  settleFxRate: number
): number {
  const amount = numLocal(fxAmount);
  const invoice = numLocal(invoiceFxRate);
  const settle = numLocal(settleFxRate);
  const rateDiff = entryType === "sale" ? settle - invoice : invoice - settle;
  return round2(amount * rateDiff);
}

/** ข้อมูลงวดชำระเท่าที่ suggestFxGainLossEntryInput ต้องใช้ (BillPayment ผ่านเข้าได้ตรง ๆ) */
export type FxGainLossPaymentInput = {
  /** YYYY-MM-DD */
  payDate: string;
  fxAmount: number;
  /** อัตราวันชำระ (settlement) ของงวดนี้ */
  fxRate: number;
  /** สกุลเงิน ISO 4217 ของงวดนี้ (ใช้แค่ทำ metadata badge ต่อบรรทัดของ JV, ไม่กระทบการคำนวณ) */
  currency: string;
  docNo?: string | null;
};

/** ข้อมูลบิลต้นทางเท่าที่ suggestFxGainLossEntryInput ต้องใช้ */
export type FxGainLossEntryInput = {
  entryType: FxEligibleEntryType;
  /** อัตรา "ตอนออกบิล" (bill_entries.fx_rate) */
  fxRate: number;
  counterpartyName?: string | null;
};

/**
 * ประกอบ ManualEntryInput (draft) สำหรับ "แนะนำ" กำไร/ขาดทุนจากอัตราแลกเปลี่ยนของงวดชำระ 1 งวด (0.5/0.8) —
 *   2 บรรทัดเสมอ สมดุลเสมอ (debit=credit): บรรทัดแรกปรับบัญชี AR (ขาย)/AP (ซื้อ) ของบิลต้นทาง · บรรทัดที่สอง
 *   ปรับบัญชีกำไร(ขาดทุน)จากอัตราแลกเปลี่ยนที่ผู้เรียกกำหนด (default เสนอ = currency.ts::
 *   DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE แต่นักบัญชีเปลี่ยนได้ทุกครั้งตอนกดแนะนำ) —
 *   ทิศทาง: กำไร (realized > 0) → เครดิตบัญชี FX (รายได้เพิ่ม) + เดบิต AR/AP ตรงข้าม · ขาดทุน (realized < 0)
 *   → เดบิตบัญชี FX + เครดิต AR/AP ตรงข้าม (สลับกันเสมอ — สมดุลโดยธรรมชาติ)
 *   @returns `null` ถ้า realized = 0 (อัตราวันออกบิล = อัตราวันชำระเป๊ะ) — ไม่มีความหมายให้สร้าง JV เปล่า (0.5/T90)
 */
export function suggestFxGainLossEntryInput(
  payment: FxGainLossPaymentInput,
  entry: FxGainLossEntryInput,
  gainLossAccountCode: string,
  chartByCode: ChartByCode
): ManualEntryInput | null {
  const realized = realizedFxGainLoss(entry.entryType, payment.fxAmount, entry.fxRate, payment.fxRate);
  if (!nonZero(realized)) return null;

  const arApCode = entry.entryType === "sale" ? AR : AP;
  const arApFallback = entry.entryType === "sale" ? "ลูกหนี้การค้า" : "เจ้าหนี้การค้า";
  const arApName = chartByCode[arApCode]?.name ?? arApFallback;
  const fxAccountName = chartByCode[gainLossAccountCode]?.name ?? "กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน";

  const amount = round2(Math.abs(realized));
  const isGain = realized > 0;
  const docNoSuffix = payment.docNo ? ` (บิล ${payment.docNo})` : "";
  const memo = `${isGain ? "กำไร" : "ขาดทุน"}จากอัตราแลกเปลี่ยน — งวดชำระวันที่ ${payment.payDate}${docNoSuffix}`;

  // metadata FX (badge ที่ JournalEntryPanel.tsx) — แปะไว้ทั้ง 2 บรรทัด ไม่กระทบ debit/credit/isBalanced เลย
  const fxMeta = { fxCurrency: payment.currency, fxRate: payment.fxRate, fxAmount: payment.fxAmount };

  const lines = isGain
    ? [
        { accountCode: arApCode, accountName: arApName, description: memo, debit: amount, credit: 0, ...fxMeta },
        { accountCode: gainLossAccountCode, accountName: fxAccountName, description: memo, debit: 0, credit: amount, ...fxMeta },
      ]
    : [
        { accountCode: gainLossAccountCode, accountName: fxAccountName, description: memo, debit: amount, credit: 0, ...fxMeta },
        { accountCode: arApCode, accountName: arApName, description: memo, debit: 0, credit: amount, ...fxMeta },
      ];

  return {
    docType: "JV",
    docDate: payment.payDate,
    docNo: null,
    memo,
    lines,
  };
}
