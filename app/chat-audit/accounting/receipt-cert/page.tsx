import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { lineNet } from "@/lib/accounting/queries";
import ReceiptCertDoc, { type ReceiptCertItem } from "./ReceiptCertDoc";
import "./receipt-cert.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/receipt-cert — "ใบรับรองแทนใบเสร็จรับเงิน"
 *
 * เอกสารที่ลูกค้า (ผู้จ่าย) ออกเมื่อจ่ายค่าใช้จ่ายแล้วผู้รับเงินออกใบเสร็จไม่ได้
 *   → หัวกระดาษ = ข้อมูล "ลูกค้า" (ผู้จ่าย/ผู้รับรอง) ไม่ใช่ Finovas
 *
 * เข้าได้ 2 ทาง (ผ่าน searchParams):
 *   - ?customer=<uuid>            → ฟอร์มเปล่าของลูกค้า (ดึงหัวกระดาษให้)
 *   - ?customer=<uuid>&bill=<uuid> → prefill รายการ/จำนวนเงิน/วันที่ จากบิลใบนั้น
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 *   ★ tenantId จาก session (ไม่เชื่อ client)
 *   ★ Phase 1: ไม่บันทึกลง DB / ไม่ auto-number — เลขที่เอกสารเป็นช่องกรอก (มี default แนะนำ)
 *   ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ที่อยู่/ตัวเลข
 */

/** วันที่วันนี้ (เวลาไทย) รูปแบบ dd/mm/พ.ศ. — ค่า default ของช่อง "วันที่" */
function todayThaiDate(): string {
  // ใช้ timeZone Asia/Bangkok กันเหลื่อมวัน (บทเรียนทีม: ตัดเดือนตามเวลาไทย)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  return `${get("day")}/${get("month")}/${y + 543}`;
}

/** แปลง doc_date (YYYY-MM-DD) → dd/mm/พ.ศ. (คืน "" ถ้าไม่มี/พัง) */
function isoToThaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/** ตัวเลขปลอดภัย (NaN/null → 0) */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** ดึง "ชื่อผู้ติดต่อ" ของลูกค้า (ข้าพเจ้า/ผู้จ่าย) — best-effort */
async function loadContactName(
  service: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<string | null> {
  // 1) ผู้ติดต่อหลักใน customer_contacts (คอลัมน์ name เป็น plain text — ไม่เข้ารหัส)
  try {
    const { data } = await service
      .from("customer_contacts")
      .select("name, is_primary")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .limit(5);
    for (const c of (data ?? []) as { name: string | null; is_primary: boolean }[]) {
      if (c.name && c.name.trim()) return c.name.trim();
    }
  } catch {
    // ตาราง/คอลัมน์ผิดพลาดชั่วคราว → ลอง fallback ต่อ
  }
  // 2) fallback: ชื่อที่แสดงของบัญชี LINE ที่ผูกลูกค้ารายนี้
  try {
    const { data } = await service
      .from("line_users")
      .select("display_name")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .limit(1);
    const dn = (data?.[0] as { display_name: string | null } | undefined)?.display_name;
    if (dn && dn.trim()) return dn.trim();
  } catch {
    // degrade เงียบ ๆ
  }
  return null;
}

/** ดึงรายการจากบิล (prefill) — คืน items + วันที่บิล (scope tenant + ต้องเป็นลูกค้ารายเดียวกัน) */
async function loadBillPrefill(
  service: SupabaseClient,
  tenantId: string,
  billId: string,
  customerId: string
): Promise<{ items: ReceiptCertItem[]; docDate: string } | null> {
  const { data: entry } = await service
    .from("bill_entries")
    .select("id, customer_id, doc_date")
    .eq("id", billId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!entry) return null;
  const e = entry as { id: string; customer_id: string | null; doc_date: string | null };
  // บิลต้องเป็นของลูกค้ารายนี้ (กันดึงข้ามลูกค้า/นอกสโคป)
  if (e.customer_id !== customerId) return null;

  const { data: lineData } = await service
    .from("bill_entry_lines")
    .select("line_no, description, amount, vat_amount, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", billId)
    .order("line_no", { ascending: true });

  const items: ReceiptCertItem[] = ((lineData ?? []) as {
    line_no: number;
    description: string | null;
    amount: number | string | null;
    vat_amount: number | string | null;
    wht_amount: number | string | null;
  }[]).map((l) => ({
    description: l.description ?? "",
    // จำนวนเงินที่ "จ่ายจริง" ต่อบรรทัด = มูลค่า + VAT − หัก ณ ที่จ่าย
    amount: lineNet({
      amount: num(l.amount),
      vatAmount: num(l.vat_amount),
      whtAmount: num(l.wht_amount),
    }),
  }));

  return { items, docDate: isoToThaiDate(e.doc_date) };
}

export default async function ReceiptCertPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; bill?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ErrorShell message="ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)" />
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const customerId = (sp.customer ?? "").trim();
  if (!UUID_RE.test(customerId)) {
    return <ErrorShell message="ไม่พบลูกค้า — เปิดใบรับรองจากการ์ดลูกค้า หรือแถวบิลอีกครั้ง" />;
  }
  // ★ สโคป: นักบัญชีออกใบรับรองได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
  if (!customerInScope(access, customerId)) {
    return <ErrorShell message="ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" />;
  }

  // หัวกระดาษ = ข้อมูลลูกค้า (ผู้จ่าย/ผู้รับรอง)
  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id, customer_code")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!custRow) {
    return <ErrorShell message="ไม่พบลูกค้า (อาจถูกลบไปแล้ว)" />;
  }
  const cust = custRow as {
    id: string;
    name: string | null;
    business_name: string | null;
    tax_id: string | null;
    customer_code: string | null;
  };

  const businessName = (cust.business_name || cust.name || "").trim();
  const contactName = await loadContactName(service, tenantId, customerId);
  // ข้าพเจ้า/ผู้จ่าย = ผู้ติดต่อลูกค้า ถ้าไม่มี → ชื่อกิจการลูกค้า
  const defaultPayerName = contactName || businessName;

  // prefill จากบิล (ถ้าส่ง ?bill= มา และผ่านสโคป)
  const billId = (sp.bill ?? "").trim();
  let items: ReceiptCertItem[] = [];
  let docDate = "";
  if (UUID_RE.test(billId)) {
    const pre = await loadBillPrefill(service, tenantId, billId, customerId);
    if (pre) {
      items = pre.items;
      docDate = pre.docDate;
    }
  }
  if (items.length === 0) items = [{ description: "", amount: 0 }];
  if (!docDate) docDate = todayThaiDate();

  return (
    <ReceiptCertDoc
      businessName={businessName}
      taxId={cust.tax_id ?? ""}
      payerName={defaultPayerName}
      docDate={docDate}
      items={items}
      backHref="/chat-audit/accounting"
    />
  );
}

/** กรอบข้อความ error/สิทธิ์ (standalone — ไม่ใช้ ChatAuditFrame เพื่อให้พิมพ์สะอาด) */
function ErrorShell({ message }: { message: string }) {
  return (
    <div className="rcv-shell">
      <div className="rcv-error">
        <p>{message}</p>
        <a href="/chat-audit/accounting" className="rcv-btn">
          ← กลับหน้าลงบันทึกบัญชี
        </a>
      </div>
    </div>
  );
}
