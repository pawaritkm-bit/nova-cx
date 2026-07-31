import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  computeBillStats,
  filterBills,
  groupBillsByCustomer,
  paginate,
  isValidMonth,
  isDocKind,
  normalizeDocKind,
  UNASSIGNED_CUSTOMER,
  type BillItem,
  type DocKind,
  type CustomerBillGroup,
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
/** จำนวนบิลต่อหน้าในการ์ดที่กางออก (สร้าง signed URL เฉพาะหน้านี้ กันโหลดหนัก) */
const PAGE_SIZE = 48;
/** เพดานสแกน metadata กันหน้าค้างถ้าบิลเยอะผิดปกติ (ดึงเป็น chunk ละ 1000) */
const SCAN_CHUNK = 1000;
const SCAN_MAX = 12000;

/** ป้ายชนิดเอกสาร: label ไทย + คลาสสี (นิยามใน bills.css) — ลำดับตาม DOC_KINDS */
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
/** ตัวเลือกในตัวกรองประเภท (ตามดีไซน์: ขาย/สลิปโอน/เขียนมือ/ซื้อ) */
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
      .in("attachment_type", ["image", "file"])
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
 * สร้าง signed URL ใหม่ตอน render (batch) ให้เฉพาะบิลของลูกค้าที่ "กางออก" เท่านั้น
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

/** วันที่แบบสั้น (ไม่มีเวลา) — ใช้บน csub หัวการ์ด */
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/** ไอคอนไฟล์ตามนามสกุล (เดาจาก original_name ก่อน แล้ว objectPath) — PDF = 📄, อื่น = 📎 */
function fileIcon(name: string | null, objectPath: string | null): string {
  const src = (name || objectPath || "").toLowerCase();
  if (src.endsWith(".pdf")) return "📄";
  return "📎";
}

