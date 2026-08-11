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
 *   เดียวกับ dynamic import ที่ bill-payments.ts ใช้กับ credit-debit-notes.ts เดิม) — payment.ts เป็น leaf
 *   module (ไม่ import จาก bill-payments.ts/fx.ts) จึง import ตรงได้ปลอดภัย ไม่วนลูป
 *
 * ★ แก้ QC เฟส 10 (พบบั๊กร้ายแรง): เดิมบรรทัดปรับบัญชีคู่ของ JV แนะนำใช้ AR (1140)/AP (2010) — ผิดหลักบัญชี
 *   เพราะ bill-payments.ts::toJournalLines() ตัด AR/AP ด้วย "invoice rate" เสมอ (ไม่ใช่ settlement rate) →
 *   AR/AP ของบิลนั้นเคลียร์เป็น 0 พอดีทุกครั้งที่รับ/จ่ายเงินครบจำนวน FX เดิม ไม่มีทางเหลือเศษให้ปรับ ส่วนต่าง
 *   จริง (realized FX gain/loss) คือความต่างระหว่าง "เงินสด/ธนาคารที่ได้รับ/จ่ายจริง" (settlement rate) กับ
 *   "ยอดที่บันทึกไว้ในสมุดบัญชี" (invoice rate) ของงวดชำระนั้น — ต้องปรับที่บัญชีเงินสด/ธนาคาร (บัญชีคู่เดียวกับ
 *   ที่ toJournalLines() ใช้เป็น contra account ของงวดนั้น, derive ผ่าน contraAccountFor เดียวกัน) ไม่ใช่ AR/AP
 *   ที่เคลียร์ไปแล้ว — ถ้าปรับ AR/AP จะเกิดยอดค้างชำระปลอมที่ไม่มีทางเคลียร์ผ่าน flow ปกติอีก (งบดุลเพี้ยนถาวร)
 *   และบัญชีเงินสด/ธนาคารที่ควรถูกแก้จริงจะไม่ถูกแก้เลย (bank reconciliation ไม่ตรงตลอดไป)
 */
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { EntryType } from "@/lib/accounting/queries";
import type { ManualEntryInput } from "@/lib/accounting/manual-journal";
import { contraAccountFor } from "@/lib/accounting/payment";
import { EPSILON } from "@/lib/accounting/statement-config";

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
  /**
   * วิธีรับ/จ่ายเงินจริงของงวดนี้ (bill_payments.method) — ใช้ derive บัญชีคู่ (เงินสด/ธนาคาร) ที่ถูกต้องผ่าน
   *   contraAccountFor เดียวกับที่ bill-payments.ts::toJournalLines ใช้ตัดบัญชีคู่ของงวดนี้จริง (QC เฟส 10)
   */
  method: "cash" | "cheque" | "transfer";
  /** รหัสผังบัญชีเงินฝากธนาคารของงวดนี้ (bill_payments.bankAccountCode) — มีความหมายเฉพาะ method='transfer' */
  bankAccountCode?: string | null;
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
 *   2 บรรทัดเสมอ สมดุลเสมอ (debit=credit): บรรทัดแรกปรับบัญชีเงินสด/ธนาคาร ("บัญชีคู่") ของงวดชำระนั้นจริง
 *   (derive ผ่าน contraAccountFor เดียวกับที่ bill-payments.ts::toJournalLines ใช้ตัดบัญชีคู่ของงวดนี้ — ★
 *   ไม่ใช่ AR/AP ของบิลต้นทาง เพราะ AR/AP ถูกตัดด้วย invoice rate เสมอจนเคลียร์เป็น 0 ไปแล้ว ไม่มีเศษให้ปรับ,
 *   ดูหมายเหตุ QC เฟส 10 หัวไฟล์) · บรรทัดที่สองปรับบัญชีกำไร(ขาดทุน)จากอัตราแลกเปลี่ยนที่ผู้เรียกกำหนด
 *   (default เสนอ = currency.ts::DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE แต่นักบัญชีเปลี่ยนได้ทุกครั้งตอนกดแนะนำ) —
 *   ทิศทาง: กำไร (realized > 0) → เดบิตบัญชีเงินสด/ธนาคาร (ปรับให้ตรงกับยอดที่รับ/จ่ายจริง) + เครดิตบัญชี FX
 *   (รายได้เพิ่ม) · ขาดทุน (realized < 0) → เครดิตบัญชีเงินสด/ธนาคาร + เดบิตบัญชี FX (สลับกันเสมอ — สมดุลโดย
 *   ธรรมชาติ)
 *   @returns `null` ถ้า realized = 0 (อัตราวันออกบิล = อัตราวันชำระเป๊ะ) — ไม่มีความหมายให้สร้าง JV เปล่า (0.5/T90)
 *   @returns `null` ถ้า derive บัญชีคู่ (เงินสด/ธนาคาร) ไม่ได้ (defensive — ไม่ควรเกิดจาก flow จริง เพราะ
 *     cash/cheque/transfer + sale/purchase คำนวณได้เสมอผ่าน contraAccountFor)
 */
export function suggestFxGainLossEntryInput(
  payment: FxGainLossPaymentInput,
  entry: FxGainLossEntryInput,
  gainLossAccountCode: string,
  chartByCode: ChartByCode
): ManualEntryInput | null {
  const realized = realizedFxGainLoss(entry.entryType, payment.fxAmount, entry.fxRate, payment.fxRate);
  if (!nonZero(realized)) return null;

  const contra = contraAccountFor(chartByCode, payment.method, entry.entryType, payment.bankAccountCode);
  if (!contra || !contra.code.trim()) return null;
  const fxAccountName = chartByCode[gainLossAccountCode]?.name ?? "กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน";

  const amount = round2(Math.abs(realized));
  const isGain = realized > 0;
  const docNoSuffix = payment.docNo ? ` (บิล ${payment.docNo})` : "";
  const memo = `${isGain ? "กำไร" : "ขาดทุน"}จากอัตราแลกเปลี่ยน — งวดชำระวันที่ ${payment.payDate}${docNoSuffix}`;

  // metadata FX (badge ที่ JournalEntryPanel.tsx) — แปะไว้ทั้ง 2 บรรทัด ไม่กระทบ debit/credit/isBalanced เลย
  const fxMeta = { fxCurrency: payment.currency, fxRate: payment.fxRate, fxAmount: payment.fxAmount };

  const lines = isGain
    ? [
        { accountCode: contra.code, accountName: contra.name, description: memo, debit: amount, credit: 0, ...fxMeta },
        { accountCode: gainLossAccountCode, accountName: fxAccountName, description: memo, debit: 0, credit: amount, ...fxMeta },
      ]
    : [
        { accountCode: gainLossAccountCode, accountName: fxAccountName, description: memo, debit: amount, credit: 0, ...fxMeta },
        { accountCode: contra.code, accountName: contra.name, description: memo, debit: 0, credit: amount, ...fxMeta },
      ];

  return {
    docType: "JV",
    docDate: payment.payDate,
    docNo: null,
    memo,
    lines,
  };
}
