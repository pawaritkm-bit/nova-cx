import { normalizeTaxId } from "@/lib/accounting/tax-id";
import { round2 } from "@/lib/accounting/queries";
import type { PaymentMethod, VatType } from "@/lib/accounting/queries";
import type { FlowAccountDocType, FlowAccountPurchaseDocType } from "@/lib/integrations/flowaccount";

/**
 * bill_entries + bill_entry_lines + customer/vendor → payload FlowAccount (pure — ไม่แตะ DB/network)
 *   ★ ตาม decision 0.2 ของแผน (docs/05-flowaccount-integration.md): ไม่ส่งข้อมูล WHT รอบแรก (ฝั่งขาย)
 *     และ decision 0.14 (docs/06) ฝั่งซื้อเช่นกัน
 *
 * ★★ เฟส 5 ส่วน P (T32, decision 0.6 — สำคัญที่สุด) ★★
 *   บิลซื้อ: contact ของเอกสาร (`contactName`/`contactTaxId`) ต้องมาจาก `entry.counterpartyName/
 *   counterpartyTaxId` (ผู้ขาย/vendor จริง) เท่านั้น — ห้ามใช้ `customers` (ตัวลูกค้า NOVA-CX เอง/เจ้าของ
 *   FlowAccount instance) เด็ดขาด (นั่นเป็นช่องว่างที่พบในมัปเปอร์บิลขายเดิม — ตัดสินใจไม่แก้ในเฟสนี้ ดู 0.6)
 *
 * ★★ เฟส 10 (multi-currency, decision 0.13 — T96) ★★ ไฟล์นี้ "ไม่ถูกแก้เลยแม้แต่บรรทัดเดียว" ในเฟส 10 —
 *   `line.amount`/`line.vatAmount` ที่อ่านอยู่แล้วเป็น THB ที่ derive มาแล้วเสมอ (ทั้งบิล THB ปกติและบิล FX
 *   ตาม 0.6 ของเฟส 10) มัปเปอร์นี้จึงไม่ต้องรู้จัก currency/fx_rate/fx_amount เลย — FlowAccount เห็นเฉพาะ
 *   ยอด/VAT เป็น THB ล้วน 100% ไม่มี currency/rate ปนไปด้วย (ยืนยันจาก help center จริงว่า FlowAccount เอง
 *   ก็บันทึกบัญชี GL เป็น THB เสมอ)
 */

/** วิธีจ่าย/รับเงิน → ชนิดเอกสารขาย (ยังไม่ระบุ = ถือเป็นเชื่อ ตาม convention journal.ts contraAccountFor) */
export function resolveDocType(paymentMethod: PaymentMethod | null): FlowAccountDocType {
  if (paymentMethod === "cash" || paymentMethod === "transfer" || paymentMethod === "cheque") {
    return "cash_sale";
  }
  return "tax_invoice"; // credit หรือ null (ยังไม่ระบุ)
}

/** วิธีจ่ายเงิน → ชนิดเอกสารซื้อ (mirror resolveDocType ฝั่งขาย — decision 0.4 ของแผน docs/06) */
export function resolvePurchaseDocType(paymentMethod: PaymentMethod | null): FlowAccountPurchaseDocType {
  if (paymentMethod === "cash" || paymentMethod === "transfer" || paymentMethod === "cheque") {
    return "cash_expense"; // จ่ายเงินแล้ว
  }
  return "purchase_bill"; // credit หรือ null (ยังไม่ระบุ) — ค้างจ่าย (AP)
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
  /**
   * รหัสบัญชี nova-cx ของบรรทัดนี้ (bill_entry_lines.account_code) — เฟส 5 ส่วน Q (decision 0.13):
   *   ใช้จับคู่กับ `maps.accountMap` เพื่อเติม `sellChartOfAccountCode` เท่านั้น · optional — ไม่ส่งมา = ไม่มีผลใดๆ
   */
  accountCode?: string | null;
  /**
   * product_id ของบรรทัดนี้ (bill_entry_lines.product_id) — ใช้จับคู่กับ `maps.productMap` เพื่อเติม
   * `items[].id` เท่านั้น · optional — ไม่ส่งมา = ไม่มีผลใดๆ
   */
  productId?: string | null;
};

/**
 * mapping ผังบัญชี/สินค้า nova-cx → FlowAccount ของลูกค้ารายนี้ (เฟส 5 ส่วน Q, decision 0.13)
 *   ★ optional ทั้งคู่ — ไม่ส่ง/ส่ง `{}` ต้องได้ผลลัพธ์เหมือนก่อนเฟสนี้เป๊ะ 100% (regression-critical)
 */
