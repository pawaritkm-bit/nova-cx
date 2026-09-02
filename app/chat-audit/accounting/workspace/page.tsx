import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import { customerIdsForAccountant, listAccountantsWithCounts, getEmployeeName, type AccountantCard } from "@/lib/accounting/accountant-scope";
import { listTeamAccountantCards, type TeamAccountantCard } from "@/lib/accounting/lead-scope";
import { listEntries, summarizeEntry, type BillEntry } from "@/lib/accounting/queries";
import { groupEntriesByCustomer, UNASSIGNED_CUSTOMER } from "@/lib/accounting/group";
import { monthKeyOf } from "@/lib/accounting/monthly";
import { formatMoney } from "@/lib/accounting/calc";
import ChatAuditFrame from "../../_Frame";
import QuickFixBill from "./QuickFixBill";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import DeleteBillButton from "./DeleteBillButton";
import RenameCustomerButton from "./RenameCustomerButton";
import UploadFileButton from "../UploadFileButton";
import StatementReconcileButton from "../StatementReconcileButton";
import BatchConfirmButton from "../BatchConfirmButton";
import CustomerToolsMenu from "../CustomerToolsMenu";
import CustomerAdminControls from "../CustomerAdminControls";
import ShareCircleToggle from "../ShareCircleToggle";
import ShareCirclePanel from "../ShareCirclePanel";
import { listAccountantEmployees, mapCustomersToAccountant, type AccountantOption } from "@/lib/accounting/accountant-scope";
import { getCustomerShareCircleFlag, customerHasShareCircle, listShareCircleEntries, type ShareCircleEntry } from "@/lib/share-circles/queries";
import "../../chat-admin.css";
import "../accounting.css";
import "./workspace.css";

export const dynamic = "force-dynamic";

const BILLS_BUCKET = "bills";
const SIGNED_URL_TTL_SEC = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ★ detect "รูป" เชิงบวก — จับทั้ง ".jpg" และ "_jpg" (naming เก่า) · ไม่ใช่รูป (รวม _pdf) = ไม่เรนเดอร์ <img> (กันรูปเสีย)
const IMG_EXT_RE = /[._](jpe?g|png|gif|webp|heic|heif|bmp)$/i;
/** ป้ายนามสกุลไฟล์ (จับทั้ง ".pdf"/"_pdf") — ไม่เจอ = "ไฟล์" */
function extLabel(path: string): string {
  const m = path.toLowerCase().match(/[._]([a-z0-9]{1,8})$/);
  return (m ? m[1] : "ไฟล์").toUpperCase();
}

function isValidMonth(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
function thaiMonth(key: string): string {
  const TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const [y, m] = key.split("-");
  return `${TH[Number(m) - 1] ?? m} ${Number(y) + 543}`;
}
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}
function entryPath(e: BillEntry): string | null {
  // ★ 2026-09-02 — บิล PDF ที่ตัดหน้าเป็นรูปแล้ว: ใช้รูปก่อนไฟล์แนบต้นทาง (OneDrive เซ็น URL ไม่ได้)
  if ((e.uploadMime ?? "").startsWith("image/") && e.uploadPath) return e.uploadPath;
  return e.attachmentObjectPath ?? e.uploadPath;
}
function entryIsImage(e: BillEntry): boolean {
  if ((e.uploadMime ?? "").startsWith("image/") && e.uploadPath) return true; // รูปหน้า PDF ที่ตัดแล้ว
  if (e.attachmentObjectPath) return IMG_EXT_RE.test(e.attachmentObjectPath);
  return (e.uploadMime ?? "").startsWith("image/");
}
/** ★ 2026-09-02 ผู้ใช้: บิล PDF ต้องโชว์เป็น "รูป" เหมือนบิลรูปถ่าย — bill-thumb เรนเดอร์หน้าแรกให้ */
function entryIsPdf(e: BillEntry): boolean {
  const p = e.attachmentObjectPath ?? e.uploadPath ?? "";
  return (e.uploadMime ?? "") === "application/pdf" || /\.pdf($|\?)/i.test(p);
}

async function signPaths(service: SupabaseClient, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(paths.filter((p): p is string => !!p))];
  if (uniq.length === 0) return out;
  try {
    const { data } = await service.storage.from(BILLS_BUCKET).createSignedUrls(uniq, SIGNED_URL_TTL_SEC);
    for (const e of data ?? []) if (e.signedUrl && e.path) out.set(e.path, e.signedUrl);
  } catch {
    /* storage blip → thumbnails ว่างชั่วคราว */
  }
  return out;
}

async function fetchCodes(service: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  try {
    const { data } = await service.from("customers").select("id, customer_code").eq("tenant_id", tenantId).in("id", ids.slice(0, 300));
    for (const c of (data ?? []) as { id: string; customer_code: string | null }[]) map.set(c.id, c.customer_code);
  } catch {
    /* best-effort */
  }
  return map;
}

/**
 * โหลดข้อมูล "จัดการลูกค้า" + ประเภทลูกค้า ของลูกค้า 1 ราย (เฉพาะที่กางอยู่ = perf)
 *   2 query: (1) code+tax_id+customer_type (คอลัมน์เดิม) (2) address/phone (คอลัมน์ใหม่ best-effort)
 */
