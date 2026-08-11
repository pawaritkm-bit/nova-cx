"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COMMON_CURRENCIES, isValidCurrencyCode } from "@/lib/accounting/currency";

/**
 * CurrencyCombobox — ตัวเลือก "สกุลเงิน" ต่อบิล (เฟส 10 ส่วน Z, mirror AccountCombobox.tsx โครงสร้าง)
 *   3 โหมด (เหมือน AccountCombobox):
 *     - readOnly (ยืนยันแล้ว/ล็อกเพราะมีการรับ-จ่ายเงินแล้ว) : แสดงรหัสอ่านอย่างเดียว
 *     - เลือกแล้ว : badge รหัส (ล็อก) + ปุ่ม "เปลี่ยน"
 *     - ยังไม่เลือก : combobox ค้นหา (COMMON_CURRENCIES ~20 สกุลที่พบบ่อย) + free-text 3 ตัวอักษรสำหรับสกุลอื่น
 *   ★ ไม่ query DB — data source คงที่ (COMMON_CURRENCIES) ★ server validate รูปแบบซ้ำเสมอ (0.3)
 */
export default function CurrencyCombobox({
  currency,
  readOnly,
  onSelect,
  onClear,
}: {
  /** รหัสสกุลเงินปัจจุบัน — "" = ยังไม่เลือก (บิล THB ปกติ) */
  currency: string;
  readOnly: boolean;
  onSelect: (code: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = !!currency;

  const results = useMemo(() => {
    const query = q.trim().toUpperCase();
    if (!query) return COMMON_CURRENCIES;
    return COMMON_CURRENCIES.filter((c) => c.code.includes(query) || c.label.toUpperCase().includes(query));
  }, [q]);

  // free-text ที่พิมพ์เป็นรหัสสกุลเงิน 3 ตัวอักษรถูกรูปแบบ แต่ไม่อยู่ใน COMMON_CURRENCIES
  const freeTextCandidate = useMemo(() => {
    const v = q.trim().toUpperCase();
    if (!isValidCurrencyCode(v)) return null;
    if (COMMON_CURRENCIES.some((c) => c.code === v)) return null;
    return v;
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (code: string) => {
    onSelect(code);
    setOpen(false);
    setQ("");
  };

  if (readOnly) {
    return (
      <div className="acc-acct acc-acct-ro">
        {currency ? <span className="acc-acct-code">{currency}</span> : <span className="acc-acct-name-ro">THB</span>}
      </div>
    );
  }

  if (selected) {
    return (
      <div className="acc-acct acc-acct-picked">
        <div className="acc-acct-toprow">
          <span className="acc-acct-code" title="สกุลเงิน (ล็อก — กด 'เปลี่ยน' เพื่อเลือกใหม่)">
            🔒 {currency}
          </span>
          <button type="button" className="acc-acct-change" onClick={onClear} title="เลือกสกุลเงินใหม่ (หรือกลับเป็น THB)">
            เปลี่ยน
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="acc-acct acc-acct-combo" ref={boxRef}>
      <input
        type="text"
        className="acc-acct-search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (freeTextCandidate) {
              pick(freeTextCandidate);
            } else {
              const first = results[0];
              if (first) pick(first.code);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="เลือก/พิมพ์รหัสสกุลเงิน (เช่น USD)…"
        aria-label="ค้นหา/เลือกสกุลเงิน"
        maxLength={10}
      />
      {open ? (
        <div className="acc-acct-list" role="listbox">
          {freeTextCandidate ? (
            <button type="button" role="option" aria-selected={false} className="acc-acct-opt" onClick={() => pick(freeTextCandidate)}>
              <span className="acc-acct-opt-code">{freeTextCandidate}</span>
              <span className="acc-acct-opt-name">ใช้รหัสนี้ (สกุลเงินอื่นนอกลิสต์)</span>
            </button>
          ) : null}
          {results.length === 0 && !freeTextCandidate ? (
            <div className="acc-acct-empty">ไม่พบสกุลเงินที่ค้นหา — พิมพ์รหัส ISO 4217 3 ตัวอักษร (เช่น USD)</div>
          ) : (
            results.map((c) => (
              <button key={c.code} type="button" role="option" aria-selected={false} className="acc-acct-opt" onClick={() => pick(c.code)}>
                <span className="acc-acct-opt-code">{c.code}</span>
                <span className="acc-acct-opt-name">{c.label}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
