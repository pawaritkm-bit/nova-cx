"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  reassignCustomerAction,
  updateCustomerFieldsAction,
  pullCustomerFromNovaSalesAction,
  clearFlowAccountCredentialAction,
} from "./customer-admin-actions";

/** นักบัญชี 1 คนสำหรับ dropdown */
export type AccountantOption = { employeeId: string; name: string };

/**
 * แผงจัดการลูกค้า ในหัวการ์ดลูกค้า หน้า /chat-audit/accounting
 *   1) เปลี่ยนผู้ดูแล — เลือกนักบัญชีจาก dropdown → reassignCustomerAction (★ เฉพาะ admin: canReassign)
 *   2) แก้ไขข้อมูลลูกค้า — ชื่อ / รหัส / เลขภาษี / ที่อยู่ / credential FlowAccount (inline)
 *      → updateCustomerFieldsAction (★ admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น — action assert สโคปซ้ำ)
 *   3) ล้างรหัสลับ FlowAccount — ปุ่มแยกต่างหาก (มี confirm) → clearFlowAccountCredentialAction
 *
 * ★ server เป็นคน gate: render ปุ่มแก้ให้ทุกคนที่เห็นลูกค้า · reassign เฉพาะ canReassign (admin)
 * ★ กลมกลืน (คลาส acc-*) · สำเร็จ → router.refresh (สโคป/ป้ายผู้ดูแล sync กับ server)
 *
 * ★ FlowAccount client id — ไม่ใช่ secret (แค่ตัวระบุ) → prefill ค่าจริงได้เหมือน address/phone
 *   ★ FlowAccount client secret — server ไม่เคยส่ง secret (plaintext/ciphertext) มาที่นี่เลย
 *     (ได้แค่ hasFlowAccountCredential: boolean) → ช่องนี้เริ่มว่างเสมอ ไม่ prefill
 *   ★ "เว้นว่างช่อง secret ไว้ตอนแก้ field อื่น" ต้อง "ไม่ส่ง key นี้ไปเลย" (ไม่ใช่ส่ง "") — ไม่งั้นจะไปล้าง
 *     secret เดิมโดยไม่ตั้งใจทุกครั้งที่กดบันทึก — client id ส่งค่าเสมอเหมือน address/phone ได้ปกติ
 *     (ค่าว่าง = ล้าง client id ตั้งใจ)
 */
