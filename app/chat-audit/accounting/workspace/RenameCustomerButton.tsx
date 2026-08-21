"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameCustomerDisplayNameAction } from "./rename-actions";

/**
 * ปุ่มแก้ชื่อลูกค้า (โต๊ะทำงาน) → เปลี่ยนชื่อในระบบ + rename โฟลเดอร์ OneDrive ทันที
 *   ★ พิมพ์ในระบบ CX (ชื่อ "แก้ไขชื่อ" ใน LINE OA ระบบอ่านไม่ได้)
 */
export default function RenameCustomerButton({ customerId, currentName }: { customerId: string; currentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="wsp-rename-ic" title="แก้ชื่อลูกค้า (เปลี่ยนชื่อโฟลเดอร์ด้วย)" onClick={() => { setName(currentName); setMsg(null); setOpen(true); }}>
        ✏️ แก้ชื่อ
      </button>
    );
  }
  return (
    <span className="wsp-rename-box">
      <input className="wsp-rename-input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="ชื่อลูกค้า" />
      <button
        type="button"
        className="wsp-btn primary"
        disabled={pending || !name.trim()}
        onClick={() => {
          setMsg(null);
          start(async () => {
            const r = await renameCustomerDisplayNameAction(customerId, name.trim());
            if (r.ok) { setOpen(false); router.refresh(); }
            else setMsg(r.message);
          });
        }}
      >
        {pending ? "กำลังบันทึก…" : "บันทึก"}
      </button>
      <button type="button" className="wsp-btn ghost" disabled={pending} onClick={() => setOpen(false)}>ยกเลิก</button>
      {msg ? <span className="wsp-delerr">{msg}</span> : null}
    </span>
  );
}
