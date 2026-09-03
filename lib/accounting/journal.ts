/**
 * A. สมุดรายวัน (Journal) — สร้างรายการเดบิต/เครดิตแบบ double-entry จากบิลที่ลงไว้
 *
 * ★ pure function ล้วน (ไม่แตะ DB/network) — unit test ได้เต็ม
 * ★ กติกาหลัก: ★ ทุก entry ที่ผ่านต้อง "เดบิตรวม = เครดิตรวม" เสมอ ★
 *
 * ★★ 2026-09-03 ผู้ใช้ยืนยันหลักบัญชีมาตรฐาน ("ตอนนี้ในระบบลงผิดอยู่") — โมเดล 2 ขา:
 *   ขา 1 "ตั้งหนี้" (invoice — ทุกบิล ไม่ว่าจ่ายแล้วหรือยัง):
 *     purchase: Dr ค่าใช้จ่าย + Dr ภาษีซื้อ / Cr หัก ณ ที่จ่าย / Cr เจ้าหนี้การค้า (2010) เสมอ
 *     sale:     Dr ลูกหนี้การค้า (1140) เสมอ / Cr รายได้ + Cr ภาษีขาย (+Dr ภาษีถูกหัก)
 *   ขา 2 "ตัดชำระ" (settlement — เฉพาะบิลที่รับ/จ่ายเงินแล้ว: เงินสด/โอน/เช็ค):
 *     purchase: Dr เจ้าหนี้การค้า / Cr เงินสด-ธนาคาร-เช็คจ่าย
 *     sale:     Dr เงินสด-ธนาคาร-เช็ครับ / Cr ลูกหนี้การค้า
 *   บิลเชื่อ (credit/ยังไม่ระบุ) = มีแค่ขา 1 — ขาตัดชำระเกิดทีหลังจากหน้า "รับ/จ่ายเงิน"
 *   (bill-payments.ts ซึ่ง Dr เจ้าหนี้ / Cr เงิน อยู่แล้ว)
 *
 * กติกา double-entry ขา 1 (ต่อ 1 บิล):
 *   purchase (ซื้อ):
 *     Dr แต่ละ line.account_code = line.amount
 *     Dr ภาษีซื้อ (1154)            = Σ vat_amount        (ถ้า > 0)
 *     Cr ภาษีหัก ณ ที่จ่าย (2910)    = Σ wht_amount        (ถ้า > 0)
 *     Cr เจ้าหนี้การค้า (2010)       = Σamount + Σvat − Σwht
 *   sale (ขาย):
 *     Cr แต่ละ line.account_code = line.amount
 *     Cr ภาษีขาย (2900)            = Σ vat_amount
 *     Dr ภาษีถูกหัก ณ ที่จ่าย (1216) = Σ wht_amount        (ถ้า > 0)
 *     Dr ลูกหนี้การค้า (1140)        = Σamount + Σvat − Σwht
 * ขา 2 (เฉพาะบิลที่จ่ายแล้ว): ยอดเดียวกับบัญชีคู่ขา 1 (Σamount + Σvat − Σwht)
 *
 * พิสูจน์สมดุล (ต่อขา):
 *   ขา 1 purchase: Dr = Σamount + Σvat ; Cr = Σwht + (Σamount+Σvat−Σwht) = Σamount + Σvat  ✓
 *   ขา 1 sale:     Cr = Σamount + Σvat ; Dr = Σwht + (Σamount+Σvat−Σwht) = Σamount + Σvat  ✓
 *   ขา 2: Dr = Cr = ยอดชำระ  ✓
 *
 * บิลที่ตกหล่น (ไม่เข้าสมุดรายวัน) → เก็บใน skipped[] พร้อมเหตุผล ให้ UI เตือนนักบัญชีไปแก้:
 *   - ยังไม่ระบุประเภท (unspecified)
 *   - ยังไม่ระบุวิธีรับ/จ่ายเงิน (คำนวณบัญชีคู่ไม่ได้) / โอนแต่ยังไม่เลือกบัญชีธนาคาร
 *   - บิลไม่มีจำนวนเงิน
 *
 * ★ 2026-09-02 ผู้ใช้: "บิลที่บรรทัดยังไม่มีเลขบัญชี ไม่ข้าม" — บรรทัดที่บัญชีขาดไม่ทำให้บิล
 *   ตกหล่นอีกต่อไป: ลงด้วยบัญชีพัก 0000 "รอเลือกบัญชี (พัก)" ให้เดบิต=เครดิตสมดุล บิลไหลเข้า
 *   สมุด 5 เล่ม → แยกประเภท → งบ ทันที · เห็น 0000 ที่ไหน = จุดที่นักบัญชีต้องกลับไปเลือกบัญชีจริง
 */
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { contraAccountFor } from "@/lib/accounting/payment";
import { round2, type BillEntry } from "@/lib/accounting/queries";
import {
  INPUT_VAT,
  OUTPUT_VAT,
  WHT_PAYABLE,
  WHT_RECEIVABLE,
  EPSILON,
} from "@/lib/accounting/statement-config";

