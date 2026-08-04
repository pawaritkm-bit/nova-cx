"use client";

import { useEffect, useState, type ReactNode } from "react";
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

/** ประเภทแท็บที่เลือกได้ (รวมแท็บพิเศษ "วงแชร์") */
type TabKey = EntryType | "share";

export default function CustomerTabs({
  initialType,
  counts,
  customerId,
  customerLabel,
  accountant,
  reviewHref,
  openingHref,
  reportsHref,
  vatPurchaseHref,
  vatSaleHref,
  sbtHref,
  journalBooksHref,
  statementHref,
  tables,
  shareCircle,
  shareCircleCount,
}: {
  initialType: EntryType;
  counts: Record<EntryType, number>;
  customerId: string | null;
  customerLabel: string;
  accountant?: string;
  reviewHref?: string;
  openingHref?: string;
  reportsHref?: string;
  /** รายงานภาษีซื้อ (ฟอร์มราชการ) — เปิดแท็บใหม่พิมพ์/PDF */
  vatPurchaseHref?: string;
  /** รายงานภาษีขาย (ฟอร์มราชการ) */
  vatSaleHref?: string;
  /** รายงาน ภธ.40 (ภาษีธุรกิจเฉพาะ) */
  sbtHref?: string;
  /** สมุดรายวัน 5 เล่ม */
  journalBooksHref?: string;
  /** AI แยกสเตทเมนต์ เข้า-ออก */
  statementHref?: string;
  tables: Record<EntryType, ReactNode>;
  /** เนื้อในแท็บ "วงแชร์" — undefined = ลูกค้ารายนี้ไม่ใช่ท้าวแชร์ (ไม่โชว์แท็บ) */
  shareCircle?: ReactNode;
  /** จำนวนวงแชร์ (badge) */
  shareCircleCount?: number;
}) {
  const [type, setType] = useState<TabKey>(initialType);

  // แท็บวงแชร์หายไป (ลบวงสุดท้าย/ยกเลิกท้าวแชร์ → shareCircle=undefined) ขณะค้างอยู่แท็บนั้น
  //   → เด้งกลับ 'purchase' กันจอว่าง (แท็บที่ถูกซ่อนแล้วไม่มีเนื้อหาให้โชว์)
  useEffect(() => {
    if (type === "share" && shareCircle === undefined) setType("purchase");
  }, [type, shareCircle]);

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

        {/* แท็บ "วงแชร์" — โผล่เฉพาะลูกค้าที่เป็นท้าวแชร์ (auto-flag จาก server) */}
        {shareCircle !== undefined ? (
          <button
            type="button"
            onClick={() => setType("share")}
            className={`acc-subtab${type === "share" ? " active" : ""}`}
            aria-current={type === "share" ? "page" : undefined}
          >
            วงแชร์ <span className="acc-subtab-n">{shareCircleCount ?? 0}</span>
          </button>
        ) : null}

        <span className="acc-toolbar-spacer" />
        {/* toolbar ซื้อ/ขาย/รอระบุ — ซ่อนเมื่ออยู่แท็บวงแชร์ (แท็บวงแชร์มี toolbar ของตัวเอง) */}
        {type !== "share" ? (
          <>
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
            {/* รายงานภาษีซื้อ/ขาย (ฟอร์มราชการ) — เปิดแท็บใหม่ให้พิมพ์สะอาด */}
            {vatPurchaseHref ? (
              <a href={vatPurchaseHref} className="btn btn-ghost" target="_blank" rel="noopener">
                รายงานภาษีซื้อ
              </a>
            ) : null}
            {vatSaleHref ? (
              <a href={vatSaleHref} className="btn btn-ghost" target="_blank" rel="noopener">
                รายงานภาษีขาย
              </a>
            ) : null}
            {/* สมุดรายวัน 5 เล่ม (double-entry) — เปิดแท็บใหม่พิมพ์/PDF */}
            {journalBooksHref ? (
              <a href={journalBooksHref} className="btn btn-ghost" target="_blank" rel="noopener">
                สมุดรายวัน
              </a>
            ) : null}
            {/* ภธ.40 ภาษีธุรกิจเฉพาะ (ฐานแก้ได้ Phase 1) */}
            {sbtHref ? (
              <a href={sbtHref} className="btn btn-ghost" target="_blank" rel="noopener">
                ภธ.40
              </a>
            ) : null}
            {openingHref ? (
              <a href={openingHref} className="btn btn-ghost">ยอดยกมา</a>
            ) : null}
            {reportsHref ? (
              <a href={reportsHref} className="btn btn-ghost">งบการเงิน</a>
            ) : null}
            {statementHref ? (
              <a href={statementHref} className="btn btn-ghost">แยกสเตทเมนต์</a>
            ) : null}
          </>
        ) : null}
      </div>

      {/* 3 ตาราง — โชว์เฉพาะแท็บที่เลือก (สลับในจอ ไม่โหลดใหม่) */}
      <div style={{ display: type === "purchase" ? undefined : "none" }}>{tables.purchase}</div>
      <div style={{ display: type === "sale" ? undefined : "none" }}>{tables.sale}</div>
      <div style={{ display: type === "unspecified" ? undefined : "none" }}>{tables.unspecified}</div>
      {/* แท็บวงแชร์ */}
      {shareCircle !== undefined ? (
        <div style={{ display: type === "share" ? undefined : "none" }}>{shareCircle}</div>
      ) : null}
    </>
  );
}
