import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import {
  computeBillStats,
  filterBills,
  groupBillsByCustomer,
  isValidMonth,
  isDocKind,
  normalizeDocKind,
  UNASSIGNED_CUSTOMER,
  type BillItem,
  type DocKind,
  type CustomerBillGroup,
} from "@/lib/chat-audit/bills";
import { scopeBillsByAccess } from "@/lib/chat-audit/album";
import ChatAuditFrame from "../_Frame";
import BillAlbum, { type AlbumBill } from "./BillAlbum";
import "../chat-admin.css";
import "./bills.css";

export const dynamic = "force-dynamic";

/** bucket รูปบิล (private) — ตรงกับ lib/storage/bill-storage.ts */
const BILLS_BUCKET = "bills";
/** อายุ signed URL ตอน render = 1 ชม. (PDPA — ลิงก์อายุสั้น) */
const SIGNED_URL_TTL_SEC = 3600;
/** เพดานจำนวนบิลที่ sign ให้ลูกค้า "ที่กางออก" 1 ราย (กันเซ็น URL เยอะเกินในครั้งเดียว) */
const ALBUM_SIGN_MAX = 500;
/** เพดานสแกน metadata กันหน้าค้างถ้าบิลเยอะผิดปกติ (ดึงเป็น chunk ละ 1000) */
const SCAN_CHUNK = 1000;
const SCAN_MAX = 12000;

/** ป้ายชนิดเอกสาร: label ไทย + คลาสสี (นิยามใน bills.css) */
const KIND_META: Record<DocKind, { label: string; cls: string }> = {
  slip: { label: "สลิปโอน", cls: "k-slip" },
  sale: { label: "ขาย", cls: "k-sale" },
  handwritten: { label: "เขียนมือ", cls: "k-hand" },
  purchase: { label: "ซื้อ", cls: "k-purchase" },
  cash: { label: "เงินสด", cls: "k-cash" },
  other: { label: "อื่นๆ", cls: "k-other" },
};
/** ลำดับป้ายบนหัวการ์ด */
const KIND_ORDER: DocKind[] = ["slip", "sale", "handwritten", "purchase", "cash", "other"];
/** ตัวเลือก chip กรองประเภท (ตามดีไซน์: ขาย/สลิปโอน/เขียนมือ/ซื้อ) */
const TYPE_FILTER_OPTIONS: DocKind[] = ["sale", "slip", "handwritten", "purchase"];

/** แถวดิบจาก message_attachments + join (โครงตาม nested select) */
type RawBillRow = {
  id: string;
  drive_file_id: string | null;
  created_at: string;
  doc_kind: string | null;
  attachment_type: string | null;
  original_name: string | null;
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
    docKind: normalizeDocKind(row.doc_kind),
    attachmentType: row.attachment_type === "file" ? "file" : "image",
    originalName: row.original_name,
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
        `id, drive_file_id, created_at, doc_kind, attachment_type, original_name,
         chat_messages!inner (
           sent_at,
           chat_groups!inner (
             customer_id,
             customers ( customer_code, name )
           )
         )`
      )
      .eq("tenant_id", tenantId)
      // ★ image-only: อัลบั้มบิลโชว์ "รูปบิล" อย่างเดียว — ไม่รวมไฟล์ (PDF/เอกสาร)
      //   (กติกาเจ้าของ + guard test bills-image-only) — ไฟล์เก่ายังอยู่ใน bucket แต่ไม่แสดง
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

/**
 * สร้าง signed URL ใหม่ตอน render (batch) ให้เฉพาะบิลของลูกค้าที่ "กางออก" เท่านั้น
 *   - bucket private → ต้อง signed เสมอ (ไม่ทำ public)
 *   - createSignedUrls: batch หลาย path ครั้งเดียว, อายุ 1 ชม.
 *   - path ที่เซ็นไม่ได้ (ไฟล์หาย/backend อื่น) → viewUrl=null (การ์ดแสดง placeholder)
 */
