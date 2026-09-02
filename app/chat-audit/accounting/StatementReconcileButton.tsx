"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ปุ่มหลัก "กระทบยอดบิลกับสเตทเมนต์" บนหัวการ์ดลูกค้า (requirement 2026-09-02 —
 *   ย้ายออกจากกล่องอัปโหลดไฟล์เอง มาเป็นปุ่มหลักในหน้าอ่านบิล + เปลี่ยนชื่อ)
 * ★ เปิด "ในหน้าเดิม" เป็น overlay (iframe /statement?embed=1) — ไม่เด้งออกไปหน้าอื่น
 * ★ ปิดแล้ว router.refresh() — บิล/สถานะที่เปลี่ยนใน overlay โผล่ทันที
 */
export default function StatementReconcileButton({
  customerId,
  accountant = null,
  label = "กระทบยอดบิลกับสเตทเมนต์",
}: {
  customerId: string;
  accountant?: string | null;
  label?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);

  function open() {
    const sp = new URLSearchParams({ embed: "1", customerId });
    if (accountant) sp.set("accountant", accountant);
    setUrl(`/chat-audit/accounting/statement?${sp.toString()}`);
  }

  return (
    <>
      <button type="button" className="btn" style={{ border: "2px solid #2563eb", color: "#1d4ed8", fontWeight: 700 }} onClick={open}>
        📑 {label}
      </button>
      {url ? (
        <div className="stmt-overlay" role="dialog" aria-modal="true" aria-label={label}>
          <div className="stmt-overlay-bar">
            <b>📑 {label}</b>
            <span style={{ flex: 1 }} />
            <a
              href={url.replace(/([?&])embed=1(&|$)/, "$1").replace(/[?&]$/, "")}
              target="_blank"
              rel="noopener"
              className="btn btn-ghost"
            >
              เปิดแท็บใหม่ ↗
            </a>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setUrl(null);
                router.refresh();
              }}
            >
              ✕ ปิด
            </button>
          </div>
          <iframe className="stmt-overlay-frame" src={url} title={label} />
        </div>
      ) : null}
    </>
  );
}
