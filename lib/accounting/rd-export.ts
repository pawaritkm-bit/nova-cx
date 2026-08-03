/**
 * Export ไฟล์ยื่นกรมสรรพากรผ่านโปรแกรม RD Prep (ภ.ง.ด.3 / ภ.ง.ด.53 / ภ.พ.30)
 *   — pure builders (input = records → output = แถว/สตริง/Buffer) แยกจาก DB ทดสอบได้เต็ม
 *
 * ★★ สำคัญ: layout ทุกแบบเป็น "มาตรฐานที่พบบ่อย (รอผู้ใช้ยืนยันตัวอย่างจริงจาก RD Prep)"
 *    ผู้ใช้จะลอง import แล้วปรับทีหลังถ้าไม่ตรง — จึงทำ "ลำดับคอลัมน์" เป็น const array
 *    (PND_FIELDS / pp30Fields) แก้ง่าย + คอมเมนต์กำกับทุกคอลัมน์
 *
 * ★ .txt: คั่นด้วย `|` (pipe) 1 บรรทัด = 1 record · CRLF (RD Prep รันบน Windows)
 *    encoding default = TIS-620 (ไทยไม่เพี้ยนใน RD Prep คลาสสิก) — สลับเป็น UTF-8
 *    ได้ผ่าน env RD_TXT_ENCODING ถ้า RD Prep เวอร์ชันใหม่รับ UTF-8
 * ★ Excel: UTF-8 ปกติ (exceljs) — มีหัวตาราง + แถวรวมท้าย อ่านง่ายสำหรับตรวจ
 * ★ ยอดรวมท้าย: ใส่เฉพาะใน Excel/รายงาน (report.totals) — ไม่ใส่ในไฟล์ .txt import
 *    เพราะ RD Prep parse ทีละ record แถวสรุปจะทำ import พัง (ดู buildPndTextLines)
 * ★ PDPA: โมดูลนี้ไม่ log ค่าใด ๆ — ผู้เรียก (route) เป็นคน gate สิทธิ์ + สโคปลูกค้า
 */
import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { round2 } from "@/lib/accounting/queries";
import { normalizeTaxId } from "@/lib/accounting/tax-id";

// ---------------------------------------------------------------------
// ค่าคงที่ layout (แก้ง่าย)
// ---------------------------------------------------------------------

/** ตัวคั่นฟิลด์ในไฟล์ .txt ของ RD Prep */
export const RD_FIELD_SEP = "|";
/** ตัวจบบรรทัด (RD Prep = Windows) */
export const RD_LINE_END = "\r\n";
/** เลขที่สาขาสำนักงานใหญ่ (RD Prep ใช้ 00000) */
export const RD_HEAD_OFFICE_BRANCH = "00000";
/** เงื่อนไขการหัก: 1 = หัก ณ ที่จ่าย (ค่ามาตรฐานที่ใช้บ่อยสุด) */
export const RD_WHT_CONDITION = "1";

// ---------------------------------------------------------------------
// encoding (.txt)
// ---------------------------------------------------------------------

export type RdTxtEncoding = "tis-620" | "utf-8";

/**
 * เลือก encoding ของไฟล์ .txt — default TIS-620
 *   ตั้ง env `RD_TXT_ENCODING=utf-8` เพื่อสลับ (RD Prep เวอร์ชันใหม่บางตัวรับ UTF-8)
 */
export function resolveTxtEncoding(): RdTxtEncoding {
  const v = (process.env.RD_TXT_ENCODING ?? "").trim().toLowerCase();
  if (v === "utf-8" || v === "utf8") return "utf-8";
  return "tis-620";
}

/**
 * เข้ารหัสข้อความ .txt เป็น bytes ตาม encoding ที่เลือก (คืน Buffer พร้อมส่ง)
 *   - TIS-620: ใช้ iconv-lite (อักขระไทย → 0xA1–0xFB, ASCII คงเดิม)
 *   - UTF-8: encode ตรง
 */
