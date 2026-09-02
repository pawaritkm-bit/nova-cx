/**
 * statement-to-bills.ts — สะพาน "เงินเข้าจากสเตทเมนต์/รายงานแพลตฟอร์ม → บิลขาย (ร่าง)"
 *
 * เป้าหมาย (requirement ผู้ใช้ 2026-09-01): อ่านสเตทเมนต์/รายงานแพลตฟอร์มเสร็จ ให้รายการเงินเข้า
 *   "วิ่งไปเป็นบิลขาย" → บิลที่ยืนยันแล้วไหลเข้าสมุดรายวัน → แยกประเภท → งบ อัตโนมัติด้วย engine เดิม
 *   ใช้ร่วมกัน 2 เส้นทาง: (1) หน้าอัปโหลดเอง (ปุ่มกดสั่ง) (2) ไฟล์จากกลุ่มไลน์ (auto-read — เฉพาะ
 *   ลูกค้าที่เปิดธง customers.auto_bills_from_statement เพื่อกันรายได้ซ้ำกับบิลจริง)
 *
 * หลักการสำคัญ:
 *   - สร้างเป็น "ร่าง" เสมอ — นักบัญชีตรวจ/แก้/ยืนยันเองตาม flow ปกติ (ไม่ auto-confirm)
 *   - บรรทัดบิลต้องมีรหัสบัญชี (journal ข้ามบรรทัดที่ไม่มีบัญชี) → เดารหัสรายได้จากผังของ tenant:
 *       ชื่อมี "บริการ" ในหมวดรายได้ → ใช้ตัวนั้น · ไม่มี → 4010 · ไม่มีอีก → รหัสแรกของหมวดรายได้
 *   - วิธีรับเงิน: ลูกค้ามีบัญชีเงินฝากผูกไว้ "พอดี 1 บัญชี" → transfer + บัญชีนั้น (เงินเข้าแบงก์จริง)
 *     ไม่งั้นปล่อย null (journal ตีเป็นลูกหนี้ — เข้าสมุดรายวันได้ นักบัญชีแก้วิธีรับทีหลัง)
 *   - dedup (idempotent): คีย์ ⚙sib|วันที่|ยอด|อ้างอิง เก็บท้าย notes — รันซ้ำ/ไฟล์ซ้ำไม่สร้างซ้ำ
 * ★ PDPA: ไม่ log ชื่อ/ยอด/เนื้อรายการ
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { PlatformReportLine } from "@/lib/accounting/platform-report-analyze";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";

type DB = SupabaseClient;

/** ร่างบิลขาย 1 ใบ (จากเงินเข้า 1 รายการ / ยอดขายแพลตฟอร์ม 1 วัน) */
export type IncomeBillDraft = {
  /** YYYY-MM-DD */
  docDate: string;
  /** ยอดเงิน (บวก) */
  amount: number;
  counterpartyName: string | null;
  /** รายละเอียดบรรทัด (โชว์ในบิล) */
  description: string;
  /** คีย์กันซ้ำ (ต่อลูกค้า) — เก็บท้าย notes */
  dedupKey: string;
};

