"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchChartNonBankGrouped, type ChartAccount } from "@/lib/accounting/chart-of-accounts";

/**
 * AccountCombobox — ตัวเลือก "บัญชี" จากผังบัญชีมาตรฐานของ tenant (ใช้ร่วมทุกหน้าที่เลือกบัญชี)
 *   ★ เดิมเป็น AccountCell ภายใน EntryEditor.tsx — แยกออกมาเป็น component กลาง เพื่อ reuse ใน
 *     หน้าลงบันทึกบัญชีเอง (journal-entry/JournalEntryPanel.tsx, เฟส 1 ส่วน C) โดยไม่ต้องเขียนซ้ำ
 *
 *   3 โหมด:
 *     - readOnly (ยืนยันแล้ว) : แสดงรหัส + ชื่อ อ่านอย่างเดียว
 *     - ยังไม่เลือก           : combobox ค้นหา (พิมพ์กรอง → คลิก/Enter เลือก · Esc ปิด)
 *     - เลือกแล้ว             : รหัส (badge ล็อก อ่านอย่างเดียว) + ชื่อบัญชี (แก้ได้) + ปุ่ม "เปลี่ยน"
 *   ★ รหัสล็อกเสมอ — เปลี่ยนได้เฉพาะกด "เปลี่ยน" (ล้าง code+name) แล้วเลือกใหม่
 *   ★ เขียน combobox เองด้วย state (ไม่พึ่งไลบรารีนอก)
 */
export default function AccountCombobox({
  accountCode,
  accountName,
  fallbackLabel,
  chart,
  readOnly,
  onSelect,
  onNameChange,
  onClear,
}: {
  accountCode: string;
  accountName: string;
  /** ข้อความสำรองตอน readOnly (ไม่มีชื่อบัญชี) — เช่น description ของบรรทัดนั้น */
  fallbackLabel?: string | null;
  /** ผังบัญชีของ tenant (โหลดจาก DB โดย page.tsx ต้นทาง) */
  chart: ChartAccount[];
  readOnly: boolean;
  onSelect: (code: string, name: string) => void;
  onNameChange: (name: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // ★ 2026-09-03 ผู้ใช้: "พิมพ์เลขแล้ว Enter ได้เลย และกดเครื่องหมายขึ้นลงได้ด้วย"
  //   — ไฮไลต์รายการในลิสต์ เลื่อนด้วย ↑↓ · Enter เลือกตัวที่ไฮไลต์ (default = ตัวแรก)
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // ผังกลางจัดกลุ่มตามหมวด (รวมบัญชีเงินฝากธนาคารในหมวด 1 แล้ว)
  //   ★ พิมพ์เลข 1–6 = เด้งทั้งหมวดนั้นมาให้เลื่อนเลือก · อย่างอื่น = ค้น substring ตามเดิม
  const chartGroups = useMemo(() => searchChartNonBankGrouped(chart, q), [chart, q]);
  // ลิสต์แบน (เรียงตามที่โชว์) — ใช้เดินด้วยลูกศร/Enter
  const flatOptions = useMemo(() => chartGroups.flatMap((g) => g.accounts), [chartGroups]);
  const selected = !!accountCode;

  // ปิด dropdown เมื่อคลิกนอกกล่อง
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (code: string, name: string) => {
    onSelect(code, name);
    setOpen(false);
    setQ("");
  };

  // ยืนยันแล้ว → อ่านอย่างเดียว
  if (readOnly) {
    return (
      <div className="acc-acct acc-acct-ro">
        {accountCode ? <span className="acc-acct-code">{accountCode}</span> : null}
        <span className="acc-acct-name-ro">{accountName || fallbackLabel || "—"}</span>
      </div>
    );
  }

  // เลือกแล้ว → 2 ช่องแยกไม่ชนกัน: แถวบน = รหัส (ล็อก) + ปุ่มเปลี่ยน · แถวล่าง = ชื่อ (แก้ได้)
  if (selected) {
    return (
      <div className="acc-acct acc-acct-picked">
        <div className="acc-acct-toprow">
          <span className="acc-acct-code" title="รหัสบัญชี (ล็อก — กด 'เปลี่ยน' เพื่อเลือกใหม่)">
            🔒 {accountCode}
          </span>
          <button type="button" className="acc-acct-change" onClick={onClear} title="เลือกบัญชีใหม่">
            เปลี่ยน
          </button>
        </div>
        <input
          type="text"
          className="acc-acct-name"
          value={accountName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="ชื่อบัญชี (แก้ได้)"
          aria-label="ชื่อบัญชี"
        />
      </div>
    );
  }

  // ยังไม่เลือก → combobox ค้นหา
  return (
    <div className="acc-acct acc-acct-combo" ref={boxRef}>
      <input
        type="text"
        className="acc-acct-search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0); // พิมพ์ใหม่ = ไฮไลต์กลับตัวแรก
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Enter = เลือกตัวที่ไฮไลต์อยู่ (default ตัวแรก) — พิมพ์เลขแล้ว Enter ได้เลย
            const opt = flatOptions[Math.min(hi, flatOptions.length - 1)] ?? flatOptions[0];
            if (opt) pick(opt.code, opt.name);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, Math.max(flatOptions.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="เลือก/ค้นหาบัญชี…"
        aria-label="ค้นหาบัญชีจากผังบัญชี"
      />
      {open ? (
        <div className="acc-acct-list" role="listbox">
          {/* ผังบัญชีกลาง จัดตามหมวด (พิมพ์เลข 1–6 = เด้งทั้งหมวด) — เงินฝากธนาคารอยู่ในหมวด 1 */}
          {chartGroups.length === 0 ? (
            <>
              <div className="acc-acct-group">ผังบัญชี</div>
              <div className="acc-acct-empty">ไม่พบบัญชีที่ค้นหา</div>
            </>
          ) : (
            chartGroups.map((grp) => (
              <div key={grp.digit} className="acc-acct-cat">
                <div className="acc-acct-group">
                  {grp.digit} {grp.category}
                </div>
                {grp.accounts.map((a) => {
                  const isHi = flatOptions[hi]?.code === a.code;
                  return (
                    <button
                      key={a.code}
                      type="button"
                      role="option"
                      aria-selected={isHi}
                      className={`acc-acct-opt${isHi ? " acc-acct-opt-hi" : ""}`}
                      // ↑↓ เลื่อนแล้วให้ตัวไฮไลต์อยู่ในสายตาเสมอ
                      ref={isHi ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onMouseEnter={() => {
                        const i = flatOptions.findIndex((o) => o.code === a.code);
                        if (i >= 0) setHi(i);
                      }}
                      onClick={() => pick(a.code, a.name)}
                    >
                      <span className="acc-acct-opt-code">{a.code}</span>
                      <span className="acc-acct-opt-name">{a.name}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