export function encodeRdText(text: string, encoding: RdTxtEncoding = resolveTxtEncoding()): Buffer {
  if (encoding === "utf-8") return Buffer.from(text, "utf-8");
  return iconv.encode(text, "tis620");
}

/** ต่อบรรทัด record เป็นสตริงไฟล์เดียว (ปิดท้ายด้วย CRLF ให้ทุกบรรทัดสม่ำเสมอ) */
export function joinRdLines(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.join(RD_LINE_END) + RD_LINE_END;
}

// ---------------------------------------------------------------------
// helper รูปแบบค่า
// ---------------------------------------------------------------------

/** กันค่าทำ delimiter พัง: ตัด `|` และขึ้นบรรทัดใหม่ออก (แทนด้วยช่องว่าง) + trim */
export function sanitizeField(v: string | null | undefined): string {
  if (!v) return "";
  return v.replace(/[|\r\n]+/g, " ").trim();
}

/** จำนวนเงินทศนิยม 2 ตำแหน่ง (RD Prep รับ 1234.56 ไม่มี comma) */
export function formatAmount(n: number): string {
  return round2(n).toFixed(2);
}

/** อัตราภาษี % ทศนิยม 2 ตำแหน่ง (เช่น 3 → "3.00") */
export function formatRate(n: number): string {
  return round2(n).toFixed(2);
}

/**
 * วันที่ ISO (YYYY-MM-DD) → `dd/mm/yyyy` แบบ พ.ศ. (ปี ค.ศ. + 543)
 *   null/รูปแบบผิด → "" (record ที่ไม่มีวันที่ยังออกได้ แต่ช่องนี้ว่าง)
 */
export function toThaiDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const [, y, mm, dd] = m;
  const be = Number(y) + 543;
  return `${dd}/${mm}/${be}`;
}

// =====================================================================
// A. ภ.ง.ด.3 / ภ.ง.ด.53 (หัก ณ ที่จ่าย) — 1 record = 1 บิลที่มี wht > 0
// =====================================================================

/** แบบยื่น WHT: pnd3 = บุคคลธรรมดา · pnd53 = นิติบุคคล · null = ยังไม่ระบุแบบ */
export type PndForm = "pnd3" | "pnd53";

/** 1 record หัก ณ ที่จ่าย (ต่อ 1 บิล) — ยังไม่ format */
export type WhtRecord = {
  entryId: string;
  /** แบบตามบิล (null = บิลมี wht แต่ยังไม่ระบุแบบ → กลุ่ม "รอระบุแบบ") */
  form: PndForm | null;
  /** ผู้ถูกหัก = counterparty (ผู้รับเงินที่เรา/ลูกค้าจ่ายให้ตอนซื้อ) */
  payeeName: string;
  /** เลขผู้เสียภาษี 13 หลัก (normalize แล้ว) · null = ไม่มี → ยื่นไม่ได้ */
  payeeTaxId: string | null;
  branch: string;
  /** คำนำหน้า/นามสกุล: แยกไม่ได้จากข้อมูล → ปล่อยว่าง (ชื่อเต็มไปช่อง "ชื่อ") */
  title: string;
  lastName: string;
  /** ที่อยู่ผู้มีเงินได้ — ระบบยังไม่เก็บ → เว้นว่างให้ผู้ใช้เติมในใบแนบ */
  address: string;
  /** วันที่จ่าย (= doc_date ของบิล) ISO */
  datePaid: string | null;
  /** ประเภทเงินได้ = ชื่อบัญชีบรรทัดหลัก (เช่น ค่าบริการ/ค่าขนส่ง) */
  incomeType: string;
  /** อัตราภาษี % */
  rate: number;
  /** จำนวนเงินที่จ่าย (ฐานที่ถูกหัก) = Σ amount ของบรรทัดที่มี wht */
  paidAmount: number;
  /** ภาษีที่หัก = Σ wht_amount */
  whtAmount: number;
  condition: string;
};