/** เครื่องหมายคีย์กันซ้ำใน notes (ตามด้วยคีย์) */
export const DEDUP_MARK = "⚙sib|";

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function isoDay(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(DATE_RE);
  return m ? m[0] : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ตัดอ้างอิงสั้น ๆ สำหรับคีย์กันซ้ำ (ASCII-safe พอประมาณ ไม่ยาวเกิน) */
function refOf(...parts: (string | null | undefined)[]): string {
  const s = parts.find((p) => p && p.trim());
  return (s ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
}

/** สเตทเมนต์ → ร่างบิลขาย "ต่อรายการเงินเข้า" (1 โอน = 1 บิล) */
export function saleDraftsFromStatementTxns(txns: StatementTxn[]): IncomeBillDraft[] {
  const out: IncomeBillDraft[] = [];
  for (const t of txns) {
    const day = isoDay(t.date);
    const amount = typeof t.amount === "number" ? round2(t.amount) : 0;
    if (t.direction !== "in" || !day || !(amount > 0)) continue;
    const ref = refOf(t.counterparty_account_no, t.counterparty_name, t.description);
    // เวลาโอนติดไปใน description ของบิล (requirement 2026-09-01 — ตามรอยธุรกรรมย้อนหลังได้)
    const baseDesc = (t.description?.trim() || "เงินเข้าจากสเตทเมนต์").slice(0, 180);
    out.push({
      docDate: day,
      amount,
      counterpartyName: t.counterparty_name?.trim() || null,
      description: t.time ? `${baseDesc} · โอน ${t.time} น.` : baseDesc,
      dedupKey: `${day}|${amount.toFixed(2)}|${ref}`,
    });
  }
  return out;
}

/**
 * รายงานแพลตฟอร์ม → ร่างบิลขาย "รวมต่อวัน" (ยอดขาย credit ของวันเดียวกันรวมเป็น 1 บิล)
 *   — รายงานมักมีเป็นพันออเดอร์ ถ้า 1 ออเดอร์ = 1 บิลจะท่วมโต๊ะทำงาน · ค่าธรรมเนียม/หักอื่น
 *     ไม่รวมที่นี่ (เป็นค่าใช้จ่าย — ใช้ปุ่มสมุดรายวันดราฟต์เดิมของหน้ารายงานแพลตฟอร์ม)
 */
export function saleDraftsFromPlatformLines(
  lines: PlatformReportLine[],
  platformLabel: string
): IncomeBillDraft[] {
  const byDay = new Map<string, number>();
  for (const l of lines) {
    const day = isoDay(l.date);
    const amount = typeof l.amount === "number" ? round2(l.amount) : 0;
    if (l.direction !== "credit" || l.category !== "sales" || !day || !(amount > 0)) continue;
    byDay.set(day, round2((byDay.get(day) ?? 0) + amount));
  }
  const label = (platformLabel || "แพลตฟอร์ม").trim().slice(0, 40);
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, amount]) => ({
      docDate: day,
      amount,
      counterpartyName: label,
      description: `ยอดขาย ${label} วันที่ ${day}`,
      dedupKey: `${day}|${amount.toFixed(2)}|pfm:${label}`,
    }));
}

/** เดารหัสบัญชีรายได้จากผังของ tenant (ดู header หลักการ) — null = ผังไม่มีหมวดรายได้เลย */
export function pickIncomeAccount(chart: ChartAccount[]): ChartAccount | null {
  const income = chart.filter((a) => a.category === "รายได้" && !a.bank);
  return (
    income.find((a) => a.name.includes("บริการ")) ??
    income.find((a) => a.code === "4010") ??
    income[0] ??
    null
  );
}

export type CreateSaleBillsResult = {
  created: number;
  /** ข้ามเพราะคีย์ซ้ำ (เคยสร้างแล้ว) */
  skippedDup: number;
  /** รหัสบัญชีรายได้ที่ใช้ (null = ผังไม่มีหมวดรายได้ — บรรทัดถูกปล่อยว่างให้เลือกเอง) */
  incomeAccountCode: string | null;
};

/** เพดานกันพลาด (ไฟล์ผิดปกติ/วนซ้ำ) — เกินนี้ตัดทิ้งส่วนเกิน (รายงานใน UI) */
const MAX_BILLS_PER_RUN = 500;

/**
 * สร้างบิลขาย (ร่าง) จากร่างเงินเข้า — idempotent ด้วย dedupKey ใน notes
 *   sourceLabel: ป้ายที่มาโชว์ใน notes เช่น "สเตทเมนต์ SCB มิ.ย. 69" / "รายงานแพลตฟอร์ม Shopee"
 */
