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
}: {
  entryId: string;
  entryType: EntryType;
  status: EntryStatus;
  editHref: string;
  /** ลูกค้าเจ้าของบิล — ใช้สร้างลิงก์ "ใบรับรองแทนใบเสร็จ" (null = บิลไม่ผูกลูกค้า → ซ่อนปุ่ม) */
  customerId?: string | null;
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
