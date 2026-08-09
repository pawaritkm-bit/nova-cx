"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendToFlowAccountAction } from "./flowaccount-actions";
import type { EntryType, EntryStatus, FlowAccountSyncInfo } from "@/lib/accounting/queries";

/**
 * ปุ่ม/ป้ายสถานะ "ส่งไป FlowAccount" ต่อแถวบิลขาย/บิลซื้อ (docs/05-flowaccount-integration.md T8,
 *   เฟส 5 ส่วน P — ขยายให้บิลซื้อ (entry_type='purchase') ด้วย)
 *
 * ไม่ render อะไรเลยถ้า:
 *   - entryType ≠ 'sale' และ ≠ 'purchase'  หรือ
 *   - status ≠ 'confirmed'  หรือ
 *   - ไม่มีลูกค้าผูก (customerId ว่าง)
 *
 * 4 สถานะ (จาก BillEntry.flowaccountSync):
 *   not_synced / failed        → ปุ่ม "ส่งไป FlowAccount" (+ ข้อความ error สั้น ๆ ถ้า failed)
 *   syncing                    → ปุ่ม disabled + spinner
 *   synced && !needsResync     → ป้ายเขียว "ส่งแล้ว ✓" + วันเวลา/เลขที่เอกสาร
 *   synced && needsResync      → ป้ายเตือนส้ม "แก้ไขแล้ว ควรส่งใหม่" + ปุ่ม "ส่งใหม่"
 *
 * ★ เรียก server action ผ่าน useTransition + router.refresh() ตาม pattern RowActions.tsx
 * ★ PDPA: ไม่ log payload/ยอดเงิน/เลขภาษี (ไม่มี console.* ที่นี่)
 */

/** วันเวลาไทย (พ.ศ.) จาก ISO string — ใช้แสดง "ส่งล่าสุด" */
function formatSyncedAt(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear() + 543;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

export default function FlowAccountSyncButton({
  entryId,
  entryType,
  status,
  customerId,
  sync,
}: {
  entryId: string;
  entryType: EntryType;
  status: EntryStatus;
  /** ลูกค้าเจ้าของบิล — null/ไม่มี = ไม่ผูกลูกค้า → ไม่โชว์ปุ่ม */
  customerId?: string | null;
  sync: FlowAccountSyncInfo;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ★ เกณฑ์แสดงปุ่ม: บิลขาย/บิลซื้อ + ยืนยันแล้ว + มีลูกค้าผูก เท่านั้น (เฟส 5 ส่วน P — เปิดให้บิลซื้อด้วย)
  if ((entryType !== "sale" && entryType !== "purchase") || status !== "confirmed" || !customerId) {
    return null;
  }

  function handleSend() {
    setErrorMsg(null);
    startTransition(async () => {
      const res = await sendToFlowAccountAction(entryId);
      if (res.ok) {
        router.refresh();
      } else {
        setErrorMsg(res.message);
      }
    });
  }

  // ---- syncing (จาก DB) หรือกำลังรอ transition ของปุ่มนี้ ----
  if (sync.status === "syncing" || pending) {
    return (
      <div className="fa-sync">
        <button type="button" className="acc-mini-btn" disabled aria-busy="true">
          <span className="fa-sync-spinner" aria-hidden="true" />
          กำลังส่ง...
        </button>
      </div>
    );
  }

  // ---- synced ไม่ต้อง resync: ป้ายเขียว + วันเวลา + เลขที่เอกสาร ----
  if (sync.status === "synced" && !sync.needsResync) {
    return (
      <div className="fa-sync">
        <span className="fa-sync-badge fa-sync-badge-ok">ส่งแล้ว ✓</span>
        <div className="fa-sync-meta">
          <span>{formatSyncedAt(sync.syncedAt)}</span>
          {sync.docNo ? <span>เลขที่: {sync.docNo}</span> : null}
        </div>
      </div>
    );
  }

  // ---- synced แต่ needsResync: ป้ายเตือนส้ม + ปุ่มส่งใหม่ ----
  if (sync.status === "synced" && sync.needsResync) {
    return (
      <div className="fa-sync">
        <span className="fa-sync-badge fa-sync-badge-warn">แก้ไขแล้ว ควรส่งใหม่</span>
        <div className="fa-sync-meta">
          <span>ส่งล่าสุด: {formatSyncedAt(sync.syncedAt)}</span>
          {sync.docNo ? <span>เลขที่เดิม: {sync.docNo}</span> : null}
        </div>
        <button type="button" className="acc-mini-btn" onClick={handleSend} disabled={pending}>
          ส่งใหม่
        </button>
        {errorMsg ? <div className="fa-sync-error">{errorMsg}</div> : null}
      </div>
    );
  }

  // ---- not_synced / failed: ปุ่ม "ส่งไป FlowAccount" (+ error สั้น ๆ ถ้า failed) ----
  return (
    <div className="fa-sync">
      <button type="button" className="acc-mini-btn" onClick={handleSend} disabled={pending}>
        ส่งไป FlowAccount
      </button>
      {errorMsg ? (
        <div className="fa-sync-error">{errorMsg}</div>
      ) : sync.status === "failed" && sync.lastError ? (
        <div className="fa-sync-error">{sync.lastError}</div>
      ) : null}
    </div>
  );
}