/**
 * แปลง 1 บิล → WhtRecord (หรือ null ถ้าบิลนี้ไม่มีการหัก ณ ที่จ่าย)
 *   ★ รวมเป็น 1 record/บิล ตามสเปก — ถ้าบิลมีหลายบรรทัด wht อัตราต่างกัน
 *     จะยึด "อัตรา/ประเภทเงินได้" จากบรรทัดที่หักมากสุด (บรรทัดหลัก) แล้ว
 *     รวมฐาน/ยอดหักทุกบรรทัด (มาตรฐาน — ผู้ใช้ปรับได้ถ้าต้องแยกบรรทัด)
 */
export function toWhtRecord(e: BillEntry): WhtRecord | null {
  const whtLines = e.lines.filter((l) => (l.whtAmount ?? 0) > 0);
  if (whtLines.length === 0) return null;

  let paidAmount = 0;
  let whtAmount = 0;
  let primary: BillEntryLine = whtLines[0];
  for (const l of whtLines) {
    paidAmount += l.amount ?? 0;
    whtAmount += l.whtAmount ?? 0;
    if ((l.whtAmount ?? 0) > (primary.whtAmount ?? 0)) primary = l;
  }
  whtAmount = round2(whtAmount);
  if (whtAmount <= 0) return null;

  return {
    entryId: e.id,
    form: e.whtForm,
    payeeName: sanitizeField(e.counterpartyName),
    payeeTaxId: normalizeTaxId(e.counterpartyTaxId),
    branch: RD_HEAD_OFFICE_BRANCH,
    title: "",
    lastName: "",
    address: "",
    datePaid: e.docDate,
    incomeType: sanitizeField(primary.accountName ?? primary.description),
    rate: primary.whtRate ?? 0,
    paidAmount: round2(paidAmount),
    whtAmount,
    condition: RD_WHT_CONDITION,
  };
}

/**
 * ลำดับคอลัมน์ .txt/Excel ของ ภ.ง.ด.3/53 (มาตรฐาน — แก้ง่าย)
 *   index (1-based) มาจาก running seq ของ record ที่ยื่นได้
 */
export const PND_FIELDS: ReadonlyArray<{
  header: string;
  get: (r: WhtRecord, seq: number) => string;
}> = [
  { header: "ลำดับที่", get: (_r, seq) => String(seq) },
  { header: "เลขประจำตัวผู้เสียภาษี", get: (r) => r.payeeTaxId ?? "" }, // 13 หลัก ผู้ถูกหัก
  { header: "เลขที่สาขา", get: (r) => r.branch }, // 00000 = สนญ.
  { header: "คำนำหน้า", get: (r) => r.title }, // ว่าง (แยกไม่ได้)
  { header: "ชื่อ", get: (r) => r.payeeName }, // ชื่อเต็ม counterparty
  { header: "นามสกุล", get: (r) => r.lastName }, // ว่าง (นิติ/แยกไม่ได้)
  { header: "วันเดือนปีที่จ่าย", get: (r) => toThaiDate(r.datePaid) }, // dd/mm/yyyy พ.ศ.
  { header: "ประเภทเงินได้", get: (r) => r.incomeType },
  { header: "อัตราภาษี", get: (r) => formatRate(r.rate) },
  { header: "จำนวนเงินที่จ่าย", get: (r) => formatAmount(r.paidAmount) },
  { header: "ภาษีที่หัก", get: (r) => formatAmount(r.whtAmount) },
  { header: "เงื่อนไข", get: (r) => r.condition }, // 1 = หัก ณ ที่จ่าย
];

export type WhtTotals = { count: number; paidTotal: number; whtTotal: number };

