"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveEntryCustomerAction, listCustomerOptionsAction } from "../actions";

/**
 * ปุ่ม "ย้ายบริษัท" บนการ์ดบิล (โต๊ะทำงาน) — ★ 2026-09-03 ผู้ใช้: "ปุ่มส่งบิลไปบริษัทอื่นอยู่ตรงไหน"
 *   ปุ่มเดิมอยู่ในตารางหน้า list เก่าซึ่งถูกโต๊ะทำงานแทนที่แล้ว (เข้าไม่ถึง) → ย้ายมาการ์ดนี้
 *   ★ server เป็นคน gate สิทธิ์: หน้า workspace ส่ง prop มาเฉพาะ admin/ผู้ดูแลกลุ่มรวมหลายบริษัท
 *     และ moveEntryCustomerAction เช็กซ้ำอีกชั้น (กันยิงตรง)
 */
export default function MoveBillButton({ entryId, customerId }: { entryId: string; customerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; label: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function toggle() {
    setErr(null);
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (options === null) {
      start(async () => {
        setOptions(await listCustomerOptionsAction());
      });
    }
  }

  function move(targetId: string) {
    if (!targetId) return;
    const label = options?.find((o) => o.id === targetId)?.label ?? "บริษัทที่เลือก";
    if (!window.confirm(`ย้ายบิลนี้ไป "${label}"?\nสมุดบัญชี/งบของทั้งสองบริษัทจะอัปเดตตามทันที`)) return;
    setErr(null);
    start(async () => {
      const r = await moveEntryCustomerAction(entryId, targetId);
      if (r.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className="wsp-btn ghost"
        onClick={toggle}
        disabled={pending}
        title="ย้ายบิลนี้ไปบริษัท/ลูกค้าอื่นที่คุณดูแล (เคส AI แยกบิลผิดบริษัท)"
      >
        ⇄ ย้ายบริษัท
      </button>
      {open ? (
        <select
          className="wsp-move-select"
          defaultValue=""
          disabled={pending || options === null}
          onChange={(e) => move(e.target.value)}
          aria-label="เลือกบริษัทปลายทาง"
        >
          <option value="" disabled>
            {options === null ? "กำลังโหลดรายชื่อบริษัท…" : "เลือกบริษัทปลายทาง…"}
          </option>
          {(options ?? [])
            .filter((o) => o.id !== customerId)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </select>
      ) : null}
      {err ? <span className="wsp-delerr">{err}</span> : null}
    </>
  );
}
