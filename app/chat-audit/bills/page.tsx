import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  computeBillStats,
  filterBills,
  paginate,
  isValidMonth,
  UNASSIGNED_CUSTOMER,
  type BillItem,
} from "@/lib/chat-audit/bills";
import ChatAuditFrame from "../_Frame";
import DeleteBillButton from "./DeleteBillButton";
import "../chat-admin.css";
import "./bills.css";

export const dynamic = "force-dynamic";

/** bucket รูปบิล (private) — ตรงกับ lib/storage/bill-storage.ts */
const BILLS_BUCKET = "bills";
/** อายุ signed URL ตอน render = 1 ชม. (PDPA — ลิงก์อายุสั้น) */
const SIGNED_URL_TTL_SEC = 3600;
/** จำนวนบิลต่อหน้า (สร้าง signed URL เฉพาะหน้านี้ กันโหลดหนัก) */
const PAGE_SIZE = 48;
/** เพดานสแกน metadata กันหน้าค้างถ้าบิลเยอะผิดปกติ (ดึงเป็น chunk ละ 1000) */
const SCAN_CHUNK = 1000;
const SCAN_MAX = 12000;

/** แถวดิบจาก message_attachments + join (โครงตาม nested select) */
type RawBillRow = {
  id: string;
  drive_file_id: string | null;
  created_at: string;
  chat_messages: {
    sent_at: string | null;
    chat_groups: {
      customer_id: string | null;
      customers: { customer_code: string | null; name: string | null } | null;
    } | null;
  } | null;
};

/** normalize แถวดิบ (join อาจคืน object หรือ array ตาม PostgREST) → BillItem */
function toBillItem(row: RawBillRow): BillItem {
  const msg = pickOne(row.chat_messages);
  const group = pickOne(msg?.chat_groups);
  const customer = pickOne(group?.customers);
  return {
    id: row.id,
    objectPath: row.drive_file_id,
    billDate: msg?.sent_at ?? row.created_at,
    customerId: group?.customer_id ?? null,
    customerCode: customer?.customer_code ?? null,
    customerName: customer?.name ?? null,
  };
}

/** PostgREST embed แบบ to-one อาจคืน object หรือ array 1 ตัว — ปรับให้เป็น object เดียว */
function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return v ?? null;
}

/**
 * ดึง metadata บิลทั้งหมดของ tenant (ไม่มี binary/ไม่ sign — เบา)
 *   ดึงเป็น chunk ละ 1000 (เพดาน max_rows ของ PostgREST) จนหมด/ชนเพดาน
 *   ★ อ่านอย่างเดียว ไม่แตะ pipeline เก็บบิล
 */
async function fetchAllBillItems(
  service: SupabaseClient,
  tenantId: string
): Promise<BillItem[]> {
  const items: BillItem[] = [];
  for (let from = 0; from < SCAN_MAX; from += SCAN_CHUNK) {
    const { data, error } = await service
      .from("message_attachments")
      .select(
        `id, drive_file_id, created_at,
         chat_messages!inner (
           sent_at,
           chat_groups!inner (
             customer_id,
             customers ( customer_code, name )
           )
         )`
      )
      .eq("tenant_id", tenantId)
      .eq("attachment_type", "image")
      .eq("fetch_status", "stored")
      .order("created_at", { ascending: false })
      .range(from, from + SCAN_CHUNK - 1);

    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as RawBillRow[];
    for (const r of rows) items.push(toBillItem(r));
    if (rows.length < SCAN_CHUNK) break; // หมดแล้ว
  }
  return items;
}

/** บิล + signed URL พร้อมแสดง */
type SignedBill = BillItem & {
  /** signed URL สำหรับดูรูป (null = เซ็นไม่ได้/ไม่มี ref → แสดง placeholder) */
  viewUrl: string | null;
};

/**
 * สร้าง signed URL ใหม่ตอน render (batch) ให้เฉพาะบิลในหน้านี้
 *   - bucket private → ต้อง signed เสมอ (ไม่ทำ public)
 *   - createSignedUrls: batch หลาย path ครั้งเดียว, อายุ 1 ชม.
 *   - path ที่เซ็นไม่ได้ (ไฟล์หาย/backend อื่น) → viewUrl=null (การ์ดแสดง placeholder)
 */