export type PndReport = {
  form: PndForm;
  /** record ที่ยื่นได้ (แบบตรง + มีเลขภาษี + มี wht) */
  records: WhtRecord[];
  totals: WhtTotals;
  issues: {
    /** บิลมี wht แต่ wht_form = null → ต้องระบุแบบก่อน (ไม่รู้ว่าเข้า 3 หรือ 53) */
    unspecifiedForm: WhtRecord[];
    /** แบบตรงกับที่ขอ แต่ไม่มีเลขผู้เสียภาษี → ยื่นไม่ได้ (ตัดออกจาก records) */
    missingTaxId: WhtRecord[];
  };
};

function sumWhtTotals(records: WhtRecord[]): WhtTotals {
  let paidTotal = 0;
  let whtTotal = 0;
  for (const r of records) {
    paidTotal += r.paidAmount;
    whtTotal += r.whtAmount;
  }
  return { count: records.length, paidTotal: round2(paidTotal), whtTotal: round2(whtTotal) };
}

/**
 * สร้างรายงาน ภ.ง.ด.3 หรือ 53 จาก entries ทั้งชุด
 *   - แยกแบบด้วย wht_form: pnd3 → ภ.ง.ด.3 · pnd53 → ภ.ง.ด.53
 *   - wht_form=null (มี wht แต่ไม่รู้แบบ) → เข้ากลุ่ม unspecifiedForm (ไม่เดา) เตือนให้ระบุก่อน
 *   - ไม่มีเลขผู้เสียภาษี → เข้ากลุ่ม missingTaxId (ยื่นไม่ได้) ตัดออกจาก records
 */
export function buildPndReport(entries: BillEntry[], form: PndForm): PndReport {
  const records: WhtRecord[] = [];
  const unspecifiedForm: WhtRecord[] = [];
  const missingTaxId: WhtRecord[] = [];

  for (const e of entries) {
    const rec = toWhtRecord(e);
    if (!rec) continue; // ไม่มี wht → ไม่ใช่ record ยื่น (กรองออก)
    if (rec.form === null) {
      unspecifiedForm.push(rec);
      continue;
    }
    if (rec.form !== form) continue; // คนละแบบ → ข้าม (จะไปโผล่ตอน export อีกแบบ)
    if (!rec.payeeTaxId) {
      missingTaxId.push(rec);
      continue;
    }
    records.push(rec);
  }

  return {
    form,
    records,
    totals: sumWhtTotals(records),
    issues: { unspecifiedForm, missingTaxId },
  };
}

/** แถว .txt (คั่น |) ของ record เดียว ตาม PND_FIELDS */
export function whtRecordToLine(r: WhtRecord, seq: number): string {
  return PND_FIELDS.map((f) => sanitizeField(f.get(r, seq))).join(RD_FIELD_SEP);
}

/**
 * บรรทัด .txt ของ ภ.ง.ด. ทั้งไฟล์ (เฉพาะ record ที่ยื่นได้ — ไม่มี header/แถวรวม)
 *   ★ 1 บรรทัด = 1 การจ่าย (RD Prep จัดกลุ่มตามเลขภาษีเอง)
 *   ★ ยอดรวมอยู่ใน report.totals + Excel เท่านั้น (แถวรวมในไฟล์ import จะทำ RD Prep พัง)
 */
export function buildPndTextLines(report: PndReport): string[] {
  return report.records.map((r, i) => whtRecordToLine(r, i + 1));
}

/**
 * กลุ่มการจ่ายตาม "ผู้มีเงินได้" (payee) — ให้ Excel ใบแนบหน้าตาเหมือนฟอร์มจริง
 *   (payee เดียวจ่ายหลายครั้ง = หลายบรรทัดใต้ 1 record) — จัดกลุ่มด้วยเลขภาษี
 *   ★ .txt ไม่ใช้กลุ่มนี้ (แบนเป็น 1 บรรทัด/การจ่าย) — ใช้เฉพาะ Excel
 */
export type PayeeGroup = {
  taxId: string;
  name: string;
  address: string;
  /** การจ่ายทั้งหมดของ payee นี้ (เรียงตามลำดับใน records) */
  payments: WhtRecord[];
  subtotalPaid: number;
  subtotalWht: number;
};

