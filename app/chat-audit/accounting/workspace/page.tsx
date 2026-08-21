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
  searchParams: Promise<{ accountant?: string; month?: string; open?: string; view?: string }>;
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

  // เดือน: ค่าเริ่ม = เดือนล่าสุดที่มีบิล
  const months = [...new Set(all.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) => b.localeCompare(a));
  const selectedMonth = isValidMonth(sp.month) && months.includes(sp.month) ? sp.month : months[0] ?? "";
  const inMonth = selectedMonth ? all.filter((e) => monthKeyOf(e) === selectedMonth) : all;

  const groups = groupEntriesByCustomer(inMonth);
  const groupKey = (g: (typeof groups)[number]) => g.customerId ?? UNASSIGNED_CUSTOMER;
  const pendingOf = (g: (typeof groups)[number]) => g.entries.filter(isPending).length;

  // มุมมอง (ย้อนดูแต่ละขั้น flow ได้): received=ทุกใบ · drafted=ร่าง AI · review=ค้างตรวจ (ค่าเริ่ม)
  const view = sp.view === "received" ? "received" : sp.view === "drafted" ? "drafted" : "review";
  const matchView = (e: BillEntry) => (view === "received" ? true : view === "drafted" ? e.status === "draft" : isPending(e));

  // KPI + stepper counts
  const received = inMonth.length;
  const pending = inMonth.filter(isPending).length;
  const draftCount = inMonth.filter((e) => e.status === "draft").length;
  const confirmed = received - pending;
  const purchaseBase = inMonth.filter((e) => e.entryType === "purchase").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);
  const saleBase = inMonth.filter((e) => e.entryType === "sale").reduce((s, e) => s + summarizeEntry(e.lines).amount, 0);

  // เรียงกลุ่ม (ค้างตรวจก่อน) — ใช้เลือกลูกค้า default โดยไม่ต้องรอ codeMap
  const sortedGroups = [...groups].sort((a, b) => pendingOf(b) - pendingOf(a) || b.entries.length - a.entries.length);
  const openKey = sp.open && groups.some((g) => groupKey(g) === sp.open) ? sp.open : sortedGroups[0] ? groupKey(sortedGroups[0]) : "";
  const openGroup = groups.find((g) => groupKey(g) === openKey) ?? null;
  const reviewList = openGroup
    ? openGroup.entries.filter(matchView).sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0))
    : [];

  // ★ perf: ยิง 2 query ที่ไม่ขึ้นต่อกัน พร้อมกัน (รหัสลูกค้า + sign รูปเฉพาะลูกค้าที่เปิด)
  const [codeMap, signed] = await Promise.all([
    fetchCodes(service, tenantId, [...new Set(inMonth.map((e) => e.customerId).filter((x): x is string => !!x))]),
    signPaths(service, reviewList.map(entryPath).filter((p): p is string => !!p)),
  ]);

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

  // ★ ขั้น flow กดย้อนดูได้ (รับเอกสาร / AI ร่างบัญชี / ตรวจ) — เปลี่ยน view · active ตาม view ที่เลือก
  const stepHref = (v: string) => `/chat-audit/accounting/workspace${q({ view: v, open: openKey })}`;
  const activeIdx = view === "received" ? 0 : view === "drafted" ? 1 : 2;
  const STEPS: { t: string; c: number | null; href?: string; active?: boolean; done?: boolean }[] = [
    { t: "รับเอกสาร", c: received, href: stepHref("received"), active: view === "received", done: activeIdx > 0 },
    { t: "AI ร่างบัญชี", c: draftCount, href: stepHref("drafted"), active: view === "drafted", done: activeIdx > 1 },
    { t: "ตรวจ/ยืนยัน", c: pending, href: stepHref("review"), active: view === "review" },
    { t: "กระทบยอดธนาคาร", c: null, href: "/chat-audit/accounting/bank-reconciliation" },
    { t: "ภาษี (ภพ.30)", c: null, href: `/chat-audit/accounting/export?month=${selectedMonth}&type=purchase${accountantParam ? `&accountant=${accountantParam}` : ""}` },
    { t: "ปิดเดือน", c: null },
  ];

  return (
    <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="โต๊ะทำงานบัญชี" subtitle="ดีไซน์ใหม่ · ตรวจเอกสารไหลลื่นในหน้าเดียว">
      {/* ลิงก์สลับกลับหน้าเดิม */}
      <div className="wsp-switch">
        {!staffOnly ? (
          <Link href="/chat-audit/accounting/workspace" className="wsp-switch-link">👤 เปลี่ยนนักบัญชี</Link>
        ) : null}
        <Link href={`/chat-audit/accounting${q({})}`} className="wsp-switch-link">↩ หน้าแบบเดิม</Link>
        {selectedAccountantLabel ? <span className="muted" style={{ fontSize: 13 }}>· {selectedAccountantLabel}</span> : null}
        <span className="wsp-badge-new">ดีไซน์ใหม่</span>
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
            <span className="wsp-tab on">{view === "received" ? "📥 เอกสารทั้งหมด" : view === "drafted" ? "🤖 ร่าง AI" : "📝 ตรวจเอกสาร"} {openGroup ? `· ${reviewList.length} ใบ` : ""}</span>
            <a className="wsp-tab" href="/chat-audit/accounting/bank-reconciliation">🏦 กระทบยอดธนาคาร</a>
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
                {reviewList.length === 0 ? (
                  <p className="empty" style={{ padding: 24 }}>
                    {view === "drafted" ? "ไม่มีร่าง AI ในมุมมองนี้" : view === "received" ? "ยังไม่มีเอกสาร" : "ตรวจครบแล้ว 🎉 ไม่มีรายการค้างตรวจ"}
                  </p>
                ) : null}
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
