import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import { customerIdsForAccountant } from "@/lib/accounting/accountant-scope";
import { listEntries, summarizeEntry, type BillEntry } from "@/lib/accounting/queries";
import { groupEntriesByCustomer, UNASSIGNED_CUSTOMER } from "@/lib/accounting/group";
import { monthKeyOf } from "@/lib/accounting/monthly";
import { formatMoney } from "@/lib/accounting/calc";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../accounting.css";
import "./workspace.css";

export const dynamic = "force-dynamic";

const BILLS_BUCKET = "bills";
const SIGNED_URL_TTL_SEC = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_EXT_RE = /\.(pdf|xlsx?|docx?|pptx?|csv|txt|zip)$/i;

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
  return e.attachmentObjectPath ?? e.uploadPath;
}
function entryIsImage(e: BillEntry): boolean {
  if (e.attachmentObjectPath) return !DOC_EXT_RE.test(e.attachmentObjectPath);
  return (e.uploadMime ?? "").startsWith("image/");
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

const isPending = (e: BillEntry) => e.status !== "confirmed";

/**
 * /chat-audit/accounting/workspace — "โต๊ะทำงานนักบัญชี" (ดีไซน์ใหม่ · เพิ่มเข้ามาไม่แตะหน้าเดิม)
 *   flow เดียวจบ: คิวลูกค้าซ้าย → ตรวจเอกสารทีละใบตรงกลาง → เปิดตัวแก้เดิม (EntryEditor) ที่หน้าเดิม
 *   ★ อ่านข้อมูลจริงจาก listEntries เดิม · ยืนยัน/แก้ = ใช้ตัวแก้ที่พิสูจน์แล้วของหน้าเดิม (ปลอดภัย)
 */
export default async function AccountingWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ accountant?: string; month?: string; open?: string }>;
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

  // สโคปลูกค้า (เหมือนหน้าเดิม แบบย่อ): accountant→ตัวเอง · admin/lead→ตามที่เลือก/ทั้งหมดในสิทธิ์
  let scopeIds: string[] | undefined;
  if (access.mode === "accountant") {
    scopeIds = [...(access.allowedCustomerIds ?? new Set<string>())];
  } else if (UUID_RE.test(accountantParam)) {
    const ids = await customerIdsForAccountant(service, tenantId, accountantParam);
    scopeIds = access.mode === "lead" && access.allowedCustomerIds ? ids.filter((id) => access.allowedCustomerIds!.has(id)) : ids;
  } else if (access.mode === "lead") {
    scopeIds = access.allowedCustomerIds ? [...access.allowedCustomerIds] : [];
  } // admin ไม่เลือก → undefined = ทุกลูกค้า

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

  // เดือน: ค่าเริ่ม = เดือนล่าสุดที่มีบิล
  const months = [...new Set(all.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) => b.localeCompare(a));
  const selectedMonth = isValidMonth(sp.month) && months.includes(sp.month) ? sp.month : months[0] ?? "";
  const inMonth = selectedMonth ? all.filter((e) => monthKeyOf(e) === selectedMonth) : all;

  const groups = groupEntriesByCustomer(inMonth);
  const codeMap = await fetchCodes(service, tenantId, [...new Set(inMonth.map((e) => e.customerId).filter((x): x is string => !!x))]);

  // KPI + stepper counts
  const received = inMonth.length;
  const pending = inMonth.filter(isPending).length;
  const confirmed = received - pending;
  const purchaseBase = inMonth.filter((e) => e.entryType === "purchase").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);
  const saleBase = inMonth.filter((e) => e.entryType === "sale").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);

  // คิว: ลูกค้าที่มีงานค้างตรวจก่อน
  const queue = groups
    .map((g) => {
      const draft = g.entries.filter((e) => e.status === "draft").length;
      const unspec = g.entries.filter((e) => e.entryType === "unspecified").length;
      const conf = g.entries.filter((e) => e.status === "confirmed").length;
      const key = g.customerId ?? UNASSIGNED_CUSTOMER;
      return { key, name: g.name, customerId: g.customerId, draft, unspec, conf, total: g.entries.length, code: g.customerId ? codeMap.get(g.customerId) ?? null : null };
    })
    .sort((a, b) => b.draft + b.unspec - (a.draft + a.unspec) || b.total - a.total);

  const openKey = sp.open && queue.some((q) => q.key === sp.open) ? sp.open : queue[0]?.key ?? "";
  const openGroup = groups.find((g) => (g.customerId ?? UNASSIGNED_CUSTOMER) === openKey) ?? null;
  const reviewList = openGroup ? [...openGroup.entries].sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0)) : [];

  // sign thumbnails เฉพาะลูกค้าที่เปิด
  const signed = await signPaths(service, reviewList.map(entryPath).filter((p): p is string => !!p));

  const q = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (accountantParam) p.set("accountant", accountantParam);
    if (selectedMonth) p.set("month", selectedMonth);
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

  const STEPS = [
    { t: "รับเอกสาร", c: received, done: true },
    { t: "AI ร่างบัญชี", c: received, done: true },
    { t: "ตรวจ/ยืนยัน", c: pending, active: true },
    { t: "กระทบยอดธนาคาร", c: null },
    { t: "ภาษี (ภพ.30)", c: null },
    { t: "ปิดเดือน", c: null },
  ];

  return (
    <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="โต๊ะทำงานบัญชี" subtitle="ดีไซน์ใหม่ · ตรวจเอกสารไหลลื่นในหน้าเดียว">
      {/* ลิงก์สลับกลับหน้าเดิม */}
      <div className="wsp-switch">
        <Link href={`/chat-audit/accounting${q({})}`} className="wsp-switch-link">↩ กลับหน้าลงบันทึกบัญชี (แบบเดิม)</Link>
        <span className="wsp-badge-new">ดีไซน์ใหม่ (เบต้า)</span>
      </div>

      {/* FLOW STEPPER */}
      <div className="wsp-flow">
        {STEPS.map((s, i) => (
          <div key={i} className={`wsp-step${s.active ? " active" : ""}${s.done ? " done" : ""}`}>
            <span className="n">{s.done ? "✓" : i + 1}</span>
            <span className="t">{s.t}</span>
            {s.c != null ? <span className="b">{s.c.toLocaleString("th-TH")}</span> : null}
          </div>
        ))}
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
          <div className="wsp-tabs">
            <span className="wsp-tab on">📝 ตรวจเอกสาร {openGroup ? `· ${reviewList.filter(isPending).length} ค้าง` : ""}</span>
            <a className="wsp-tab" href={`/chat-audit/accounting/export?month=${selectedMonth}&type=purchase${accountantParam ? `&accountant=${accountantParam}` : ""}`}>🧾 ภพ.30 ซื้อ</a>
            <a className="wsp-tab" href={`/chat-audit/accounting/export?month=${selectedMonth}&type=sale${accountantParam ? `&accountant=${accountantParam}` : ""}`}>🧾 ภพ.30 ขาย</a>
          </div>

          {!openGroup ? (
            <p className="empty" style={{ padding: 40 }}>เลือกลูกค้าจากคิวด้านซ้ายเพื่อเริ่มตรวจ</p>
          ) : (
            <>
              <div className="wsp-center-head">
                <b>{openGroup.name ?? "ยังไม่จับคู่ลูกค้า"}</b>
                <span className="muted">{reviewList.length} ใบ · ค้างตรวจ {reviewList.filter(isPending).length}</span>
              </div>
              <div className="wsp-reviews">
                {reviewList.map((e) => {
                  const s = summarizeEntry(e.lines);
                  const path = entryPath(e);
                  const url = path ? signed.get(path) ?? null : null;
                  const img = entryIsImage(e);
                  const pend = isPending(e);
                  return (
                    <div key={e.id} className={`wsp-card${pend ? " pend" : " done"}`}>
                      <div className="wsp-thumb">
                        {url && img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={url} alt="บิล" loading="lazy" decoding="async" />
                        ) : path ? <span className="ext">{(path.split(".").pop() ?? "ไฟล์").toUpperCase()}</span> : <span className="ext none">ไม่มีรูป</span>}
                      </div>
                      <div className="wsp-fields">
                        <div className="wsp-row1">
                          <span className={`type ${e.entryType}`}>{e.entryType === "purchase" ? "ภาษีซื้อ" : e.entryType === "sale" ? "ภาษีขาย" : "รอระบุ"}</span>
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
                      </div>
                      <div className="wsp-act">
                        <Link href={editHref(e)} className="wsp-btn primary">ตรวจ / ยืนยัน →</Link>
                        <a href={`/chat-audit/accounting/receipt-cert?bill=${e.id}${e.customerId ? `&customer=${e.customerId}` : ""}`} target="_blank" rel="noopener" className="wsp-btn ghost">ใบรับรองฯ</a>
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
