import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import {
  customerIdsForAccountant,
  getEmployeeName,
  listAccountantsWithCounts,
  listAccountantEmployees,
  mapCustomersToAccountant,
  type AccountantCard,
  type AccountantOption,
} from "@/lib/accounting/accountant-scope";
import {
  listTeamAccountantCards,
  type TeamAccountantCard,
} from "@/lib/accounting/lead-scope";
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
import { countNeedsReview } from "@/lib/accounting/line-status";
import {
  monthKeyOf,
  summarizeMonth,
  customerColumnRows,
  thaiMonthLabel,
  type MonthKpi,
} from "@/lib/accounting/monthly";
import { createEntryAction } from "./actions";
import ChatAuditFrame from "../_Frame";
import EntryEditor from "./EntryEditor";
import RowActions from "./RowActions";
import CustomerTaxIdField from "./CustomerTaxIdField";
import EntryDateField from "./EntryDateField";
import UploadFileButton from "./UploadFileButton";
import UndoDeleteBar from "./UndoDeleteBar";
import CustomerTabs from "./CustomerTabs";
import ShareCirclePanel from "./ShareCirclePanel";
import ShareCircleToggle from "./ShareCircleToggle";
import CustomerAdminControls from "./CustomerAdminControls";
import {
  customerHasShareCircle,
  getCustomerShareCircleFlag,
  listShareCircleEntries,
  type ShareCircleEntry,
} from "@/lib/share-circles/queries";
import UploadProcessingBar from "./UploadProcessingBar";
import EntryEditorPager, { type PagerBill } from "./EntryEditorPager";
import { extOf } from "@/lib/accounting/upload";
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

/** object path ของไฟล์บิลของ entry (บิลไลน์ ก่อน แล้วไฟล์อัปเอง) — null = ไม่มีไฟล์ */
function entryObjectPath(e: BillEntry): string | null {
  return e.attachmentObjectPath ?? e.uploadPath;
}

/** ไฟล์ของ entry เป็น "รูป" ไหม (บิลไลน์ = รูปเสมอ · ไฟล์อัปเอง = ดูจาก uploadMime) */
function entryIsImage(e: BillEntry): boolean {
  if (e.attachmentObjectPath) return true;
  return (e.uploadMime ?? "").startsWith("image/");
}