export async function createSaleBillDrafts(
  db: DB,
  args: {
    tenantId: string;
    customerId: string;
    drafts: IncomeBillDraft[];
    sourceLabel: string;
  }
): Promise<CreateSaleBillsResult> {
  const drafts = args.drafts.slice(0, MAX_BILLS_PER_RUN);
  if (drafts.length === 0) return { created: 0, skippedDup: 0, incomeAccountCode: null };

  // 1) ผังบัญชี → รหัสรายได้
  const chart = await listChartOfAccounts(db, args.tenantId);
  const incomeAcc = pickIncomeAccount(chart);

  // 2) วิธีรับเงิน: ลูกค้ามีบัญชีเงินฝากพอดี 1 บัญชี → transfer + บัญชีนั้น
  let paymentMethod: string | null = null;
  let paymentBankAccountId: string | null = null;
  try {
    const { data: banks } = await db
      .from("customer_bank_accounts")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("customer_id", args.customerId)
      .is("deleted_at", null)
      .limit(2);
    if ((banks ?? []).length === 1) {
      paymentMethod = "transfer";
      paymentBankAccountId = (banks![0] as { id: string }).id;
    }
  } catch {
    // best-effort — ไม่มีตาราง/พลาด → ปล่อย null (journal ตีเป็นลูกหนี้)
  }

  // 3) โหลดคีย์ที่เคยสร้างแล้วของลูกค้ารายนี้ (จาก notes) — กันซ้ำแบบ idempotent
  const seen = new Set<string>();
  try {
    const { data } = await db
      .from("bill_entries")
      .select("notes")
      .eq("tenant_id", args.tenantId)
      .eq("customer_id", args.customerId)
      .like("notes", `%${DEDUP_MARK}%`)
      .limit(5000);
    for (const r of (data ?? []) as { notes: string | null }[]) {
      const m = r.notes?.match(/⚙sib\|(.+)$/m);
      if (m) seen.add(m[1].trim());
    }
  } catch {
    // อ่านคีย์เดิมไม่ได้ → สร้างต่อ (เสี่ยงซ้ำน้อยกว่าไม่สร้างเลย — นักบัญชีเห็น/ลบร่างซ้ำได้)
  }

  let created = 0;
  let skippedDup = 0;

  for (const d of drafts) {
    if (seen.has(d.dedupKey)) {
      skippedDup++;
      continue;
    }
    seen.add(d.dedupKey);

    const { data: ins, error } = await db
      .from("bill_entries")
      .insert({
        tenant_id: args.tenantId,
        customer_id: args.customerId,
        entry_type: "sale",
        status: "draft",
        source: "manual",
        doc_date: d.docDate,
        counterparty_name: d.counterpartyName,
        payment_method: paymentMethod,
        payment_bank_account_id: paymentBankAccountId,
        notes: `สร้างจาก${args.sourceLabel}\n${DEDUP_MARK}${d.dedupKey}`,
      })
      .select("id")
      .single();
    if (error || !ins) continue; // ใบนี้พลาด → ข้าม (ใบอื่นไปต่อ)

    await db.from("bill_entry_lines").insert({
      tenant_id: args.tenantId,
      entry_id: (ins as { id: string }).id,
      line_no: 1,
      vat_type: "novat",
      description: d.description,
      account_code: incomeAcc?.code ?? null,
      account_name: incomeAcc?.name ?? null,
      amount: d.amount,
      vat_amount: 0,
      wht_rate: 0,
      wht_amount: 0,
      ai_filled: false,
    });
    created++;
  }

  return { created, skippedDup, incomeAccountCode: incomeAcc?.code ?? null };
}

// ---------------------------------------------------------------------
// ★ 2026-09-02 — "ลงบัญชี" จากหน้ากระทบยอดบิลกับสเตทเมนต์:
//   แถวที่ไม่มีบิลแต่นักบัญชีกรอกบัญชีคู่แล้ว → สร้างเป็น "บิลยืนยัน" พร้อมรหัสบัญชีทันที
//   → ไหลเข้าสมุดรายวัน 5 เล่ม → แยกประเภท → งบ ด้วย engine เดิม (journal.ts)
//   เข้า = บิลขาย (Dr 1020 / Cr บัญชีที่เลือก) · ออก = บิลซื้อ (Dr บัญชีที่เลือก / Cr 1020)
//   idempotent ด้วย DEDUP_MARK เดียวกับ sale drafts (กันซ้ำข้ามฟีเจอร์)
// ---------------------------------------------------------------------

export type ReconPostRow = {
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  direction: "in" | "out";
  counterpartyName: string | null;
  accountNo: string | null;
  description: string | null;
  time: string | null;
  /** บัญชีที่นักบัญชีเลือก (รายได้/ค่าใช้จ่าย) — บรรทัดบิล · บัญชีคู่ 1020 journal จัดให้เอง */
  accountCode: string;
  accountName: string | null;
};

export type PostReconResult = { created: number; skippedDup: number; failed: number; updated: number };