export function groupWhtByPayee(records: WhtRecord[]): PayeeGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PayeeGroup>();
  for (const r of records) {
    const key = r.payeeTaxId ?? `name:${r.payeeName}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        taxId: r.payeeTaxId ?? "",
        name: r.payeeName,
        address: r.address,
        payments: [],
        subtotalPaid: 0,
        subtotalWht: 0,
      };
      byKey.set(key, g);
      order.push(key);
    }
    g.payments.push(r);
    g.subtotalPaid = round2(g.subtotalPaid + r.paidAmount);
    g.subtotalWht = round2(g.subtotalWht + r.whtAmount);
  }
  return order.map((k) => byKey.get(k)!);
}

// =====================================================================
// B. ภ.พ.30 — รายงานภาษีขาย / รายงานภาษีซื้อ
// =====================================================================

export type Pp30Kind = "sale" | "purchase";

/** 1 บรรทัดรายงานภาษีขาย/ซื้อ (ต่อ 1 ใบกำกับ) — ยังไม่ format */
export type Pp30Record = {
  entryId: string;
  docDate: string | null;
  docNo: string;
  /** ผู้ซื้อ (ขาย) / ผู้ขาย (ซื้อ) — fallback ไป counterparty ถ้าฝั่งเฉพาะว่าง */
  partyName: string;
  partyTaxId: string | null;
  branch: string;
  /** มูลค่าสินค้า/บริการ (ก่อน VAT) = Σ amount */
  baseAmount: number;
  /** ภาษีมูลค่าเพิ่ม = Σ vat_amount */
  vatAmount: number;
};

/** ผลรวมของบรรทัดในรายงาน (มี vat) */
function sumEntryVat(e: BillEntry): { base: number; vat: number } {
  let base = 0;
  let vat = 0;
  for (const l of e.lines) {
    base += l.amount ?? 0;
    vat += l.vatAmount ?? 0;
  }
  return { base: round2(base), vat: round2(vat) };
}

/** แปลง 1 บิล → Pp30Record ตามฝั่ง (sale = ผู้ซื้อ · purchase = ผู้ขาย) */
export function toPp30Record(e: BillEntry, kind: Pp30Kind): Pp30Record {
  const { base, vat } = sumEntryVat(e);
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
    docNo: sanitizeField(e.docNo),
    partyName: sanitizeField(name),
    partyTaxId: normalizeTaxId(taxRaw),
    branch: RD_HEAD_OFFICE_BRANCH,
    baseAmount: base,
    vatAmount: vat,
  };
}

/** ลำดับคอลัมน์ .txt/Excel ของ ภ.พ.30 (มาตรฐาน — แก้ง่าย) — party header ต่างตามฝั่ง */
export function pp30Fields(kind: Pp30Kind): ReadonlyArray<{
  header: string;
  get: (r: Pp30Record, seq: number) => string;
}> {
  return [
    { header: "ลำดับ", get: (_r, seq) => String(seq) },
    { header: "วันที่ใบกำกับ", get: (r) => toThaiDate(r.docDate) }, // พ.ศ.
    { header: "เลขที่ใบกำกับ", get: (r) => r.docNo },
    { header: kind === "sale" ? "ชื่อผู้ซื้อ" : "ชื่อผู้ขาย", get: (r) => r.partyName },
    { header: "เลขประจำตัวผู้เสียภาษี", get: (r) => r.partyTaxId ?? "" },
    { header: "เลขที่สาขา", get: (r) => r.branch }, // 00000 = สนญ.
    { header: "มูลค่าสินค้า/บริการ", get: (r) => formatAmount(r.baseAmount) },
    { header: "ภาษีมูลค่าเพิ่ม", get: (r) => formatAmount(r.vatAmount) },
  ];
}

export type Pp30Totals = { count: number; baseTotal: number; vatTotal: number };

export type Pp30Report = {
  kind: Pp30Kind;
  records: Pp30Record[];
  totals: Pp30Totals;
  /** เตือน: บิลที่ไม่มีเลขผู้เสียภาษี (ยังอยู่ในรายงาน VAT ได้ แต่ควรเติมก่อนยื่น) */
  warnings: { missingTaxId: number };
};

/**
 * สร้างรายงานภาษีขาย/ซื้อ (ภ.พ.30)
 *   - เลือก entry ตาม entry_type = kind และ "มี VAT" (Σ vat_amount > 0)
 *   - รวม record ที่ไม่มีเลขภาษีไว้ในรายงาน (VAT report ต้องครบทุกใบกำกับ) แต่ count เตือนไว้
 */
export function buildPp30Report(entries: BillEntry[], kind: Pp30Kind): Pp30Report {
  const records: Pp30Record[] = [];
  let missingTaxId = 0;
  let baseTotal = 0;
  let vatTotal = 0;

  for (const e of entries) {
    if (e.entryType !== kind) continue;
    const { vat } = sumEntryVat(e);
    if (vat <= 0) continue; // ไม่มี VAT → ไม่เข้ารายงานภาษี
    const rec = toPp30Record(e, kind);
    records.push(rec);
    if (!rec.partyTaxId) missingTaxId += 1;
    baseTotal += rec.baseAmount;
    vatTotal += rec.vatAmount;
  }

  return {
    kind,
    records,
    totals: { count: records.length, baseTotal: round2(baseTotal), vatTotal: round2(vatTotal) },
    warnings: { missingTaxId },
  };
}

/** แถว .txt (คั่น |) ของ 1 record ตาม pp30Fields(kind) */
export function pp30RecordToLine(r: Pp30Record, seq: number, kind: Pp30Kind): string {
  return pp30Fields(kind)
    .map((f) => sanitizeField(f.get(r, seq)))
    .join(RD_FIELD_SEP);
}

/** บรรทัด .txt ของ ภ.พ.30 ทั้งไฟล์ (ไม่มี header/แถวรวม — ยอดรวมอยู่ใน Excel/report) */
export function buildPp30TextLines(report: Pp30Report): string[] {
  const fields = pp30Fields(report.kind);
  return report.records.map((r, i) =>
    fields.map((f) => sanitizeField(f.get(r, i + 1))).join(RD_FIELD_SEP)
  );
}

// =====================================================================
// Excel builders (exceljs) — UTF-8, มีหัวตาราง + แถวรวมท้าย
// =====================================================================

const MONEY_FMT = "#,##0.00";

export type RdExcelHeader = {
  /** ป้ายกิจการ/ลูกค้า (เช่น "N023 · บริษัท ...") */
  entityLabel: string;
  /** ป้ายงวด (เช่น "ก.ค. 2569") */
  periodLabel: string;
  /** เลขผู้เสียภาษีของ "ผู้มีหน้าที่หักภาษี ณ ที่จ่าย" = ลูกค้าเรา (13 หลัก) · null = ไม่มี */
  payerTaxId?: string | null;
  /** สาขาของผู้หัก (default 00000 = สนญ.) */
  payerBranch?: string;
};

const PND_TITLE: Record<PndForm, string> = {
  pnd3: "ใบแนบ ภ.ง.ด.3",
  pnd53: "ใบแนบ ภ.ง.ด.53",
};

/**
 * คอลัมน์ Excel ใบแนบ ภ.ง.ด.3/53 (มาตรฐานตามใบแนบจริง — แก้ง่าย)
 *   ★ ภ.ง.ด.3 (บุคคล) มีช่อง "ชื่อสกุล" แยก · ภ.ง.ด.53 (นิติบุคคล) มีชื่อเดียว (ไม่มีชื่อสกุล)
 *   ค่าใน column มาจาก 1 "การจ่าย" (payment) โดยแถวแรกของ payee โชว์ข้อมูลผู้มีเงินได้
 *   แถวการจ่ายถัดไปของ payee เดิม เว้นช่องผู้มีเงินได้ (เหมือนฟอร์มจริง)
 */
type PndExcelCol = {
  header: string;
  width: number;
  money?: boolean;
  get: (ctx: {
    group: PayeeGroup;
    pay: WhtRecord;
    seq: number;
    isFirstOfPayee: boolean;
  }) => string | number;
};

export function pndExcelColumns(form: PndForm): PndExcelCol[] {
  const cols: PndExcelCol[] = [
    { header: "ลำดับที่", width: 8, get: (c) => (c.isFirstOfPayee ? c.seq : "") },
    {
      header: "เลขประจำตัวผู้เสียภาษี\n(ผู้มีเงินได้)",
      width: 18,
      get: (c) => (c.isFirstOfPayee ? c.group.taxId : ""),
    },
    { header: "ชื่อ", width: 26, get: (c) => (c.isFirstOfPayee ? c.group.name : "") },
  ];
  // ★ ภ.ง.ด.3 เท่านั้น มีช่อง "ชื่อสกุล" (นิติบุคคลไม่มี)
  if (form === "pnd3") {
    cols.push({ header: "ชื่อสกุล", width: 16, get: (c) => (c.isFirstOfPayee ? c.pay.lastName : "") });
  }
  cols.push(
    { header: "ที่อยู่", width: 24, get: (c) => (c.isFirstOfPayee ? c.group.address : "") },
    { header: "สาขาที่", width: 9, get: (c) => (c.isFirstOfPayee ? c.pay.branch : "") },
    { header: "วัน เดือน ปี ที่จ่าย", width: 15, get: (c) => toThaiDate(c.pay.datePaid) },
    { header: "ประเภทเงินได้", width: 20, get: (c) => c.pay.incomeType },
    { header: "อัตราภาษี\nร้อยละ", width: 9, money: true, get: (c) => round2(c.pay.rate) },
    { header: "จำนวนเงินที่จ่าย", width: 16, money: true, get: (c) => round2(c.pay.paidAmount) },
    { header: "ภาษีที่หักและนำส่ง", width: 16, money: true, get: (c) => round2(c.pay.whtAmount) },
    { header: "เงื่อนไข", width: 8, get: (c) => c.pay.condition }
  );
  return cols;
}

/** เขียนหัวเรื่องใบแนบ (ชื่อฟอร์ม + เลขภาษีผู้หัก + สาขา + กิจการ + งวด) */
function pndTitleRows(ws: ExcelJS.Worksheet, form: PndForm, h: RdExcelHeader): void {
  ws.addRow([PND_TITLE[form]]).font = { bold: true, size: 14 };
  ws.addRow([
    `เลขประจำตัวผู้เสียภาษีอากร (ของผู้มีหน้าที่หักภาษี ณ ที่จ่าย): ${h.payerTaxId ?? "-"}`,
    "",
    `สาขาที่: ${h.payerBranch ?? RD_HEAD_OFFICE_BRANCH}`,
  ]);
  ws.addRow([h.entityLabel]);
  ws.addRow([`งวด: ${h.periodLabel}`]);
  ws.addRow([]);
}

/**
 * Excel ใบแนบ ภ.ง.ด.3/53 — หน้าตาตามใบแนบจริง (หัว + จัดกลุ่มตามผู้มีเงินได้ + รวมท้าย)
 */
export async function buildPndWorkbook(
  report: PndReport,
  header: RdExcelHeader
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const ws = wb.addWorksheet(report.form === "pnd3" ? "ภ.ง.ด.3" : "ภ.ง.ด.53");

  pndTitleRows(ws, report.form, header);

  const cols = pndExcelColumns(report.form);
  const head = ws.addRow(cols.map((c) => c.header));
  head.font = { bold: true };
  head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  const groups = groupWhtByPayee(report.records);
  groups.forEach((group, gi) => {
    const seq = gi + 1;
    group.payments.forEach((pay, pi) => {
      const isFirstOfPayee = pi === 0;
      ws.addRow(cols.map((c) => c.get({ group, pay, seq, isFirstOfPayee })));
    });
  });

  // แถวรวมท้าย (ตามฟอร์ม: "รวมยอดเงินได้และภาษีที่นำส่ง")
  const totalRow: (string | number)[] = cols.map((c) =>
    c.header === "ประเภทเงินได้" ? "รวมยอดเงินได้และภาษีที่นำส่ง" : ""
  );
  // ใส่ยอดรวมลงคอลัมน์เงิน "จำนวนเงินที่จ่าย" และ "ภาษีที่หักและนำส่ง"
  const paidIdx = cols.findIndex((c) => c.header === "จำนวนเงินที่จ่าย");
  const whtIdx = cols.findIndex((c) => c.header === "ภาษีที่หักและนำส่ง");
  if (paidIdx >= 0) totalRow[paidIdx] = round2(report.totals.paidTotal);
  if (whtIdx >= 0) totalRow[whtIdx] = round2(report.totals.whtTotal);
  ws.addRow(totalRow).font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = cols[i]?.width ?? 14));
  cols.forEach((c, i) => {
    if (c.money) ws.getColumn(i + 1).numFmt = MONEY_FMT;
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Excel ภ.พ.30 (ขาย/ซื้อ) — คอลัมน์เดียวกับ .txt + แถวรวมท้าย */
export async function buildPp30Workbook(
  report: Pp30Report,
  header: RdExcelHeader
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const sheetName = report.kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ";
  const ws = wb.addWorksheet(sheetName);

  // หัวรายงาน (VAT register ที่ป้อนยอดให้ ภ.พ.30)
  ws.addRow([report.kind === "sale" ? "รายงานภาษีขาย" : "รายงานภาษีซื้อ"]).font = {
    bold: true,
    size: 14,
  };
  ws.addRow([`เลขประจำตัวผู้เสียภาษีอากร: ${header.payerTaxId ?? "-"}`, "", `สาขาที่: ${header.payerBranch ?? RD_HEAD_OFFICE_BRANCH}`]);
  ws.addRow([header.entityLabel]);
  ws.addRow([`งวด: ${header.periodLabel}`]);
  ws.addRow([]);

  const fields = pp30Fields(report.kind);
  const head = ws.addRow(fields.map((f) => f.header));
  head.font = { bold: true };
  head.alignment = { horizontal: "center" };

  report.records.forEach((r, i) => {
    ws.addRow([
      i + 1,
      toThaiDate(r.docDate),
      r.docNo,
      r.partyName,
      r.partyTaxId ?? "",
      r.branch,
      round2(r.baseAmount),
      round2(r.vatAmount),
    ]);
  });

  const total = ws.addRow([
    "",
    "",
    "",
    `รวม ${report.totals.count} ใบ`,
    "",
    "",
    round2(report.totals.baseTotal),
    round2(report.totals.vatTotal),
  ]);
  total.font = { bold: true };

  // อ้างช่องใน ภ.พ.30 ที่ยอดรวมนี้ป้อนเข้า (ให้ตรวจ/กรอกฟอร์มได้ง่าย)
  const boxNote =
    report.kind === "sale"
      ? "→ ภ.พ.30: ยอดขาย = ช่อง 1/4 · ภาษีขาย = ช่อง 5"
      : "→ ภ.พ.30: ยอดซื้อ = ช่อง 6 · ภาษีซื้อ = ช่อง 7";
  ws.addRow(["", "", "", boxNote]).font = { italic: true, color: { argb: "FF666666" } };

  ws.columns.forEach((c, i) => (c.width = [8, 14, 16, 28, 16, 10, 16, 14][i] ?? 14));
  ws.getColumn(7).numFmt = MONEY_FMT;
  ws.getColumn(8).numFmt = MONEY_FMT;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