/** ป้ายนามสกุลไฟล์ (PDF/XLSX/CSV…) สำหรับ thumbnail ของไฟล์ที่ไม่ใช่รูป */
function fileExtLabel(name: string | null, objectPath: string | null): string {
  const ext = extOf(name || objectPath || "");
  return ext ? ext.toUpperCase() : "ไฟล์";
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

function isValidMonth(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** ประกอบ query string คงบริบท (accountant/q/month/open/type/edit) */
function buildQuery(params: {
  accountant?: string;
  q?: string;
  month?: string;
  open?: string;
  type?: EntryType;
  edit?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.accountant) sp.set("accountant", params.accountant);
  if (params.q) sp.set("q", params.q);
  if (params.month) sp.set("month", params.month);
  if (params.open) sp.set("open", params.open);
  if (params.type) sp.set("type", params.type);
  if (params.edit) sp.set("edit", params.edit);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** การ์ดนักบัญชี (หน้าแรก admin/lead) — คลิกเข้าดูลูกค้าของคนนั้น */
function AccountantHome({ accountants }: { accountants: AccountantCard[] }) {
  return (
    <div className="dash-views">
      <div className="card">
        <div className="section-title">
          <span>เลือกนักบัญชี</span>
          <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
            {accountants.length.toLocaleString("th-TH")} คน
          </span>
        </div>
        <div className="acc-team-grid">
          {/* ทั้งสำนักงาน (ดูรวมทุกคน) */}
          <Link href="/chat-audit/accounting?accountant=all" className="acc-team-card acc-team-all">
            <span className="acc-team-avatar">ALL</span>
            <span className="acc-team-name">ทั้งสำนักงาน</span>
            <span className="acc-team-sub">ดูลูกค้าทุกคนรวมกัน</span>
          </Link>

          {accountants.length === 0 ? (
            <p className="empty" style={{ gridColumn: "1 / -1" }}>
              ยังไม่มีนักบัญชีที่ถูกกำหนดเป็นผู้ดูแลกลุ่มลูกค้า
            </p>
          ) : (
            accountants.map((a) => (
              <Link
                key={a.employeeId}
                href={`/chat-audit/accounting?accountant=${a.employeeId}`}
                className="acc-team-card"
              >
                <span className="acc-team-avatar">{a.name.slice(0, 2)}</span>
                <span className="acc-team-name">{a.name}</span>
                <span className="acc-team-sub">
                  {a.customerCount.toLocaleString("th-TH")} ลูกค้า ·{" "}
                  {a.billCount.toLocaleString("th-TH")} รายการ
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * หน้าแรกของหัวหน้าทีม (mode=lead) — การ์ดนักบัญชีในทีม (ลูกทีม + ตัวเอง)
 *   แต่ละการ์ด: ชื่อ · จำนวนลูกค้า/บิล · สถานะรอตรวจ (ร่าง+รอระบุ) · กด "ตรวจงาน" → เข้าดูลูกค้าของคนนั้น
 *   ★ ไม่มีการ์ด "ทั้งสำนักงาน" — หัวหน้าเห็นเฉพาะทีมตัวเอง
 */
function TeamHome({ leadName, cards }: { leadName: string | null; cards: TeamAccountantCard[] }) {
  const totalCustomers = cards.reduce((s, c) => s + c.customerCount, 0);
  const totalBills = cards.reduce((s, c) => s + c.billCount, 0);
  const totalPending = cards.reduce((s, c) => s + c.pendingCount, 0);
  return (
    <div className="dash-views">
      {/* KPI ภาพรวมทีม */}
      <div className="card">
        <div className="section-title">
          <span>ภาพรวมทีม{leadName ? ` · ${leadName}` : ""}</span>
          <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
            👑 หัวหน้าทีม
          </span>
        </div>
        <div className="kpi-grid">
          <div className="kpi">
            <div className="label">นักบัญชีในทีม</div>
            <div className="value">{cards.length.toLocaleString("th-TH")}<span className="unit">คน</span></div>
          </div>
          <div className="kpi">
            <div className="label">ลูกค้าที่ทีมดูแล</div>
            <div className="value">{totalCustomers.toLocaleString("th-TH")}<span className="unit">ราย</span></div>
          </div>
          <div className="kpi">
            <div className="label">บิลทั้งหมด</div>
            <div className="value">{totalBills.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
          <div className="kpi">
            <div className="label">รอตรวจ (ร่าง+รอระบุ)</div>
            <div className="value v-green">{totalPending.toLocaleString("th-TH")}<span className="unit">ใบ</span></div>
          </div>
        </div>
      </div>

      {/* การ์ดนักบัญชีในทีม */}
      <div className="card">
        <div className="section-title">
          <span>นักบัญชีในทีม</span>
          <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
            เรียงคนที่ค้างตรวจมากสุดขึ้นก่อน · กด “ตรวจงาน”
          </span>
        </div>
        {cards.length === 0 ? (
          <p className="empty">ยังไม่มีนักบัญชีในทีม (ยังไม่ได้กำหนดสมาชิกทีม)</p>
        ) : (
          <div className="acc-team-grid">
            {cards.map((c) => (
              <Link
                key={c.employeeId}
                href={`/chat-audit/accounting?accountant=${c.employeeId}`}
                className={`acc-team-card${c.pendingCount > 0 ? " needs" : ""}`}
              >
                <span className="acc-team-avatar">{c.name.slice(0, 2)}</span>
                <span className="acc-team-name">
                  {c.name}
                  {c.isSelf ? <span className="acc-team-self"> (ของฉันเอง)</span> : null}
                </span>
                <span className="acc-team-sub">
                  {c.customerCount.toLocaleString("th-TH")} ลูกค้า ·{" "}
                  {c.billCount.toLocaleString("th-TH")} บิล
                </span>
                {c.pendingCount > 0 ? (
                  <span className="acc-team-flag">
                    ค้าง {c.pendingCount.toLocaleString("th-TH")} ใบ
                  </span>
                ) : (
                  <span className="acc-team-flag clear">เรียบร้อย</span>
                )}
                <span className="acc-team-pills">
                  <span className="acc-team-pill ok">ยืนยัน {c.confirmedCount}</span>
                  <span className="acc-team-pill draft">ร่าง {c.draftCount}</span>
                  <span className="acc-team-pill un">รอระบุ {c.unspecifiedCount}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
  try {
    const { data } = await service
      .from("customers")
      .select("id, customer_code")
      .eq("tenant_id", tenantId)
      .in("id", ids);
    for (const c of (data ?? []) as { id: string; customer_code: string | null }[]) {
      map.set(c.id, c.customer_code);
    }
  } catch {
    // backend blip ชั่วคราว → คืน map ว่าง (หน้ายังขึ้น แค่ไม่มีรหัสลูกค้าให้แสดงชั่วคราว)
  }
  return map;
}

/** ดึงเลขภาษี (tax_id) ของ customerIds — สำหรับช่องกรอก/แก้เลขภาษีต่อลูกค้า (loop เก็บเลขภาษี) */
async function fetchCustomerTaxIds(
  service: SupabaseClient,
  tenantId: string,
  ids: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  try {
    const { data } = await service
      .from("customers")
      .select("id, tax_id")
      .eq("tenant_id", tenantId)
      .in("id", ids);
    for (const c of (data ?? []) as { id: string; tax_id: string | null }[]) {
      map.set(c.id, c.tax_id);
    }
  } catch {
    // backend blip ชั่วคราว → คืน map ว่าง (ช่องเลขภาษีเริ่มว่าง กรอกใหม่ได้)
  }
  return map;
}

/**
 * สร้าง signed URL (batch — 1 call) ให้ thumbnail ที่ต้องโชว์ (PDPA/perf)
 *   ★ perf: batch เดียว = ไม่บล็อก SSR render นาน (ต่างจาก sign ทีละใบ 100+ ครั้ง)
 *     รูปเต็ม แต่ thumbnail ในตาราง lazy-load → เบราว์เซอร์โหลดเฉพาะที่เห็นในจอ
 */
async function signPaths(
  service: SupabaseClient,
  paths: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(paths.filter((p): p is string => !!p))];
  if (uniq.length === 0) return out;
  try {
    const { data } = await service.storage.from(BILLS_BUCKET).createSignedUrls(uniq, SIGNED_URL_TTL_SEC);
    for (const e of data ?? []) {
      if (e.signedUrl && e.path) out.set(e.path, e.signedUrl);
    }
  } catch {
    // storage blip ชั่วคราว → คืน map ว่าง (บิลโชว์ "ไม่มีรูป" ชั่วคราว หน้าไม่ crash)
  }
  return out;
}

/**
 * sign "รูปบิลแบบย่อขนาด" สำหรับหน้าตรวจ/แก้ + pager (Supabase image transform)
 *   ★ perf: รูปต้นฉบับหลาย MB → ย่อ ~1300px q66 = เล็กลงมาก เลื่อนเปลี่ยนบิลเร็ว
 *   ★ degrade: transform ไม่รองรับ → คืน null (ใช้รูปเต็มจาก batch แทน)
 */
async function signResizedImage(service: SupabaseClient, path: string): Promise<string | null> {
  try {
    const { data, error } = await service.storage
      .from(BILLS_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEC, { transform: { width: 1300, quality: 66 } });
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch {
    // transform ไม่รองรับ → fallback รูปเต็ม
  }
  return null;
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
            const objectPath = entryObjectPath(e);
            const isImg = entryIsImage(e);
            const viewUrl = objectPath ? signed.get(objectPath) ?? null : null;
            const editHref = editHrefOf(e.id);
            const single = e.lines[0] ?? null;

            return (
              <tbody key={e.id} className="acc-entry">
                {/* ---- docrow (หัวเอกสาร) ---- */}
                <tr className={`acc-docrow${e.status === "confirmed" ? " is-confirmed" : ""}`}>
                  <td>
                    {viewUrl && isImg ? (
                      <Link href={editHref} className="acc-thumb" aria-label="เปิดตรวจ/แก้บิล" scroll={false}>
                        {/* ★ perf: lazy — โหลดเฉพาะรูปที่เห็นในจอ (ลูกค้าบิลเยอะ 100+ ใบ ไม่โหลดพร้อมกันหมด/ไม่โหลดแท็บที่ซ่อน) */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={viewUrl} alt="บิล" loading="lazy" decoding="async" />
                      </Link>
                    ) : objectPath ? (
                      <Link href={editHref} className="acc-thumb acc-thumb-file" aria-label="เปิดตรวจ/แก้ไฟล์" scroll={false}>
                        <span className="acc-thumb-ext">{fileExtLabel(e.uploadName, objectPath)}</span>
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

/** KPI สรุปเดือน (ฐาน/VAT ซื้อ·ขาย + หัก ณ ที่จ่าย + ยืนยันแล้ว X/Y) */
function MonthKpiRow({ k }: { k: MonthKpi }) {
  const remain = k.totalCount - k.confirmedCount;
  return (
    <div className="acc-mkpis">
      <div className="acc-mkpi buy">
        <div className="v">{formatMoney(k.purchaseBase)}</div>
        <div className="lbl">ภาษีซื้อ (ฐาน) · VAT {formatMoney(k.purchaseVat)}</div>
      </div>
      <div className="acc-mkpi sell">
        <div className="v">{formatMoney(k.saleBase)}</div>
        <div className="lbl">ภาษีขาย (ฐาน) · VAT {formatMoney(k.saleVat)}</div>
      </div>
      <div className="acc-mkpi">
        <div className="v">{formatMoney(k.wht)}</div>
        <div className="lbl">หัก ณ ที่จ่าย (ภ.ง.ด.3/53)</div>
      </div>
      <div className="acc-mkpi">
        <div className="v">
          {k.confirmedCount.toLocaleString("th-TH")} / {k.totalCount.toLocaleString("th-TH")}
        </div>
        <div className="lbl">
          ยืนยันแล้ว{remain > 0 ? ` · เหลือ ${remain.toLocaleString("th-TH")}` : ""}
        </div>
      </div>
    </div>
  );
}

/**
 * 2 คอลัมน์ ซื้อ/ขาย ของเดือนที่เลือก — ลิสต์รายลูกค้า + ปุ่มออกรายงานรายเดือน
 *   คลิกลูกค้า → toggle open (เปิดตารางบิลของลูกค้ารายนั้นเฉพาะเดือนนี้ ด้านล่าง)
 */
function BuySellColumns({
  filtered,
  codeById,
  accParam,
  q,
  selectedMonth,
  openKey,
  exportAccountant,
}: {
  filtered: BillEntry[];
  codeById: Map<string, string | null>;
  accParam?: string;
  q?: string;
  selectedMonth: string;
  openKey: string;
  exportAccountant?: string;
}) {
  const columns: { type: "purchase" | "sale"; title: string; cls: string }[] = [
    { type: "purchase", title: "📥 บิลซื้อ (ภาษีซื้อ)", cls: "buy" },
    { type: "sale", title: "📤 บิลขาย (ภาษีขาย)", cls: "sell" },
  ];
  return (
    <div className="acc-cols">
      {columns.map((col) => {
        const rows = customerColumnRows(filtered, col.type);
        const totalBase = rows.reduce((s, r) => s + r.base, 0);
        const totalCount = rows.reduce((s, r) => s + r.count, 0);
        // export รายเดือนทั้งคอลัมน์ (ทุกลูกค้าในสโคปของเดือน — ไม่ใส่ customerId)
        const exportHref = `/chat-audit/accounting/export?month=${selectedMonth}&type=${col.type}${
          exportAccountant ? `&accountant=${exportAccountant}` : ""
        }`;
        return (
          <div key={col.type} className={`acc-col ${col.cls}`}>
            <div className="acc-col-head">
              <span>{col.title}</span>
              <span className="acc-col-sum">
                {totalCount.toLocaleString("th-TH")} ใบ · ฿{formatMoney(totalBase)}
              </span>
            </div>
            {rows.length === 0 ? (
              <p className="empty" style={{ margin: "14px" }}>ยังไม่มีบิลในเดือนนี้</p>
            ) : (
              rows.map((r) => {
                const key = r.customerId ?? UNASSIGNED_CUSTOMER;
                const isOpen = openKey === key;
                const code = r.customerId ? codeById.get(r.customerId) ?? null : null;
                const href = `/chat-audit/accounting${buildQuery({
                  accountant: accParam,
                  q,
                  month: selectedMonth,
                  open: isOpen ? undefined : key,
                  type: col.type,
                })}`;
                return (
                  <Link
                    key={key}
                    href={href}
                    scroll={false}
                    className={`acc-crow${isOpen ? " open" : ""}`}
                    aria-expanded={isOpen}
                  >
                    <span className="acc-cc">{avatarText(code)}</span>
                    <span className="acc-cn">
                      <span className="nm">{customerLabel(code, r.customerName)}</span>
                      <span className="sub">
                        {r.count.toLocaleString("th-TH")} ใบ · ฿{formatMoney(r.base)}
                        {r.draftCount > 0 ? (
                          <span className="acc-flag"> · ร่าง {r.draftCount}</span>
                        ) : null}
                      </span>
                    </span>
                    <span className="acc-camt">฿{formatMoney(r.vat)}</span>
                  </Link>
                );
              })
            )}
            <div className="acc-col-foot">
              <a className={`btn ${col.cls === "buy" ? "acc-btn-buy" : "acc-btn-sell"}`} href={exportHref}>
                ⬇ ภพ.30 {col.type === "purchase" ? "ซื้อ" : "ขาย"} (Excel)
              </a>
            </div>
          </div>
        );
      })}
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
    accountant?: string;
    q?: string;
    month?: string;
    open?: string;
    type?: string;
    edit?: string;
    undo?: string;
    uploaded?: string;
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
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);

  // ไม่มีสิทธิ์ (ยังไม่ login / ไม่ใช่ admin / ไม่ใช่นักบัญชี) → ไปหน้า login
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const navRole = access.navRole;
  // staff (นักบัญชี/หัวหน้า LINE) → เมนูจำกัดเฉพาะบัญชีของตัวเอง
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  // ---- โหมด & สโคปลูกค้า ----
  // scopeCustomerIds: undefined = เห็นทุกลูกค้า (admin/lead ที่เลือก "ทั้งสำนักงาน")
  //                   string[]  = จำกัดเฉพาะชุดนี้ (นักบัญชี หรือ admin ที่เลือกนักบัญชีคนหนึ่ง)
  const accountantParam = (sp.accountant ?? "").trim();
  let scopeCustomerIds: string[] | undefined;
  let selectedAccountantName: string | null = null;

  if (access.mode === "accountant") {
    // ★ บังคับสโคปตัวเอง — ไม่ให้ override ผ่าน query param คนอื่น (server-side enforce)
    scopeCustomerIds = [...(access.allowedCustomerIds ?? new Set<string>())];
  } else {
    // admin / lead — หน้าแรกเลือกนักบัญชี, เลือกแล้วเห็นลูกค้าของคนนั้น
    // ★ lead: จำกัดทุกอย่างในทีมตัวเอง (allowedCustomerIds = สโคปทีม)
    const teamScope = access.mode === "lead" ? access.allowedCustomerIds : null;

    if (accountantParam === "all") {
      // lead ไม่มีสิทธิ์ดู "ทั้งสำนักงาน" → จำกัดเป็นสโคปทีมตัวเอง
      scopeCustomerIds = teamScope ? [...teamScope] : undefined;
    } else if (UUID_RE.test(accountantParam)) {
      const ids = await customerIdsForAccountant(service, tenantId, accountantParam);
      // lead: ตัดลูกค้าที่อยู่นอกทีมออก (กัน override ผ่าน query param คนนอกทีม)
      scopeCustomerIds = teamScope ? ids.filter((id) => teamScope.has(id)) : ids;
      selectedAccountantName = await getEmployeeName(service, tenantId, accountantParam);
    } else if (access.mode === "lead") {
      // หัวหน้าทีม ยังไม่เลือก → หน้าแรก = การ์ดนักบัญชีในทีม
      const cards = await listTeamAccountantCards(service, tenantId, access.employeeId!);
      return (
        <ChatAuditFrame
          active="chat-accounting"
          role={navRole}
          authed
          staffOnly={staffOnly}
          title="ตรวจงานทีม"
          subtitle="เลือกนักบัญชีในทีมเพื่อตรวจงานลูกค้าที่ดูแล"
        >
          <TeamHome leadName={access.name} cards={cards} />
        </ChatAuditFrame>
      );
    } else {
      // admin ยังไม่เลือก → หน้าแรก = การ์ดนักบัญชีทั้งสำนักงาน
      const accountants = await listAccountantsWithCounts(service, tenantId);
      return (
        <ChatAuditFrame
          active="chat-accounting"
          role={navRole}
          authed
          staffOnly={staffOnly}
          title="ลงบันทึกบัญชี"
          subtitle="เลือกนักบัญชีเพื่อดูลูกค้าที่ดูแล"
        >
          <AccountantHome accountants={accountants} />
        </ChatAuditFrame>
      );
    }
  }

  let allEntries: BillEntry[];
  try {
    const res = await listEntries(
      service,
      tenantId,
      scopeCustomerIds === undefined ? {} : { customerIds: scopeCustomerIds }
    );
    allEntries = res.entries;
  } catch {
    return (
      <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="ลงบันทึกบัญชี" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
      </ChatAuditFrame>
    );
  }

  // param accountant ที่ต้องคงไว้เวลากดสลับลูกค้า/แท็บ (เฉพาะ admin/lead ที่เลือกแล้ว)
  const accParam = access.mode === "accountant" ? undefined : accountantParam || undefined;

  // รหัสลูกค้า (สำหรับ avatar/ชื่อ/ค้นหา/ไฟล์ Excel) เฉพาะที่โชว์
  //   ★ perf: ไม่ดึงรายชื่อลูกค้า 5,000 รายทุกคลิกแล้ว — dropdown อัปไฟล์โหลดตอนเปิดกล่อง (on-demand)
  const custIds = [...new Set(allEntries.map((e) => e.customerId).filter((x): x is string => !!x))];
  const [codeById, taxIdById] = await Promise.all([
    fetchCustomerCodes(service, tenantId, custIds),
    fetchCustomerTaxIds(service, tenantId, custIds),
  ]);

  // ---- จัดการลูกค้า (เฉพาะ admin): รายชื่อนักบัญชี + ผู้ดูแลปัจจุบันต่อลูกค้า ----
  //   ★ โหลดเฉพาะ admin (นักบัญชี/หัวหน้าไม่เห็นปุ่มนี้ + action guard admin ซ้ำ)
  let accountantOptions: AccountantOption[] = [];
  let accountantByCustomer = new Map<string, string | null>();
  if (access.mode === "admin") {
    [accountantOptions, accountantByCustomer] = await Promise.all([
      listAccountantEmployees(service, tenantId),
      mapCustomersToAccountant(service, tenantId, custIds),
    ]);
  }
  const showCustomerAdmin = access.mode === "admin";

  // ---- ตัวกรอง (validate ก่อนใช้) ----
  const q = (sp.q ?? "").trim();
  const monthOptions = [...new Set(allEntries.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) => b.localeCompare(a));
  const selectedMonth = isValidMonth(sp.month) && monthOptions.includes(sp.month) ? sp.month : "";
  // โหมด "ยังไม่ลงวันที่" (บิล doc_date=null) — month=none
  const undatedMode = sp.month === "none";
  // ค่า month ที่ต้องคงในลิงก์ย่อย (เดือนจริง หรือ none) — undefined = ทุกเดือน
  const monthParam = undatedMode ? "none" : selectedMonth || undefined;
  const selectedType: EntryType =
    sp.type === "sale" ? "sale" : sp.type === "unspecified" ? "unspecified" : "purchase";

  // กรอง (เดือน/undated + ค้นหาลูกค้า) ก่อนจัดกลุ่ม
  const qLower = q.toLowerCase();
  const filtered = allEntries.filter((e) => {
    if (undatedMode) {
      if (monthKeyOf(e) !== null) return false;
    } else if (selectedMonth && monthKeyOf(e) !== selectedMonth) {
      return false;
    }
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

  // ---- วงแชร์ (แท็บพิเศษ) : โหลดเฉพาะ "ลูกค้าที่กางอยู่" เท่านั้น ----
  //   ★ perf: ไม่ยิง query ในหน้า list — เฉพาะตอนกางการ์ดลูกค้า (openGroup)
  //   ★ เงื่อนไขโผล่แท็บ: สวิตช์ท้าวแชร์ (is_share_circle) OR มีวง ≥1 (customerHasShareCircle)
  //     → กดสวิตช์แล้วแท็บโผล่ทันที (แม้ยัง 0 วง) เพื่อเริ่มอ่านจากไลน์/เพิ่มวง
  //   ★ degrade: table/คอลัมน์ยังไม่ apply (0057) → ซ่อนแท็บ+สวิตช์เงียบ ๆ (ไม่ crash)
  let shareCircleTab: ReactNode | undefined = undefined;
  let shareCircleCount = 0;
  let shareIsFlag = false; // สวิตช์ "ลูกค้าเป็นท้าวแชร์"
  let shareResolved = false; // อ่านสถานะได้ (migration 0057 พร้อม)
  const shareCustomerId = openGroup?.customerId ?? null;
  if (shareCustomerId) {
    shareIsFlag = await getCustomerShareCircleFlag(service, tenantId, shareCustomerId); // degrade→false
    try {
      const hasShare = await customerHasShareCircle(service, tenantId, shareCustomerId);
      shareResolved = true;
      if (shareIsFlag || hasShare) {
        const scEntries: ShareCircleEntry[] = await listShareCircleEntries(service, {
          tenantId,
          customerId: shareCustomerId,
        });
        shareCircleCount = scEntries.length;
        shareCircleTab = (
          <ShareCirclePanel
            customerId={shareCustomerId}
            entries={scEntries}
            exportHref={`/chat-audit/accounting/share-circle-export?customerId=${shareCustomerId}`}
          />
        );
      }
    } catch {
      // table ยังไม่มี / schema cache → ไม่โชว์แท็บ/สวิตช์ (หน้าไม่ล้ม)
      shareResolved = false;
    }
  }
  // สวิตช์ท้าวแชร์ — เฉพาะ admin + migration พร้อม (คอลัมน์ is_share_circle apply แล้ว)
  const showShareToggle = access.mode === "admin" && shareResolved && !!shareCustomerId;

  // ---- sign thumbnail ของลูกค้าที่เปิด (ทุกแท็บ) + บิลที่แก้ ----
  //   ★ perf: thumbnail = batch sign (1 call, ไม่บล็อก render) + lazy-load ในเบราว์เซอร์
  //     รูปในหน้าตรวจ/เลื่อนบิล = ย่อขนาด (เล็ก เลื่อนเร็ว)
  const shownEntries = openGroup ? entriesOfType(openGroup, selectedType) : [];
  const navOrderIds = shownEntries.map((e) => e.id);
  const pathsToSign: string[] = [];
  for (const e of openGroup ? openGroup.entries : []) {
    const p = entryObjectPath(e);
    if (p) pathsToSign.push(p);
  }
  const editObjectPath = editEntry ? entryObjectPath(editEntry) : null;
  if (editObjectPath) pathsToSign.push(editObjectPath);
  const signed = await signPaths(service, pathsToSign);

  const editIsImage = editEntry ? entryIsImage(editEntry) : false;
  let editViewUrl = editObjectPath ? signed.get(editObjectPath) ?? null : null;
  if (editObjectPath && editIsImage) {
    const resized = await signResizedImage(service, editObjectPath);
    if (resized) editViewUrl = resized;
  }

  // nav bills (แท็บปัจจุบัน) — sign รูปย่อทุกใบ (parallel) เฉพาะตอนเข้าหน้าแก้ → pager เลื่อน client + preload
  const editInNav = !!editEntry && navOrderIds.includes(editEntry.id);
  let pagerBills: PagerBill[] = [];
  if (editInNav) {
    pagerBills = await Promise.all(
      shownEntries.map(async (e) => {
        const p = entryObjectPath(e);
        const isImg = entryIsImage(e);
        let url: string | null = p ? signed.get(p) ?? null : null;
        if (p && isImg) {
          const rz = await signResizedImage(service, p);
          if (rz) url = rz;
        }
        return { id: e.id, entry: e, viewUrl: url, viewIsImage: isImg, fileName: e.uploadName };
      })
    );
  }

  const hasAnyFilter = !!(q || selectedMonth || undatedMode);
  // export: ส่ง accountant เฉพาะกรณีเลือกนักบัญชีคนหนึ่ง (ไม่ใช่ "ทั้งสำนักงาน")
  //   นักบัญชี (staff) ไม่ต้องส่ง — export route สโคปจาก session ให้เอง
  const exportAccountant = accParam && accParam !== "all" ? accParam : undefined;
  // ไปหน้า "ตรวจทานก่อนออก Excel" (คงสโคป/ตัวกรอง) — ปุ่มดาวน์โหลดจริงอยู่ในหน้านั้น
  const reviewAllHref = `/chat-audit/accounting/review${buildQuery({ accountant: exportAccountant, month: selectedMonth || undefined })}`;

  // ป้ายบอกสโคป + ปุ่มกลับไปเลือกนักบัญชี (เฉพาะ admin/lead)
  const scopeLabel =
    access.mode === "accountant"
      ? "ลูกค้าที่คุณดูแล"
      : accountantParam === "all"
      ? access.mode === "lead"
        ? "ทีมของฉัน (ทุกคน)"
        : "ทั้งสำนักงาน (ทุกนักบัญชี)"
      : `นักบัญชี: ${selectedAccountantName ?? "—"}`;
  const showAccountantPicker = access.mode !== "accountant";

  /**
   * เนื้อหากางออกของลูกค้า 1 ราย (เลขภาษี + KPI + แท็บซื้อ/ขาย/รอระบุ + ตารางบิล)
   *   ใช้ซ้ำได้ทั้งโหมด accordion (ทุกเดือน) และโหมดเลือกเดือน (กดลูกค้าในคอลัมน์ซื้อ/ขาย)
   */
  const renderCustomerBody = (g: CustomerEntryGroup, key: string, code: string | null) => (
    <div className="cust-body">
      {/* สวิตช์ "ลูกค้าเป็นท้าวแชร์" (admin) — เปิดครั้งเดียวให้แท็บวงแชร์โผล่ */}
      {showShareToggle && g.customerId && g.customerId === shareCustomerId ? (
        <div className="acc-scopebar" style={{ marginBottom: 10 }}>
          <span className="acc-scope-label">วงแชร์</span>
          <ShareCircleToggle customerId={g.customerId} initialOn={shareIsFlag} />
        </div>
      ) : null}

      {/* จัดการลูกค้า (admin): เปลี่ยนผู้ดูแล + แก้ ชื่อ/รหัส/เลขภาษี */}
      {showCustomerAdmin && g.customerId ? (
        <CustomerAdminControls
          customerId={g.customerId}
          currentAccountantId={accountantByCustomer.get(g.customerId) ?? null}
          accountants={accountantOptions}
          initialName={g.name ?? null}
          initialCode={code}
          initialTaxId={taxIdById.get(g.customerId) ?? null}
        />
      ) : null}

      {/* เลขภาษีของลูกค้า (loop เก็บเลขภาษี) — กรอก/แก้ได้ เฉพาะลูกค้าที่จับคู่แล้ว */}
      {g.customerId ? (
        <CustomerTaxIdField
          customerId={g.customerId}
          initialTaxId={taxIdById.get(g.customerId) ?? null}
        />
      ) : null}

      {/* สรุปของลูกค้ารายนี้ */}
      <KpiRow s={g.summary.all} />

      {/* แท็บ ซื้อ/ขาย/รอระบุ + ตาราง — ★ สลับในจอ (client) ไม่วิ่ง server (perf #1) */}
      <CustomerTabs
        initialType={selectedType}
        counts={{
          purchase: countOfType(g, "purchase"),
          sale: countOfType(g, "sale"),
          unspecified: countOfType(g, "unspecified"),
        }}
        customerId={g.customerId}
        customerLabel={customerLabel(code, g.name)}
        accountant={accParam}
        reviewHref={
          g.customerId
            ? `/chat-audit/accounting/review${buildQuery({ month: selectedMonth || undefined })}${selectedMonth ? "&" : "?"}customerId=${g.customerId}`
            : undefined
        }
        openingHref={g.customerId ? `/chat-audit/accounting/opening?customerId=${g.customerId}` : undefined}
        reportsHref={g.customerId ? `/chat-audit/accounting/reports?customerId=${g.customerId}` : undefined}
        // แท็บวงแชร์ — เฉพาะลูกค้าที่กำลังกาง + เป็นท้าวแชร์ (โหลดไว้ด้านบน)
        shareCircle={g.customerId && g.customerId === shareCustomerId ? shareCircleTab : undefined}
        shareCircleCount={shareCircleCount}
        tables={{
          purchase: (
            <EntryTable
              entries={entriesOfType(g, "purchase")}
              signed={signed}
              editHrefOf={(id) =>
                `/chat-audit/accounting${buildQuery({ accountant: accParam, q, month: monthParam, open: key, type: "purchase", edit: id })}`
              }
            />
          ),
          sale: (
            <EntryTable
              entries={entriesOfType(g, "sale")}
              signed={signed}
              editHrefOf={(id) =>
                `/chat-audit/accounting${buildQuery({ accountant: accParam, q, month: monthParam, open: key, type: "sale", edit: id })}`
              }
            />
          ),
          unspecified: (
            <EntryTable
              entries={entriesOfType(g, "unspecified")}
              signed={signed}
              editHrefOf={(id) =>
                `/chat-audit/accounting${buildQuery({ accountant: accParam, q, month: monthParam, open: key, type: "unspecified", edit: id })}`
              }
            />
          ),
        }}
      />
    </div>
  );

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ลงบันทึกบัญชี"
      subtitle="ภาษีซื้อ/ขาย แยกตามลูกค้า — ตรวจบิลจริง แก้ได้ทุกช่อง แล้วออกรายงาน Excel"
    >
      <div className="dash-views">
        {/* ---- แถบสโคป (นักบัญชีที่กำลังดู) ---- */}
        <div className="card acc-scopebar">
          <span className="acc-scope-label">{scopeLabel}</span>
          {showAccountantPicker ? (
            <Link href="/chat-audit/accounting" className="btn btn-ghost">
              ← เปลี่ยนนักบัญชี
            </Link>
          ) : null}
        </div>

        {/* ---- toolbar ---- */}
        <div className="card">
          <form method="get" className="inline-form bills-filter">
            {/* คงบริบทนักบัญชีที่กำลังดูไว้เวลากรอง (form GET จะไม่ทิ้ง accountant) */}
            {accParam ? <input type="hidden" name="accountant" value={accParam} /> : null}
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
                <option key={m} value={m}>{thaiMonthLabel(m)}</option>
              ))}
            </select>
            <button type="submit" className="btn">กรอง</button>
            {hasAnyFilter ? <Link href={`/chat-audit/accounting${buildQuery({ accountant: accParam })}`} className="btn btn-ghost">ล้าง</Link> : null}

            <span className="acc-toolbar-spacer" />

            {/* เพิ่มรายการเอง (ไม่ผูกลูกค้า) */}
            <form action={createEntryAction} className="acc-inline">
              <input type="hidden" name="entryType" value="purchase" />
              {accParam ? <input type="hidden" name="accountant" value={accParam} /> : null}
              <button type="submit" className="btn">+ เพิ่มรายการเอง</button>
            </form>
            {/* อัปโหลดไฟล์เอง (เลือกลูกค้าได้ — โหลดรายชื่อลูกค้าตอนเปิดกล่อง) */}
            <UploadFileButton accountant={accParam} />
            {/* ตรวจทานทุกบรรทัดก่อนออก Excel รวม */}
            <a href={reviewAllHref} className="btn btn-ghost">ตรวจทาน / ออก Excel (รวม)</a>
          </form>
        </div>

        {/* ================= เนื้อหาตามโหมด ================= */}
        {undatedMode ? (
          /* ---- โหมด "บิลยังไม่ลงวันที่" (ลงวันที่ด่วน → เด้งเข้าเดือน) ---- */
          <div className="card acc-undated">
            <div className="acc-ud-head">
              ⚠️ บิลยังไม่ลงวันที่
              <span className="acc-ud-cnt">
                {filtered.length.toLocaleString("th-TH")} ใบ (AI อ่านวันที่ไม่ได้ / บิลเขียนมือ)
              </span>
            </div>
            {filtered.length === 0 ? (
              <p className="empty">ไม่มีบิลที่ยังไม่ลงวันที่ 🎉</p>
            ) : (
              <>
                <div className="acc-ud-body">
                  {filtered.map((e) => {
                    const code = e.customerId ? codeById.get(e.customerId) ?? null : null;
                    const kindLabel =
                      e.entryType === "purchase" ? "ซื้อ" : e.entryType === "sale" ? "ขาย" : "ยังไม่ระบุ ซื้อ/ขาย";
                    const s = summarizeEntry(e.lines);
                    const openHref = `/chat-audit/accounting${buildQuery({
                      accountant: accParam,
                      q,
                      month: "none",
                      edit: e.id,
                    })}`;
                    return (
                      <div key={e.id} className="acc-ud-row">
                        <div className="acc-ud-thumb" aria-hidden="true">🧾</div>
                        <div className="acc-ud-info">
                          <span className="nm">{customerLabel(code, e.customerName)}</span>
                          <span className="sub">฿{formatMoney(s.net)} · {kindLabel}</span>
                        </div>
                        <EntryDateField entryId={e.id} />
                        <Link href={openHref} className="btn btn-ghost" scroll={false}>เปิดบิล</Link>
                      </div>
                    );
                  })}
                </div>
                <p className="acc-ud-note">
                  พอลงวันที่ → บิลย้ายเข้าเดือนที่ถูกต้องอัตโนมัติ (ออกจากกล่องนี้)
                </p>
              </>
            )}
          </div>
        ) : selectedMonth ? (
          /* ---- โหมดเลือกเดือน: KPI เดือน + 2 คอลัมน์ ซื้อ/ขาย + (กดลูกค้า) ตารางบิล ---- */
          <>
            <div className="card acc-month-head">
              <div className="section-title">
                <span>เดือน {thaiMonthLabel(selectedMonth)}</span>
                <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
                  {filtered.length.toLocaleString("th-TH")} รายการ
                </span>
              </div>
              <MonthKpiRow k={summarizeMonth(filtered)} />
              <BuySellColumns
                filtered={filtered}
                codeById={codeById}
                accParam={accParam}
                q={q}
                selectedMonth={selectedMonth}
                openKey={openKey}
                exportAccountant={exportAccountant}
              />
              <p className="acc-month-hint">
                กดชื่อลูกค้า → เข้าดู/แก้บิลของลูกค้ารายนั้น <b>เฉพาะเดือนนี้</b> · แต่ละลูกค้ายื่นภาษีแยกกัน
              </p>
            </div>

            {/* ตารางบิลของลูกค้าที่กดเลือก (เฉพาะเดือนนี้) */}
            {openGroup ? (
              <div className="card acc-detail">
                <div className="section-title">
                  <span>
                    {customerLabel(
                      openGroup.customerId ? codeById.get(openGroup.customerId) ?? null : null,
                      openGroup.name
                    )}
                  </span>
                  <Link
                    href={`/chat-audit/accounting${buildQuery({ accountant: accParam, q, month: monthParam })}`}
                    className="btn btn-ghost"
                    scroll={false}
                  >
                    ปิด
                  </Link>
                </div>
                {renderCustomerBody(
                  openGroup,
                  openKey,
                  openGroup.customerId ? codeById.get(openGroup.customerId) ?? null : null
                )}
              </div>
            ) : null}
          </>
        ) : (
          /* ---- โหมด "ทุกเดือน" (เดิม): KPI รวม + accordion รายลูกค้า ---- */
          <>
            <KpiRow s={globalSummary} />
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
                    // จำนวนบิลที่ AI ลงให้แล้วยัง "รอตรวจ" (ร่าง + มีบรรทัด 🟡) — เตือนนักบัญชี
                    const needsReview = countNeedsReview(g.entries);
                    const toggleHref = `/chat-audit/accounting${buildQuery({
                      accountant: accParam,
                      q,
                      month: monthParam,
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
                            {needsReview > 0 ? <span className="kind-badge k-review">🟡 รอตรวจ {needsReview}</span> : null}
                          </span>
                          <span className="cust-total">{g.count.toLocaleString("th-TH")} รายการ</span>
                          <span className={`cust-chev${isOpen ? " up" : ""}`} aria-hidden="true">▾</span>
                        </Link>

                        {/* เนื้อหากางออก */}
                        {isOpen ? renderCustomerBody(g, key, code) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---- หน้าต่างตรวจ/แก้ (verify panel) ---- */}
      {editEntry ? (
        editInNav && pagerBills.length > 0 ? (
          /* ★ เลื่อนบิลแบบ client (instant · รูป preload) — กด ก่อนหน้า/ถัดไป ไม่โหลดหน้าใหม่ */
          <EntryEditorPager
            bills={pagerBills}
            initialId={editEntry.id}
            customerLabel={customerLabel(
              editEntry.customerId ? codeById.get(editEntry.customerId) ?? null : null,
              editEntry.customerName
            )}
            orderIds={navOrderIds}
            closeHref={`/chat-audit/accounting${buildQuery({
              accountant: accParam,
              q,
              month: monthParam,
              open: sp.open && sp.open !== "" ? sp.open : undefined,
              type: selectedType,
            })}`}
          />
        ) : (
          /* fallback: บิลไม่อยู่ใน nav ของแท็บที่เปิด (แก้ข้ามบริบท) — ตัวเดียว navigate ตามเดิม */
          <EntryEditor
            key={editEntry.id}
            entry={editEntry}
            viewUrl={editViewUrl}
            viewIsImage={editIsImage}
            fileName={editEntry.uploadName}
            orderIds={navOrderIds}
            customerLabel={customerLabel(
              editEntry.customerId ? codeById.get(editEntry.customerId) ?? null : null,
              editEntry.customerName
            )}
            closeHref={`/chat-audit/accounting${buildQuery({
              accountant: accParam,
              q,
              month: monthParam,
              open: sp.open && sp.open !== "" ? sp.open : undefined,
              type: selectedType,
            })}`}
          />
        )
      ) : null}

      {/* แถบ "เลิกทำ" หลังลบบิล (undo) — กู้บิลที่ลบผิดกลับได้ทันที */}
      {sp.undo && UUID_RE.test(sp.undo) ? (
        <UndoDeleteBar
          entryId={sp.undo}
          backHref={`/chat-audit/accounting${buildQuery({
            accountant: accParam,
            q,
            month: monthParam,
            open: sp.open && sp.open !== "" ? sp.open : undefined,
            type: selectedType,
          })}`}
        />
      ) : null}

      {/* แถบ "AI กำลังอ่านบิลเบื้องหลัง" หลังอัปไฟล์ (async) — ข้อมูลเด้งเข้ามาเองเมื่อเสร็จ */}
      {sp.uploaded && UUID_RE.test(sp.uploaded) ? (
        <UploadProcessingBar
          backHref={`/chat-audit/accounting${buildQuery({
            accountant: accParam,
            q,
            month: monthParam,
            open: sp.open && sp.open !== "" ? sp.open : undefined,
            type: selectedType,
          })}`}
        />
      ) : null}
    </ChatAuditFrame>
  );
}