/** ชื่อไฟล์ที่โชว์: original_name (ถ้ามี) หรือ "เอกสาร {วันที่}" เมื่อไม่มีชื่อ */
function fileDisplayName(name: string | null, billDate: string): string {
  const n = (name ?? "").trim();
  return n || `เอกสาร ${formatDateShort(billDate)}`;
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

/**
 * ประกอบ query string — คงค่าตัวกรอง (q/type/month) เสมอ, เซ็ต open/p ตามต้องการ
 */
function buildQuery(params: {
  q?: string;
  type?: string;
  month?: string;
  open?: string;
  p?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.type) sp.set("type", params.type);
  if (params.month) sp.set("month", params.month);
  if (params.open) sp.set("open", params.open);
  if (params.p && params.p > 1) sp.set("p", String(params.p));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** คีย์ที่ใช้ใน ?open= ของกลุ่มหนึ่ง (unassigned = ค่าพิเศษ) */
function groupOpenKey(g: CustomerBillGroup): string {
  return g.customerId ?? UNASSIGNED_CUSTOMER;
}

/**
 * /chat-audit/bills — "บิลแยกตามลูกค้า" (admin/executive เท่านั้น)
 *   การ์ดลูกค้าแบบ accordion เรียงตามจำนวนบิลมาก→น้อย · กลุ่มยังไม่จับคู่ท้ายสุด
 *   ดู/ดาวน์โหลดบิลที่เก็บใน Supabase Storage bucket `bills` (private)
 *
 * ★ guard admin + tenant จาก session (reuse resolveAdminContext) — ไม่เชื่อ client
 * ★ PDPA/performance: sign รูปเฉพาะลูกค้าที่ "กางออก" (?open=) เท่านั้น (≤48 ใบ/หน้า, อายุ 1 ชม.)
 *   การ์ดที่ปิด = แสดงแค่ metadata (หัว/จำนวน/ป้าย) ไม่ sign · ห้าม log ชื่อไฟล์/ลูกค้า/URL
 */
export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    type?: string;
    month?: string;
    open?: string;
    p?: string;
  }>;
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

  // ---- ตัวกรองจาก query param (validate ก่อนใช้) ----
  const q = (sp.q ?? "").trim();
  const selectedType: DocKind | null = isDocKind(sp.type) ? sp.type : null;
  const selectedMonth = isValidMonth(sp.month) && stats.monthOptions.includes(sp.month) ? sp.month : "";

  // กรองก่อนจัดกลุ่ม (ประเภท/เดือน/ค้นหา)
  const filtered = filterBills(all, {
    docKind: selectedType,
    month: selectedMonth || null,
    search: q || null,
  });
  const groups = groupBillsByCustomer(filtered);

  // ลูกค้าที่ "กางออก" — ต้องเป็นคีย์ที่มีอยู่จริงในกลุ่มหลังกรอง
  const openKey =
    sp.open && groups.some((g) => groupOpenKey(g) === sp.open) ? sp.open : "";

  // sign รูปเฉพาะลูกค้าที่กางออก (≤48 ใบ/หน้า) — การ์ดอื่นไม่ sign
  let openBills: SignedBill[] = [];
  let openPaged: ReturnType<typeof paginate<BillItem>> | null = null;
  const requestedPage = Number.parseInt(sp.p ?? "1", 10);
  if (openKey) {
    const billsOfOpen = filterBills(filtered, { customerId: openKey }); // เรียงใหม่→เก่าแล้ว
    openPaged = paginate(billsOfOpen, Number.isNaN(requestedPage) ? 1 : requestedPage, PAGE_SIZE);
    const service = createServiceRoleClient();
    openBills = await signBills(service, openPaged.items);
  }

  const hasAnyFilter = !!(q || selectedType || selectedMonth);

  return (
    <ChatAuditFrame
      active="chat-bills"
      role={ctx.role}
      authed
      title="บิลลูกค้า"
      subtitle="บิลแยกตามลูกค้า เรียงตามจำนวนมากสุด (เก็บจากกลุ่ม LINE แทนการเปิดไดรฟ์)"
    >
      <div className="dash-views">
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

        {/* ---- ตัวกรอง (GET form — submit แล้ว open/p รีเซ็ตอัตโนมัติ เพราะไม่อยู่ในฟอร์ม) ---- */}
        <div className="card">
          <form method="get" className="inline-form bills-filter">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="ค้นหาลูกค้า / รหัส…"
              className="bills-search"
              aria-label="ค้นหาลูกค้าหรือรหัส"
            />

            <label htmlFor="f-type" style={{ fontWeight: 600, fontSize: 14 }}>ประเภท:</label>
            <select id="f-type" name="type" defaultValue={selectedType ?? ""}>
              <option value="">— ทุกประเภท —</option>
              {TYPE_FILTER_OPTIONS.map((k) => (
                <option key={k} value={k}>{KIND_META[k].label}</option>
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

                    {/* ---- เนื้อหากางออก: grid รูป (signed) ---- */}
                    {isOpen && openPaged ? (
                      <div className="cust-body">
                        {openBills.length === 0 ? (
                          <p className="empty">ไม่มีบิลในหน้านี้</p>
                        ) : (
                          <div className="bills-grid">
                            {openBills.map((b) =>
                              b.attachmentType === "file" ? (
                                /* ---- การ์ดไฟล์ (PDF/เอกสาร) — ไอคอน + ชื่อไฟล์ + เปิด/ดาวน์โหลด ---- */
                                <div key={b.id} className="bill-card bill-card-file">
                                  <span className="bill-kind k-file">ไฟล์</span>
                                  {/* ปุ่มลบมุมการ์ด (admin) — reuse ตัวเดียวกับบิล */}
                                  <DeleteBillButton attachmentId={b.id} />
                                  <div className="file-body">
                                    <span className="file-icon" aria-hidden="true">
                                      {fileIcon(b.originalName, b.objectPath)}
                                    </span>
                                    <span
                                      className="file-name"
                                      title={fileDisplayName(b.originalName, b.billDate)}
                                    >
                                      {fileDisplayName(b.originalName, b.billDate)}
                                    </span>
                                  </div>
                                  <div className="bill-meta">
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
                              ) : (
                                /* ---- การ์ดรูปบิล (image) — thumbnail เดิม ---- */
                                <div key={b.id} className="bill-card">
                                  {b.docKind ? (
                                    <span className={`bill-kind ${KIND_META[b.docKind].cls}`}>
                                      {KIND_META[b.docKind].label}
                                    </span>
                                  ) : null}
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
                              )
                            )}
                          </div>
                        )}

                        {/* แถบสรุป + แบ่งหน้าในลูกค้า (ถ้า > 48 ใบ) */}
                        <div className="cust-foot">
                          <span className="muted" style={{ fontSize: 13 }}>
                            ดูทั้งหมด {openPaged.totalItems.toLocaleString("th-TH")} ใบ
                            {openPaged.totalPages > 1 ? ` · หน้า ${openPaged.page}/${openPaged.totalPages}` : ""}
                          </span>
                          {openPaged.totalPages > 1 ? (
                            <span className="cust-pager">
                              {openPaged.page > 1 ? (
                                <Link
                                  href={`/chat-audit/bills${buildQuery({ q, type: selectedType ?? undefined, month: selectedMonth || undefined, open: key, p: openPaged.page - 1 })}`}
                                  className="btn btn-ghost"
                                  scroll={false}
                                >
                                  ← ก่อนหน้า
                                </Link>
                              ) : null}
                              {openPaged.page < openPaged.totalPages ? (
                                <Link
                                  href={`/chat-audit/bills${buildQuery({ q, type: selectedType ?? undefined, month: selectedMonth || undefined, open: key, p: openPaged.page + 1 })}`}
                                  className="btn btn-ghost"
                                  scroll={false}
                                >
                                  ถัดไป →
                                </Link>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      </div>
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
