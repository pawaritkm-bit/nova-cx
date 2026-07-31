import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import { customerIdsForAccountant, getEmployeeName } from "@/lib/accounting/accountant-scope";
import { listEntries, type EntryType, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildReview, type ReviewRow, type ReviewTypeTotal } from "@/lib/accounting/review";
import { formatMoney } from "@/lib/accounting/calc";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** วันที่แบบไทยสั้น (YYYY-MM-DD → 1 ก.ค. 2569) */
function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/** ป้าย ภ.ง.ด. */
function whtFormLabel(form: string | null): string {
  if (form === "pnd3") return "ภ.ง.ด.3";
  if (form === "pnd53") return "ภ.ง.ด.53";
  return "";
}

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** ประกอบ query string (คงบริบท accountant/customerId/month/type) */
function buildQuery(params: {
  accountant?: string;
  customerId?: string;
  month?: string;
  type?: EntryType;
}): string {
  const sp = new URLSearchParams();
  if (params.accountant) sp.set("accountant", params.accountant);
  if (params.customerId) sp.set("customerId", params.customerId);
  if (params.month) sp.set("month", params.month);
  if (params.type) sp.set("type", params.type);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** แถวรวมท้าย (มูลค่า/VAT/หัก/รวม) ของประเภทหนึ่ง */
function TotalRow({ label, t }: { label: string; t: ReviewTypeTotal }) {
  return (
    <tr className="acc-total">
      <td colSpan={5} className="strong">
        {label} · {t.count.toLocaleString("th-TH")} บิล
      </td>
      <td className="num strong">{formatMoney(t.amount)}</td>
      <td className="num strong">{formatMoney(t.vat)}</td>
      <td className="num strong">{formatMoney(t.wht)}</td>
      <td className="num strong">{formatMoney(t.net)}</td>
      <td />
    </tr>
  );
}

/** ตารางแบนของประเภทหนึ่ง (ทุกบรรทัดที่จะเข้าชีทนั้น) + แถวรวมท้าย */
function ReviewSection({
  title,
  rows,
  total,
}: {
  title: string;
  rows: ReviewRow[];
  total: ReviewTypeTotal;
}) {
  return (
    <div className="card">
      <div className="section-title">
        <span>{title}</span>
        <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
          {total.count.toLocaleString("th-TH")} บิล
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">ไม่มีรายการในประเภทนี้</p>
      ) : (
        <div className="table-wrap">
          <table className="dlv-table acc-table">
            <thead>
              <tr>
                <th>วันที่</th>
                <th>เลขที่</th>
                <th>คู่ค้า / เลขภาษี</th>
                <th>รายการ</th>
                <th className="center">VAT</th>
                <th className="num">มูลค่า</th>
                <th className="num">VAT</th>
                <th className="num">หัก ณ ที่จ่าย</th>
                <th className="num">รวมจ่ายจริง</th>
                <th className="center">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.entryId}-${i}`}>
                  <td>{formatDate(r.docDate)}</td>
                  <td>{r.docNo || "—"}</td>
                  <td>
                    <div className="acc-party">{r.counterparty || "—"}</div>
                    {r.taxId ? <div className="acc-taxid">{r.taxId}</div> : null}
                  </td>
                  <td>
                    <span className="acc-desc">{r.description || "—"}</span>
                    {r.whtForm ? <span className="acc-pnd">{whtFormLabel(r.whtForm)}</span> : null}
                  </td>
                  <td className="center">
                    {r.vatType ? (
                      <span className={`vat-badge ${r.vatType === "novat" ? "no" : "yes"}`}>
                        {r.vatType === "novat" ? "ไม่ VAT" : "VAT"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">{formatMoney(r.amount)}</td>
                  <td className="num">{formatMoney(r.vat)}</td>
                  <td className="num">{formatMoney(r.wht)}</td>
                  <td className="num">{formatMoney(r.net)}</td>
                  <td className="center">
                    <span className={`st-badge ${r.status === "confirmed" ? "st-confirmed" : "st-draft"}`}>
                      {r.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}
                    </span>
                  </td>
                </tr>
              ))}
              <TotalRow label="รวม" t={total} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * /chat-audit/accounting/review — "ตรวจทานรายการก่อนออก Excel"
 *   โชว์ "ทุกบรรทัดที่จะเข้าไฟล์" ตามบริบท (ลูกค้า/นักบัญชี/ทั้งสำนักงาน + เดือน + ประเภท)
 *   + แถวรวมแยกซื้อ/ขาย + เตือน รอระบุ/ร่าง + ปุ่มดาวน์โหลด Excel (เรียก export route เดิม)
 *
 * ★ guard + scope เดียวกับหน้า accounting (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 */
export default async function AccountingReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    accountant?: string;
    customerId?: string;
    month?: string;
    type?: string;
  }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="ตรวจทานก่อนออก Excel" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  // ---- อ่าน + validate param ----
  const customerId = (sp.customerId ?? "").trim();
  const accountant = (sp.accountant ?? "").trim();
  const month = (sp.month ?? "").trim();
  const typeParam = (sp.type ?? "").trim();

  const validCustomerId = UUID_RE.test(customerId) ? customerId : "";
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : "";
  const validType: EntryType | "" = typeParam === "purchase" || typeParam === "sale" ? typeParam : "";

  const filter: ListEntriesFilter = {};
  if (validMonth) filter.month = validMonth;
  if (validType) filter.entryType = validType;

  // ---- สโคปลูกค้า (mirror export route — server-side enforce) ----
  let scopeDenied = false;
  if (access.allowedCustomerIds !== null) {
    // นักบัญชี: จำกัดเฉพาะลูกค้าที่ตัวเองดูแล
    if (validCustomerId) {
      if (!access.allowedCustomerIds.has(validCustomerId)) scopeDenied = true;
      else filter.customerId = validCustomerId;
    } else {
      filter.customerIds = [...access.allowedCustomerIds];
    }
  } else {
    // admin/lead: ตามลูกค้าที่ระบุ หรือ สโคปตามนักบัญชีที่เลือก (ถ้ามี) ไม่งั้นทั้งสำนักงาน
    if (validCustomerId) {
      filter.customerId = validCustomerId;
    } else if (UUID_RE.test(accountant)) {
      filter.customerIds = await customerIdsForAccountant(service, tenantId, accountant);
    }
  }

  // href กลับไปหน้าลงบันทึก (คงบริบท) + กรณีเจาะลูกค้า → เปิด accordion ลูกค้านั้น
  const backAccountant = access.mode === "accountant" ? undefined : accountant || undefined;
  const backSp = new URLSearchParams();
  if (backAccountant) backSp.set("accountant", backAccountant);
  if (validMonth) backSp.set("month", validMonth);
  if (validCustomerId) backSp.set("open", validCustomerId);
  const backHref = `/chat-audit/accounting${backSp.toString() ? `?${backSp.toString()}` : ""}`;

  if (scopeDenied) {
    return (
      <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="ตรวจทานก่อนออก Excel" subtitle="ภาษีซื้อ/ขาย">
        <div className="dash-views">
          <div className="card">
            ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ
            <div style={{ marginTop: 12 }}>
              <Link href={backHref} className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
            </div>
          </div>
        </div>
      </ChatAuditFrame>
    );
  }

  let review;
  try {
    const { entries } = await listEntries(service, tenantId, filter);
    review = buildReview(entries);
  } catch {
    return (
      <ChatAuditFrame active="chat-accounting" role={navRole} authed staffOnly={staffOnly} title="ตรวจทานก่อนออก Excel" subtitle="ภาษีซื้อ/ขาย">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
      </ChatAuditFrame>
    );
  }

  // ---- ป้ายสโคป (ไม่ log ชื่อ — แสดงบนหน้าเท่านั้น) ----
  let scopeLabel: string;
  if (validCustomerId) {
    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", validCustomerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    scopeLabel = `ลูกค้า: ${customerLabel(c?.customer_code ?? null, c?.name ?? null)}`;
  } else if (access.mode === "accountant") {
    scopeLabel = "ลูกค้าที่คุณดูแล";
  } else if (UUID_RE.test(accountant)) {
    const name = await getEmployeeName(service, tenantId, accountant);
    scopeLabel = `นักบัญชี: ${name ?? "—"}`;
  } else {
    scopeLabel = "ทั้งสำนักงาน (ทุกนักบัญชี)";
  }
  const monthLabel = validMonth || "ทุกเดือน";

  // ---- ปุ่มดาวน์โหลด Excel (export route เดิม — คง scope/filter) ----
  const downloadHref = `/chat-audit/accounting/export${buildQuery({
    accountant: backAccountant,
    customerId: validCustomerId || undefined,
    month: validMonth || undefined,
    type: validType || undefined,
  })}`;

  const hasWarn = review.unspecifiedCount > 0 || review.draftCount > 0;
  const nothingToExport = review.purchase.count === 0 && review.sale.count === 0;

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ตรวจทานก่อนออก Excel"
      subtitle="ตรวจทุกบรรทัดที่จะเข้าไฟล์ — แยกภาษีซื้อ/ขาย แล้วดาวน์โหลด"
    >
      <div className="dash-views">
        {/* ---- แถบหัว: สโคป + เดือน + ปุ่มกลับ/ดาวน์โหลด ---- */}
        <div className="card acc-review-head">
          <div className="acc-review-scope">
            <span className="acc-scope-label">{scopeLabel}</span>
            <span className="acc-review-month">เดือน: {monthLabel}</span>
          </div>
          <span className="acc-toolbar-spacer" />
          <Link href={backHref} className="btn btn-ghost">← กลับไปแก้รายการ</Link>
          <a
            href={downloadHref}
            className={`btn${nothingToExport ? " is-disabled" : ""}`}
            aria-disabled={nothingToExport}
            tabIndex={nothingToExport ? -1 : undefined}
          >
            ดาวน์โหลด Excel
          </a>
        </div>

        {/* ---- เตือน: รอระบุ / ร่าง ---- */}
        {hasWarn ? (
          <div className="card acc-review-warn">
            <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
            <div className="acc-review-warn-body">
              <div className="acc-review-warn-title">ตรวจก่อนออกไฟล์</div>
              <ul className="acc-review-warn-list">
                {review.unspecifiedCount > 0 ? (
                  <li>
                    มี <strong>{review.unspecifiedCount.toLocaleString("th-TH")}</strong> รายการ “รอระบุประเภท” —
                    จะ<strong>ไม่</strong>เข้าไฟล์ Excel (ต้องเลือกซื้อ/ขายก่อน)
                  </li>
                ) : null}
                {review.draftCount > 0 ? (
                  <li>
                    มี <strong>{review.draftCount.toLocaleString("th-TH")}</strong> รายการที่ยังเป็น “ร่าง” —
                    เข้าไฟล์ได้ แต่ควรตรวจ/ยืนยันก่อน
                  </li>
                ) : null}
              </ul>
              <Link href={backHref} className="btn btn-ghost">ไปแก้รายการ</Link>
            </div>
          </div>
        ) : null}

        {nothingToExport ? (
          <div className="card">
            <p className="empty">ไม่มีรายการภาษีซื้อ/ขายที่จะเข้าไฟล์ตามเงื่อนไขนี้</p>
          </div>
        ) : (
          <>
            {/* type=purchase/sale → โชว์เฉพาะประเภทนั้น, ไม่ระบุ → ทั้งสอง */}
            {validType !== "sale" ? (
              <ReviewSection
                title="ภาษีซื้อ"
                rows={review.rows.filter((r) => r.type === "purchase")}
                total={review.purchase}
              />
            ) : null}
            {validType !== "purchase" ? (
              <ReviewSection
                title="ภาษีขาย"
                rows={review.rows.filter((r) => r.type === "sale")}
                total={review.sale}
              />
            ) : null}
          </>
        )}
      </div>
    </ChatAuditFrame>
  );
}