async function signAlbumBills(
  service: SupabaseClient,
  items: BillItem[]
): Promise<AlbumBill[]> {
  const paths = items.map((it) => it.objectPath).filter((p): p is string => !!p);

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
    id: it.id,
    viewUrl: it.objectPath ? urlByPath.get(it.objectPath) ?? null : null,
    docKind: it.docKind,
    billDate: it.billDate,
    attachmentType: it.attachmentType,
    originalName: it.originalName,
    objectPath: it.objectPath,
  }));
}

/** วันที่แบบสั้น (ไม่มีเวลา) — ใช้บน csub หัวการ์ด */
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/** ชื่อลูกค้าแสดงผล (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ยังไม่จับคู่ลูกค้า";
}

/** avatar สั้น ๆ จากรหัสลูกค้า (ไม่มีรหัส → "?") */
function avatarText(code: string | null): string {
  if (code) return code.slice(0, 4);
  return "?";
}

/** ประกอบ query string — คงค่าตัวกรอง (q/type/month) เสมอ, เซ็ต open ตามต้องการ */
function buildQuery(params: {
  q?: string;
  type?: string;
  month?: string;
  open?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.type) sp.set("type", params.type);
  if (params.month) sp.set("month", params.month);
  if (params.open) sp.set("open", params.open);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** คีย์ที่ใช้ใน ?open= ของกลุ่มหนึ่ง (unassigned = ค่าพิเศษ) */
function groupOpenKey(g: CustomerBillGroup): string {
  return g.customerId ?? UNASSIGNED_CUSTOMER;
}

/**
 * /chat-audit/bills — "อัลบั้มบิล" (แอดมิน = ทุกลูกค้า · นักบัญชี = เฉพาะลูกค้าตัวเอง)
 *   การ์ดลูกค้าแบบ accordion เรียงตามจำนวนบิลมาก→น้อย · กลุ่มยังไม่จับคู่ท้ายสุด
 *   กางออก → อัลบั้ม (เลือกหลายรูป + ดาวน์โหลดทีละรูป/zip) — ดูรูปจาก bucket `bills` (private)
 *
 * ★ guard: resolveAccountingAccess (แอดมิน/executive = ทุกลูกค้า · lead = ทีม · accountant = เฉพาะตัวเอง)
 *   ไม่มีสิทธิ์ = redirect /login · สโคปบิลด้วย allowedCustomerIds "ฝั่ง server" (ห้ามเชื่อ client)
 * ★ PDPA/performance: sign รูปเฉพาะลูกค้าที่ "กางออก" (≤500 ใบ, อายุ 1 ชม.)
 *   ห้าม log ชื่อไฟล์/ลูกค้า/URL
 */
export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    type?: string;
    month?: string;
    open?: string;
  }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-bills" role={null} authed={false} title="อัลบั้มบิล" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);

  // ไม่มีสิทธิ์ (ยังไม่ login / ไม่ใช่ admin / ไม่ใช่นักบัญชี) → ไปหน้า login
  if (!access) redirect("/login?redirect=/chat-audit/bills");

  const navRole = access.navRole;
  // staff (นักบัญชี/หัวหน้า LINE) → เมนูจำกัดเฉพาะบัญชีของตัวเอง
  const staffOnly = access.mode === "accountant" || access.mode === "lead";
  // ลบบิลได้เฉพาะ admin (server action guard admin อยู่แล้ว — ซ่อนปุ่มให้นักบัญชี)
  const canDelete = access.mode === "admin";

  let all: BillItem[];
  try {
    all = await fetchAllBillItems(service, access.tenantId);
  } catch {
    return (
      <ChatAuditFrame active="chat-bills" role={navRole} authed staffOnly={staffOnly} title="อัลบั้มบิล" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
      </ChatAuditFrame>
    );
  }

  // ★ สโคปนักบัญชี "ฝั่ง server" — นักบัญชี/หัวหน้าเห็นเฉพาะบิลของลูกค้าที่ตัวเองดูแล
  //   admin/executive (allowedCustomerIds=null) เห็นทุกบิลตามเดิม
  const scoped = scopeBillsByAccess(all, access.allowedCustomerIds);

  const stats = computeBillStats(scoped);

  // ---- ตัวกรองจาก query param (validate ก่อนใช้) ----
  const q = (sp.q ?? "").trim();
  const selectedType: DocKind | null = isDocKind(sp.type) ? sp.type : null;
  const selectedMonth = isValidMonth(sp.month) && stats.monthOptions.includes(sp.month) ? sp.month : "";

  // กรองก่อนจัดกลุ่ม (ประเภท/เดือน/ค้นหา)
  const filtered = filterBills(scoped, {
    docKind: selectedType,
    month: selectedMonth || null,
    search: q || null,
  });
  const groups = groupBillsByCustomer(filtered);

  // ลูกค้าที่ "กางออก" — ต้องเป็นคีย์ที่มีอยู่จริงในกลุ่มหลังกรอง
  const openKey = sp.open && groups.some((g) => groupOpenKey(g) === sp.open) ? sp.open : "";

  // sign รูปเฉพาะลูกค้าที่กางออก (≤500 ใบ) — การ์ดอื่นไม่ sign
  let openBills: AlbumBill[] = [];
  let openTruncated = false;
  if (openKey) {
    const billsOfOpen = filterBills(filtered, { customerId: openKey }); // เรียงใหม่→เก่าแล้ว
    openTruncated = billsOfOpen.length > ALBUM_SIGN_MAX;
    openBills = await signAlbumBills(service, billsOfOpen.slice(0, ALBUM_SIGN_MAX));
  }

  const hasAnyFilter = !!(q || selectedType || selectedMonth);
  const scopeLabel =
    access.mode === "accountant"
      ? "ลูกค้าที่คุณดูแล"
      : access.mode === "lead"
      ? "ลูกค้าของทีมคุณ"
      : "ทุกลูกค้าในสำนักงาน";

  return (
    <ChatAuditFrame
      active="chat-bills"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="อัลบั้มบิล"
      subtitle="รูปบิลที่ดึงจากกลุ่ม LINE — เลือกแล้วดาวน์โหลดไปใช้ต่อ (ทีละรูป / เลือกหลายรูป / ทั้งลูกค้าเป็น zip)"
    >
      <div className="dash-views">
        {/* ---- แถบบอกสโคป (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง) ---- */}
        <div className="card acc-scopebar">
          <span className="acc-scope-label">
            {access.name ? `${access.name} · ` : ""}{scopeLabel}
          </span>
        </div>

        {/* ---- KPI ---- */}
        <div className="kpi-grid">
          <div className="kpi">
            <div className="label">บิลทั้งหมด</div>
            <div className="value">{stats.total.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
          <div className="kpi">
            <div className="label">ลูกค้าที่มีบิล</div>
            <div className="value">{stats.customerCount.toLocaleString("th-TH")}<span className="unit">ราย</span></div>
          </div>
          <div className="kpi">
            <div className="label">ยังไม่จับคู่</div>
            <div className={`value${stats.unassignedCount > 0 ? " v-amber" : ""}`}>
              {stats.unassignedCount.toLocaleString("th-TH")}<span className="unit">ใบ</span>
            </div>
          </div>
          <div className="kpi">
            <div className="label">เดือนนี้</div>
            <div className="value">{stats.thisMonth.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
        </div>

        {/* ---- ตัวกรอง: chip ประเภท + ค้นหา + เดือน ---- */}
        <div className="card">
          {/* chip กรองประเภท (ลิงก์ — คง q/month, สลับ type, ยุบการ์ดที่เปิด) */}
          <div className="album-chips">
            <Link
              href={`/chat-audit/bills${buildQuery({ q, month: selectedMonth || undefined })}`}
              className={`album-chip${selectedType === null ? " on" : ""}`}
            >
              ทุกประเภท
            </Link>
            {TYPE_FILTER_OPTIONS.map((k) => (
              <Link
                key={k}
                href={`/chat-audit/bills${buildQuery({ q, month: selectedMonth || undefined, type: k })}`}
                className={`album-chip${selectedType === k ? " on" : ""}`}
              >
                {KIND_META[k].label}
              </Link>
            ))}
          </div>

          {/* ค้นหา + เดือน (GET form — submit แล้ว open รีเซ็ตอัตโนมัติ) */}
          <form method="get" className="inline-form bills-filter">
            {selectedType ? <input type="hidden" name="type" value={selectedType} /> : null}
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="ค้นหาลูกค้า / รหัส…"
              className="bills-search"
              aria-label="ค้นหาลูกค้าหรือรหัส"
            />
            <label htmlFor="f-month" style={{ fontWeight: 600, fontSize: 14 }}>เดือน:</label>
            <select id="f-month" name="month" defaultValue={selectedMonth}>
              <option value="">— ทุกเดือน —</option>
              {stats.monthOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button type="submit" className="btn">กรอง</button>
            {hasAnyFilter ? (
              <Link href="/chat-audit/bills" className="btn btn-ghost">ล้างตัวกรอง</Link>
            ) : null}
          </form>
        </div>

        {/* ---- รายการการ์ดลูกค้า (accordion) ---- */}
        <div className="card">
          <div className="section-title">
            <span>ลูกค้า</span>
            <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
              {groups.length.toLocaleString("th-TH")} ราย · {filtered.length.toLocaleString("th-TH")} ใบ
            </span>
          </div>

          {groups.length === 0 ? (
            <p className="empty">ยังไม่มีบิลตามเงื่อนไขที่เลือก</p>
          ) : (
            <div className="cust-list">
              {groups.map((g) => {
                const key = groupOpenKey(g);
                const isOpen = openKey === key;
                const isUnassigned = g.customerId === null;
                const toggleHref = `/chat-audit/bills${buildQuery({
                  q,
                  type: selectedType ?? undefined,
                  month: selectedMonth || undefined,
                  open: isOpen ? undefined : key,
                })}`;

                return (
                  <div key={key} className={`cust-card${isUnassigned ? " cust-unassigned" : ""}${isOpen ? " open" : ""}`}>
                    {/* ---- หัวการ์ด (ลิงก์ toggle) ---- */}
                    <Link href={toggleHref} className="cust-head" aria-expanded={isOpen} scroll={false}>
                      <span className={`cust-avatar${isUnassigned ? " un" : ""}`}>{avatarText(g.code)}</span>
                      <span className="cust-id">
                        <span className="cust-name">{customerLabel(g.code, g.name)}</span>
                        <span className="csub">
                          บิลล่าสุด {g.latestAt ? formatDateShort(g.latestAt) : "-"}
                        </span>
                      </span>

                      {/* ป้ายแยกประเภท (ซ่อนบนจอแคบผ่าน CSS) */}
                      <span className="cust-kinds">
                        {KIND_ORDER.filter((k) => g.kinds[k] > 0).map((k) => (
                          <span key={k} className={`kind-badge ${KIND_META[k].cls}`}>
                            {KIND_META[k].label} {g.kinds[k]}
                          </span>
                        ))}
                        {g.fileCount > 0 ? (
                          <span className="kind-badge k-file">ไฟล์ {g.fileCount}</span>
                        ) : null}
                      </span>

                      <span className="cust-total">{g.total.toLocaleString("th-TH")} ใบ</span>
                      <span className={`cust-chev${isOpen ? " up" : ""}`} aria-hidden="true">▾</span>
                    </Link>

                    {/* ---- เนื้อหากางออก: อัลบั้ม (client) ---- */}
                    {isOpen ? (
                      <BillAlbum
                        bills={openBills}
                        customerCode={g.code}
                        canDelete={canDelete}
                        truncated={openTruncated}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