type CustomerAdminFields = {
  code: string | null;
  taxId: string | null;
  customerType: "company" | "individual" | null;
  address: string | null;
  phone: string | null;
};
async function loadCustomerFields(
  service: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<CustomerAdminFields> {
  const out: CustomerAdminFields = { code: null, taxId: null, customerType: null, address: null, phone: null };
  try {
    const { data } = await service.from("customers").select("customer_code, tax_id, customer_type").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
    const c = data as { customer_code: string | null; tax_id: string | null; customer_type: string | null } | null;
    if (c) {
      out.code = c.customer_code;
      out.taxId = c.tax_id;
      out.customerType = c.customer_type === "company" || c.customer_type === "individual" ? c.customer_type : null;
    }
  } catch { /* best-effort */ }
  try {
    const { data, error } = await service
      .from("customers")
      .select("address, phone")
      .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
    const c = data as { address: string | null; phone: string | null } | null;
    if (!error && c) {
      out.address = c.address;
      out.phone = c.phone;
    }
  } catch { /* คอลัมน์ใหม่ยังไม่ apply → degrade */ }
  return out;
}

const isPending = (e: BillEntry) => e.status !== "confirmed";

/** แท็บ "ปิดเดือน" — เช็กลิสต์ความพร้อม + ฝังงบการเงินในหน้า (ไม่เด้งออก) */
function CloseMonthView({ received, pending, confirmed, purchaseBase, saleBase, whtTotal, month }: {
  received: number; pending: number; confirmed: number; purchaseBase: number; saleBase: number; whtTotal: number; month: string;
}) {
  const ready = received > 0 && pending === 0;
  return (
    <div className="wsp-close">
      <div className={`wsp-close-banner ${ready ? "ok" : "warn"}`}>
        {received === 0 ? "ยังไม่มีบิลในเดือนนี้" : ready ? "✓ พร้อมปิดเดือน — ตรวจ/ยืนยันครบทุกใบแล้ว" : `⚠ ยังมีบิลค้างตรวจ ${pending.toLocaleString("th-TH")} ใบ — ควรตรวจให้ครบก่อนปิดเดือน`}
      </div>
      <div className="wsp-close-grid">
        <div><span className="k">บิลทั้งหมด</span><span className="v">{received.toLocaleString("th-TH")}</span></div>
        <div><span className="k">ยืนยันแล้ว</span><span className="v ok">{confirmed}/{received}</span></div>
        <div><span className="k">ค้างตรวจ</span><span className={`v ${pending > 0 ? "warn" : "ok"}`}>{pending.toLocaleString("th-TH")}</span></div>
        <div><span className="k">ภาษีซื้อ (ฐาน)</span><span className="v">฿{formatMoney(purchaseBase)}</span></div>
        <div><span className="k">ภาษีขาย (ฐาน)</span><span className="v">฿{formatMoney(saleBase)}</span></div>
        <div><span className="k">หัก ณ ที่จ่าย</span><span className="v">฿{formatMoney(whtTotal)}</span></div>
      </div>
      <div className="wsp-close-embed-head">📑 งบการเงินฉบับทางการ</div>
      <iframe className="wsp-embed" src={`/chat-audit/accounting/financial-statements?embed=1${month ? `&from=${month}&to=${month}` : ""}`} title="งบการเงิน" />
    </div>
  );
}

/** แท็บ "ภาษี ภพ.30" — ดูตารางในโปรแกรมก่อน (ไม่ดาวน์โหลดทันที) + ปุ่มดาวน์โหลด Excel แยก */
function TaxView({ entries, month, accParam }: { entries: BillEntry[]; month: string; accParam?: string }) {
  const section = (type: "purchase" | "sale", title: string, cls: string) => {
    const rows = entries
      .filter((e) => e.entryType === type)
      .map((e) => {
        const s = summarizeEntry(e.lines);
        return { id: e.id, date: e.docDate, no: e.docNo, party: e.counterpartyName || e.sellerName || e.buyerName || "—", base: s.amount, vat: s.vat };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const tBase = rows.reduce((x, r) => x + r.base, 0);
    const tVat = rows.reduce((x, r) => x + r.vat, 0);
    const dl = `/chat-audit/accounting/export?month=${month}&type=${type}${accParam ? `&accountant=${accParam}` : ""}`;
    return (
      <div className={`wsp-tax-sec ${cls}`}>
        <div className="wsp-tax-head">
          <span>{title} · {rows.length.toLocaleString("th-TH")} ใบ</span>
          <a className="wsp-btn ghost" href={dl}>⬇ ดาวน์โหลด Excel</a>
        </div>
        {rows.length === 0 ? <p className="empty" style={{ padding: 16 }}>ไม่มีบิลในเดือนนี้</p> : (
          <div className="wsp-tax-tablewrap">
            <table className="wsp-tax-table">
              <thead><tr><th>วันที่</th><th>เลขที่</th><th>คู่ค้า</th><th className="num">มูลค่า</th><th className="num">VAT</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}><td>{formatDate(r.date)}</td><td>{r.no || "—"}</td><td>{r.party}</td><td className="num">{formatMoney(r.base)}</td><td className="num">{formatMoney(r.vat)}</td></tr>
                ))}
                <tr className="wsp-tax-total"><td colSpan={3}>รวม</td><td className="num">{formatMoney(tBase)}</td><td className="num">{formatMoney(tVat)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="wsp-tax">
      {section("purchase", "📥 ภาษีซื้อ (ภพ.30)", "buy")}
      {section("sale", "📤 ภาษีขาย (ภพ.30)", "sell")}
    </div>
  );
}

/** การ์ดเลือกนักบัญชี (admin) — กดเข้าดูโต๊ะทำงานของลูกค้าที่คนนั้นดูแล */
function AccountantPicker({ accountants }: { accountants: AccountantCard[] }) {
  return (
    <div className="card">
      <div className="section-title"><span>เลือกนักบัญชี</span><span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>{accountants.length.toLocaleString("th-TH")} คน</span></div>
      <div className="acc-team-grid">
        <Link href="/chat-audit/accounting/workspace?accountant=all" className="acc-team-card acc-team-all">
          <span className="acc-team-avatar">ALL</span><span className="acc-team-name">ทั้งสำนักงาน</span><span className="acc-team-sub">ดูลูกค้าทุกคนรวมกัน</span>
        </Link>
        {accountants.length === 0 ? (
          <p className="empty" style={{ gridColumn: "1 / -1" }}>ยังไม่มีนักบัญชีที่ถูกกำหนดเป็นผู้ดูแล</p>
        ) : accountants.map((a) => (
          <Link key={a.employeeId} href={`/chat-audit/accounting/workspace?accountant=${a.employeeId}`} className="acc-team-card">
            <span className="acc-team-avatar">{a.name.slice(0, 2)}</span>
            <span className="acc-team-name">{a.name}</span>
            <span className="acc-team-sub">{a.customerCount.toLocaleString("th-TH")} ลูกค้า · {a.billCount.toLocaleString("th-TH")} รายการ</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** การ์ดเลือกนักบัญชีในทีม (lead) */
function TeamPicker({ leadName, cards }: { leadName: string | null; cards: TeamAccountantCard[] }) {
  return (
    <div className="card">
      <div className="section-title"><span>ตรวจงานทีม{leadName ? ` · ${leadName}` : ""}</span><span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>👑 หัวหน้าทีม · เลือกนักบัญชี</span></div>
      {cards.length === 0 ? <p className="empty">ยังไม่มีนักบัญชีในทีม</p> : (
        <div className="acc-team-grid">
          {cards.map((c) => (
            <Link key={c.employeeId} href={`/chat-audit/accounting/workspace?accountant=${c.employeeId}`} className={`acc-team-card${c.pendingCount > 0 ? " needs" : ""}`}>
              <span className="acc-team-avatar">{c.name.slice(0, 2)}</span>
              <span className="acc-team-name">{c.name}{c.isSelf ? <span className="acc-team-self"> (ของฉัน)</span> : null}</span>
              <span className="acc-team-sub">{c.customerCount.toLocaleString("th-TH")} ลูกค้า · {c.billCount.toLocaleString("th-TH")} บิล</span>
              {c.pendingCount > 0 ? <span className="acc-team-flag">ค้าง {c.pendingCount.toLocaleString("th-TH")} ใบ</span> : <span className="acc-team-flag clear">เรียบร้อย</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * /chat-audit/accounting/workspace — "โต๊ะทำงานนักบัญชี" (ดีไซน์ใหม่ · เพิ่มเข้ามาไม่แตะหน้าเดิม)
 *   flow เดียวจบ: คิวลูกค้าซ้าย → ตรวจเอกสารทีละใบตรงกลาง → เปิดตัวแก้เดิม (EntryEditor) ที่หน้าเดิม
 *   ★ อ่านข้อมูลจริงจาก listEntries เดิม · ยืนยัน/แก้ = ใช้ตัวแก้ที่พิสูจน์แล้วของหน้าเดิม (ปลอดภัย)
 */
export default async function AccountingWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ accountant?: string; month?: string; open?: string; view?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="โต๊ะทำงานบัญชี" subtitle="ดีไซน์ใหม่">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }
  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/workspace");

  const tenantId = access.tenantId;
  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";
  const accountantParam = (sp.accountant ?? "").trim();

  // ★ Landing: admin/lead ยังไม่เลือกนักบัญชี → โชว์การ์ดให้เลือกก่อน (เหมือนหน้าเดิม)
  const frameProps = { active: "chat-accounting" as const, role: navRole, authed: true, staffOnly, title: "โต๊ะทำงานบัญชี", subtitle: "เลือกนักบัญชีเพื่อดูลูกค้าที่ดูแล" };
  if (access.mode === "admin" && accountantParam === "") {
    const accountants = await listAccountantsWithCounts(service, tenantId);
    return <ChatAuditFrame {...frameProps}><AccountantPicker accountants={accountants} /></ChatAuditFrame>;
  }
  if (access.mode === "lead" && accountantParam === "") {
    const cards = await listTeamAccountantCards(service, tenantId, access.employeeId!);
    return <ChatAuditFrame {...frameProps}><TeamPicker leadName={access.name} cards={cards} /></ChatAuditFrame>;
  }

  // สโคปลูกค้า: accountant→ตัวเอง · เลือกคน→ลูกค้าของคนนั้น · "all"→ทั้งหมด(admin)/ทีม(lead)
  let scopeIds: string[] | undefined;
  if (access.mode === "accountant") {
    scopeIds = [...(access.allowedCustomerIds ?? new Set<string>())];
  } else if (accountantParam === "all") {
    scopeIds = access.mode === "lead" && access.allowedCustomerIds ? [...access.allowedCustomerIds] : undefined; // admin all = ทุกลูกค้า
  } else if (UUID_RE.test(accountantParam)) {
    const ids = await customerIdsForAccountant(service, tenantId, accountantParam);
    scopeIds = access.mode === "lead" && access.allowedCustomerIds ? ids.filter((id) => access.allowedCustomerIds!.has(id)) : ids;
  }

  let selectedAccountantLabel = "";
  if (accountantParam === "all") selectedAccountantLabel = "ทั้งสำนักงาน";
  else if (UUID_RE.test(accountantParam)) selectedAccountantLabel = (await getEmployeeName(service, tenantId, accountantParam)) ?? "";

  let all: BillEntry[] = [];
  try {
    const res = await listEntries(service, tenantId, scopeIds === undefined ? {} : { customerIds: scopeIds });
    all = res.entries;
  } catch {
    return (
      <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="โต๊ะทำงานบัญชี" subtitle="ดีไซน์ใหม่">
        <div className="card">อ่านข้อมูลไม่สำเร็จ</div>
      </ChatAuditFrame>
    );
  }

  // เดือน: ค่าเริ่ม = เดือนล่าสุดที่มีบิล · month=all = ดูบิลทุกเดือนรวมกัน
  const months = [...new Set(all.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) => b.localeCompare(a));
  const wantAllMonths = sp.month === "all";
  const selectedMonth = wantAllMonths
    ? ""
    : isValidMonth(sp.month) && months.includes(sp.month) ? sp.month : months[0] ?? "";
  const inMonth = selectedMonth ? all.filter((e) => monthKeyOf(e) === selectedMonth) : all;

  const groups = groupEntriesByCustomer(inMonth);

  // ★ ลูกค้าในความดูแลที่ "ยังไม่มีบิลเดือนนี้" (เช่น ลูกค้าบิลกระดาษเพิ่งเปิด) — โชว์ในคิวด้วย
  //   ให้เปิดการ์ด/กดอัปโหลดไฟล์ได้ทันที ไม่ต้องรอบิลใบแรก · เฉพาะมุมมองที่มีสโคปชัด
  //   (นักบัญชี/หัวหน้า/admin ที่เลือกนักบัญชี) — มุมมอง "ทั้งสำนักงาน" ไม่เติม (ลูกค้าเยอะเกิน)
  if (scopeIds !== undefined && scopeIds.length > 0) {
    const have = new Set(groups.map((g) => g.customerId).filter((x): x is string => !!x));
    const missing = scopeIds.filter((id) => !have.has(id)).slice(0, 300);
    if (missing.length > 0) {
      try {
        const { data } = await service
          .from("customers")
          .select("id, name")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .in("id", missing);
        const zero = () => ({ count: 0, amount: 0, vat: 0, wht: 0, net: 0 });
        for (const c of (data ?? []) as { id: string; name: string | null }[]) {
          groups.push({
            customerId: c.id,
            name: c.name,
            count: 0,
            purchaseCount: 0,
            saleCount: 0,
            unspecifiedCount: 0,
            summary: { purchase: zero(), sale: zero(), unspecified: zero(), all: zero() },
            latestAt: "",
            entries: [],
          });
        }
      } catch {
        // best-effort — โหลดไม่ได้ก็แค่ไม่โชว์ลูกค้าที่ยังไม่มีบิล
      }
    }
  }

  const groupKey = (g: (typeof groups)[number]) => g.customerId ?? UNASSIGNED_CUSTOMER;
  const pendingOf = (g: (typeof groups)[number]) => g.entries.filter(isPending).length;

  // มุมมอง (ย้อนดูแต่ละขั้น flow ได้): received=ทุกใบ · drafted=ร่าง AI · review=ค้างตรวจ (ค่าเริ่ม)
  const view = sp.view === "received" ? "received" : sp.view === "drafted" ? "drafted" : "review";
  const tab = sp.tab === "tax" ? "tax" : sp.tab === "reconcile" ? "reconcile" : sp.tab === "close" ? "close" : "review"; // ตรวจ(default)·กระทบยอด·ภาษี·ปิดเดือน
  const matchView = (e: BillEntry) => (view === "received" ? true : view === "drafted" ? e.status === "draft" : isPending(e));

  // KPI + stepper counts
  const received = inMonth.length;
  const pending = inMonth.filter(isPending).length;
  const draftCount = inMonth.filter((e) => e.status === "draft").length;
  const confirmed = received - pending;
  const purchaseBase = inMonth.filter((e) => e.entryType === "purchase").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);
  const saleBase = inMonth.filter((e) => e.entryType === "sale").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);
  const whtTotal = inMonth.reduce((s, e) => s + summarizeEntry(e.lines).wht, 0);

  // เรียงกลุ่ม (ค้างตรวจก่อน) — ใช้เลือกลูกค้า default โดยไม่ต้องรอ codeMap
  const sortedGroups = [...groups].sort((a, b) => pendingOf(b) - pendingOf(a) || b.entries.length - a.entries.length);
  const openKey = sp.open && groups.some((g) => groupKey(g) === sp.open) ? sp.open : sortedGroups[0] ? groupKey(sortedGroups[0]) : "";
  const openGroup = groups.find((g) => groupKey(g) === openKey) ?? null;
  const reviewList = openGroup
    ? openGroup.entries.filter(matchView).sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0))
    : [];

  // ★ perf: ยิง query ที่ไม่ขึ้นต่อกัน พร้อมกัน (รหัสลูกค้า + sign รูป + ผังบัญชีสำหรับแผงแก้ด่วน)
  const [codeMap, signed, chart] = await Promise.all([
    fetchCodes(service, tenantId, [...new Set(groups.map((g) => g.customerId).filter((x): x is string => !!x))]),
    signPaths(service, reviewList.map(entryPath).filter((p): p is string => !!p)),
    listChartOfAccounts(service, tenantId),
  ]);

  // ---- จัดการลูกค้า + ประเภทลูกค้า + วงแชร์ (เฉพาะลูกค้าที่กางอยู่ = perf) ----
  const openCustomerId = openGroup?.customerId ?? null;
  let adminFields: CustomerAdminFields | null = null;
  let accountantOptions: AccountantOption[] = [];
  let currentAccountantId: string | null = null;
  const canReassignCustomer = access.mode === "admin";
  let shareIsFlag = false;
  let shareResolved = false;
  let shareCircleEntries: ShareCircleEntry[] | null = null;
  // ★ ตัดสิน "นิติบุคคล": customer_type='company' · หรือ (ยังไม่ตั้งค่า + ชื่อเข้าข่ายนิติบุคคล) เดาให้เลย
  //   → บริษัท/ห้างหุ้นส่วน/บจก/หจก/…จำกัด/Ltd/Partnership · ลูกค้าที่ตั้ง 'individual' ชัด = ไม่ใช่นิติบุคคล
  const nameLooksJuristic = /บริษัท|ห้างหุ้นส่วน|บจก|หจก|จำกัด|มหาชน|\bltd\b|\bco\.?,?\s*ltd|partnership|plc/i.test(openGroup?.name ?? "");
  let custIsCompany = false;
  if (openCustomerId) {
    adminFields = await loadCustomerFields(service, tenantId, openCustomerId);
    custIsCompany =
      adminFields.customerType === "company" ||
      (adminFields.customerType !== "individual" && nameLooksJuristic);
    if (access.mode === "admin") {
      const [opts, byCust] = await Promise.all([
        listAccountantEmployees(service, tenantId),
        mapCustomersToAccountant(service, tenantId, [openCustomerId]),
      ]);
      accountantOptions = opts;
      currentAccountantId = byCust.get(openCustomerId) ?? null;
    }
    // ★ วงแชร์ = บุคคลธรรมดาเท่านั้น (ตามกฎหมาย) → นิติบุคคลไม่ต้องดึง/ไม่โชว์
    if (!custIsCompany) {
      shareIsFlag = await getCustomerShareCircleFlag(service, tenantId, openCustomerId);
      try {
        const hasShare = await customerHasShareCircle(service, tenantId, openCustomerId);
        shareResolved = true;
        if (shareIsFlag || hasShare) {
          shareCircleEntries = await listShareCircleEntries(service, { tenantId, customerId: openCustomerId });
        }
      } catch {
        shareResolved = false; // ตาราง/คอลัมน์วงแชร์ยังไม่ apply → ไม่โชว์ (ไม่ crash)
      }
    }
  }
  const showShareToggle = access.mode === "admin" && shareResolved && !!openCustomerId;

  // คิว: ลูกค้าที่มีงานค้างตรวจก่อน (ใช้ sortedGroups + codeMap)
  const queue = sortedGroups.map((g) => ({
    key: groupKey(g),
    name: g.name,
    customerId: g.customerId,
    draft: g.entries.filter((e) => e.status === "draft").length,
    unspec: g.entries.filter((e) => e.entryType === "unspecified").length,
    conf: g.entries.filter((e) => e.status === "confirmed").length,
    total: g.entries.length,
    code: g.customerId ? codeMap.get(g.customerId) ?? null : null,
  }));

  const q = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (accountantParam) p.set("accountant", accountantParam);
    if (wantAllMonths) p.set("month", "all");
    else if (selectedMonth) p.set("month", selectedMonth);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  // ลิงก์ไปตัวแก้เดิม (หน้าเดิมที่พิสูจน์แล้ว) — เปิด overlay แก้/ยืนยัน
  const editHref = (e: BillEntry) => {
    const p = new URLSearchParams();
    if (accountantParam) p.set("accountant", accountantParam);
    if (selectedMonth) p.set("month", selectedMonth);
    if (e.customerId) p.set("open", e.customerId);
    p.set("type", e.entryType === "sale" ? "sale" : e.entryType === "unspecified" ? "unspecified" : "purchase");
    p.set("edit", e.id);
    return `/chat-audit/accounting?${p.toString()}`;
  };

  // ★ ขั้น flow กดย้อนดูได้ (รับเอกสาร / AI ร่างบัญชี / ตรวจ) — เปลี่ยน view · active ตาม view ที่เลือก
  const stepHref = (v: string) => `/chat-audit/accounting/workspace${q({ view: v, open: openKey })}`;
  // active ตาม tab ก่อน (กระทบยอด=3 / ภาษี=4) ไม่งั้นตาม view (รับเอกสาร=0 / ร่าง=1 / ตรวจ=2)
  // ★ 2026-09-02 ผู้ใช้: ตัดขั้น "กระทบยอดธนาคาร" — ซ้ำกับปุ่มหลัก "กระทบยอดบิลกับสเตทเมนต์"
  const curIdx = tab === "tax" ? 3 : tab === "close" ? 4 : view === "received" ? 0 : view === "drafted" ? 1 : 2;
  const STEPS: { t: string; c: number | null; href?: string; active?: boolean; done?: boolean }[] = [
    { t: "รับเอกสาร", c: received, href: stepHref("received") },
    { t: "AI ร่างบัญชี", c: draftCount, href: stepHref("drafted") },
    { t: "ตรวจ/ยืนยัน", c: pending, href: stepHref("review") },
    // ★ ขั้น flow เปิด "ในหน้าเดียว" (แท็บ) ไม่เด้งออก/ไม่ดาวน์โหลด
    { t: "ภาษี (ภพ.30)", c: null, href: `/chat-audit/accounting/workspace${q({ tab: "tax", open: openKey })}` },
    { t: "ปิดเดือน", c: null, href: `/chat-audit/accounting/workspace${q({ tab: "close", open: openKey })}` },
  ].map((s, i) => ({ ...s, active: i === curIdx, done: i < curIdx }));

  return (
    <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="โต๊ะทำงานบัญชี" subtitle="ดีไซน์ใหม่ · ตรวจเอกสารไหลลื่นในหน้าเดียว">
      {/* ลิงก์สลับกลับหน้าเดิม */}
      <div className="wsp-switch">
        {!staffOnly ? (
          <Link href="/chat-audit/accounting/workspace" className="wsp-switch-link">👤 เปลี่ยนนักบัญชี</Link>
        ) : null}
        {selectedAccountantLabel ? <span className="muted" style={{ fontSize: 13 }}>· {selectedAccountantLabel}</span> : null}
        {/* ★ อัปโหลดไฟล์บิลได้เสมอ (เลือกลูกค้าในกล่อง) — จำเป็นสำหรับลูกค้าบิลกระดาษ 100%
            ที่ยังไม่มีบิลในระบบ (ไม่โผล่ในคิวซ้าย → ไม่มีการ์ดให้กดอัปโหลด) เช่น สแกนบิลใบแรกของเดือน */}
        <UploadFileButton accountant={accountantParam || null} label="＋ อัปโหลดไฟล์เอง" />
        <span className="wsp-badge-new">โต๊ะทำงานบัญชี</span>
      </div>

      {/* FLOW STEPPER */}
      <div className="wsp-flow">
        {STEPS.map((s, i) => {
          const cls = `wsp-step${s.active ? " active" : ""}${s.done ? " done" : ""}${s.href ? " clickable" : ""}`;
          const inner = (
            <>
              <span className="n">{s.done ? "✓" : i + 1}</span>
              <span className="t">{s.t}</span>
              {s.c != null ? <span className="b">{s.c.toLocaleString("th-TH")}</span> : null}
            </>
          );
          return s.href ? (
            <Link key={i} href={s.href} className={cls} scroll={false}>{inner}</Link>
          ) : (
            <div key={i} className={cls}>{inner}</div>
          );
        })}
      </div>

      <div className="wsp-layout">
        {/* LEFT: month + KPI + queue */}
        <div className="wsp-rail">
          <div className="wsp-month">
            🗓️
            <div className="wsp-month-tabs">
              {months.slice(0, 6).map((m) => (
                <Link key={m} href={`/chat-audit/accounting/workspace${q({ month: m, open: undefined })}`} className={`wsp-mtab${m === selectedMonth ? " on" : ""}`}>
                  {thaiMonth(m)}
                </Link>
              ))}
              {/* ★ ดูบิลทุกเดือนรวมกัน (requirement 2026-09-01) — คิว/KPI/ตารางนับรวมทุกเดือน */}
              {months.length > 0 ? (
                <Link href={`/chat-audit/accounting/workspace${q({ month: "all", open: undefined })}`} className={`wsp-mtab${wantAllMonths ? " on" : ""}`}>
                  ทุกเดือน
                </Link>
              ) : null}
            </div>
          </div>
          <div className="wsp-kpis">
            <div><span className="k">ภาษีซื้อ</span><span className="v">฿{formatMoney(purchaseBase)}</span></div>
            <div><span className="k">ภาษีขาย</span><span className="v">฿{formatMoney(saleBase)}</span></div>
            <div><span className="k">ค้างตรวจ</span><span className="v warn">{pending.toLocaleString("th-TH")}</span></div>
            <div><span className="k">ยืนยันแล้ว</span><span className="v ok">{confirmed}/{received}</span></div>
          </div>
          <div className="wsp-qtitle">คิวงาน · ค้างตรวจก่อน <span>{queue.length} ราย</span></div>
          <div className="wsp-queue">
            {queue.length === 0 ? <p className="empty">ไม่มีบิลในเดือนนี้</p> : queue.map((qi) => (
              <Link key={qi.key} href={`/chat-audit/accounting/workspace${q({ open: qi.key })}`} className={`wsp-qrow${qi.key === openKey ? " on" : ""}`} scroll={false}>
                <span className="av">{qi.code ? qi.code.slice(0, 4) : (qi.name ?? "?").slice(0, 2)}</span>
                <span className="nm">
                  <b>{qi.code ? `${qi.code} · ` : ""}{qi.name ?? "ยังไม่จับคู่ลูกค้า"}</b>
                  <small>{qi.total} ใบ
                    {qi.draft > 0 ? <span className="pill draft">ร่าง {qi.draft}</span> : null}
                    {qi.unspec > 0 ? <span className="pill un">รอระบุ {qi.unspec}</span> : null}
                    {qi.conf > 0 ? <span className="pill ok">ยืนยัน {qi.conf}</span> : null}
                  </small>
                </span>
                {qi.draft + qi.unspec > 0 ? <span className="flag">ค้าง {qi.draft + qi.unspec}</span> : <span className="flag clear">✓</span>}
              </Link>
            ))}
          </div>
        </div>

        {/* CENTER: review list ของลูกค้าที่เปิด */}
        <div className="wsp-center">
          {/* ★ header การ์ดลูกค้า "ถาวร" — โชว์ทุกแท็บ (ตรวจ/กระทบยอด/ภาษี/ปิดเดือน) เพื่อให้เข้าเมนูได้เสมอ */}
          {openGroup && openGroup.customerId ? (
            <div className="wsp-center-head wsp-head-persist">
              <b>{openGroup.name ?? "ยังไม่จับคู่ลูกค้า"}</b>
              <RenameCustomerButton customerId={openGroup.customerId} currentName={openGroup.name ?? ""} />
              <UploadFileButton
                lockedCustomerId={openGroup.customerId}
                lockedCustomerLabel={openGroup.name ?? undefined}
                accountant={accountantParam || null}
                label="เพิ่มไฟล์บิลเอง"
              />
              {/* ★ ปุ่มหลักกระทบยอด (requirement 2026-09-02) — ย้ายทางเข้าสเตทเมนต์จากกล่องอัปโหลดมาไว้ที่นี่ */}
              <StatementReconcileButton customerId={openGroup.customerId} accountant={accountantParam || null} />
              <CustomerToolsMenu
                customerId={openGroup.customerId}
                month={selectedMonth}
                accountant={accountantParam || null}
                customerType={custIsCompany ? "company" : adminFields?.customerType ?? null}
              />
              <details className="cust-tools" name="cust-menu">
                <summary className="btn">⚙️ จัดการลูกค้า</summary>
                <div className="cust-tools-pop" style={{ width: "min(90vw, 380px)" }}>
                  {showShareToggle ? (
                    <div className="acc-scopebar" style={{ marginBottom: 8 }}>
                      <span className="acc-scope-label">วงแชร์</span>
                      <ShareCircleToggle customerId={openGroup.customerId} initialOn={shareIsFlag} />
                    </div>
                  ) : null}
                  <CustomerAdminControls
                    customerId={openGroup.customerId}
                    canReassign={canReassignCustomer}
                    currentAccountantId={currentAccountantId}
                    accountants={accountantOptions}
                    initialName={openGroup.name ?? null}
                    initialCode={adminFields?.code ?? (codeMap.get(openGroup.customerId) ?? null)}
                    initialTaxId={adminFields?.taxId ?? null}
                    initialCustomerType={adminFields?.customerType ?? null}
                    initialAddress={adminFields?.address ?? null}
                    initialPhone={adminFields?.phone ?? null}
                  />
                </div>
              </details>
            </div>
          ) : null}
          <div className="wsp-tabs">
            <Link className={`wsp-tab${tab === "review" ? " on" : ""}`} href={`/chat-audit/accounting/workspace${q({ open: openKey })}`} scroll={false}>
              {view === "received" ? "📥 เอกสารทั้งหมด" : view === "drafted" ? "🤖 ร่าง AI" : "📝 ตรวจเอกสาร"} {tab === "review" && openGroup ? `· ${reviewList.length} ใบ` : ""}
            </Link>
            <Link className={`wsp-tab${tab === "tax" ? " on" : ""}`} href={`/chat-audit/accounting/workspace${q({ tab: "tax", open: openKey })}`} scroll={false}>🧾 ภาษี ภพ.30</Link>
            <Link className={`wsp-tab${tab === "close" ? " on" : ""}`} href={`/chat-audit/accounting/workspace${q({ tab: "close", open: openKey })}`} scroll={false}>📑 ปิดเดือน</Link>
          </div>

          {tab === "close" ? (
            <CloseMonthView received={received} pending={pending} confirmed={confirmed} purchaseBase={purchaseBase} saleBase={saleBase} whtTotal={whtTotal} month={selectedMonth} />
          ) : tab === "tax" ? (
            <TaxView entries={inMonth} month={selectedMonth} accParam={accountantParam} />
          ) : !openGroup ? (
            <p className="empty" style={{ padding: 40 }}>เลือกลูกค้าจากคิวด้านซ้ายเพื่อเริ่มตรวจ — ลูกค้าใหม่/บิลกระดาษที่ยังไม่มีบิลในระบบ ใช้ปุ่ม “อัปโหลดไฟล์เอง” ด้านบนได้เลย</p>
          ) : (
            <>
              <div className="wsp-center-head">
                <span className="muted">{reviewList.length} ใบ · ค้างตรวจ {reviewList.filter(isPending).length}</span>
                {(() => {
                  // ★ "เขียว/พร้อมยืนยัน" = draft + ระบุซื้อ/ขาย + มียอด + ไม่ใช่ AI เดา + ไม่มี anomaly ระดับ error
                  const green = reviewList.filter((e) => {
                    if (e.status === "confirmed") return false;
                    if (e.entryType !== "purchase" && e.entryType !== "sale") return false;
                    if (e.sideGuessed) return false;
                    if ((e.anomalies ?? []).some((a) => a.severity === "error")) return false;
                    const s = summarizeEntry(e.lines);
                    return s.amount > 0 || s.vat > 0;
                  }).length;
                  return openGroup.customerId ? (
                    <BatchConfirmButton customerId={openGroup.customerId} count={green} />
                  ) : null;
                })()}
              </div>
              {/* ★ วงแชร์ (ท้าวแชร์) — โชว์เมื่อลูกค้าเป็นท้าวแชร์/มีวง ≥1 · ภธ.40+ภงด.90 */}
              {openGroup.customerId && shareCircleEntries ? (
                <details className="wsp-sharecircle">
                  <summary className="btn">🔗 วงแชร์ ({shareCircleEntries.length.toLocaleString("th-TH")})</summary>
                  <ShareCirclePanel
                    customerId={openGroup.customerId}
                    entries={shareCircleEntries}
                    exportHref={`/chat-audit/accounting/share-circle-export?customerId=${openGroup.customerId}`}
                  />
                </details>
              ) : null}
              <div className="wsp-reviews">
                {reviewList.length === 0 ? (
                  <p className="empty" style={{ padding: 24 }}>
                    {view === "drafted" ? "ไม่มีร่าง AI ในมุมมองนี้" : view === "received" ? "ยังไม่มีเอกสาร" : "ตรวจครบแล้ว 🎉 ไม่มีรายการค้างตรวจ"}
                  </p>
                ) : null}
                {reviewList.map((e) => {
                  const s = summarizeEntry(e.lines);
                  const anomalies = e.anomalies ?? [];
                  const errAnoms = anomalies.filter((a) => a.severity === "error");
                  const warnAnoms = anomalies.filter((a) => a.severity === "warn");
                  const path = entryPath(e);
                  const url = path ? signed.get(path) ?? null : null;
                  const img = entryIsImage(e) || entryIsPdf(e); // PDF = รูปหน้าแรกผ่าน bill-thumb
                  const pend = isPending(e);
                  // ★ 2026-09-02 ผู้ใช้ ("กดรูปใหญ่ช้า"): รูปใหญ่ใช้ bill-thumb w=1300 เสมอ
                  //   (เล็กกว่าไฟล์สแกนเต็ม ~10 เท่า + browser cache) — ครอบ OneDrive ที่เซ็น URL ไม่ได้ด้วย
                  const lightboxSrc = `/api/accounting/bill-thumb?entry=${e.id}&w=1300&v=2`;
                  return (
                    <div key={e.id} className={`wsp-card${pend ? " pend" : " done"}`}>
                      <div className="wsp-thumb">
                        {img && path ? (
                          <a href={`#zoom-${e.id}`} className="wsp-thumb-zoom" aria-label="ขยายดูบิล">
                            {/* ★ perf 2026-09-01: รูปย่อผ่าน bill-thumb (~10-30KB + browser cache)
                                แทน signed URL สแกนเต็ม (~0.3-1MB/ใบ) — เลื่อนรายการลื่นขึ้นมาก
                                รูปเต็มโหลดเฉพาะตอนกดขยาย (lightbox ด้านล่างใช้ signed URL เดิม) */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/accounting/bill-thumb?entry=${e.id}&w=360&v=2`} alt="บิล" loading="lazy" decoding="async" />
                            <span className="wsp-zoom-ic">🔍 ขยาย</span>
                          </a>
                        ) : path && url ? (
                          <a href={url} target="_blank" rel="noopener" className="wsp-thumb-file" title="เปิดดูไฟล์ในเบราว์เซอร์">
                            <span className="ext">{extLabel(path)}</span>
                            <span className="wsp-zoom-ic">🔍 ดู</span>
                          </a>
                        ) : path ? <span className="ext">{extLabel(path)}</span> : <span className="ext none">ไม่มีรูป</span>}
                      </div>
                      {/* แว่นขยาย: คลิกรูปเล็ก → เปิดรูปใหญ่เต็มจอ (CSS :target · คลิกพื้นหลัง/รูปเพื่อปิด)
                          ★ 2026-09-02 ผู้ใช้: กดปิดแล้วห้ามเด้งขึ้นบนสุด — href="#" ทำ browser scroll top
                          → ใช้ hash ที่ไม่มี element (#ปิด): :target หลุด = รูปปิด แต่ตำแหน่งจอคงเดิม */}
                      {img && path ? (
                        <a id={`zoom-${e.id}`} href="#ปิด" className="wsp-lightbox" aria-label="ปิดรูปขยาย">
                          {/* ★ 2026-09-02 ผู้ใช้เลือกโหมดประหยัด: โหลดตอนกดเหมือนเดิม (lazy) —
                              แต่ใช้รูปย่อ 1300px (~100KB) แทนสแกนเต็ม (เป็น MB) = กดแล้วเร็วขึ้นมากอยู่ดี */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={lightboxSrc} alt="บิล (ขยาย)" loading="lazy" decoding="async" />
                          <span className="wsp-lightbox-close">✕ ปิด</span>
                        </a>
                      ) : null}
                      <div className="wsp-fields">
                        <div className="wsp-row1">
                          <span className={`type ${e.entryType}`}>{e.entryType === "purchase" ? "ภาษีซื้อ" : e.entryType === "sale" ? "ภาษีขาย" : "รอระบุ"}</span>
                          {e.sideGuessed ? <span className="type-guess" title="AI เดาฝั่งซื้อ/ขาย — โปรดตรวจก่อนยืนยัน">🤖 เดา</span> : null}
                          {errAnoms.length > 0 ? <span className="anom-err" title={errAnoms.map((a) => a.message).join("\n")}>⚠️ ตรวจยอด</span> : null}
                          {errAnoms.length === 0 && warnAnoms.length > 0 ? <span className="anom-warn" title={warnAnoms.map((a) => a.message).join("\n")}>📄 เอกสารขาด</span> : null}
                          <span className="party">{e.counterpartyName || e.sellerName || e.buyerName || "—"}</span>
                          <span className={`st ${pend ? "draft" : "ok"}`}>{pend ? "ร่าง — รอตรวจ" : "ยืนยันแล้ว"}</span>
                        </div>
                        <div className="wsp-row2">
                          <span>เลขที่ <b>{e.docNo || "—"}</b></span>
                          <span>วันที่ <b>{formatDate(e.docDate)}</b></span>
                          <span>มูลค่า <b>฿{formatMoney(s.amount)}</b></span>
                          <span>VAT <b>฿{formatMoney(s.vat)}</b></span>
                          <span>รวมจ่าย <b className="net">฿{formatMoney(s.net)}</b></span>
                        </div>
                        {/* ★ 2026-09-02 ผู้ใช้: แก้ด่วนบนการ์ด — คู่ค้า / ⇄ สลับเดบิต-เครดิต / บัญชี (เฉพาะร่าง) */}
                        {pend && e.customerId ? (
                          <QuickFixBill
                            customerId={e.customerId}
                            entryId={e.id}
                            entryType={e.entryType}
                            counterpartyName={e.counterpartyName}
                            accountCode={e.lines[0]?.accountCode ?? null}
                            accountName={e.lines[0]?.accountName ?? null}
                            lineAmount={e.lines[0]?.amount ?? null}
                            netAmount={s.net}
                            paymentMethod={e.paymentMethod}
                            paymentBankAccountCode={e.paymentBankAccountCode}
                            chart={chart}
                          />
                        ) : null}
                      </div>
                      <div className="wsp-act">
                        <Link href={editHref(e)} className="wsp-btn primary">ตรวจ / ยืนยัน →</Link>
                        <a href={`/chat-audit/accounting/receipt-cert?bill=${e.id}${e.customerId ? `&customer=${e.customerId}` : ""}`} target="_blank" rel="noopener" className="wsp-btn ghost">ใบรับรองฯ</a>
                        {isPending(e) ? <DeleteBillButton entryId={e.id} /> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