export type JournalSide = "debit" | "credit";

/** ขาใบสำคัญ (2026-09-03): invoice = ตั้งหนี้ (เล่มซื้อ/ขาย) · settlement = ตัดชำระ (เล่มจ่าย/รับ) */
export type JournalLeg = "invoice" | "settlement";

/** บัญชีพักสำหรับบรรทัดที่ยังไม่เลือกบัญชี — เด่นชัดในสมุด/แยกประเภท ให้กลับไปเลือกบัญชีจริง */
export const SUSPENSE_ACCOUNT_CODE = "0000";
export const SUSPENSE_ACCOUNT_NAME = "รอเลือกบัญชี (พัก)";

/** 1 บรรทัดในสมุดรายวัน (เดบิตหรือเครดิต) */
export type JournalLine = {
  entryId: string;
  date: string | null;
  docNo: string | null;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  side: JournalSide;
  customerId: string | null;
  /** ชื่อคู่ค้า (ผู้ขาย/ผู้ซื้อ) — ใช้เป็นคำอธิบายในบัญชีแยกประเภท */
  counterparty: string | null;
  /** ขาใบสำคัญ: invoice = ตั้งหนี้ · settlement = ตัดชำระ (บิลจ่ายแล้วมี 2 ขา)
   *  optional เพื่อ backward-compat กับผู้สร้างบรรทัดอื่น (payments/CN-DN/manual) — ไม่ระบุ = invoice */
  leg?: JournalLeg;
};

/** บิลที่ลงบัญชีไม่ได้ (ตกหล่น) + เหตุผล */
export type SkippedEntry = {
  entryId: string;
  docNo: string | null;
  date: string | null;
  customerId: string | null;
  entryType: BillEntry["entryType"];
  reason: string;
};

export type JournalResult = {
  lines: JournalLine[];
  skipped: SkippedEntry[];
  totalDebit: number;
  totalCredit: number;
};

/** ชื่อบัญชีมาตรฐานจากผัง (fallback: ชื่อที่ลงในบิล → รหัส) */
function accountName(chartByCode: ChartByCode, code: string, fallback?: string | null): string {
  const fb = fallback && fallback.trim() ? fallback.trim() : null;
  return chartByCode[code]?.name ?? fb ?? code;
}

/** มีจำนวนเงินที่นับได้ (เกิน epsilon) ไหม */
function nonZero(n: number): boolean {
  return Math.abs(n) >= EPSILON;
}

/**
 * สร้างสมุดรายวันจากบิลทั้งชุด — ต่อ 1 บิลที่ผ่านเงื่อนไข จะได้หลายบรรทัดที่ "สมดุล"
 *   คืน { lines, skipped, totalDebit, totalCredit }
 *   @param chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — default {} เพื่อ backward-compat
 *     ระดับ compile เท่านั้น (ผู้เรียกจริงต้องส่งของจริงมาเสมอ ไม่งั้นชื่อบัญชี fallback เป็นแค่รหัส)
 */
