"use client";

import { useState } from "react";
import EntryEditor from "./EntryEditor";
import type { BillEntry } from "@/lib/accounting/queries";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import type { Product } from "@/lib/accounting/products";
import type { ProductUnit } from "@/lib/accounting/product-units";

/** 1 บิลใน nav (ข้อมูล + รูปที่ sign ย่อไว้แล้ว) */
export type PagerBill = {
  id: string;
  entry: BillEntry;
  viewUrl: string | null;
  viewIsImage: boolean;
  fileName: string | null;
  /** เฟส 10 ส่วน Z (0.9) — บิลนี้มีการรับ/จ่ายเงินไปแล้ว ≥1 รายการ → ล็อกช่อง currency/fx_rate ที่ EntryEditor */
  fxLocked: boolean;
};

/**
 * ตัวเลื่อนบิล "แบบ client" ในหน้าตรวจ/แก้ — ★ กด ก่อนหน้า/ถัดไป แล้วเปลี่ยนทันที (ไม่โหลดหน้าใหม่)
 *   ★ preload รูปทุกบิลใน nav ไว้ก่อน (ซ่อน) → กดปุ๊บรูปพร้อมปั๊บ (URL เดียวกับที่ EntryEditor ใช้ → cache hit)
 *   ★ EntryEditor key={currentId} → remount + re-init ฟอร์มให้บิลใหม่ (save ร่างอัตโนมัติก่อนเลื่อนอยู่ใน EntryEditor)
 */
export default function EntryEditorPager({
  bills,
  initialId,
  customerLabel,
  closeHref,
  orderIds,
  chart,
  products,
  productUnits,
}: {
  bills: PagerBill[];
  initialId: string;
  customerLabel: string;
  closeHref: string;
  orderIds: string[];
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) — ส่งต่อให้ EntryEditor ทุกบิลใน pager */
  chart: ChartAccount[];
  /** สินค้า/บริการของ tenant (เฟส 1 ส่วน B) — ส่งต่อให้ EntryEditor ทุกบิลใน pager (product picker ต่อบรรทัด) */
  products: Product[];
  /** หน่วยนับเพิ่มเติมต่อสินค้า (wishlist backlog ข้อ 2) — ส่งต่อให้ EntryEditor ทุกบิลใน pager */
  productUnits?: Map<string, ProductUnit[]>;
}) {
  const [currentId, setCurrentId] = useState(initialId);
  const current = bills.find((b) => b.id === currentId) ?? bills.find((b) => b.id === initialId) ?? bills[0];
  if (!current) return null;

  return (
    <>
      {/* preload รูปทุกบิลใน nav (ซ่อน) — เลื่อนแล้วรูปขึ้นทันที */}
      <div style={{ display: "none" }} aria-hidden="true">
        {bills
          .filter((b) => b.viewIsImage && b.viewUrl)
          .map((b) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={b.id} src={b.viewUrl as string} alt="" decoding="async" />
          ))}
      </div>

      <EntryEditor
        key={current.id}
        entry={current.entry}
        viewUrl={current.viewUrl}
        viewIsImage={current.viewIsImage}
        fileName={current.fileName}
        customerLabel={customerLabel}
        closeHref={closeHref}
        orderIds={orderIds}
        onNavigate={(id) => setCurrentId(id)}
        chart={chart}
        products={products}
        productUnits={productUnits}
        fxLocked={current.fxLocked}
      />
    </>
  );
}
