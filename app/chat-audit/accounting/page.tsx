import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  listEntries,
  lineNet,
  summarizeEntry,
  type BillEntry,
  type EntryType,
  type EntrySummary,
} from "@/lib/accounting/queries";
import {
  groupEntriesByCustomer,
  summarizeAll,
  entriesOfType,
  countOfType,
  UNASSIGNED_CUSTOMER,
  type CustomerEntryGroup,
} from "@/lib/accounting/group";
import { formatMoney } from "@/lib/accounting/calc";
import { createEntryAction } from "./actions";
import ChatAuditFrame from "../_Frame";
import EntryEditor from "./EntryEditor";
import RowActions from "./RowActions";
import "../chat-admin.css";
import "../bills/bills.css";
import "./accounting.css";

export const dynamic = "force-dynamic";

/** bucket รูปบิล (private) — ตรงกับหน้า bills / lib/storage/bill-storage.ts */
const BILLS_BUCKET = "bills";
/** อายุ signed URL = 1 ชม. (PDPA — ลิงก์อายุสั้น) */
const SIGNED_URL_TTL_SEC = 3600;

/** 3 แท็บย่อยในลูกค้า — ตามดีไซน์ (ภาษีซื้อ/ภาษีขาย/รอระบุ) */
const TYPE_TABS: { type: EntryType; label: string }[] = [
  { type: "purchase", label: "ภาษีซื้อ" },
  { type: "sale", label: "ภาษีขาย" },
  { type: "unspecified", label: "รอระบุประเภท" },
];

/** ป้าย ภ.ง.ด. */
function whtFormLabel(form: string | null): string {
  if (form === "pnd3") return "ภ.ง.ด.3";
  if (form === "pnd53") return "ภ.ง.ด.53";
  return "";
}

/** วันที่แบบไทยสั้น (YYYY-MM-DD → 1 ก.ค. 2569) — fallback ค่าเดิม */
function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ยังไม่จับคู่ลูกค้า";
}

/** avatar สั้นจากรหัสลูกค้า (ไม่มี → "?") */
function avatarText(code: string | null): string {
  return code ? code.slice(0, 4) : "?";
}

/** YYYY-MM ของ entry (จาก docDate) */
function monthKeyOf(e: BillEntry): string | null {
  return e.docDate && /^\d{4}-\d{2}/.test(e.docDate) ? e.docDate.slice(0, 7) : null;
}