async function signBills(
  service: SupabaseClient,
  items: BillItem[]
): Promise<SignedBill[]> {
  const paths = items
    .map((it) => it.objectPath)
    .filter((p): p is string => !!p);

  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data } = await service.storage
      .from(BILLS_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
    for (const entry of data ?? []) {
      if (entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl);
    }
  }

  return items.map((it) => ({
    ...it,
    viewUrl: it.objectPath ? urlByPath.get(it.objectPath) ?? null : null,
  }));
}

/** วันที่แบบไทยอ่านง่าย (ไม่โชว์วินาที) — fallback เป็นค่าเดิมถ้า parse ไม่ได้ */
function formatBillDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** ชื่อลูกค้าแสดงผล (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ยังไม่จับคู่ลูกค้า";
}

/** ประกอบ query string ของตัวกรอง (คงค่า customer/month, เซ็ต page) */
function buildQuery(params: { customer?: string; month?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.customer) sp.set("customer", params.customer);
  if (params.month) sp.set("month", params.month);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * /chat-audit/bills — หน้ารวมรูปบิลลูกค้า (admin/executive เท่านั้น)
 *   ดู/ดาวน์โหลดบิลที่เก็บใน Supabase Storage bucket `bills` (private)
 *   แทนการเปิดไดรฟ์ · ตัวกรองลูกค้า/เดือน + แบ่งหน้า 48/หน้า
 *
 * ★ guard admin + tenant จาก session (reuse resolveAdminContext) — ไม่เชื่อ client
 * ★ PDPA: signed URL อายุ 1 ชม. สร้างตอน render เฉพาะหน้าปัจจุบัน · ไม่ทำ bucket public
 *   ห้าม log ชื่อไฟล์/ลูกค้า/URL
 */
export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; month?: string; page?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-bills" role={null} authed={false} title="บิลลูกค้า" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/bills");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-bills" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="บิลลูกค้า" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className="muted" style={{ fontSize: 13 }}>บิลเป็นข้อมูลการเงินอ่อนไหว เปิดเฉพาะผู้ดูแลระบบ (admin) และผู้บริหาร (executive)</p>
          <p style={{ marginTop: 12 }}><Link href="/chat-audit" className="underline">← กลับ</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  let all: BillItem[];
  try {
    const service = createServiceRoleClient();
    all = await fetchAllBillItems(service, ctx.tenantId);
  } catch {
    return (
      <ChatAuditFrame active="chat-bills" role={ctx.role} authed title="บิลลูกค้า" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
      </ChatAuditFrame>
    );
  }

  const stats = computeBillStats(all);

  // ตัวกรองจาก query param (validate ก่อนใช้)
  const selectedCustomer =
    sp.customer && (sp.customer === UNASSIGNED_CUSTOMER || stats.customerOptions.some((c) => c.id === sp.customer))
      ? sp.customer
      : "";
  const selectedMonth = isValidMonth(sp.month) && stats.monthOptions.includes(sp.month) ? sp.month : "";
  const requestedPage = Number.parseInt(sp.page ?? "1", 10);

  const filtered = filterBills(all, { customerId: selectedCustomer || null, month: selectedMonth || null });
  const paged = paginate(filtered, Number.isNaN(requestedPage) ? 1 : requestedPage, PAGE_SIZE);

  // สร้าง signed URL เฉพาะบิลในหน้านี้ (≤48 ใบ) — ไม่ sign ทั้งหมด
  const service = createServiceRoleClient();
  const bills = await signBills(service, paged.items);

  const hasUnassigned = all.some((it) => !it.customerId);

  return (
    <ChatAuditFrame
      active="chat-bills"
      role={ctx.role}
      authed
      title="บิลลูกค้า"
      subtitle="ดู/ดาวน์โหลดรูปบิลที่เก็บจากกลุ่ม LINE (แทนการเปิดไดรฟ์)"
    >
      <div className="dash-views">
        {/* ---- KPI ---- */}
        <div className="kpi-grid cols-3">
          <div className="kpi">
            <div className="label">บิลที่เก็บแล้วทั้งหมด</div>
            <div className="value">{stats.total.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
          <div className="kpi">
            <div className="label">ลูกค้าที่มีบิล</div>
            <div className="value">{stats.customerCount.toLocaleString("th-TH")}<span className="unit">ราย</span></div>
          </div>
          <div className="kpi">
            <div className="label">บิลเดือนนี้</div>
            <div className="value">{stats.thisMonth.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
        </div>

        {/* ---- ตัวกรอง (GET form — submit แล้ว page รีเซ็ตเป็น 1 อัตโนมัติ) ---- */}
        <div className="card">
          <form method="get" className="inline-form bills-filter">
            <label htmlFor="f-customer" style={{ fontWeight: 600, fontSize: 14 }}>ลูกค้า:</label>
            <select id="f-customer" name="customer" defaultValue={selectedCustomer}>
              <option value="">— ทุกลูกค้า —</option>
              {hasUnassigned ? <option value={UNASSIGNED_CUSTOMER}>— ยังไม่จับคู่ลูกค้า —</option> : null}
              {stats.customerOptions.map((c) => (
                <option key={c.id} value={c.id}>{customerLabel(c.code, c.name)} ({c.count})</option>
              ))}
            </select>

            <label htmlFor="f-month" style={{ fontWeight: 600, fontSize: 14 }}>เดือน:</label>
            <select id="f-month" name="month" defaultValue={selectedMonth}>
              <option value="">— ทุกเดือน —</option>
              {stats.monthOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <button type="submit" className="btn">กรอง</button>
            {selectedCustomer || selectedMonth ? (
              <Link href="/chat-audit/bills" className="btn btn-ghost">ล้างตัวกรอง</Link>
            ) : null}
          </form>
        </div>

        {/* ---- Grid การ์ดบิล ---- */}
        <div className="card">
          <div className="section-title">
            <span>รายการบิล</span>
            <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
              {paged.totalItems.toLocaleString("th-TH")} ใบ
              {paged.totalPages > 1 ? ` · หน้า ${paged.page}/${paged.totalPages}` : ""}
            </span>
          </div>

          {bills.length === 0 ? (
            <p className="empty">ยังไม่มีบิลตามเงื่อนไขที่เลือก</p>
          ) : (
            <div className="bills-grid">
              {bills.map((b) => (
                <div key={b.id} className="bill-card">
                  {/* ปุ่มลบมุมการ์ด (admin) — ยืนยันก่อนลบเสมอ, ลบไฟล์จริง + mark DB */}
                  <DeleteBillButton attachmentId={b.id} />
                  {b.viewUrl ? (
                    <a href={b.viewUrl} target="_blank" rel="noopener noreferrer" className="bill-thumb" aria-label="เปิดรูปบิล">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={b.viewUrl} alt="รูปบิล" loading="lazy" />
                    </a>
                  ) : (
                    <div className="bill-thumb bill-thumb-empty" aria-hidden="true">เปิดไม่ได้</div>
                  )}
                  <div className="bill-meta">
                    <div className="bill-customer" title={customerLabel(b.customerCode, b.customerName)}>
                      {customerLabel(b.customerCode, b.customerName)}
                    </div>
                    <div className="bill-date">{formatBillDate(b.billDate)}</div>
                    {b.viewUrl ? (
                      <a
                        href={`${b.viewUrl}&download`}
                        className="btn bill-open"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        เปิด / ดาวน์โหลด
                      </a>
                    ) : (
                      <span className="btn bill-open bill-open-disabled" aria-disabled="true">ไฟล์ไม่พร้อม</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- แบ่งหน้า ---- */}
          {paged.totalPages > 1 ? (
            <div className="bills-pager">
              {paged.page > 1 ? (
                <Link
                  href={`/chat-audit/bills${buildQuery({ customer: selectedCustomer, month: selectedMonth, page: paged.page - 1 })}`}
                  className="btn btn-ghost"
                >
                  ← ก่อนหน้า
                </Link>
              ) : (
                <span className="btn btn-ghost bill-open-disabled" aria-disabled="true">← ก่อนหน้า</span>
              )}
              <span className="muted" style={{ fontSize: 13 }}>หน้า {paged.page} / {paged.totalPages}</span>
              {paged.page < paged.totalPages ? (
                <Link
                  href={`/chat-audit/bills${buildQuery({ customer: selectedCustomer, month: selectedMonth, page: paged.page + 1 })}`}
                  className="btn btn-ghost"
                >
                  ถัดไป →
                </Link>
              ) : (
                <span className="btn btn-ghost bill-open-disabled" aria-disabled="true">ถัดไป →</span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
