"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setInputTaxMonthAction } from "./actions";
import { taxMonthOptions, taxMonthLabel } from "@/lib/accounting/tax-month";
import { monthOf } from "@/lib/accounting/queries";

/**
 * ตัวเลือก "ยื่นภาษีในเดือน" เล็ก ๆ ในแถวบิล (list) — เฉพาะบิลซื้อ
 *
 * บริบท: บิลซื้อยกภาษีซื้อไปใช้เดือนถัดไปได้ (≤6 เดือน) → เลือกเดือนที่แถวได้เลยไม่ต้องเปิดบิล.
 *   ค่าเริ่มต้น = effectiveTaxMonth (inputTaxMonth ?? เดือน doc_date).
 *   ตัวเลือก = เดือนของ doc_date + 6 เดือนถัดไป (label ไทย พ.ศ.).
 *
 * ★ perf: client เล็ก ไม่ดึงข้อมูลเพิ่ม — ค่ามากับ BillEntry อยู่แล้ว (inputTaxMonth/docDate)
 * ★ เปลี่ยนแล้ว → server action (guard/validate/สโคปที่ server) → router.refresh()
 *   ★ บิลไม่มี doc_date + ไม่ระบุเดือน → ไม่มีเดือนฐาน → ไม่โชว์ (เปิดบิลลงวันที่ก่อน)
 */
export default function InputTaxMonthCell({
  entryId,
  inputTaxMonth,
  docDate,
}: {
  entryId: string;
  inputTaxMonth: string | null;
  docDate: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // เดือนฐานสำหรับตัวเลือก = เดือนของ doc_date (บิลไม่มีวันที่ → ใช้ inputTaxMonth ถ้ามี)
  const baseYm = monthOf(docDate) ?? inputTaxMonth ?? "";
  // ★ ค่าปัจจุบัน = "เดือนที่ติ๊ก" เท่านั้น (ไม่ยึดวันที่บิล) · ยังไม่ติ๊ก = "" → ยังไม่เข้ารายงาน
  const current = inputTaxMonth ?? "";
  const notTagged = !current;

  const opts = taxMonthOptions(baseYm);
  // เผื่อ inputTaxMonth เดิมอยู่นอกช่วงตัวเลือก (เช่นเคยตั้งไว้ไกล) → คงให้เลือกอยู่
  if (current && !opts.includes(current)) opts.unshift(current);

  // ไม่มีเดือนฐานเลย (บิลยังไม่ลงวันที่ + ไม่เคยตั้งเดือน) → ไม่โชว์ตัวเลือก
  if (opts.length === 0) return null;

  function onPick(next: string) {
    setMsg(null);
    if (next === current) return; // ไม่เปลี่ยน → ไม่ยิง
    startTransition(async () => {
      const res = await setInputTaxMonthAction(entryId, next || null);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <span
      className={`acc-itm${notTagged ? " acc-itm-empty" : ""}`}
      title="เดือนที่นำภาษีซื้อของบิลนี้ไปยื่น (ยกได้ ≤ 6 เดือน) — ต้องเลือกก่อนถึงเข้ารายงาน"
    >
      <span className="acc-itm-label">ยื่นภาษีในเดือน</span>
      <select
        className="acc-itm-select"
        value={current}
        onChange={(e) => onPick(e.target.value)}
        disabled={pending}
        aria-label="ยื่นภาษีในเดือน"
        style={notTagged ? { borderColor: "#e0a020", background: "#fff9ec", color: "#8a5a00" } : undefined}
      >
        {notTagged ? <option value="">— เลือกเดือน —</option> : null}
        {opts.map((ym) => (
          <option key={ym} value={ym}>
            {taxMonthLabel(ym)}
          </option>
        ))}
      </select>
      {msg && !msg.ok ? <span className="acc-itm-msg err">{msg.text}</span> : null}
    </span>
  );
}