function isValidMonth(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** ประกอบ query string คงบริบท (q/month/open/type/edit) */
function buildQuery(params: {
  q?: string;
  month?: string;
  open?: string;
  type?: EntryType;
  edit?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.month) sp.set("month", params.month);
  if (params.open) sp.set("open", params.open);
  if (params.type) sp.set("type", params.type);
  if (params.edit) sp.set("edit", params.edit);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** คีย์ ?open= ของกลุ่ม (unassigned = ค่าพิเศษ) */
function groupOpenKey(g: CustomerEntryGroup): string {
  return g.customerId ?? UNASSIGNED_CUSTOMER;
}

/** ดึงรหัสลูกค้า (customer_code) ของ customerIds ที่มี entry — สำหรับ avatar/ชื่อ/ไฟล์ Excel */
async function fetchCustomerCodes(
  service: SupabaseClient,
  tenantId: string,
  ids: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const { data } = await service
    .from("customers")
    .select("id, customer_code")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  for (const c of (data ?? []) as { id: string; customer_code: string | null }[]) {
    map.set(c.id, c.customer_code);
  }
  return map;
}

/** สร้าง signed URL (batch) ให้ object path ที่ต้องโชว์เท่านั้น (PDPA/perf) */
async function signPaths(
  service: SupabaseClient,
  paths: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(paths.filter((p): p is string => !!p))];
  if (uniq.length === 0) return out;
  const { data } = await service.storage.from(BILLS_BUCKET).createSignedUrls(uniq, SIGNED_URL_TTL_SEC);
  for (const e of data ?? []) {
    if (e.signedUrl && e.path) out.set(e.path, e.signedUrl);
  }
  return out;
}

/** KPI 4 ช่องจากสรุป (มูลค่า/VAT/หัก/จ่ายจริง) */
function KpiRow({ s }: { s: EntrySummary }) {
  return (
    <div className="kpi-grid">
      <div className="kpi">
        <div className="label">รวมมูลค่า</div>
        <div className="value">{formatMoney(s.amount)}<span className="unit">บาท</span></div>
      </div>
      <div className="kpi">
        <div className="label">รวม VAT</div>
        <div className="value">{formatMoney(s.vat)}<span className="unit">บาท</span></div>
      </div>
      <div className="kpi">
        <div className="label">รวมหัก ณ ที่จ่าย</div>
        <div className="value">{formatMoney(s.wht)}<span className="unit">บาท</span></div>
      </div>
      <div className="kpi">
        <div className="label">รวมจ่ายจริง</div>
        <div className="value v-green">{formatMoney(s.net)}<span className="unit">บาท</span></div>
      </div>
    </div>
  );
}

/** ตารางบิลของประเภทที่เลือกในลูกค้าหนึ่ง (docrow + sub-lines ถ้าบิลผสม) */
function EntryTable({
  entries,
  signed,
  editHrefOf,
}: {
  entries: BillEntry[];
  signed: Map<string, string>;
  editHrefOf: (entryId: string) => string;
}) {
  if (entries.length === 0) {
    return <p className="empty">ยังไม่มีรายการในประเภทนี้</p>;
  }

  // ยอดรวมท้ายตาราง
  let tAmount = 0;
  let tVat = 0;
  let tWht = 0;
  let tNet = 0;

  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>บิล</th>
            <th>วันที่</th>
            <th>เลขที่</th>
            <th>คู่ค้า / เลขภาษี</th>
            <th>รายการ</th>
            <th className="num">มูลค่า</th>
            <th className="num">VAT</th>
            <th className="num">หัก ณ ที่จ่าย</th>
            <th className="num">รวมจ่ายจริง</th>
            <th className="center">สถานะ</th>
            <th className="center">จัดการ</th>
          </tr>
        </thead>
        {/* หมายเหตุ: 1 entry = 1 <tbody> (docrow + sub-lines) — table มีหลาย tbody ได้ */}
        {entries.map((e) => {
            const s = summarizeEntry(e.lines);
            tAmount += s.amount;
            tVat += s.vat;
            tWht += s.wht;
            tNet += s.net;
            const multi = e.lines.length > 1;
            const viewUrl = e.attachmentObjectPath ? signed.get(e.attachmentObjectPath) ?? null : null;
            const editHref = editHrefOf(e.id);
            const single = e.lines[0] ?? null;

            return (
              <tbody key={e.id} className="acc-entry">
                {/* ---- docrow (หัวเอกสาร) ---- */}
                <tr className={`acc-docrow${e.status === "confirmed" ? " is-confirmed" : ""}`}>
                  <td>
                    {viewUrl ? (
                      <Link href={editHref} className="acc-thumb" aria-label="เปิดตรวจ/แก้บิล" scroll={false}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={viewUrl} alt="บิล" loading="lazy" />
                      </Link>
                    ) : (
                      <Link href={editHref} className="acc-thumb acc-thumb-empty" aria-label="ตรวจ/แก้" scroll={false}>
                        ไม่มีรูป
                      </Link>
                    )}
                  </td>
                  <td>{formatDate(e.docDate)}</td>
                  <td>
                    <Link href={editHref} className="acc-docno" scroll={false}>
                      {e.docNo || "—"}
                    </Link>
                  </td>
                  <td>
                    <div className="acc-party">{e.counterpartyName || "—"}</div>
                    {e.counterpartyTaxId ? <div className="acc-taxid">{e.counterpartyTaxId}</div> : null}
                    {e.entryType === "unspecified" && (e.sellerName || e.buyerName) ? (
                      <div className="acc-hint">
                        {e.sellerName ? `ผู้ขาย: ${e.sellerName}` : ""}
                        {e.sellerName && e.buyerName ? " · " : ""}
                        {e.buyerName ? `ผู้ซื้อ: ${e.buyerName}` : ""}
                      </div>
                    ) : null}
                  </td>

                  {/* ถ้าบิลผสม (หลาย line) → docrow เป็นยอดรวม (bold) แล้วแตก sub-lines ด้านล่าง */}
                  {multi ? (
                    <>
                      <td className="acc-multi">{e.lines.length} รายการ</td>
                      <td className="num strong">{formatMoney(s.amount)}</td>
                      <td className="num strong">{formatMoney(s.vat)}</td>
                      <td className="num strong">
                        {formatMoney(s.wht)}
                        {e.whtForm ? <span className="acc-pnd">{whtFormLabel(e.whtForm)}</span> : null}
                      </td>
                      <td className="num strong">{formatMoney(s.net)}</td>
                    </>
                  ) : (
                    <>
                      <td>
                        <span className="acc-desc">{single?.description || "—"}</span>
                        <span className={`vat-badge ${single?.vatType === "novat" ? "no" : "yes"}`}>
                          {single?.vatType === "novat" ? "ไม่ VAT" : "VAT"}
                        </span>
                      </td>
                      <td className="num">{formatMoney(single ? single.amount : 0)}</td>
                      <td className="num">{formatMoney(single ? single.vatAmount : 0)}</td>
                      <td className="num">
                        {formatMoney(single ? single.whtAmount : 0)}
                        {e.whtForm ? <span className="acc-pnd">{whtFormLabel(e.whtForm)}</span> : null}
                      </td>
                      <td className="num">{formatMoney(single ? lineNet(single) : 0)}</td>
                    </>
                  )}

                  <td className="center">
                    <span className={`st-badge ${e.status === "confirmed" ? "st-confirmed" : "st-draft"}`}>
                      {e.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}
                    </span>
                  </td>
                  <td className="center">
                    <RowActions
                      entryId={e.id}
                      entryType={e.entryType}
                      status={e.status}
                      editHref={editHref}
                    />
                  </td>
                </tr>

                {/* ---- sub-lines (บิลผสม) ---- */}
                {multi
                  ? e.lines.map((l) => (
                      <tr key={l.id} className="acc-subrow">
                        <td className="acc-sub-spacer" colSpan={4}>
                          <span className="acc-sub-tick" aria-hidden="true">↳</span>
                        </td>
                        <td>
                          <span className="acc-desc">{l.description || "—"}</span>
                          <span className={`vat-badge ${l.vatType === "novat" ? "no" : "yes"}`}>
                            {l.vatType === "novat" ? "ไม่ VAT" : "VAT"}
                          </span>
                        </td>
                        <td className="num">{formatMoney(l.amount)}</td>
                        <td className="num">{formatMoney(l.vatAmount)}</td>
                        <td className="num">{formatMoney(l.whtAmount)}</td>
                        <td className="num">{formatMoney(lineNet(l))}</td>
                        <td colSpan={2} />
                      </tr>
                    ))
                  : null}
              </tbody>
            );
          })}

          {/* ---- แถวรวมท้ายตาราง (tbody แยก) ---- */}
          <tbody>
            <tr className="acc-total">
              <td colSpan={5} className="strong">รวมทั้งสิ้น</td>
              <td className="num strong">{formatMoney(tAmount)}</td>
              <td className="num strong">{formatMoney(tVat)}</td>
              <td className="num strong">{formatMoney(tWht)}</td>
              <td className="num strong">{formatMoney(tNet)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
      </table>
    </div>
  );
}

/**
 * /chat-audit/accounting — "ลงบันทึกบัญชี ภาษีซื้อ/ขาย" (admin/executive เท่านั้น)
 *   ★ ลูกค้าเป็นตัวจัดกลุ่มหลัก (accordion) — แต่ละลูกค้ายื่นภาษีแยกกัน
 *   ★ ในลูกค้า: แท็บย่อย ภาษีซื้อ/ขาย/รอระบุ + ตารางบิล + แก้ได้ทุกช่อง (verify + auto-calc)
 *   ★ guard admin + tenant จาก session · sign รูปเฉพาะที่กางออก/กำลังแก้ (อายุ 1 ชม.)
 */
export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    month?: string;
    open?: string;
    type?: string;
    edit?: string;
  }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="ลงบันทึกบัญชี" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/accounting");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-accounting" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="ลงบันทึกบัญชี" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className="muted" style={{ fontSize: 13 }}>ข้อมูลบัญชี/ภาษีเป็นข้อมูลอ่อนไหว เปิดเฉพาะผู้ดูแลระบบ (admin) และผู้บริหาร (executive)</p>
          <p style={{ marginTop: 12 }}><Link href="/chat-audit" className="underline">← กลับ</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  const tenantId = ctx.tenantId;
  let allEntries: BillEntry[];
  try {
    const service = createServiceRoleClient();
    const res = await listEntries(service, tenantId, {});
    allEntries = res.entries;
  } catch {
    return (
      <ChatAuditFrame active="chat-accounting" role={ctx.role} authed title="ลงบันทึกบัญชี" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
      </ChatAuditFrame>
    );
  }

  // รหัสลูกค้า (สำหรับ avatar/ชื่อ/ค้นหา/ไฟล์ Excel)
  const service = createServiceRoleClient();
  const custIds = [...new Set(allEntries.map((e) => e.customerId).filter((x): x is string => !!x))];
  const codeById = await fetchCustomerCodes(service, tenantId, custIds);

  // ---- ตัวกรอง (validate ก่อนใช้) ----
  const q = (sp.q ?? "").trim();
  const monthOptions = [...new Set(allEntries.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) => b.localeCompare(a));
  const selectedMonth = isValidMonth(sp.month) && monthOptions.includes(sp.month) ? sp.month : "";
  const selectedType: EntryType =
    sp.type === "sale" ? "sale" : sp.type === "unspecified" ? "unspecified" : "purchase";

  // กรอง (เดือน + ค้นหาลูกค้า) ก่อนจัดกลุ่ม
  const qLower = q.toLowerCase();
  const filtered = allEntries.filter((e) => {
    if (selectedMonth && monthKeyOf(e) !== selectedMonth) return false;
    if (q) {
      const code = e.customerId ? codeById.get(e.customerId) ?? "" : "";
      const hay = `${code} ${e.customerName ?? ""}`.toLowerCase();
      if (!hay.includes(qLower)) return false;
    }
    return true;
  });

  const groups = groupEntriesByCustomer(filtered);
  const globalSummary = summarizeAll(filtered);

  // ลูกค้าที่กางออก (validate ให้อยู่ในกลุ่มจริง)
  const openKey = sp.open && groups.some((g) => groupOpenKey(g) === sp.open) ? sp.open : "";
  const openGroup = openKey ? groups.find((g) => groupOpenKey(g) === openKey) ?? null : null;

  // entry ที่กำลังแก้ (edit overlay) — หาได้จากทั้งชุด (ไม่จำกัดกลุ่ม/ประเภท)
  const editId = sp.edit ?? "";
  const editEntry = editId ? allEntries.find((e) => e.id === editId) ?? null : null;

  // ---- sign รูปเฉพาะที่โชว์: entry ของแท็บที่เปิด + entry ที่กำลังแก้ ----
  const shownEntries = openGroup ? entriesOfType(openGroup, selectedType) : [];
  const pathsToSign: string[] = [];
  for (const e of shownEntries) if (e.attachmentObjectPath) pathsToSign.push(e.attachmentObjectPath);
  if (editEntry?.attachmentObjectPath) pathsToSign.push(editEntry.attachmentObjectPath);
  const signed = await signPaths(service, pathsToSign);
  const editViewUrl = editEntry?.attachmentObjectPath ? signed.get(editEntry.attachmentObjectPath) ?? null : null;

  const hasAnyFilter = !!(q || selectedMonth);
  const exportAllHref = `/chat-audit/accounting/export${buildQuery({ month: selectedMonth || undefined })}`;

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={ctx.role}
      authed
      title="ลงบันทึกบัญชี"
      subtitle="ภาษีซื้อ/ขาย แยกตามลูกค้า — ตรวจบิลจริง แก้ได้ทุกช่อง แล้วออกรายงาน Excel"
    >
      <div className="dash-views">
        {/* ---- KPI รวม (ตามตัวกรอง) ---- */}
        <KpiRow s={globalSummary} />

        {/* ---- toolbar ---- */}
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
            <label htmlFor="f-month" style={{ fontWeight: 600, fontSize: 14 }}>เดือน:</label>
            <select id="f-month" name="month" defaultValue={selectedMonth}>
              <option value="">— ทุกเดือน —</option>
              {monthOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button type="submit" className="btn">กรอง</button>
            {hasAnyFilter ? <Link href="/chat-audit/accounting" className="btn btn-ghost">ล้าง</Link> : null}

            <span className="acc-toolbar-spacer" />

            {/* เพิ่มรายการเอง (ไม่ผูกลูกค้า) */}
            <form action={createEntryAction} className="acc-inline">
              <input type="hidden" name="entryType" value="purchase" />
              <button type="submit" className="btn">+ เพิ่มรายการเอง</button>
            </form>
            {/* Excel รวมทั้งหมด */}
            <a href={exportAllHref} className="btn btn-ghost">บันทึกเป็น Excel (รวม)</a>
          </form>
        </div>

        {/* ---- รายการลูกค้า (accordion) ---- */}
        <div className="card">
          <div className="section-title">
            <span>ลูกค้า</span>
            <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
              {groups.length.toLocaleString("th-TH")} ราย · {filtered.length.toLocaleString("th-TH")} รายการ
            </span>
          </div>

          {groups.length === 0 ? (
            <p className="empty">ยังไม่มีรายการตามเงื่อนไขที่เลือก</p>
          ) : (
            <div className="cust-list">
              {groups.map((g) => {
                const key = groupOpenKey(g);
                const isOpen = openKey === key;
                const isUnassigned = g.customerId === null;
                const code = g.customerId ? codeById.get(g.customerId) ?? null : null;
                const toggleHref = `/chat-audit/accounting${buildQuery({
                  q,
                  month: selectedMonth || undefined,
                  open: isOpen ? undefined : key,
                  type: isOpen ? undefined : selectedType,
                })}`;

                return (
                  <div key={key} className={`cust-card${isUnassigned ? " cust-unassigned" : ""}${isOpen ? " open" : ""}`}>
                    {/* หัวการ์ด */}
                    <Link href={toggleHref} className="cust-head" aria-expanded={isOpen} scroll={false}>
                      <span className={`cust-avatar${isUnassigned ? " un" : ""}`}>{avatarText(code)}</span>
                      <span className="cust-id">
                        <span className="cust-name">{customerLabel(code, g.name)}</span>
                        <span className="csub">รวมจ่ายจริง {formatMoney(g.summary.all.net)} บาท</span>
                      </span>
                      <span className="cust-kinds">
                        {g.purchaseCount > 0 ? <span className="kind-badge k-purchase">ซื้อ {g.purchaseCount}</span> : null}
                        {g.saleCount > 0 ? <span className="kind-badge k-sale">ขาย {g.saleCount}</span> : null}
                        {g.unspecifiedCount > 0 ? <span className="kind-badge k-hand">รอระบุ {g.unspecifiedCount}</span> : null}
                      </span>
                      <span className="cust-total">{g.count.toLocaleString("th-TH")} รายการ</span>
                      <span className={`cust-chev${isOpen ? " up" : ""}`} aria-hidden="true">▾</span>
                    </Link>

                    {/* เนื้อหากางออก */}
                    {isOpen ? (
                      <div className="cust-body">
                        {/* สรุปของลูกค้ารายนี้ */}
                        <KpiRow s={g.summary.all} />

                        {/* แท็บย่อย ภาษีซื้อ/ขาย/รอระบุ */}
                        <div className="acc-subtabs">
                          {TYPE_TABS.map((t) => {
                            const n = countOfType(g, t.type);
                            const active = selectedType === t.type;
                            const href = `/chat-audit/accounting${buildQuery({
                              q,
                              month: selectedMonth || undefined,
                              open: key,
                              type: t.type,
                            })}`;
                            return (
                              <Link
                                key={t.type}
                                href={href}
                                scroll={false}
                                className={`acc-subtab${active ? " active" : ""}${t.type === "unspecified" && n > 0 ? " amber" : ""}`}
                                aria-current={active ? "page" : undefined}
                              >
                                {t.label} <span className="acc-subtab-n">{n}</span>
                              </Link>
                            );
                          })}

                          <span className="acc-toolbar-spacer" />
                          {/* เพิ่มรายการเองให้ลูกค้ารายนี้ */}
                          <form action={createEntryAction} className="acc-inline">
                            {g.customerId ? <input type="hidden" name="customerId" value={g.customerId} /> : null}
                            <input type="hidden" name="entryType" value={selectedType} />
                            <button type="submit" className="btn">+ เพิ่มรายการ</button>
                          </form>
                          {/* Excel ของลูกค้ารายนี้ */}
                          {g.customerId ? (
                            <a
                              href={`/chat-audit/accounting/export${buildQuery({ month: selectedMonth || undefined })}${selectedMonth ? "&" : "?"}customerId=${g.customerId}`}
                              className="btn btn-ghost"
                            >
                              Excel ลูกค้านี้
                            </a>
                          ) : null}
                        </div>

                        <EntryTable
                          entries={entriesOfType(g, selectedType)}
                          signed={signed}
                          editHrefOf={(id) =>
                            `/chat-audit/accounting${buildQuery({
                              q,
                              month: selectedMonth || undefined,
                              open: key,
                              type: selectedType,
                              edit: id,
                            })}`
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ---- หน้าต่างตรวจ/แก้ (verify panel) ---- */}
      {editEntry ? (
        <EntryEditor
          entry={editEntry}
          viewUrl={editViewUrl}
          customerLabel={customerLabel(
            editEntry.customerId ? codeById.get(editEntry.customerId) ?? null : null,
            editEntry.customerName
          )}
          closeHref={`/chat-audit/accounting${buildQuery({
            q,
            month: selectedMonth || undefined,
            open: sp.open && sp.open !== "" ? sp.open : undefined,
            type: selectedType,
          })}`}
        />
      ) : null}
    </ChatAuditFrame>
  );
}
