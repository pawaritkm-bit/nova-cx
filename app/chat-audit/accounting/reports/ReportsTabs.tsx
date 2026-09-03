"use client";

import { Children, useState, type ReactNode } from "react";

/**
 * แท็บรายงานแบบ client — ★ 2026-09-02 ผู้ใช้: "แต่ละปุ่มกดแล้วช้า แก้ให้เร็วขึ้น"
 *   เดิมแท็บเป็น <Link> → โหลดหน้าใหม่ทั้งหน้า (ดึงบิลทั้งชุด + คำนวณงบใหม่) ทุกคลิก
 *   ทั้งที่ข้อมูลชุดเดียวกัน · แก้: server คำนวณครบทั้ง 5 รายงานในรอบเดียว (ทำอยู่แล้ว)
 *   แล้วส่งมาเป็น children — สลับแท็บฝั่ง client ล้วน = เปลี่ยนทันที ไม่ยิง server ซ้ำ
 * children ต้องเรียงตามลำดับ tabs (1 child ต่อ 1 แท็บ)
 */
export default function ReportsTabs({
  tabs,
  initial,
  exportHrefs,
  allHref,
  children,
}: {
  tabs: { key: string; label: string }[];
  initial: string;
  /** href ปุ่ม Export Excel ต่อแท็บ (เรียงตาม tabs) */
  exportHrefs: string[];
  /** href ปุ่ม Export ทั้งหมด */
  allHref: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState(
    tabs.some((t) => t.key === initial) ? initial : tabs[0]?.key ?? ""
  );
  const idx = Math.max(0, tabs.findIndex((t) => t.key === active));
  const items = Children.toArray(children);
  return (
    <>
      <div className="acc-subtabs" style={{ marginBottom: 14 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`acc-subtab${active === t.key ? " active" : ""}`}
            style={{ cursor: "pointer" }}
            aria-current={active === t.key ? "page" : undefined}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span className="acc-toolbar-spacer" />
        <a href={exportHrefs[idx]} className="btn">⬇ Export {tabs[idx]?.label} (Excel)</a>
        <a href={allHref} className="btn btn-ghost">⬇ ทั้งหมด</a>
      </div>
      {/* ★ 2026-09-03 ผู้ใช้: "หน้างบการเงิน ปรับให้แก้ไม่ได้เหมือนกัน" — ถอด contentEditable ออก
          (เดิม 2026-09-02 เปิดแก้บนจอได้) รายงานอ่านอย่างเดียว ตัวเลขตรงบิลจริงเสมอ
          ต้องการแก้ = ไปแก้ที่บิล/รายการปรับปรุง แล้วรายงานคำนวณใหม่ให้เอง */}
      {items.map((c, i) => (
        <div key={tabs[i]?.key ?? i} hidden={i !== idx}>
          {c}
        </div>
      ))}
    </>
  );
}
