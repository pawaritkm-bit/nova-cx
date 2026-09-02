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

    // 3) บัญชีคู่ (เครดิต/เดบิต) จากวิธีรับ/จ่ายเงิน
    //   ★ บิลที่ยังไม่ตั้งวิธีจ่าย/รับ → ถือเป็น "เชื่อ" (ตั้งเจ้าหนี้/ลูกหนี้) เพื่อให้เข้าสมุดรายวันเลย
    //     (นักบัญชีค่อยแก้วิธีจ่ายจริงทีหลัง) — กันบิลตกหล่นจากสมุดรายวัน
    const contra = contraAccountFor(chartByCode, e.paymentMethod ?? "credit", e.entryType, e.paymentBankAccountCode);
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
        const a = lineAccount(l);
        pushDebit(a.code, a.name, l.amount);
      }
      pushDebit(INPUT_VAT, accountName(chartByCode, INPUT_VAT), sumVat);
      pushCredit(WHT_PAYABLE, accountName(chartByCode, WHT_PAYABLE), sumWht);
      pushCredit(contra.code, contra.name, contraAmount);
    } else {
      for (const l of e.lines) {
        const a = lineAccount(l);
        pushCredit(a.code, a.name, l.amount);
      }
      pushCredit(OUTPUT_VAT, accountName(chartByCode, OUTPUT_VAT), sumVat);
      pushDebit(WHT_RECEIVABLE, accountName(chartByCode, WHT_RECEIVABLE), sumWht);
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
