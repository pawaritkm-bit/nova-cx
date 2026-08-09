"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { moveEntryTypeAction, deleteEntryAction } from "./actions";
import type { EntryType, EntryStatus } from "@/lib/accounting/queries";

/**
 * ปุ่มจัดการต่อแถว (client) — ปุ่มลัด "ย้ายไปซื้อ/ขาย" + ลบ + ลิงก์ตรวจ/แก้
 *
 * ★ ย้ายประเภท: โชว์เฉพาะปลายทางที่ ≠ ประเภทปัจจุบัน และเฉพาะ entry ที่ยังไม่ยืนยัน
 *   (ยืนยันแล้วแก้ไม่ได้ — actions-lib กันไว้ ฝั่ง UI ซ่อนปุ่มด้วย)
 * ★ ลบ: ยืนยันก่อนเสมอ (soft delete) — คืนสถานะ ไม่ throw
 * ★ ระหว่างทำงาน disable กันกดซ้ำ + refresh หน้าเมื่อสำเร็จ
 */
export default function RowActions({
  entryId,
  entryType,
  status,
  editHref,
  customerId,
  hasWht,
  isCreditEligible,
}: {
  entryId: string;
  entryType: EntryType;
  status: EntryStatus;
  editHref: string;
  /** ลูกค้าเจ้าของบิล — ใช้สร้างลิงก์ "ใบรับรองแทนใบเสร็จ"/"ใบหัก ณ ที่จ่าย"/"ใบลดหนี้/เพิ่มหนี้" (null = บิลไม่ผูกลูกค้า → ซ่อนปุ่ม) */
  customerId?: string | null;
  /** true = มีอย่างน้อย 1 บรรทัด whtAmount>0 — ใช้โชว์ปุ่ม "ใบหัก ณ ที่จ่าย" (เฉพาะบิลซื้อเท่านั้น, 0.2) */
  hasWht?: boolean;
  /** true = บิลเชื่อที่ยืนยันแล้ว (isCreditEligibleForPayment) — ใช้โชว์ปุ่ม "ใบลดหนี้/เพิ่มหนี้" (เฟส 3 ส่วน J, 0.3) */
  isCreditEligible?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const confirmed = status === "confirmed";

  function move(target: EntryType) {
    setMsg(null);
    startTransition(async () => {
      const res = await moveEntryTypeAction(entryId, target);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function remove() {
    if (!window.confirm("ลบบิลนี้? (กดผิดกู้คืนได้ด้วยปุ่ม “เลิกทำ”)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteEntryAction(entryId);
      if (res.ok) {
        // คงตัวกรองเดิม + เพิ่ม ?undo=<id> → โชว์แถบ "เลิกทำ" ให้กู้คืนทันที
        const params = new URLSearchParams(searchParams.toString());
        params.set("undo", entryId);
        router.push(`${pathname}?${params.toString()}`);
        router.refresh();
      } else {
        setMsg({ ok: res.ok, text: res.message });
      }
    });
  }

  // ปลายทางย้าย: ทุกประเภทที่ไม่ใช่ประเภทปัจจุบัน (ซื้อ/ขาย เป็นหลัก)
  const allTargets: { type: EntryType; label: string }[] = [
    { type: "purchase", label: "→ ซื้อ" },
    { type: "sale", label: "→ ขาย" },
  ];
  const moveTargets = allTargets.filter((t) => t.type !== entryType);

  return (
    <div className="acc-rowactions">
      <div className="acc-rowactions-btns">
        <Link href={editHref} className="acc-mini-btn" scroll={false} aria-label="ตรวจ/แก้">
          ตรวจ/แก้
        </Link>
        {/* ออกใบรับรองแทนใบเสร็จ (prefill รายการ/ยอด/วันที่ จากบิลนี้) — เฉพาะบิลที่ผูกลูกค้า */}
        {customerId ? (
          <a
            href={`/chat-audit/accounting/receipt-cert?customer=${customerId}&bill=${entryId}`}
            className="acc-mini-btn"
            target="_blank"
            rel="noopener"
            title="ออกใบรับรองแทนใบเสร็จจากบิลนี้"
          >
            ใบรับรองฯ
          </a>
        ) : null}
        {/* ออกหนังสือรับรองหัก ณ ที่จ่าย — เฉพาะบิลซื้อที่มีรายการ WHT (isWhtCertEligible ทั้ง 2 เงื่อนไข) */}
        {customerId && entryType === "purchase" && hasWht ? (
          <a
            href={`/chat-audit/accounting/wht-cert?customer=${customerId}&bill=${entryId}`}
            className="acc-mini-btn"
            target="_blank"
            rel="noopener"
            title="ออกหนังสือรับรองหัก ณ ที่จ่ายจากบิลนี้"
          >
            ใบหัก ณ ที่จ่าย
          </a>
        ) : null}
        {/* ใบลดหนี้/เพิ่มหนี้ — เฉพาะบิลเชื่อที่ยืนยันแล้ว (isCreditEligibleForPayment, เฟส 3 ส่วน J 0.3) */}
        {customerId && isCreditEligible ? (
          <a
            href={`/chat-audit/accounting/credit-debit-notes?customerId=${customerId}&entryId=${entryId}`}
            className="acc-mini-btn"
            title="ออกใบลดหนี้/เพิ่มหนี้จากบิลนี้"
          >
            ใบลดหนี้/เพิ่มหนี้
          </a>
        ) : null}
        {!confirmed
          ? moveTargets.map((t) => (
              <button
                key={t.type}
                type="button"
                className="acc-mini-btn"
                onClick={() => move(t.type)}
                disabled={pending}
                title={`ย้ายไป${t.label}`}
              >
                {t.label}
              </button>
            ))
          : null}
        <button
          type="button"
          className="acc-mini-btn danger"
          onClick={remove}
          disabled={pending}
          aria-label="ลบรายการ"
        >
          ลบ
        </button>
      </div>
      {msg && !msg.ok ? <div className="acc-rowmsg err">{msg.text}</div> : null}
    </div>
  );
}
