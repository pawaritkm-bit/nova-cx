"use client";

import { useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import {
  createChartAccountAction,
  updateChartAccountAction,
  toggleChartAccountActiveAction,
  deleteChartAccountAction,
  type ActionResult,
} from "./actions";
import type { ChartAccountRow } from "@/lib/accounting/chart-accounts-data";
import { CATEGORY_BY_DIGIT } from "@/lib/accounting/chart-of-accounts";

const CATEGORY_OPTIONS = Object.values(CATEGORY_BY_DIGIT);

/** ข้อความผลลัพธ์ของ action (ok/err) */
function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`action-msg ${state.ok ? "ok" : "err"}`}>{state.message}</p>;
}

/** ฟอร์มเพิ่มบัญชีใหม่ */
function AddAccountForm() {
  const [state, formAction] = useActionState(createChartAccountAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      action={formAction}
      ref={formRef}
      className="inline-form"
      style={{ flexWrap: "wrap", marginBottom: 12 }}
      onSubmit={() => {
        // ★ เคลียร์ฟอร์มหลัง submit สำเร็จ (useActionState ไม่รีเซ็ต input ให้เอง)
        requestAnimationFrame(() => {
          if (formRef.current) formRef.current.reset();
        });
      }}
    >
      <input name="code" placeholder="รหัสบัญชี เช่น 5900" maxLength={20} required style={{ width: 130 }} />
      <input name="name" placeholder="ชื่อบัญชี" maxLength={200} required style={{ width: 220 }} />
      <select name="category" defaultValue={CATEGORY_OPTIONS[4] ?? ""} required>
        {CATEGORY_OPTIONS.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
        <input type="checkbox" name="isBank" /> เงินฝากธนาคาร
      </label>
      <button type="submit" className="btn">เพิ่มบัญชี</button>
      <Msg state={state} />
    </form>
  );
}

/** 1 แถวผังบัญชี — แก้ไข/สลับสถานะ/ลบ */
function AccountRow({
  account,
  isProtected,
  isBankStructural,
}: {
  account: ChartAccountRow;
  isProtected: boolean;
  isBankStructural: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [updState, updAction] = useActionState(updateChartAccountAction, null);
  const [toggleState, toggleAction] = useActionState(toggleChartAccountActiveAction, null);
  const [delState, delAction] = useActionState(deleteChartAccountAction, null);
  const delFormRef = useRef<HTMLFormElement>(null);

  function confirmDelete() {
    if (window.confirm(`ลบบัญชี "${account.code} ${account.name}" ? (ซ่อนจากผัง — กู้คืนได้จากฐานข้อมูล)`)) {
      delFormRef.current?.requestSubmit();
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={5}>
          <form action={updAction} className="inline-form" style={{ flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={account.id} />
            <input
              name="code"
              defaultValue={account.code}
              maxLength={20}
              required
              readOnly={isProtected || isBankStructural}
              title={isProtected || isBankStructural ? "รหัสโครงสร้าง — แก้รหัสไม่ได้" : undefined}
              style={{ width: 110 }}
            />
            <input name="name" defaultValue={account.name} maxLength={200} required style={{ width: 220 }} />
            <select name="category" defaultValue={account.category} required>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
              <input type="checkbox" name="isBank" defaultChecked={!!account.bank} /> เงินฝากธนาคาร
            </label>
            <button type="submit" className="btn">บันทึก</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>ยกเลิก</button>
          </form>
          <Msg state={updState} />
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{account.code}</td>
      <td>{account.name}</td>
      <td>{account.category}</td>
      <td className="center">
        {account.bank ? <span className="badge b-green">เงินฝาก</span> : <span className="muted">—</span>}
      </td>
      <td className="center">
        <div className="inline-form" style={{ justifyContent: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>แก้ไข</button>
          <form action={toggleAction}>
            <input type="hidden" name="id" value={account.id} />
            <input type="hidden" name="isActive" value={account.isActive ? "0" : "1"} />
            <button type="submit" className="btn btn-ghost">
              {account.isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"}
            </button>
          </form>
          {isProtected ? (
            <span className="badge b-orange" title="รหัสโครงสร้างที่ระบบบัญชีผูกไว้ — ลบไม่ได้">
              ป้องกันการลบ
            </span>
          ) : (
            <form action={delAction} ref={delFormRef}>
              <input type="hidden" name="id" value={account.id} />
              <button type="button" className="btn danger" onClick={confirmDelete}>ลบ</button>
            </form>
          )}
        </div>
        <Msg state={toggleState} />
        <Msg state={delState} />
      </td>
    </tr>
  );
}

export default function ChartOfAccountsPanel({
  accounts,
  protectedCodes,
  bankStructuralCodes,
}: {
  accounts: ChartAccountRow[];
  /** รหัสโครงสร้างที่ลบไม่ได้เสมอ (VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้/กำไรสะสม) */
  protectedCodes: string[];
  /** รหัสเงินฝากธนาคาร generic ที่ customer_bank_accounts ผูกอยู่ (1020/1025/1030) */
  bankStructuralCodes: string[];
}) {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const protectedSet = useMemo(() => new Set(protectedCodes), [protectedCodes]);
  const bankStructuralSet = useMemo(() => new Set(bankStructuralCodes), [bankStructuralCodes]);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    // ★ ค้นด้วยตัวเลข = จับจาก "เลขหลักแรก" (prefix) — หมวดบัญชีอิงเลขหน้า (ผู้ใช้สั่ง 2026-09-02):
    //   พิมพ์ "40" เจอ 4030/4010 (หมวด 4) แต่ไม่เจอ 3040 · ชื่อบัญชียังค้นแบบมีคำอยู่ตรงไหนก็เจอ
    const isNumeric = /^\d+$/.test(s);
    return accounts.filter((a) => {
      if (!showInactive && !a.isActive) return false;
      if (!s) return true;
      const codeHit = isNumeric ? a.code.toLowerCase().startsWith(s) : a.code.toLowerCase().includes(s);
      return codeHit || a.name.toLowerCase().includes(s);
    });
  }, [accounts, query, showInactive]);

  return (
    <div className="card">
      <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        ผังบัญชีนี้ใช้ร่วมทุกลูกค้าภายในสำนักงานของคุณ — รหัสโครงสร้าง (VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้/กำไรสะสม/เงินฝากธนาคาร)
        ลบไม่ได้ (แก้ชื่อ/หมวดได้ปกติ)
      </p>
      <AddAccountForm />
      <div className="inline-form" style={{ marginBottom: 8 }}>
        <input
          placeholder="ค้นรหัส/ชื่อบัญชี"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 240 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          แสดงบัญชีที่ปิดใช้งาน
        </label>
        <span className="muted" style={{ fontSize: 13 }}>{filtered.length} / {accounts.length} รายการ</span>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>รหัส</th>
            <th>ชื่อบัญชี</th>
            <th>หมวด</th>
            <th className="center">เงินฝาก</th>
            <th className="center">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              isProtected={protectedSet.has(a.code)}
              isBankStructural={bankStructuralSet.has(a.code)}
            />
          ))}
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted center">ไม่พบบัญชีที่ตรงกับคำค้น</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
