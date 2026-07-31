"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEntryDocDateAction } from "./actions";

/**
 * ช่องลงวันที่ด่วน (client) สำหรับกล่อง "บิลยังไม่ลงวันที่" — หน้า /chat-audit/accounting
 *
 * บริบท: บิลที่ AI อ่านวันที่ไม่ได้ (เขียนมือ/เงินสด) doc_date=null → ตกเดือน.
 *   นักบัญชีเลือกวันที่ → server เซฟ doc_date ทันที → บิลเด้งเข้าเดือนที่ถูกต้อง (หลุดจากกล่อง).
 *
 * ★ เบา ๆ: input[type=date] + เซฟตอน onChange (ผ่าน server action, guard/validate ที่ server)
 * ★ ระหว่างเซฟ disable กันกดซ้ำ + refresh หน้าเมื่อสำเร็จ (ให้บิลย้ายออกจากกล่อง)
 */
export default function EntryDateField({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onPick(next: string) {
    setValue(next);
    setMsg(null);
    // ยังกรอกไม่ครบ (input date คืน "" ระหว่างแก้) → ยังไม่เซฟ
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    startTransition(async () => {
      const res = await setEntryDocDateAction(entryId, next);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-udate">
      <input
        type="date"
        className="acc-udate-input"
        value={value}
        onChange={(e) => onPick(e.target.value)}
        disabled={pending}
        aria-label="ลงวันที่บิล"
      />
      {msg ? (
        <span className={`acc-udate-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>
      ) : null}
    </div>
  );
}
