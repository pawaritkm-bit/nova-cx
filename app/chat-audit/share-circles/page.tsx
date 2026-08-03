import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import {
  listShareCircles,
  getShareCircle,
  type ShareCircle,
  type ShareCircleHand,
} from "@/lib/share-circles/queries";
import ShareCircleCreator, { DeleteCircleButton } from "./ShareCircleCreator";
import ChatAuditFrame from "../_Frame";
import "../chat-admin.css";
import "../accounting/accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ไม่ระบุลูกค้า";
}

/** จำนวนเงินแบบไทย (null → "—") */
function money(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** วันที่แบบไทยสั้น (YYYY-MM-DD → 1 เม.ย. 2569) */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * ดึงรายชื่อลูกค้าทั้งหมดของ tenant (id + label) — dropdown เลือกท้าวแชร์
 *   ★ ถ้าเป็นนักบัญชี (allowedCustomerIds != null) จำกัดเฉพาะลูกค้าที่ดูแล
 */
async function fetchCustomerSelectOptions(
  service: SupabaseClient,
  tenantId: string,
  allowed: Set<string> | null
): Promise<{ id: string; label: string }[]> {
  try {
    let q = service
      .from("customers")
      .select("id, customer_code, name")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("customer_code", { ascending: true, nullsFirst: false })
      .limit(5000);
    if (allowed !== null) {
      const ids = [...allowed];
      if (ids.length === 0) return [];
      q = q.in("id", ids);
    }
    const { data } = await q;
    const rows = (data ?? []) as { id: string; customer_code: string | null; name: string | null }[];
    return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
  } catch {
    return [];
  }
}

/** ตารางมือของวงที่เปิดดู */
function HandsTable({ hands }: { hands: ShareCircleHand[] }) {
  if (hands.length === 0) {
    return <p className="empty">ยังไม่มีมือในวงนี้</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dlv-table">
        <thead>
          <tr>
            <th style={{ width: 60 }}>มือ</th>
            <th>ชื่อสมาชิก</th>
            <th className="num">ยอดส่ง</th>
            <th className="num">ดอก</th>
            <th className="center">ท้าว</th>
          </tr>
        </thead>
        <tbody>
          {hands.map((h) => (
            <tr key={h.id}>
              <td>{h.handNo ?? "—"}</td>
              <td>{h.memberName || "—"}</td>
              <td className="num">{money(h.sendAmount)}</td>
              <td className="num">{money(h.bidAmount)}</td>
              <td className="center">{h.isOrganizer ? "✅ ท้าว" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** การ์ดวง 1 วง (หัว + ปุ่มดู hands + ลบ) */
function CircleCard({
  circle,
  isOpen,
  toggleHref,
  hands,
}: {
  circle: ShareCircle;
  isOpen: boolean;
  toggleHref: string;
  hands: ShareCircleHand[] | null;
}) {
  return (
    <div className={`cust-card${isOpen ? " open" : ""}`}>
      <div className="cust-head" style={{ cursor: "default" }}>
        <span className="cust-id">
          <span className="cust-name">{circle.name}</span>
          <span className="csub">
            {circle.principal !== null ? `ต้น ${money(circle.principal)} · ` : ""}
            {circle.handCount.toLocaleString("th-TH")} มือ
            {circle.numHands !== null ? ` / ${circle.numHands} มือ` : ""}
            {circle.feePerHand !== null ? ` · ดูแล ${money(circle.feePerHand)}/มือ` : ""}
            {circle.periodNote ? ` · ${circle.periodNote}` : ""}
            {circle.startDate ? ` · เริ่ม ${formatDate(circle.startDate)}` : ""}
          </span>
        </span>
        <Link href={toggleHref} className="btn btn-ghost" scroll={false} aria-expanded={isOpen}>
          {isOpen ? "ปิด" : "ดูมือ"}
        </Link>
        <DeleteCircleButton circleId={circle.id} />
      </div>
      {isOpen && hands ? (
        <div className="cust-body">
          <HandsTable hands={hands} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * /chat-audit/share-circles — "วงแชร์" (ท้าวแชร์วางลิสต์จากไลน์ AI แยกเป็นตาราง)
 *   สิทธิ์เดียวกับหน้าลงบันทึกบัญชี (admin/executive/lead/accountant — scope บังคับ server-side)
 *   ★ เลือกลูกค้า (ท้าว) → เพิ่มวง (AI แยก) → รายการวง → กดดูมือ
 */
export default async function ShareCirclesPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; open?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-share-circles" role={null} authed={false} title="วงแชร์" subtitle="ท้าวแชร์">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/share-circles");

  const tenantId = access.tenantId;
  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  // ลูกค้าที่เลือก (validate uuid + สโคป) — ค่าที่ไม่อยู่ในสโคป = ไม่ผูก
  const rawCustomer = (sp.customer ?? "").trim();
  const selectedCustomerId =
    UUID_RE.test(rawCustomer) &&
    (access.allowedCustomerIds === null || access.allowedCustomerIds.has(rawCustomer))
      ? rawCustomer
      : "";

  const customerOptions = await fetchCustomerSelectOptions(
    service,
    tenantId,
    access.allowedCustomerIds
  );
  const selectedLabel =
    selectedCustomerId
      ? customerOptions.find((c) => c.id === selectedCustomerId)?.label ?? null
      : null;

  // รายการวง (ของลูกค้าที่เลือก หรือทั้งหมดในสโคป) — จับ query error = ยังไม่ apply migration
  let circles: ShareCircle[];
  try {
    circles = await listShareCircles(service, tenantId, selectedCustomerId || undefined);
    // นักบัญชี: กรองเฉพาะวงของลูกค้าในสโคป (เผื่อไม่ได้เลือกลูกค้าเจาะจง)
    if (access.allowedCustomerIds !== null) {
      const allowed = access.allowedCustomerIds;
      circles = circles.filter((c) => allowed.has(c.customerId));
    }
  } catch {
    return (
      <ChatAuditFrame active="chat-share-circles" role={navRole} authed staffOnly={staffOnly} title="วงแชร์" subtitle="ท้าวแชร์">
        <div className="card">
          อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า <b>SUPABASE_SERVICE_ROLE_KEY</b> และ apply migration{" "}
          <b>0057_share_circles.sql</b> ครบแล้ว
        </div>
      </ChatAuditFrame>
    );
  }

  // วงที่กางดูมือ (validate ว่าอยู่ในรายการจริง)
  const openId = sp.open && circles.some((c) => c.id === sp.open) ? sp.open : "";
  let openHands: ShareCircleHand[] | null = null;
  if (openId) {
    const detail = await getShareCircle(service, tenantId, openId);
    openHands = detail?.hands ?? [];
  }

  const buildHref = (params: { customer?: string; open?: string }): string => {
    const q = new URLSearchParams();
    if (params.customer) q.set("customer", params.customer);
    if (params.open) q.set("open", params.open);
    const s = q.toString();
    return s ? `/chat-audit/share-circles?${s}` : "/chat-audit/share-circles";
  };

  return (
    <ChatAuditFrame
      active="chat-share-circles"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="วงแชร์"
      subtitle="ท้าวแชร์ — วางลิสต์จากไลน์ AI แยกให้"
    >
      <div className="dash-views">
        {/* ---- toolbar: เลือกลูกค้า + เพิ่มวง ---- */}
        <div className="card">
          <form method="get" className="inline-form" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label htmlFor="f-customer" style={{ fontWeight: 600, fontSize: 14 }}>
              ลูกค้า (ท้าว):
            </label>
            <select id="f-customer" name="customer" defaultValue={selectedCustomerId}>
              <option value="">— ทุกลูกค้า —</option>
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn">
              ดู
            </button>
            <span className="acc-toolbar-spacer" />
            {selectedCustomerId ? (
              <ShareCircleCreator
                lockedCustomerId={selectedCustomerId}
                lockedCustomerLabel={selectedLabel ?? undefined}
              />
            ) : (
              <ShareCircleCreator customers={customerOptions} />
            )}
          </form>
        </div>

        {/* ---- รายการวง ---- */}
        <div className="card">
          <div className="section-title">
            <span>{selectedLabel ? `วงของ ${selectedLabel}` : "วงแชร์ทั้งหมด"}</span>
            <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
              {circles.length.toLocaleString("th-TH")} วง
            </span>
          </div>

          {circles.length === 0 ? (
            <p className="empty">
              ยังไม่มีวงแชร์
              {selectedLabel ? " ของลูกค้ารายนี้" : ""} — กด “+ เพิ่มวงแชร์” เพื่อให้ AI แยกลิสต์จากไลน์
            </p>
          ) : (
            <div className="cust-list">
              {circles.map((c) => {
                const isOpen = openId === c.id;
                const toggleHref = buildHref({
                  customer: selectedCustomerId || undefined,
                  open: isOpen ? undefined : c.id,
                });
                return (
                  <CircleCard
                    key={c.id}
                    circle={c}
                    isOpen={isOpen}
                    toggleHref={toggleHref}
                    hands={isOpen ? openHands : null}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
