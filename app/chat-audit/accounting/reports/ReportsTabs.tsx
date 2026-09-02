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
      {/* ★ 2026-09-02 ผู้ใช้: "พิมพ์แก้ตรงนี้ได้เลย เหมือนหน้าสมุดบัญชี" — ตารางทุกแท็บ
          แก้ข้อความ/ตัวเลขตรงบนจอได้ (contentEditable) ใช้ดู/พิมพ์เท่านั้น ไม่กระทบบิลจริง
          (Excel export ยังใช้ตัวเลขจริงจากระบบ · แก้ข้อมูลจริงให้ไปที่ ตรวจ/แก้บิล) */}
      <p className="muted no-print" style={{ fontSize: 12, margin: "0 0 8px" }}>
        ✏️ คลิกแก้ข้อความ/ตัวเลขบนตารางได้เลย (เฉพาะการแสดง/พิมพ์หน้านี้ — ไม่กระทบข้อมูลบิลจริง)
      </p>
      {items.map((c, i) => (
        <div
          key={tabs[i]?.key ?? i}
          hidden={i !== idx}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          style={{ outline: "none" }}
        >
          {c}
        </div>
      ))}
    </>
  );
}