export default function CustomerAdminControls({
  customerId,
  canReassign = false,
  currentAccountantId,
  accountants,
  initialName,
  initialCode,
  initialTaxId,
  initialCustomerType,
  initialAddress,
  initialPhone,
  initialFlowAccountClientId,
  hasFlowAccountCredential = false,
}: {
  customerId: string;
  /** true = แสดงปุ่ม "เปลี่ยนผู้ดูแล" (admin เท่านั้น) */
  canReassign?: boolean;
  currentAccountantId: string | null;
  accountants: AccountantOption[];
  initialName: string | null;
  initialCode: string | null;
  initialTaxId: string | null;
  /** ประเภทลูกค้า: 'company'=นิติบุคคล · 'individual'=บุคคลธรรมดา · null=ยังไม่ระบุ */
  initialCustomerType?: "company" | "individual" | null;
  /** ที่อยู่บริษัทลูกค้า (customers.address) — undefined ถ้าคอลัมน์ยังไม่ apply */
  initialAddress?: string | null;
  /** เบอร์โทรติดต่อ (customers.phone) — undefined ถ้าคอลัมน์ยังไม่ apply */
  initialPhone?: string | null;
  /** FlowAccount client id ปัจจุบัน (ไม่ใช่ secret — prefill ได้) — undefined ถ้าคอลัมน์ยังไม่ apply */
  initialFlowAccountClientId?: string | null;
  /** true = ลูกค้ารายนี้ตั้งค่า client id + secret ครบแล้ว (ไม่ใช่ค่าจริง — แค่สถานะ) */
  hasFlowAccountCredential?: boolean;
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
  const [customerType, setCustomerType] = useState<"" | "company" | "individual">(initialCustomerType ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  // FlowAccount client id — prefill ได้ (ไม่ใช่ secret) เหมือน phone/address
  const [flowaccountClientId, setFlowaccountClientId] = useState(initialFlowAccountClientId ?? "");
  // FlowAccount client secret — ★ เริ่มว่างเสมอ (server ไม่ส่งค่าจริงมาให้เลย)
  const [flowaccountClientSecret, setFlowaccountClientSecret] = useState("");
  const [editMsg, setEditMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // สถานะปุ่ม "ดึงจาก NOVA Sales" (แยกจาก pending บันทึก เพื่อโชว์ข้อความของตัวเอง)
  const [pulling, setPulling] = useState(false);
  // สถานะปุ่ม "ล้างรหัสลับ FlowAccount" (แยกจาก pending บันทึกฟอร์มหลัก)
  const [clearingCred, setClearingCred] = useState(false);
  const [credMsg, setCredMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
    // ★ FlowAccount client id: prefill มาแล้ว (ไม่ใช่ secret) — ส่งค่าเสมอเหมือน address/phone
    //   ("" = ล้าง client id ตั้งใจ)
    // ★ FlowAccount client secret: ส่ง key ก็ต่อเมื่อผู้ใช้พิมพ์ค่าใหม่จริง ๆ เท่านั้น —
    //   เว้นว่างไว้เฉย ๆ (ไม่ได้พิมพ์อะไร ช่องนี้ไม่ prefill) ต้อง "ไม่ส่ง key นี้ไปเลย"
    //   กัน server ตีความเป็นการล้าง secret เดิมโดยไม่ตั้งใจ
    const flowFields: { flowaccountClientId?: string; flowaccountClientSecret?: string } = {
      flowaccountClientId,
    };
    if (flowaccountClientSecret.trim() !== "") flowFields.flowaccountClientSecret = flowaccountClientSecret;

    startTransition(async () => {
      const res = await updateCustomerFieldsAction(customerId, {
        name,
        code, // "" = ล้างรหัส
        taxId, // "" = ล้างเลขภาษี
        customerType: customerType === "" ? null : customerType, // ประเภทลูกค้า (นิติบุคคล/บุคคลธรรมดา)
        address, // "" = ล้างที่อยู่
        phone, // "" = ล้างเบอร์โทร
        ...flowFields,
      });
      setEditMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setEditOpen(false);
        // เคลียร์ช่อง FlowAccount กลับเป็นค่าว่างเสมอ (ไม่โชว์ค่าที่เพิ่งพิมพ์ค้างไว้)
        setFlowaccountClientId("");
        setFlowaccountClientSecret("");
        router.refresh();
      }
    });
  }

  /** ล้างรหัสลับ FlowAccount ของลูกค้ารายนี้ทันที (แยกจากการแก้ไขข้อมูลทั่วไป — มี confirm ก่อนลบ) */
  function doClearFlowAccountCredential() {
    if (
      !window.confirm(
        "ยืนยันล้างรหัสลับ FlowAccount ของลูกค้ารายนี้?\nต้องกรอก Client ID/Secret ใหม่ก่อนจึงจะส่งบิลไป FlowAccount ได้อีกครั้ง"
      )
    ) {
      return;
    }
    setCredMsg(null);
    setClearingCred(true);
    startTransition(async () => {
      const res = await clearFlowAccountCredentialAction(customerId);
      setCredMsg({ ok: res.ok, text: res.message });
      setClearingCred(false);
      if (res.ok) {
        setFlowaccountClientId("");
        setFlowaccountClientSecret("");
        router.refresh();
      }
    });
  }

  /**
   * ดึงข้อมูลจาก NOVA Sales ด้วยเลขภาษีของลูกค้า → เติมช่อง ชื่อ/ที่อยู่/เบอร์ ให้
   *   ★ ไม่บันทึกอัตโนมัติ: เติมช่องแล้วให้ผู้ใช้ตรวจ แล้วกด "บันทึกข้อมูล" เอง
   *   ★ เติมเฉพาะช่องที่ NOVA Sales มีค่า (ค่าว่างไม่ทับของเดิมในฟอร์ม)
   */
  function doPull() {
    setEditMsg(null);
    setPulling(true);
    startTransition(async () => {
      const res = await pullCustomerFromNovaSalesAction(customerId);
      if (res.ok && res.data) {
        if (res.data.name) setName(res.data.name);
        if (res.data.address) setAddress(res.data.address);
        if (res.data.phone) setPhone(res.data.phone);
      }
      setEditMsg({ ok: res.ok, text: res.message });
      setPulling(false);
    });
  }

  const currentName =
    accountants.find((a) => a.employeeId === currentAccountantId)?.name ?? null;

  return (
    <div className="acc-scopebar" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
      <span className="acc-scope-label">จัดการลูกค้า</span>

      {/* ---- เปลี่ยนผู้ดูแล (admin เท่านั้น — ห่อทั้งบล็อกด้วย canReassign กันนักบัญชีเห็นฟอร์ม) ---- */}
      {canReassign ? (
        !assignOpen ? (
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
        )
      ) : null}

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
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">ประเภทลูกค้า</span>
            <select
              className="acc-taxid-input"
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as "" | "company" | "individual")}
              disabled={pending}
            >
              <option value="">— ยังไม่ระบุ —</option>
              <option value="company">นิติบุคคล (บริษัท/ห้าง)</option>
              <option value="individual">บุคคลธรรมดา</option>
            </select>
            <span style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
              นิติบุคคล = เปิดเมนูวงจรบัญชีคู่ (สมุดรายวัน 5 เล่ม, งบการเงิน ฯลฯ)
            </span>
          </label>
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">เบอร์โทรติดต่อ</span>
            <input
              className="acc-taxid-input"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="เบอร์โทรติดต่อ (เว้นว่างได้)"
              maxLength={60}
              disabled={pending}
            />
          </label>
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">FlowAccount Client ID</span>
            <input
              className="acc-taxid-input"
              value={flowaccountClientId}
              onChange={(e) => setFlowaccountClientId(e.target.value)}
              placeholder="FlowAccount Client ID (เว้นว่างได้)"
              maxLength={200}
              disabled={pending}
              autoComplete="off"
            />
          </label>
          <label className="acc-taxid-field" style={{ margin: 0 }}>
            <span className="acc-taxid-label">FlowAccount Client Secret</span>
            <input
              className="acc-taxid-input"
              type="password"
              value={flowaccountClientSecret}
              onChange={(e) => setFlowaccountClientSecret(e.target.value)}
              placeholder="เว้นว่างไว้ = ไม่เปลี่ยน"
              maxLength={500}
              disabled={pending}
              autoComplete="new-password"
            />
            <span className="muted" style={{ fontSize: 12, display: "block", marginTop: 2 }}>
              {hasFlowAccountCredential
                ? "ตั้งค่าไว้แล้ว (กรอกใหม่เพื่อเปลี่ยน หรือเว้นว่างไว้)"
                : "ยังไม่ได้ตั้งค่า — กรอก Client ID/Secret เพื่อเปิดใช้การส่งบิลไป FlowAccount"}
            </span>
          </label>
          {hasFlowAccountCredential ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={doClearFlowAccountCredential}
              disabled={pending || clearingCred}
              title="ล้าง Client ID/Secret ของ FlowAccount ที่ตั้งไว้ทั้งหมด"
            >
              {clearingCred ? "กำลังล้าง…" : "🗑️ ล้างรหัสลับ FlowAccount"}
            </button>
          ) : null}
          {credMsg ? (
            <span
              className={`action-msg ${credMsg.ok ? "" : "err"}`}
              style={credMsg.ok ? { color: "#166534" } : undefined}
            >
              {credMsg.text}
            </span>
          ) : null}
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
          {/* ดึงจาก NOVA Sales: เติม ชื่อ/ที่อยู่/เบอร์ ด้วยเลขภาษี — ผู้ใช้ตรวจแล้วกดบันทึกเอง */}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={doPull}
            disabled={pending}
            title="ดึงชื่อ/ที่อยู่/เบอร์โทร จาก NOVA Sales ด้วยเลขภาษีของลูกค้า"
          >
            {pulling ? "กำลังดึง…" : "⬇️ ดึงจาก NOVA Sales"}
          </button>
          <button type="button" className="btn" onClick={doUpdate} disabled={pending}>
            {pending && !pulling ? "กำลังบันทึก…" : "บันทึกข้อมูล"}
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
              setPhone(initialPhone ?? "");
              setFlowaccountClientId(initialFlowAccountClientId ?? "");
              setFlowaccountClientSecret("");
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