export type MapperMaps = {
  /** nova-cx account_code → รหัสบัญชีฝั่ง FlowAccount ของลูกค้ารายนี้ */
  accountMap?: Record<string, string>;
  /** nova-cx product_id → id สินค้าฝั่ง FlowAccount ของลูกค้ารายนี้ (เก็บเป็น text — parse เป็น number ตรงนี้) */
  productMap?: Record<string, string>;
};

export type MapperCustomerInput = {
  name: string | null;
  taxId: string | null;
  address: string | null;
};

/**
 * ผู้ขาย/vendor ของบิลซื้อ (T32, decision 0.6) — มาจาก `entry.counterpartyName/counterpartyTaxId` เท่านั้น
 *   ★ ไม่มีคอลัมน์ที่อยู่ผู้ขายในสคีมาปัจจุบัน (decision 0.15) — จึงไม่มี field `address` ที่นี่
 *   (ต่างจาก `MapperCustomerInput` ของฝั่งขายที่มี `address` จาก `customers.address`)
 */
export type MapperVendorInput = {
  name: string | null;
  taxId: string | null;
};

export type MapperRejectReason = "missing_customer_tax_id" | "no_value_lines" | "missing_doc_date";

export type MapperResult =
  | { ok: true; docType: FlowAccountDocType; body: Record<string, unknown> }
  | { ok: false; reason: MapperRejectReason };

/** เหตุผลปฏิเสธของ mapper บิลซื้อ (T32) — คนละชุดจากฝั่งขาย: ไม่มีเลขภาษี "ผู้ขาย" ไม่ใช่ "ลูกค้า" */
export type PurchaseMapperRejectReason = "missing_vendor_tax_id" | "no_value_lines" | "missing_doc_date";

export type PurchaseMapperResult =
  | { ok: true; docType: FlowAccountPurchaseDocType; body: Record<string, unknown> }
  | { ok: false; reason: PurchaseMapperRejectReason };

/** ยังไม่มีคอลัมน์สาขาลูกค้าใน customers — ใช้สำนักงานใหญ่เป็น default เสมอ (M1) */
const DEFAULT_BRANCH = "สำนักงานใหญ่";

/** จำนวนวันเครดิตปริยาย (บิลเชื่อ) — NOVA-CX ยังไม่เก็บเงื่อนไขเครดิตจริง ใช้ค่ากลาง 30 วัน */
const DEFAULT_CREDIT_DAYS = 30;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** ฝั่งไหนของ ProductItem ที่จะเติมรหัสบัญชีที่ map ได้ (ขาย=sellChartOfAccountCode, ซื้อ=buyChartOfAccountCode) */
type ChartCodeSide = "sell" | "buy";

/**
 * สร้างรายการ `items[]` ของ ProductItem — ใช้ร่วมกันทั้งเอกสารขาย/ซื้อ (T27/T32) ต่างกันแค่ field ชื่อ
 * รหัสบัญชีที่ map ได้ (sell/buy) — ตรรกะคำนวณ/mapping เหมือนกันทุกประการ (ไม่เขียนสูตรคู่ขนาน)
 *   ★ เฟส 5 (decision 0.13): ถ้ามี mapping ตรงกับ accountCode/productId ของบรรทัดนั้น → เติมค่าจริง
 *   ไม่มี maps/ไม่ตรง mapping ไหนเลย → ค่ายังว่าง/0 เหมือนก่อนเฟสนี้ทุกประการ (ไม่ throw)
 */
function buildLineItems(
  valueLines: MapperLineInput[],
  maps: MapperMaps | undefined,
  side: ChartCodeSide
): Record<string, unknown>[] {
  const accountMap = maps?.accountMap;
  const productMap = maps?.productMap;
  return valueLines.map((l, idx) => {
    const amount = round2(num(l.amount));
    const name = l.description?.trim() || `รายการที่ ${idx + 1}`;
    const mappedAccountCode = l.accountCode ? accountMap?.[l.accountCode] : undefined;
    const mappedProductRaw = l.productId ? productMap?.[l.productId] : undefined;
    const mappedProductId = mappedProductRaw !== undefined ? Number(mappedProductRaw) : NaN;
    return {
      id: Number.isFinite(mappedProductId) ? mappedProductId : 0,
      type: 1, // Service — ไม่ผูกผังบัญชีถ้าไม่มี mapping (ตาม decision 0.2/0.13)
      name,
      description: l.description ?? "",
      quantity: 1,
      unitName: "รายการ",
      pricePerUnit: amount,
      total: amount,
      sellChartOfAccountCode: side === "sell" ? (mappedAccountCode ?? "") : "",
      buyChartOfAccountCode: side === "buy" ? (mappedAccountCode ?? "") : "",
    };
  });
}

