/**
 * A. สมุดรายวัน (Journal) — สร้างรายการเดบิต/เครดิตแบบ double-entry จากบิลที่ลงไว้
 *
 * ★ pure function ล้วน (ไม่แตะ DB/network) — unit test ได้เต็ม
 * ★ กติกาหลัก: ★ ทุก entry ที่ผ่านต้อง "เดบิตรวม = เครดิตรวม" เสมอ ★
 *
 * กติกา double-entry (ต่อ 1 บิล):
 *   purchase (ซื้อ):
 *     Dr แต่ละ line.account_code = line.amount
 *     Dr ภาษีซื้อ (1154)            = Σ vat_amount        (ถ้า > 0)
 *     Cr ภาษีหัก ณ ที่จ่าย (2910)    = Σ wht_amount        (ถ้า > 0)
 *     Cr บัญชีคู่ (เงินสด/ธนาคาร/เจ้าหนี้) = Σamount + Σvat − Σwht
 *   sale (ขาย):
 *     Cr แต่ละ line.account_code = line.amount
 *     Cr ภาษีขาย (2900)            = Σ vat_amount
 *     Dr ภาษีถูกหัก ณ ที่จ่าย (1216) = Σ wht_amount        (ถ้า > 0)
 *     Dr บัญชีคู่ (เงินสด/ธนาคาร/ลูกหนี้) = Σamount + Σvat − Σwht
 *
 * พิสูจน์สมดุล:
 *   purchase: Dr = Σamount + Σvat ; Cr = Σwht + (Σamount+Σvat−Σwht) = Σamount + Σvat  ✓
 *   sale:     Cr = Σamount + Σvat ; Dr = Σwht + (Σamount+Σvat−Σwht) = Σamount + Σvat  ✓
 *
 * บิลที่ตกหล่น (ไม่เข้าสมุดรายวัน) → เก็บใน skipped[] พร้อมเหตุผล ให้ UI เตือนนักบัญชีไปแก้:
 *   - ยังไม่ระบุประเภท (unspecified)
 *   - มีบรรทัดที่ยังไม่เลือกบัญชี (account_code ขาด) — กันงบเพี้ยน
 *   - ยังไม่ระบุวิธีรับ/จ่ายเงิน (คำนวณบัญชีคู่ไม่ได้) / โอนแต่ยังไม่เลือกบัญชีธนาคาร
 *   - บิลไม่มีจำนวนเงิน
 */
import { CHART_BY_CODE } from "@/lib/accounting/chart-of-accounts";
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

/** ชื่อบัญชีมาตรฐานจากผังกลาง (fallback: ชื่อที่ลงในบิล → รหัส) */
function accountName(code: string, fallback?: string | null): string {
  const fb = fallback && fallback.trim() ? fallback.trim() : null;
  return CHART_BY_CODE[code]?.name ?? fb ?? code;
}

/** มีจำนวนเงินที่นับได้ (เกิน epsilon) ไหม */
function nonZero(n: number): boolean {
  return Math.abs(n) >= EPSILON;
}

/**
 * สร้างสมุดรายวันจากบิลทั้งชุด — ต่อ 1 บิลที่ผ่านเงื่อนไข จะได้หลายบรรทัดที่ "สมดุล"
 *   คืน { lines, skipped, totalDebit, totalCredit }
 */
export function buildJournalEntries(entries: BillEntry[]): JournalResult {
  const lines: JournalLine[] = [];
  const skipped: SkippedEntry[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const e of entries) {
    const base = {
      entryId: e.id,
      docNo: e.docNo,
      date: e.docDate,
      customerId: e.customerId,
    };
    const skip = (reason: string) =>
      skipped.push({ ...base, entryType: e.entryType, reason });

    // 1) ต้องเป็นซื้อ/ขายเท่านั้น (unspecified = รอนักบัญชีเลือกฝั่ง)
    if (e.entryType !== "purchase" && e.entryType !== "sale") {
      skip("ยังไม่ระบุประเภท (ซื้อ/ขาย)");
      continue;
    }

    // 2) ทุกบรรทัดที่มียอด ต้องเลือกบัญชีแล้ว (บัญชีขาด = ลงไม่ครบ → งบเพี้ยน)
    const missingAccount = e.lines.some(
      (l) => nonZero(round2(l.amount)) && !(l.accountCode && l.accountCode.trim())
    );
    if (missingAccount) {
      skip("มีบรรทัดที่ยังไม่เลือกบัญชี");
      continue;
    }

    // 3) บัญชีคู่ (เครดิต/เดบิต) จากวิธีรับ/จ่ายเงิน
    const contra = contraAccountFor(e.paymentMethod, e.entryType, e.paymentBankAccountCode);
    if (!contra) {
      skip("ยังไม่ระบุวิธีรับ/จ่ายเงิน (คำนวณบัญชีคู่ไม่ได้)");
      continue;
    }
    if (!contra.code.trim()) {
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

    // buffer ต่อ 1 บิล (push จริงเมื่อยืนยันสมดุลแล้ว)
    const buf: JournalLine[] = [];
    const pushDebit = (code: string, name: string, amount: number) => {
      const v = round2(amount);
      if (!nonZero(v)) return;
      buf.push({ ...base, accountCode: code, accountName: name, debit: v, credit: 0, side: "debit" });
    };
    const pushCredit = (code: string, name: string, amount: number) => {
      const v = round2(amount);
      if (!nonZero(v)) return;
      buf.push({ ...base, accountCode: code, accountName: name, debit: 0, credit: v, side: "credit" });
    };

    if (e.entryType === "purchase") {
      for (const l of e.lines) {
        pushDebit(l.accountCode as string, accountName(l.accountCode as string, l.accountName), l.amount);
      }
      pushDebit(INPUT_VAT, accountName(INPUT_VAT), sumVat);
      pushCredit(WHT_PAYABLE, accountName(WHT_PAYABLE), sumWht);
      pushCredit(contra.code, contra.name, contraAmount);
    } else {
      for (const l of e.lines) {
        pushCredit(l.accountCode as string, accountName(l.accountCode as string, l.accountName), l.amount);
      }
      pushCredit(OUTPUT_VAT, accountName(OUTPUT_VAT), sumVat);
      pushDebit(WHT_RECEIVABLE, accountName(WHT_RECEIVABLE), sumWht);
      pushDebit(contra.code, contra.name, contraAmount);
    }

    // 5) ยืนยันสมดุลต่อบิล (กันเคสตัวเลขบิลเพี้ยน) — ไม่สมดุลก็ไม่ปล่อยเข้าระบบงบ
    const d = round2(buf.reduce((s, l) => s + l.debit, 0));
    const c = round2(buf.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(d - c) >= EPSILON) {
      skip("เดบิต/เครดิตไม่สมดุล (ตรวจตัวเลขบิล)");
      continue;
    }

    lines.push(...buf);
    totalDebit = round2(totalDebit + d);
    totalCredit = round2(totalCredit + c);
  }

  return { lines, skipped, totalDebit, totalCredit };
}
