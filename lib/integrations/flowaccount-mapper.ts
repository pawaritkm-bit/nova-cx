import { normalizeTaxId } from "@/lib/accounting/tax-id";
import { round2 } from "@/lib/accounting/queries";
import type { PaymentMethod, VatType } from "@/lib/accounting/queries";
import type { FlowAccountDocType } from "@/lib/integrations/flowaccount";

/**
 * bill_entries + bill_entry_lines + customer → payload FlowAccount (pure — ไม่แตะ DB/network)
 *   ★ ตาม decision 0.2 ของแผน (docs/05-flowaccount-integration.md): ไม่ส่งข้อมูล WHT รอบแรก
 *     ไม่ส่ง account_code ของผังบัญชีเราไป (ส่งรายการเป็น free-text แทน — เลี่ยงปัญหา mapping ผังบัญชี)
 */

/** วิธีจ่าย/รับเงิน → ชนิดเอกสาร (ยังไม่ระบุ = ถือเป็นเชื่อ ตาม convention journal.ts contraAccountFor) */
export function resolveDocType(paymentMethod: PaymentMethod | null): FlowAccountDocType {
  if (paymentMethod === "cash" || paymentMethod === "transfer" || paymentMethod === "cheque") {
    return "cash_sale";
  }
  return "tax_invoice"; // credit หรือ null (ยังไม่ระบุ)
}

export type MapperEntryInput = {
  docNo: string | null;
  docDate: string | null;
  paymentMethod: PaymentMethod | null;
};

export type MapperLineInput = {
  description: string | null;
  amount: number;
  vatAmount: number;
  vatType: VatType;
};

export type MapperCustomerInput = {
  name: string | null;
  taxId: string | null;
  address: string | null;
};

export type MapperRejectReason = "missing_customer_tax_id" | "no_value_lines" | "missing_doc_date";

export type MapperResult =
  | { ok: true; docType: FlowAccountDocType; body: Record<string, unknown> }
  | { ok: false; reason: MapperRejectReason };

/** ยังไม่มีคอลัมน์สาขาลูกค้าใน customers — ใช้สำนักงานใหญ่เป็น default เสมอ (M1) */
const DEFAULT_BRANCH = "สำนักงานใหญ่";

/** จำนวนวันเครดิตปริยาย (บิลเชื่อ) — NOVA-CX ยังไม่เก็บเงื่อนไขเครดิตจริง ใช้ค่ากลาง 30 วัน */
const DEFAULT_CREDIT_DAYS = 30;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * map เป็น payload สร้างเอกสารขาย (ทาง POST /tax-invoices หรือ /cash-invoices — ดู flowaccount.ts)
 *   reject ก่อน map ถ้า: ไม่มีเลขภาษีลูกค้า / ไม่มี line ที่มีมูลค่า>0 / ไม่มีวันที่บิล
 */
export function buildSalesDocumentPayload(
  entry: MapperEntryInput,
  lines: MapperLineInput[],
  customer: MapperCustomerInput
): MapperResult {
  const taxId = normalizeTaxId(customer.taxId ?? "");
  if (!taxId) return { ok: false, reason: "missing_customer_tax_id" };

  const valueLines = lines.filter((l) => round2(num(l.amount)) > 0 || round2(num(l.vatAmount)) > 0);
  if (valueLines.length === 0) return { ok: false, reason: "no_value_lines" };

  if (!entry.docDate) return { ok: false, reason: "missing_doc_date" };

  const docType = resolveDocType(entry.paymentMethod);
  const isCashSale = docType === "cash_sale";

  const subTotal = round2(valueLines.reduce((sum, l) => sum + num(l.amount), 0));
  const vatAmount = round2(valueLines.reduce((sum, l) => sum + num(l.vatAmount), 0));
  const grandTotal = round2(subTotal + vatAmount);
  const isVat = vatAmount > 0;

  // รายการสินค้า/บริการเป็น free-text ล้วน (M1 ไม่ผูกผังบัญชี/product master ของ FlowAccount)
  // ยืนยันจาก schema ProductItem (OpenAPI): `id` ไม่ใช่ required field — ใส่ 0 (ไม่อ้าง product master) ได้จริง
  const items = valueLines.map((l, idx) => {
    const amount = round2(num(l.amount));
    const name = l.description?.trim() || `รายการที่ ${idx + 1}`;
    return {
      id: 0,
      type: 1, // Service — ไม่ผูกผังบัญชี (ตาม decision 0.2)
      name,
      description: l.description ?? "",
      quantity: 1,
      unitName: "รายการ",
      pricePerUnit: amount,
      total: amount,
      sellChartOfAccountCode: "",
      buyChartOfAccountCode: "",
    };
  });

  const body: Record<string, unknown> = {
    recordId: 0,
    contactName: customer.name ?? "",
    contactAddress: customer.address ?? "",
    contactTaxId: taxId,
    contactBranch: DEFAULT_BRANCH,
    publishedOn: entry.docDate,
    // creditType ยืนยันจาก schema DateFields (OpenAPI): 1=เครดิต(วัน), 3=เงินสด, 5=เครดิต(ไม่แสดงวันครบกำหนด)
    creditType: isCashSale ? 3 : 1,
    creditDays: isCashSale ? 0 : DEFAULT_CREDIT_DAYS,
    dueDate: entry.docDate,
    reference: entry.docNo ?? "",
    isVatInclusive: false,
    useReceiptDeduction: false,
    subTotal,
    discountPercentage: 0,
    discountAmount: 0,
    totalAfterDiscount: subTotal,
    isVat,
    vatAmount,
    grandTotal,
    // M1 ไม่ส่งข้อมูล WHT ตอนสร้างเอกสารขาย (decision 0.2)
    documentShowWithholdingTax: false,
    documentWithholdingTaxPercentage: 0,
    documentWithholdingTaxAmount: 0,
    documentDeductionType: 0,
    documentDeductionAmount: 0,
    remarks: entry.docNo ? `อ้างอิงเลขที่บิล NOVA-CX: ${entry.docNo}` : "",
    documentStructureType: "SimpleDocument",
    saleAndPurchaseChannel: "",
    items,
  };

  return { ok: true, docType, body };
}