/**
 * map เป็น payload สร้างเอกสารขาย (ทาง POST /tax-invoices หรือ /cash-invoices — ดู flowaccount.ts)
 *   reject ก่อน map ถ้า: ไม่มีเลขภาษีลูกค้า / ไม่มี line ที่มีมูลค่า>0 / ไม่มีวันที่บิล
 */
export function buildSalesDocumentPayload(
  entry: MapperEntryInput,
  lines: MapperLineInput[],
  customer: MapperCustomerInput,
  maps?: MapperMaps
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

  // รายการสินค้า/บริการเป็น free-text โดย default (M1 ไม่ผูกผังบัญชี/product master ของ FlowAccount)
  // ยืนยันจาก schema ProductItem (OpenAPI): `id` ไม่ใช่ required field — ใส่ 0 (ไม่อ้าง product master) ได้จริง
  const items = buildLineItems(valueLines, maps, "sell");

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

/**
 * map เป็น payload สร้างเอกสารซื้อ/ค่าใช้จ่าย (ทาง POST /purchases หรือ /expenses — ดู flowaccount.ts,
 *   ⚠️ endpoint ยังไม่ยืนยันสเปกจริง — ดู decision 0.3)
 *   reject ก่อน map ถ้า: ผู้ขาย/vendor ไม่มีเลขภาษี / ไม่มี line ที่มีมูลค่า>0 / ไม่มีวันที่บิล
 *
 * ★★ decision 0.6 (สำคัญที่สุดของ T32) ★★ — `vendor` มาจาก `entry.counterpartyName/counterpartyTaxId`
 *   (ผู้ขายจริง) เท่านั้น ไม่ใช่ `customers` (ตัวลูกค้า NOVA-CX เอง — ใช้แค่ระบุ credential/FlowAccount
 *   instance ที่จะยิงเอกสารเข้า ไม่ใช่ contact ของเอกสาร)
 *   ★ ฟังก์ชัน pure 100% — ไม่แตะ DB/network (เหมือน buildSalesDocumentPayload)
 */
export function buildPurchaseDocumentPayload(
  entry: MapperEntryInput,
  lines: MapperLineInput[],
  vendor: MapperVendorInput,
  maps?: MapperMaps
): PurchaseMapperResult {
  const taxId = normalizeTaxId(vendor.taxId ?? "");
  if (!taxId) return { ok: false, reason: "missing_vendor_tax_id" };

  const valueLines = lines.filter((l) => round2(num(l.amount)) > 0 || round2(num(l.vatAmount)) > 0);
  if (valueLines.length === 0) return { ok: false, reason: "no_value_lines" };

  if (!entry.docDate) return { ok: false, reason: "missing_doc_date" };

  const docType = resolvePurchaseDocType(entry.paymentMethod);
  const isCashExpense = docType === "cash_expense";

  const subTotal = round2(valueLines.reduce((sum, l) => sum + num(l.amount), 0));
  const vatAmount = round2(valueLines.reduce((sum, l) => sum + num(l.vatAmount), 0));
  const grandTotal = round2(subTotal + vatAmount);
  const isVat = vatAmount > 0;

  // reuse buildLineItems ตัวเดียวกับฝั่งขาย (ไม่เขียนสูตรคำนวณคู่ขนาน) — side="buy" เติม buyChartOfAccountCode
  const items = buildLineItems(valueLines, maps, "buy");

  const body: Record<string, unknown> = {
    recordId: 0,
    contactName: vendor.name ?? "",
    // decision 0.15: bill_entries ไม่มีคอลัมน์ที่อยู่ผู้ขาย (counterparty_address) ในสคีมาปัจจุบัน → ส่งว่างเสมอ
    contactAddress: "",
    contactTaxId: taxId,
    contactBranch: DEFAULT_BRANCH,
    publishedOn: entry.docDate,
    // creditType convention เดียวกับฝั่งขาย: 1=เครดิต(วัน), 3=เงินสด
    creditType: isCashExpense ? 3 : 1,
    creditDays: isCashExpense ? 0 : DEFAULT_CREDIT_DAYS,
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
    // ไม่ส่งข้อมูล WHT ตอนสร้างเอกสารซื้อรอบแรกเช่นกัน (decision 0.14 — mirror decision 0.2 ของ M1)
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
