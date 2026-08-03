"use client";

import { useState, type ReactNode } from "react";
import { createEntryAction } from "./actions";
import UploadFileButton from "./UploadFileButton";
import type { EntryType } from "@/lib/accounting/queries";

/**
 * แท็บย่อย ซื้อ/ขาย/รอระบุ ของลูกค้า 1 ราย — ★ สลับ "ในจอ" (client) ไม่วิ่ง server
 *   perf #1: server render ทั้ง 3 ตารางไว้ (ผ่าน prop tables) แล้วตรงนี้แค่โชว์/ซ่อนตามแท็บ
 *   → กดแท็บ = เปลี่ยนทันที (ไม่มีจอโหลด/re-fetch) · หน้าตาเหมือนเดิมทุกอย่าง
 *   ★ ปุ่ม "เพิ่มรายการ/อัปไฟล์" ใช้ประเภทของแท็บที่เลือกอยู่ (client state)
 */
const TABS: { type: EntryType; label: string }[] = [
  { type: "purchase", label: "ภาษีซื้อ" },
  { type: "sale", label: "ภาษีขาย" },
  { type: "unspecified", label: "รอระบุประเภท" },
];

export default function CustomerTabs({
  initialType,
  counts,
  customerId,
  customerLabel,
  accountant,
  reviewHref,
  openingHref,
  reportsHref,
  tables,
}: {
  initialType: EntryType;
  counts: Record<EntryType, number>;
  customerId: string | null;
  customerLabel: string;
  accountant?: string;
  reviewHref?: string;
  openingHref?: string;
  reportsHref?: string;
  tables: Record<EntryType, ReactNode>;
}) {
  const [type, setType] = useState<EntryType>(initialType);

  return (
    <>
      <div className="acc-subtabs">
        {TABS.map((t) => {
          const n = counts[t.type] ?? 0;
          const active = type === t.type;
          return (
            <button
              key={t.type}
              type="button"
              onClick={() => setType(t.type)}
              className={`acc-subtab${active ? " active" : ""}${t.type === "unspecified" && n > 0 ? " amber" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {t.label} <span className="acc-subtab-n">{n}</span>
            </button>
          );
        })}

        <span className="acc-toolbar-spacer" />
        {/* เพิ่มรายการเอง (ประเภท = แท็บที่เลือก) */}
        <form action={createEntryAction} className="acc-inline">
          {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}
          <input type="hidden" name="entryType" value={type} />
          {accountant ? <input type="hidden" name="accountant" value={accountant} /> : null}
          <button type="submit" className="btn">+ เพิ่มรายการ</button>
        </form>
        {/* อัปโหลดไฟล์เอง (key=type → รับ defaultEntryType ใหม่ตามแท็บ) */}
        <UploadFileButton
          key={type}
          lockedCustomerId={customerId}
          lockedCustomerLabel={customerLabel}
          defaultEntryType={type}
          label="อัปไฟล์"
          accountant={accountant}
        />
        {reviewHref ? (
          <a href={reviewHref} className="btn btn-ghost">ตรวจทาน / ออก Excel</a>
        ) : null}
        {openingHref ? (
          <a href={openingHref} className="btn btn-ghost">ยอดยกมา</a>
        ) : null}
        {reportsHref ? (
          <a href={reportsHref} className="btn btn-ghost">งบการเงิน</a>
        ) : null}
      </div>

      {/* 3 ตาราง — โชว์เฉพาะแท็บที่เลือก (สลับในจอ ไม่โหลดใหม่) */}
      <div style={{ display: type === "purchase" ? undefined : "none" }}>{tables.purchase}</div>
      <div style={{ display: type === "sale" ? undefined : "none" }}>{tables.sale}</div>
      <div style={{ display: type === "unspecified" ? undefined : "none" }}>{tables.unspecified}</div>
    </>
  );
}
