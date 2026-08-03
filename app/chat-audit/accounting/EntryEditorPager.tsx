"use client";

import { useState } from "react";
import EntryEditor from "./EntryEditor";
import type { BillEntry } from "@/lib/accounting/queries";

/** 1 บิลใน nav (ข้อมูล + รูปที่ sign ย่อไว้แล้ว) */
export type PagerBill = {
  id: string;
  entry: BillEntry;
  viewUrl: string | null;
  viewIsImage: boolean;
  fileName: string | null;
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
}: {
  bills: PagerBill[];
  initialId: string;
  customerLabel: string;
  closeHref: string;
  orderIds: string[];
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
      />
    </>
  );
}