/** สร้างบิล "ยืนยันแล้ว" จากแถวกระทบยอดที่กรอกบัญชีครบ — idempotent */
export async function createConfirmedBillsFromRecon(
  db: DB,
  args: { tenantId: string; customerId: string; rows: ReconPostRow[]; sourceLabel: string }
): Promise<PostReconResult> {
  const rows = args.rows.slice(0, MAX_BILLS_PER_RUN);
  if (rows.length === 0) return { created: 0, skippedDup: 0, failed: 0, updated: 0 };

  // วิธีรับ/จ่ายเงิน: โอนเสมอ (มาจากสเตทเมนต์ธนาคาร) — บัญชีเงินฝากผูกเมื่อมีบัญชีเดียวพอดี
  let paymentBankAccountId: string | null = null;
  try {
    const { data: banks } = await db
      .from("customer_bank_accounts")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("customer_id", args.customerId)
      .is("deleted_at", null)
      .limit(2);
    if ((banks ?? []).length === 1) paymentBankAccountId = (banks![0] as { id: string }).id;
  } catch {
    // best-effort
  }

  // คีย์ที่เคยสร้างแล้ว (รวมร่างจากฟีเจอร์เก่า) — กันซ้ำ · เก็บ entryId ไว้เผื่อ "แก้บัญชี" ใบเดิม
  const seen = new Map<string, string | null>();
  try {
    const { data } = await db
      .from("bill_entries")
      .select("id, notes")
      .eq("tenant_id", args.tenantId)
      .eq("customer_id", args.customerId)
      .like("notes", `%${DEDUP_MARK}%`)
      .limit(5000);
    for (const r of (data ?? []) as { id: string; notes: string | null }[]) {
      const m = r.notes?.match(/⚙sib\|(.+)$/m);
      if (m) seen.set(m[1].trim(), r.id);
    }
  } catch {
    // อ่านคีย์เดิมไม่ได้ → สร้างต่อ (นักบัญชีเห็น/ลบใบซ้ำได้)
  }

  const now = new Date().toISOString();
  let created = 0;
  let skippedDup = 0;
  let failed = 0;
  let updated = 0;

  for (const r of rows) {
    const day = isoDay(r.date);
    const amount = round2(r.amount);
    if (!day || !(amount > 0) || !r.accountCode.trim()) {
      failed++;
      continue;
    }
    const ref = refOf(r.accountNo, r.counterpartyName, r.description);
    const dedupKey = `${day}|${amount.toFixed(2)}|${ref}`;
    if (seen.has(dedupKey)) {
      // ★ 2026-09-02 ผู้ใช้ (ลงบัญชีอัตโนมัติ ไม่มีปุ่ม): ใบนี้เคยลงแล้ว → ถ้านักบัญชี "เปลี่ยนบัญชี"
      //   บนแถวเดิม ให้แก้บัญชีของใบเดิมตาม (ไม่สร้างใบใหม่ ไม่เบิ้ล)
      const existingId = seen.get(dedupKey);
      if (existingId) {
        try {
          const { error: upErr } = await db
            .from("bill_entry_lines")
            .update({ account_code: r.accountCode.trim(), account_name: r.accountName?.trim() || null })
            .eq("tenant_id", args.tenantId)
            .eq("entry_id", existingId)
            .neq("account_code", r.accountCode.trim());
          if (!upErr) updated++;
        } catch {
          // best-effort — ใบเดิมยังอยู่ครบ
        }
      }
      skippedDup++;
      continue;
    }
    seen.set(dedupKey, null);

    const isIn = r.direction === "in";
    const timeNote = r.time ? ` · โอน ${r.time} น.` : "";
    const { data: ins, error } = await db
      .from("bill_entries")
      .insert({
        tenant_id: args.tenantId,
        customer_id: args.customerId,
        entry_type: isIn ? "sale" : "purchase",
        status: "confirmed", // ★ ยืนยันทันที → เข้าสมุดรายวัน/แยกประเภท/งบเลย (นักบัญชีเลือกบัญชีเองแล้ว)
        confirmed_at: now,
        source: "manual",
        doc_date: day,
        counterparty_name: r.counterpartyName,
        payment_method: "transfer",
        payment_bank_account_id: paymentBankAccountId,
        notes: `ลงบัญชีจาก${args.sourceLabel}${timeNote}\n${DEDUP_MARK}${dedupKey}`,
      })
      .select("id")
      .single();
    if (error || !ins) {
      failed++;
      continue;
    }

    const { error: lineErr } = await db.from("bill_entry_lines").insert({
      tenant_id: args.tenantId,
      entry_id: (ins as { id: string }).id,
      line_no: 1,
      vat_type: "novat",
      description: (r.description?.trim() || (isIn ? "เงินเข้าจากสเตทเมนต์" : "เงินออกจากสเตทเมนต์")).slice(0, 180) + timeNote,
      account_code: r.accountCode,
      account_name: r.accountName,
      amount,
      vat_amount: 0,
      wht_rate: 0,
      wht_amount: 0,
      ai_filled: false,
    });
    if (lineErr) {
      // บรรทัดพลาด = บิลยืนยันเปล่าจะทำงบเพี้ยน → ถอนหัวบิลทิ้ง (best-effort)
      await db.from("bill_entries").delete().eq("id", (ins as { id: string }).id).eq("tenant_id", args.tenantId);
      failed++;
      continue;
    }
    created++;
  }

  return { created, skippedDup, failed, updated };
}
