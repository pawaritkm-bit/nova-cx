/**
 * รายงานภาษีซื้อ / รายงานภาษีขาย (แบบราชการ กรมสรรพากร) — data builder (pure)
 *
 * ★ ต่างจาก buildPp30Report (rd-export.ts) ตรงที่ฟอร์มราชการนี้แยก 3 คอลัมน์เงินต่อบิล:
 *     1) มูลค่าสินค้า/บริการที่คิด VAT  = Σ amount ของ line ที่ vatType='vat'
 *     2) มูลค่าที่ยกเว้น VAT           = Σ amount ของ line ที่ vatType='novat'
 *     3) ภาษีมูลค่าเพิ่ม               = Σ vatAmount (ทุก line)
 *   (buildPp30Report รวม amount ทุก line เป็น base เดียว + คัดเฉพาะบิลที่มี VAT>0 —
 *    ใช้สำหรับไฟล์ยื่น RD Prep คนละงาน จึง reuse ไม่ได้ตรง ๆ เลยแยก builder ตัวนี้)
 *
 * ★ ขอบเขต: 1 แถว = 1 บิล ของ entry_type ตรงกับ kind (purchase/sale) — ครบทุกใบ
 *   (ต่างจากรายงานยื่นที่คัดเฉพาะมี VAT) เพื่อให้ผู้ใช้เห็นทั้งบิลคิด VAT และยกเว้น VAT
 * ★ pure ไม่มี exceljs/DB — unit test ได้เต็ม · PDPA: ไม่ log ค่าใด ๆ
 */
import type { BillEntry } from "@/lib/accounting/queries";
import { round2 } from "@/lib/accounting/queries";
import { normalizeTaxId } from "@/lib/accounting/tax-id";

export type VatReportKind = "purchase" | "sale";

/** 1 แถวรายงาน (ต่อ 1 บิล) — ยังไม่ format ตัวเลข */
export type VatReportRow = {
  entryId: string;
  /** วันที่ใบกำกับ (ISO YYYY-MM-DD) · null = ไม่มี */
  docDate: string | null;
  /** เลขที่ใบกำกับ */
  docNo: string;
  /** ชื่อคู่ค้า: ภาษีซื้อ = ผู้ขาย · ภาษีขาย = ผู้ซื้อ (fallback → counterparty) */
  partyName: string;
  /** เลขประจำตัวผู้เสียภาษีคู่ค้า (normalize 13 หลัก) · null = ไม่มี */
  partyTaxId: string | null;
  /** สถานประกอบการเป็นสำนักงานใหญ่ (ลูกค้าไม่มีข้อมูลสาขา → true เสมอ Phase นี้) */
  isHeadOffice: boolean;
  /** มูลค่าที่คิด VAT (ก่อนภาษี) */
  baseVat: number;
  /** มูลค่าที่ยกเว้น VAT */
  baseExempt: number;
  /** ภาษีมูลค่าเพิ่ม */
  vat: number;
};

export type VatReportTotals = {
  count: number;
  baseVatTotal: number;
  baseExemptTotal: number;
  vatTotal: number;
};

export type VatReport = {
  kind: VatReportKind;
  rows: VatReportRow[];
  totals: VatReportTotals;
};

/** แยกยอด 1 บิลเป็น (คิด VAT / ยกเว้น VAT / VAT) ตามชนิดของแต่ละ line */
export function splitEntryVat(e: BillEntry): {
  baseVat: number;
  baseExempt: number;
  vat: number;
} {
  let baseVat = 0;
  let baseExempt = 0;
  let vat = 0;
  for (const l of e.lines) {
    const amount = l.amount ?? 0;
    // line ยกเว้น VAT (vatType='novat') → เข้าคอลัมน์ "มูลค่าที่ยกเว้น"
    if (l.vatType === "novat") baseExempt += amount;
    else baseVat += amount;
    vat += l.vatAmount ?? 0;
  }
  return { baseVat: round2(baseVat), baseExempt: round2(baseExempt), vat: round2(vat) };
}

/** ตัดช่องว่างหัวท้าย + กันค่า null (คืน "" ถ้าไม่มี) */
function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** แปลง 1 บิล → 1 แถวรายงาน ตามฝั่ง (sale=ผู้ซื้อ · purchase=ผู้ขาย) */
export function toVatReportRow(e: BillEntry, kind: VatReportKind): VatReportRow {
  const { baseVat, baseExempt, vat } = splitEntryVat(e);
  const name =
    kind === "sale"
      ? e.buyerName ?? e.counterpartyName
      : e.sellerName ?? e.counterpartyName;
  const taxRaw =
    kind === "sale"
      ? e.buyerTaxId ?? e.counterpartyTaxId
      : e.sellerTaxId ?? e.counterpartyTaxId;
  return {
    entryId: e.id,
    docDate: e.docDate,
    docNo: clean(e.docNo),
    partyName: clean(name),
    partyTaxId: normalizeTaxId(taxRaw),
    isHeadOffice: true, // ลูกค้าไม่มีข้อมูลสาขา → สำนักงานใหญ่เสมอ (Phase นี้)
    baseVat,
    baseExempt,
    vat,
  };
}

/** เรียงตามวันที่ใบกำกับ (เก่า→ใหม่) · ไม่มีวันที่ = ท้ายสุด · เท่ากันเรียงต่อด้วยเลขที่ */
function byDocDateAsc(a: VatReportRow, b: VatReportRow): number {
  if (a.docDate && b.docDate) {
    if (a.docDate !== b.docDate) return a.docDate < b.docDate ? -1 : 1;
  } else if (a.docDate) {
    return -1;
  } else if (b.docDate) {
    return 1;
  }
  return a.docNo.localeCompare(b.docNo, "th");
}

/**
 * สร้างรายงานภาษีซื้อ/ขาย จาก entries ทั้งชุด
 *   - คัดเฉพาะ entry_type ตรงกับ kind (purchase/sale) — 'unspecified' ไม่เข้ารายงาน
 *   - เรียงตามวันที่ + รวมยอด 3 คอลัมน์ท้าย
 *
 * หมายเหตุ: ผู้เรียกควรกรอง month + customer มาก่อน (ผ่าน listEntries filter)
 */
export function buildVatReport(entries: BillEntry[], kind: VatReportKind): VatReport {
  const rows: VatReportRow[] = [];
  let baseVatTotal = 0;
  let baseExemptTotal = 0;
  let vatTotal = 0;

  for (const e of entries) {
    if (e.entryType !== kind) continue;
    const row = toVatReportRow(e, kind);
    rows.push(row);
    baseVatTotal += row.baseVat;
    baseExemptTotal += row.baseExempt;
    vatTotal += row.vat;
  }

  rows.sort(byDocDateAsc);

  return {
    kind,
    rows,
    totals: {
      count: rows.length,
      baseVatTotal: round2(baseVatTotal),
      baseExemptTotal: round2(baseExemptTotal),
      vatTotal: round2(vatTotal),
    },
  };
}
