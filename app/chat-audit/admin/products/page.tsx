import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { listProductsAdmin } from "@/lib/accounting/products";
import { listProductUnitsForProducts } from "@/lib/accounting/product-units";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import ChatAuditFrame from "../../_Frame";
import ProductsPanel from "./ProductsPanel";
import "../../chat-admin.css";
import "../../../admin/admin.css";

export const dynamic = "force-dynamic";

/**
 * /chat-audit/admin/products — จัดการสินค้า/บริการ (เฟส 1 ส่วน B4, docs/06 หมวด B)
 *   list + เพิ่ม/แก้/เปิดปิดใช้งาน/soft-delete — tenant-scoped
 * ★ guard admin/executive + tenant จาก session (ไม่เชื่อ client) — reuse resolveAdminContext
 *   (สินค้า/บริการเป็น tenant-level ไม่ผูกลูกค้า → เฉพาะ admin/executive ตาม docs/06 หมวด 0.9)
 */
export default async function ProductsAdminPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="สินค้า/บริการ" subtitle="จัดการสินค้า/บริการกลาง">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);
  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/admin/products");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-accounting" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="สินค้า/บริการ" subtitle="จัดการสินค้า/บริการกลาง">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p></div>
      </ChatAuditFrame>
    );
  }

  try {
    const service = createServiceRoleClient();
    const [products, chart] = await Promise.all([
      listProductsAdmin(service, ctx.tenantId),
      listChartOfAccounts(service, ctx.tenantId),
    ]);
    // หน่วยนับเพิ่มเติมต่อสินค้า (wishlist backlog ข้อ 2) — โหลดครั้งเดียวต่อ request
    const productUnits = await listProductUnitsForProducts(service, ctx.tenantId, products.map((p) => p.id));

    return (
      <ChatAuditFrame
        active="chat-accounting"
        role={ctx.role}
        authed
        title="สินค้า/บริการ"
        subtitle="จัดการสินค้า/บริการกลาง (ใช้ร่วมทุกลูกค้าในสำนักงานของคุณ) — เลือกในบรรทัดบิลได้"
      >
        <div className="dash-views">
          <p><Link href="/chat-audit/accounting" className="underline">← กลับหน้าลงบันทึกบัญชี</Link></p>
          <ProductsPanel products={products} chart={chart} productUnits={productUnits} />
        </div>
      </ChatAuditFrame>
    );
  } catch {
    return (
      <ChatAuditFrame active="chat-accounting" role={ctx.role} authed title="สินค้า/บริการ" subtitle="จัดการสินค้า/บริการกลาง">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0064)</div>
      </ChatAuditFrame>
    );
  }
}
