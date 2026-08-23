import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listProducts } from "@/lib/accounting/products";
import {
  listMovements,
  getProductOpeningBalance,
  computeStockLedger,
  buildStockCard,
  buildInventoryValuationReport,
  listWarehouses,
  getOrCreateDefaultWarehouse,
  computeWarehouseQuantities,
  type StockCardRow,
  type ProductLedgerInput,
  type OpeningBalance,
  type InventoryValuationReport,
  type Warehouse,
} from "@/lib/accounting/product-stock";
import InventoryPanel from "./InventoryPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** เพดานสินค้าที่คำนวณบัตรสต็อกต่อ 1 ครั้งเปิดหน้า (กันสำนักงานที่มีสินค้าเยอะผิดปกติแล้วช้า —
 *   mirror LOG_FETCH_LIMIT ของ fixed-assets/page.tsx) */
const PRODUCT_LEDGER_LIMIT = 500;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** รายชื่อลูกค้าในสโคป (สำหรับ dropdown) — เหมือนหน้า budget/fixed-assets */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/inventory — "สต็อกสินค้าคงเหลือ" (เฟส 8 ส่วน X, T72)
 *   เลือกลูกค้า (ในสโคป) → แท็บ "บัตรสต็อก" (เลือกสินค้า ดูประวัติรับ/จ่าย/คงเหลือ+ต้นทุนถ่วงเฉลี่ยเคลื่อนที่)
 *   / "สินค้าคงเหลือแยกหมวด" (ทั้งหมด ณ วันนี้) — ปุ่มบันทึกปรับปรุงสต็อกมือ + ฟอร์มยอดยกมาต่อสินค้า
 *
 * ★ guard + scope เดียวกับหน้าอื่น (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ 0.5 คำนวณจากการ replay ทั้งหมดใหม่ทุกครั้ง (ไม่มี cache) — เรียก computeStockLedger ตรงจากข้อมูลดิบ
 * ★ N+1 query ต่อสินค้า (opening balance + movements) — mirror fixed-assets/page.tsx (จำนวนสินค้าต่อ
 *   สำนักงานปกติไม่ถึงระดับที่มีผล perf จริง, PRODUCT_LEDGER_LIMIT กันเวอร์)
 * ★ รายงาน "สินค้าคงเหลือแยกหมวด" รวมเฉพาะสินค้าที่มียอดยกมา/รายการเคลื่อนไหวจริงของลูกค้ารายนี้เท่านั้น
 *   (products เป็น master data ใช้ร่วมทุกลูกค้าในสำนักงาน — ไม่ใช่ทุกสินค้าเกี่ยวข้องกับลูกค้ารายนี้)
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="สต็อกสินค้าคงเหลือ" subtitle="บัตรสต็อก + สินค้าคงเหลือแยกหมวด (ต้นทุนถ่วงเฉลี่ยเคลื่อนที่)">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/inventory");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);
  const products = await listProducts(service, access.tenantId);

  const rawCustomer = (sp.customerId ?? "").trim();
  const customerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === customerId)?.label ?? "";

  let stockCardsByProduct: Record<string, StockCardRow[]> = {};
  let openingByProduct: Record<string, OpeningBalance> = {};
  let valuationReport: InventoryValuationReport = { groups: [], grandTotalValue: 0 };
  let warehouses: Warehouse[] = [];
  let warehouseQtyByProduct: Record<string, { warehouseId: string; quantity: number }[]> = {};
  let loadError = false;

  if (customerId) {
    try {
      // ★ wishlist ข้อ 8 — โหลดคลังของลูกค้ารายนี้ (อ่านอย่างเดียว ไม่สร้างคลังหลักที่นี่ — สร้างแบบ lazy
      //   ตอนเขียนจริงเท่านั้น ผ่าน getOrCreateDefaultWarehouse ที่ actions.ts/product-stock.ts)
      warehouses = await listWarehouses(service, access.tenantId, customerId, { includeInactive: true });
      const defaultWarehouseId = warehouses.find((w) => w.isDefault)?.id ?? null;

      const ledgerInputs: ProductLedgerInput[] = [];
      for (const p of products.slice(0, PRODUCT_LEDGER_LIMIT)) {
        const [opening, movements] = await Promise.all([
          getProductOpeningBalance(service, access.tenantId, customerId, p.id),
          listMovements(service, access.tenantId, customerId, p.id),
        ]);
        if (opening) openingByProduct[p.id] = opening;
        const ledgerRows = computeStockLedger(opening, movements);
        stockCardsByProduct[p.id] = buildStockCard(ledgerRows);
        if (opening || movements.length > 0) {
          ledgerInputs.push({ productId: p.id, productName: p.name, category: p.category, ledgerRows });
          warehouseQtyByProduct[p.id] = computeWarehouseQuantities(defaultWarehouseId, opening, movements);
        }
      }
      valuationReport = buildInventoryValuationReport(ledgerInputs);
    } catch {
      loadError = true;
    }
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="สต็อกสินค้าคงเหลือ"
      subtitle="บัตรสต็อก + สินค้าคงเหลือแยกหมวด (ต้นทุนถ่วงเฉลี่ยเคลื่อนที่) — ไม่กระทบบัญชีแยกประเภท/งบการเงิน"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          <form method="get" className="acc-opening-cust">
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={customerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">เปิด</button>
          </form>
          <span className="acc-toolbar-spacer" />
          {customerId ? (
            <a href={`/chat-audit/accounting/inventory/export?customerId=${customerId}`} className="btn btn-ghost">
              ออก Excel
            </a>
          ) : null}
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card"><p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p></div>
        ) : !customerId ? (
          <div className="card"><p className="empty">เลือกลูกค้าด้านบนเพื่อดูสต็อกสินค้าคงเหลือ</p></div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <InventoryPanel
              customerId={customerId}
              products={products}
              stockCardsByProduct={stockCardsByProduct}
              openingByProduct={openingByProduct}
              valuationReport={valuationReport}
              warehouses={warehouses}
              warehouseQtyByProduct={warehouseQtyByProduct}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
