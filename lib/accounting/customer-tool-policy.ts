export type AccountingCustomerType = "company" | "individual" | null;

/**
 * งานบัญชีรายเดือนใช้ร่วมกันทั้งบุคคลธรรมดาและนิติบุคคล
 * ต่างกันเฉพาะงานปิดงบ/งบทางการปลายปีของนิติบุคคล
 */
export type AccountingToolScope = "monthly" | "company_closing";

export function canUseAccountingTool(
  customerType: AccountingCustomerType,
  scope: AccountingToolScope = "monthly"
): boolean {
  if (scope === "monthly") return customerType === "company" || customerType === "individual";
  return customerType === "company";
}

