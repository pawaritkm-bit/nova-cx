"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reassignCustomerAction, updateCustomerFieldsAction } from "./customer-admin-actions";

/** นักบัญชี 1 คนสำหรับ dropdown */
export type AccountantOption = { employeeId: string; name: string };

/**
 * แผงจัดการลูกค้า (เฉพาะ admin) ในหัวการ์ดลูกค้า หน้า /chat-audit/accounting
 *   1) เปลี่ยนผู้ดูแล — เลือกนักบัญชีจาก dropdown → reassignCustomerAction
 *   2) แก้ไขข้อมูลลูกค้า — ชื่อ / รหัส / เลขภาษี (inline) → updateCustomerFieldsAction
 *
 * ★ server เป็นคน gate ว่าจะ render ไหม (แสดงเฉพาะ admin) + guard ซ้ำใน action
 * ★ กลมกลืน (คลาส acc-*) · สำเร็จ → router.refresh (สโคป/ป้ายผู้ดูแล sync กับ server)
 */
export default function CustomerAdminControls({
  customerId,
  currentAccountantId,
  accountants,
  initialName,
  initialCode,
  initialTaxId,
  initialAddress,
}: {
  customerId: string;
  currentAccountantId: string | null;
  accountants: AccountantOption[];
  initialName: string | null;
  initialCode: string | null;
  initialTaxId: string | null;
  /** ที่อยู่บริษัทลูกค้า (customers.address) — undefined ถ้าคอลัมน์ยังไม่ apply */
  initialAddress?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // ---- เปลี่ยนผู้ดูแล ----
  const [assignOpen, setAssignOpen] = useState(false);
  const [empId, setEmpId] = useState(currentAccountantId ?? "");
  const [assignMsg, setAssignMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ---- แก้ไขข้อมูลลูกค้า ----
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(initialName ?? "");
  const [code, setCode] = useState(initialCode ?? "");
  const [taxId, setTaxId] = useState(initialTaxId ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [editMsg, setEditMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function doReassign() {
    setAssignMsg(null);
    if (!empId) {
      setAssignMsg({ ok: false, text: "กรุณาเลือกนักบัญชี" });
      return;
    }
    if (empId === currentAccountantId) {
      setAssignMsg({ ok: false, text: "เป็นผู้ดูแลคนเดิมอยู่แล้ว" });
      return;
    }
    startTransition(async () => {
      const res = await reassignCustomerAction(customerId, empId);
      setAssignMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setAssignOpen(false);
        router.refresh();
      }
    });
  }

  function doUpdate() {
    setEditMsg(null);
    if (!name.trim()) {
      setEditMsg({ ok: false, text: "ชื่อลูกค้าห้ามว่าง" });
      return;
    }
    startTransition(async () => {
      const res = await updateCustomerFieldsAction(customerId, {
        name,
        code, // "" = ล้างรหัส
        taxId, // "" = ล้างเลขภาษี
        address, // "" = ล้างที่อยู่
      });
      setEditMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setEditOpen(false);
        router.refresh();
      }
    });
  }

  const currentName =
    accountants.find((a) => a.employeeId === currentAccountantId)?.name ?? null;

  return (
    <div className="acc-scopebar" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
      <span className="acc-scope-label">จัดการ (แอดมิน)</span>

      {/* ---- เปลี่ยนผู้ดูแล ---- */}
      {!assignOpen ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setAssignOpen(true);
            setEditOpen(false);
          }}
          disabled={pending}
          title="เปลี่ยนนักบัญชี/ทีมงานที่ดูแลลูกค้ารายนี้"
        >
          🔁 เปลี่ยนผู้ดูแล{currentName ? ` (ตอนนี้: ${currentName})` : ""}
        </button>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <select
            className="acc-taxid-input"
            value={empId}
            onChange={(e) => setEmpId(e.target.value)}
            disabled={pending}
            aria-label="เลือกนักบัญชีที่จะมอบหมาย"
          >
            <option value="">— เลือกนักบัญชี —</option>
            {accountants.map((a) => (
              <option key={a.employeeId} value={a.employeeId}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={doReassign} disabled={pending}>
            {pending ? "…" : "บันทึก"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setAssignOpen(false);
              setAssignMsg(null);
              setEmpId(currentAccountantId ?? "");
            }}
            disabled={pending}
          >
            ยกเลิก
          </button>
        </span>
      )}

      {/* ---- แก้ไขข้อมูลลูกค้า ---- */}
      {!editOpen ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setEditOpen(true);
            setAssignOpen(false);
          }}
          disabled={pending}
          title="แก้ชื่อ / รหัสลูกค้า / เลขภาษี"
        >
          ✏️ แก้ไขข้อมูลลูกค้า
        </button>
      ) : null}

      {assignMsg ? (
        <span className={`action-msg ${assignMsg.ok ? "" : "err"}`} style={assignMsg.ok ? { color: "#166534" } : undefined}>
          {assignMsg.text}
        </span>
      ) : null}

      {/* ฟอร์มแก้ไข (เต็มบรรทัด) */}
      {editOpen ? (
        <div
          style={{
            flexBasis: "100%",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "flex-end",
            marginTop: 6,
          }}
        >
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">ชื่อลูกค้า</span>
            <input
              className="acc-taxid-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อลูกค้า"
              maxLength={200}
              disabled={pending}
            />
          </label>
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">รหัสลูกค้า</span>
            <input
              className="acc-taxid-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="รหัสลูกค้า (เว้นว่างได้)"
              maxLength={60}
              disabled={pending}
            />
          </label>
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">เลขภาษี</span>
            <input
              className="acc-taxid-input"
              inputMode="numeric"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder="เลขผู้เสียภาษี 13 หลัก (เว้นว่างได้)"
              maxLength={20}
              disabled={pending}
            />
          </label>
          <label className="acc-taxid-field" style={{ margin: 0, flexBasis: "100%" }}>
            <span className="acc-taxid-label">ที่อยู่ (ขึ้นหัวรายงานภาษีซื้อ/ขาย)</span>
            <textarea
              className="acc-taxid-input"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="ที่อยู่บริษัทลูกค้า (เว้นว่างได้)"
              maxLength={500}
              rows={2}
              disabled={pending}
              style={{ width: "100%", resize: "vertical" }}
            />
          </label>
          <button type="button" className="btn" onClick={doUpdate} disabled={pending}>
            {pending ? "กำลังบันทึก…" : "บันทึกข้อมูล"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setEditOpen(false);
              setEditMsg(null);
              setName(initialName ?? "");
              setCode(initialCode ?? "");
              setTaxId(initialTaxId ?? "");
              setAddress(initialAddress ?? "");
            }}
            disabled={pending}
          >
            ยกเลิก
          </button>
          {editMsg ? (
            <span
              className={`action-msg ${editMsg.ok ? "" : "err"}`}
              style={editMsg.ok ? { color: "#166534" } : undefined}
            >
              {editMsg.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