export function buildJournalEntries(entries: BillEntry[], chartByCode: ChartByCode = {}): JournalResult {
  const lines: JournalLine[] = [];
  const skipped: SkippedEntry[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const e of entries) {
    // ★ 2026-09-02 ผู้ใช้ ("ทำไมคำอธิบายไม่ขึ้น"): บิลไม่มีชื่อคู่ค้า (เช่น รายการสเตทเมนต์
    //   ที่เป็นโค้ดธนาคาร ไม่มีชื่อผู้โอน) → ใช้คำอธิบายบรรทัดแรกที่มีข้อความแทน
    //   (เช่น "TX SYSG จากระบบเงินฝาก · โอน 00:00 น.") — แยกประเภท/สมุดรายวันจะได้ไม่ว่าง
    const counterparty =
      (e.counterpartyName ?? "").trim() ||
      (e.lines.find((l) => (l.description ?? "").trim())?.description?.trim() ?? null);
    const base = {
      entryId: e.id,
      docNo: e.docNo,
      date: e.docDate,
      customerId: e.customerId,
      counterparty,
    };
    const skip = (reason: string) =>
      skipped.push({ ...base, entryType: e.entryType, reason });

    // 1) ต้องเป็นซื้อ/ขายเท่านั้น (unspecified = รอนักบัญชีเลือกฝั่ง)
    if (e.entryType !== "purchase" && e.entryType !== "sale") {
      skip("ยังไม่ระบุประเภท (ซื้อ/ขาย)");
      continue;
    }

    // 2) ★ 2026-09-02 ผู้ใช้: บรรทัดที่ยังไม่เลือกบัญชี "ไม่ข้าม" — ลงบัญชีพัก 0000 แทน
    //    (เดิม: บัญชีขาด = บิลทั้งใบตกหล่นจากสมุด 5 เล่ม) · 0000 โผล่ที่ไหน = ต้องกลับไปเลือกบัญชีจริง
    const lineAccount = (l: { accountCode: string | null; accountName?: string | null }) => {
      const code = (l.accountCode ?? "").trim();
      return code
        ? { code, name: accountName(chartByCode, code, l.accountName) }
        : { code: SUSPENSE_ACCOUNT_CODE, name: SUSPENSE_ACCOUNT_NAME };
    };

    // 3) บัญชีคู่ 2 ขา (★ 2026-09-03 หลักบัญชีมาตรฐาน — ผู้ใช้: "ตอนนี้ในระบบลงผิดอยู่"):
    //   ขา 1 ตั้งหนี้: บัญชีคู่ = เจ้าหนี้การค้า (ซื้อ) / ลูกหนี้การค้า (ขาย) "เสมอ" ทุกวิธีชำระ
    //   ขา 2 ตัดชำระ: เฉพาะบิลที่รับ/จ่ายแล้ว (เงินสด/โอน/เช็ค) — Dr/Cr เจ้าหนี้-ลูกหนี้ กับบัญชีเงิน
    const arap = contraAccountFor(chartByCode, "credit", e.entryType);
    if (!arap || !arap.code.trim()) {
      skip("คำนวณบัญชีเจ้าหนี้/ลูกหนี้ไม่ได้");
      continue;
    }
    const method = e.paymentMethod ?? "credit";
    const settled = method === "cash" || method === "transfer" || method === "cheque";
    const money = settled
      ? contraAccountFor(chartByCode, method, e.entryType, e.paymentBankAccountCode)
      : null;
    if (settled && (!money || !money.code.trim())) {
      skip("โอนแต่ยังไม่เลือกบัญชีธนาคาร");
      continue;
    }

    // 4) รวมยอด
    let sumAmount = 0;
    let sumVat = 0;
    let sumWht = 0;
    for (const l of e.lines) {
      sumAmount += l.amount;
      sumVat += l.vatAmount;
      sumWht += l.whtAmount;
    }
    sumAmount = round2(sumAmount);
    sumVat = round2(sumVat);
    sumWht = round2(sumWht);
    const contraAmount = round2(sumAmount + sumVat - sumWht);

    if (!nonZero(sumAmount) && !nonZero(sumVat) && !nonZero(sumWht)) {
      skip("บิลไม่มีจำนวนเงิน");
      continue;
    }

    // buffer ต่อ 1 บิล (push จริงเมื่อยืนยันสมดุลแล้ว) — แยกขาใบสำคัญ
    const buf: JournalLine[] = [];
    const pushDebit = (leg: JournalLeg, code: string, name: string, amount: number) => {
      const v = round2(amount);
      if (!nonZero(v)) return;
      buf.push({ ...base, accountCode: code, accountName: name, debit: v, credit: 0, side: "debit", leg });
    };
    const pushCredit = (leg: JournalLeg, code: string, name: string, amount: number) => {
      const v = round2(amount);
      if (!nonZero(v)) return;
      buf.push({ ...base, accountCode: code, accountName: name, debit: 0, credit: v, side: "credit", leg });
    };

    // ---- ขา 1: ตั้งหนี้ (เข้าสมุดรายวันซื้อ/ขายเสมอ) ----
    if (e.entryType === "purchase") {
      for (const l of e.lines) {
        const a = lineAccount(l);
        pushDebit("invoice", a.code, a.name, l.amount);
      }
      pushDebit("invoice", INPUT_VAT, accountName(chartByCode, INPUT_VAT), sumVat);
      pushCredit("invoice", WHT_PAYABLE, accountName(chartByCode, WHT_PAYABLE), sumWht);
      pushCredit("invoice", arap.code, arap.name, contraAmount);
    } else {
      for (const l of e.lines) {
        const a = lineAccount(l);
        pushCredit("invoice", a.code, a.name, l.amount);
      }
      pushCredit("invoice", OUTPUT_VAT, accountName(chartByCode, OUTPUT_VAT), sumVat);
      pushDebit("invoice", WHT_RECEIVABLE, accountName(chartByCode, WHT_RECEIVABLE), sumWht);
      pushDebit("invoice", arap.code, arap.name, contraAmount);
    }

    // ---- ขา 2: ตัดชำระ (เฉพาะบิลที่รับ/จ่ายเงินแล้ว — เข้าสมุดรายวันจ่าย/รับ) ----
    if (money && nonZero(contraAmount)) {
      if (e.entryType === "purchase") {
        // จ่ายชำระ: Dr เจ้าหนี้ / Cr เงินสด-ธนาคาร-เช็คจ่าย
        pushDebit("settlement", arap.code, arap.name, contraAmount);
        pushCredit("settlement", money.code, money.name, contraAmount);
      } else {
        // รับชำระ: Dr เงินสด-ธนาคาร-เช็ครับ / Cr ลูกหนี้
        pushDebit("settlement", money.code, money.name, contraAmount);
        pushCredit("settlement", arap.code, arap.name, contraAmount);
      }
    }

    // 5) ยืนยันสมดุล "ต่อขา" (กันเคสตัวเลขบิลเพี้ยน) — ขาไหนไม่สมดุลก็ไม่ปล่อยทั้งบิล
    let balanced = true;
    for (const leg of ["invoice", "settlement"] as const) {
      const legLines = buf.filter((l) => l.leg === leg);
      const d = round2(legLines.reduce((s, l) => s + l.debit, 0));
      const c = round2(legLines.reduce((s, l) => s + l.credit, 0));
      if (Math.abs(d - c) >= EPSILON) {
        balanced = false;
        break;
      }
    }
    if (!balanced) {
      skip("เดบิต/เครดิตไม่สมดุล (ตรวจตัวเลขบิล)");
      continue;
    }

    lines.push(...buf);
    totalDebit = round2(totalDebit + buf.reduce((s, l) => s + l.debit, 0));
    totalCredit = round2(totalCredit + buf.reduce((s, l) => s + l.credit, 0));
  }

  return { lines, skipped, totalDebit, totalCredit };
}
