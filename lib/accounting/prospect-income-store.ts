/**
 * prospect-income-store.ts — data layer: สะสมยอดเงินเข้าต่อธนาคาร/ปี ของว่าที่ลูกค้า
 *   ผูก chat_group (ยังไม่ต้องมี customer_id) → รวมหลายธนาคารเป็นตารางวิเคราะห์ (Excel)
 *
 * ★ ทุก query กรอง tenant_id + chat_group_id · service role เท่านั้น (RLS ไม่มี policy)
 * ★ PDPA: ไม่ log ยอด/ชื่อ
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BankMonthly, BankSummary } from "@/lib/accounting/prospect-income-analysis";

type DB = SupabaseClient;

/** upsert ยอดรายเดือนของธนาคารหนึ่ง/ปีหนึ่ง (คีย์ tenant+group+bank+year) */
export async function upsertProspectBankSummary(
  db: DB,
  p: {
    tenantId: string;
    chatGroupId: string;
    bankLabel: string;
    year: number;
    monthly: BankMonthly[];
    closingBalance?: number | null;
    nowIso: string;
  }
): Promise<void> {
  await db.from("prospect_bank_summaries").upsert(
    {
      tenant_id: p.tenantId,
      chat_group_id: p.chatGroupId,
      bank_label: p.bankLabel,
      year: p.year,
      monthly: p.monthly,
      closing_balance: p.closingBalance ?? null,
      updated_at: p.nowIso,
    },
    { onConflict: "tenant_id,chat_group_id,bank_label,year" }
  );
}

/** โหลดยอดทุกธนาคารของว่าที่ลูกค้ารายนี้ ปีนั้น → BankSummary[] (สำหรับ buildProspectIncomeWorkbook) */
export async function loadProspectBankSummaries(
  db: DB,
  tenantId: string,
  chatGroupId: string,
  year: number
): Promise<BankSummary[]> {
  const { data } = await db
    .from("prospect_bank_summaries")
    .select("bank_label, monthly, closing_balance")
    .eq("tenant_id", tenantId)
    .eq("chat_group_id", chatGroupId)
    .eq("year", year)
    .order("bank_label", { ascending: true });
  return ((data ?? []) as Array<{ bank_label: string; monthly: BankMonthly[] | null; closing_balance: number | null }>).map((r) => ({
    bankLabel: r.bank_label,
    monthly: Array.isArray(r.monthly) ? r.monthly : [],
    closingBalance: r.closing_balance,
  }));
}
