"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  parseShareCircleAction,
  saveShareCircleAction,
  deleteShareCircleAction,
  type HandInput,
} from "./actions";
import type { ParsedShareCircle } from "@/lib/ai/share-circle";

/**
 * ปุ่มลบวง (client) — ยืนยันก่อนลบ แล้วเรียก deleteShareCircleAction (soft-delete) + refresh
 */
export function DeleteCircleButton({ circleId }: { circleId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onDelete() {
    if (!window.confirm("ลบวงนี้? (กู้คืนไม่ได้จากหน้านี้)")) return;
    setErr(null);
    startTransition(async () => {
      const res = await deleteShareCircleAction(circleId);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onDelete} disabled={pending}>
        {pending ? "กำลังลบ…" : "ลบวง"}
      </button>
      {err ? <span className="action-msg err">{err}</span> : null}
    </>
  );
}

/**
 * ปุ่ม/พาเนล "เพิ่มวงแชร์" (client) — ท้าวแชร์วางลิสต์จากไลน์ แล้ว AI แยกเป็นตารางให้ตรวจ/แก้
 *
 * flow: วางข้อความ / แนบรูป → "🤖 ให้ AI แยก" (parseShareCircleAction) →
 *       ตารางแก้ได้ (หัววง + มือ) → "บันทึกวง" (saveShareCircleAction) → router.refresh
 *
 * ★ AI ใช้ gpt-5-mini (reasoning) ช้า ~30-90s — โชว์สถานะ "AI กำลังอ่าน…"
 * ★ รูปแปลงเป็น base64 ฝั่ง client ก่อนส่ง (ไม่ผูก Storage — ลิสต์วงเป็นข้อความสั้น)
 */

/** แถวมือที่แก้ได้ในตาราง (string เพื่อผูก input; แปลงเป็นเลขตอนบันทึก) */
type EditableHand = {
  handNo: string;
  memberName: string;
  sendAmount: string;
  bidAmount: string;
  isOrganizer: boolean;
};

/** หัววงที่แก้ได้ */
type EditableHead = {
  name: string;
  principal: string;
  numHands: string;
  feePerHand: string;
  periodNote: string;
  startDate: string;
};

/** number|null → string (สำหรับ prefill input) */
function numToStr(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

/** string → number|null (ว่าง = null) */
function strToNum(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** อ่านไฟล์ → base64 ล้วน (ตัด prefix data:...;base64,) */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

export default function ShareCircleCreator({
  customers,
  lockedCustomerId,
  lockedCustomerLabel,
}: {
  /** ตัวเลือกลูกค้า (โหมด toolbar — ยังไม่ผูก) */
  customers?: { id: string; label: string }[];
  /** ผูกลูกค้าไว้แล้ว (เลือกจาก dropdown ด้านบน) — prefill ค่าเริ่มต้น */
  lockedCustomerId?: string | null;
  lockedCustomerLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<"" | "reading" | "saving">("");

  const [text, setText] = useState("");
  const [customerId, setCustomerId] = useState<string>(lockedCustomerId ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  // ผลที่ AI แยกได้ (null = ยังไม่แยก / ยังไม่มีตาราง)
  const [head, setHead] = useState<EditableHead | null>(null);
  const [hands, setHands] = useState<EditableHand[]>([]);

  function reset() {
    setErr(null);
    setPhase("");
    setText("");
    setHead(null);
    setHands([]);
    if (!lockedCustomerId) setCustomerId("");
    if (fileRef.current) fileRef.current.value = "";
  }

  function close() {
    setOpen(false);
    reset();
  }

  /** เติมตารางจากผล AI */
  function fillFromParsed(p: ParsedShareCircle) {
    setHead({
      name: p.name ?? "",
      principal: numToStr(p.principal),
      numHands: numToStr(p.num_hands),
      feePerHand: numToStr(p.fee_per_hand),
      periodNote: p.period_note ?? "",
      startDate: p.start_date ?? "",
    });
    setHands(
      p.hands.map((h) => ({
        handNo: String(h.hand_no),
        memberName: h.member_name ?? "",
        sendAmount: numToStr(h.send_amount),
        bidAmount: numToStr(h.bid_amount),
        isOrganizer: h.is_organizer,
      }))
    );
  }

  /** ปุ่ม "🤖 ให้ AI แยก" */
  function runParse() {
    setErr(null);
    const file = fileRef.current?.files?.[0] ?? null;
    if (!text.trim() && !file) {
      setErr("กรุณาวางข้อความ หรือแนบรูปลิสต์วงแชร์ก่อน");
      return;
    }
    startTransition(async () => {
      setPhase("reading");
      let imageBase64: string | undefined;
      let mime: string | undefined;
      if (file) {
        try {
          imageBase64 = await fileToBase64(file);
          mime = file.type || "image/jpeg";
        } catch {
          setErr("อ่านไฟล์รูปไม่สำเร็จ กรุณาลองใหม่");
          setPhase("");
          return;
        }
      }
      const res = await parseShareCircleAction({
        customerId: customerId || null,
        text: text.trim() || undefined,
        imageBase64,
        mime,
      });
      setPhase("");
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      fillFromParsed(res.parsed);
    });
  }

  /** แก้ค่าหัววง */
  function updateHead(patch: Partial<EditableHead>) {
    setHead((h) => (h ? { ...h, ...patch } : h));
  }

  /** แก้ค่ามือแถว i */
  function updateHand(i: number, patch: Partial<EditableHand>) {
    setHands((list) => list.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  }

  function removeHand(i: number) {
    setHands((list) => list.filter((_, idx) => idx !== i));
  }

  function addHand() {
    setHands((list) => [
      ...list,
      {
        handNo: String(list.length + 1),
        memberName: "",
        sendAmount: "",
        bidAmount: "",
        isOrganizer: false,
      },
    ]);
  }

  /** ปุ่ม "บันทึกวง" */
  function save() {
    setErr(null);
    if (!head) return;
    if (!customerId) {
      setErr("กรุณาเลือกลูกค้า (ท้าวแชร์) ก่อนบันทึก");
      return;
    }
    if (!head.name.trim()) {
      setErr("กรุณาระบุชื่อวง");
      return;
    }
    const handInputs: HandInput[] = [];
    for (const h of hands) {
      const handNo = strToNum(h.handNo);
      if (handNo === null) continue; // มือที่ไม่มีลำดับ = ข้าม
      handInputs.push({
        hand_no: Math.round(handNo),
        member_name: h.memberName.trim() || null,
        send_amount: strToNum(h.sendAmount),
        bid_amount: strToNum(h.bidAmount),
        is_organizer: h.isOrganizer,
      });
    }

    startTransition(async () => {
      setPhase("saving");
      const res = await saveShareCircleAction({
        customerId,
        name: head.name.trim(),
        principal: strToNum(head.principal),
        num_hands: strToNum(head.numHands),
        fee_per_hand: strToNum(head.feePerHand),
        period_note: head.periodNote.trim() || null,
        start_date: head.startDate.trim() || null,
        source_text: text.trim() || null,
        hands: handInputs,
      });
      setPhase("");
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      close();
      router.refresh();
    });
  }

  const locked = lockedCustomerId != null;

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + เพิ่มวงแชร์
      </button>

      {open ? (
        <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="เพิ่มวงแชร์">
          <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={close} />
          <div className="acc-modal">
            <div className="acc-modal-head">
              <div>
                <div className="acc-modal-title">เพิ่มวงแชร์</div>
                <div className="acc-modal-sub">
                  วางลิสต์จากไลน์ / แนบรูป → ให้ AI แยกเป็นตาราง → ตรวจ/แก้ → บันทึก
                </div>
              </div>
              <button type="button" className="acc-modal-close" onClick={close} aria-label="ปิด">
                ✕
              </button>
            </div>

            <div className="acc-upload-form">
              {/* ลูกค้า (ท้าว) */}
              {locked ? (
                <div className="acc-field acc-field-wide">
                  <span>ลูกค้า (ท้าวแชร์)</span>
                  <div className="acc-upload-locked">{lockedCustomerLabel || "ลูกค้าที่เลือก"}</div>
                </div>
              ) : (
                <label className="acc-field acc-field-wide">
                  <span>ลูกค้า (ท้าวแชร์)</span>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">— เลือกลูกค้า —</option>
                    {(customers ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* ข้อความลิสต์วงแชร์ */}
              <label className="acc-field acc-field-wide">
                <span>วางลิสต์วงแชร์ (จากไลน์)</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  placeholder={
                    "วงโปรเจค ต้น 100,000\nดูแล 500/มือ · รายเดือน ทุกวันที่ 15\n1.ท้าว 15/4/69\n2.5000❤️แม่ก้อย\n3.5000🌸1000❤️แอน\n..."
                  }
                  style={{
                    padding: "10px 12px",
                    border: "1px solid var(--line, #d9dee6)",
                    borderRadius: 10,
                    fontSize: 14,
                    fontFamily: "inherit",
                    resize: "vertical",
                  }}
                />
              </label>

              {/* รูป (optional) */}
              <label className="acc-field acc-field-wide">
                <span>หรือแนบรูปลิสต์ (ไม่บังคับ)</span>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" />
              </label>

              {err ? <div className="action-msg err">{err}</div> : null}

              <div className="acc-modal-actions">
                <button type="button" className="btn" onClick={runParse} disabled={pending}>
                  {pending && phase === "reading" ? "AI กำลังอ่าน…" : "🤖 ให้ AI แยก"}
                </button>
                <span className="acc-toolbar-spacer" />
                <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>
                  ยกเลิก
                </button>
              </div>

              {/* ตารางแก้ได้ (โผล่หลัง AI แยก) */}
              {head ? (
                <div className="acc-field-wide" style={{ marginTop: 8 }}>
                  {/* หัววง */}
                  <div className="acc-field-grid" style={{ display: "grid", gap: 10 }}>
                    <label className="acc-field acc-field-wide">
                      <span>ชื่อวง</span>
                      <input value={head.name} onChange={(e) => updateHead({ name: e.target.value })} />
                    </label>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                        gap: 10,
                      }}
                    >
                      <label className="acc-field">
                        <span>ต้น</span>
                        <input
                          inputMode="decimal"
                          value={head.principal}
                          onChange={(e) => updateHead({ principal: e.target.value })}
                        />
                      </label>
                      <label className="acc-field">
                        <span>จำนวนมือ</span>
                        <input
                          inputMode="numeric"
                          value={head.numHands}
                          onChange={(e) => updateHead({ numHands: e.target.value })}
                        />
                      </label>
                      <label className="acc-field">
                        <span>ค่าดูแล/มือ</span>
                        <input
                          inputMode="decimal"
                          value={head.feePerHand}
                          onChange={(e) => updateHead({ feePerHand: e.target.value })}
                        />
                      </label>
                      <label className="acc-field">
                        <span>วันเริ่ม (ค.ศ.)</span>
                        <input
                          type="date"
                          value={head.startDate}
                          onChange={(e) => updateHead({ startDate: e.target.value })}
                        />
                      </label>
                    </div>
                    <label className="acc-field acc-field-wide">
                      <span>รอบ</span>
                      <input
                        value={head.periodNote}
                        onChange={(e) => updateHead({ periodNote: e.target.value })}
                        placeholder="เช่น รายเดือน ทุกวันที่ 15"
                      />
                    </label>
                  </div>

                  {/* ตารางมือ */}
                  <div className="table-wrap" style={{ marginTop: 12 }}>
                    <table className="dlv-table">
                      <thead>
                        <tr>
                          <th style={{ width: 60 }}>มือ</th>
                          <th>ชื่อสมาชิก</th>
                          <th className="num">ยอดส่ง</th>
                          <th className="num">ดอก</th>
                          <th className="center" style={{ width: 60 }}>
                            ท้าว
                          </th>
                          <th className="center" style={{ width: 50 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {hands.length === 0 ? (
                          <tr>
                            <td colSpan={6}>
                              <p className="empty" style={{ margin: "8px 0" }}>
                                ยังไม่มีมือ — กด “+ เพิ่มมือ”
                              </p>
                            </td>
                          </tr>
                        ) : (
                          hands.map((h, i) => (
                            <tr key={i}>
                              <td>
                                <input
                                  inputMode="numeric"
                                  value={h.handNo}
                                  onChange={(e) => updateHand(i, { handNo: e.target.value })}
                                  style={{ width: 48 }}
                                />
                              </td>
                              <td>
                                <input
                                  value={h.memberName}
                                  onChange={(e) => updateHand(i, { memberName: e.target.value })}
                                  style={{ width: "100%" }}
                                />
                              </td>
                              <td className="num">
                                <input
                                  inputMode="decimal"
                                  value={h.sendAmount}
                                  onChange={(e) => updateHand(i, { sendAmount: e.target.value })}
                                  style={{ width: 90, textAlign: "right" }}
                                />
                              </td>
                              <td className="num">
                                <input
                                  inputMode="decimal"
                                  value={h.bidAmount}
                                  onChange={(e) => updateHand(i, { bidAmount: e.target.value })}
                                  style={{ width: 90, textAlign: "right" }}
                                />
                              </td>
                              <td className="center">
                                <input
                                  type="checkbox"
                                  checked={h.isOrganizer}
                                  onChange={(e) => updateHand(i, { isOrganizer: e.target.checked })}
                                  aria-label="เป็นท้าว"
                                />
                              </td>
                              <td className="center">
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  onClick={() => removeHand(i)}
                                  aria-label="ลบมือ"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="acc-modal-actions" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-ghost" onClick={addHand} disabled={pending}>
                      + เพิ่มมือ
                    </button>
                    <span className="acc-toolbar-spacer" />
                    <button type="button" className="btn" onClick={save} disabled={pending}>
                      {pending && phase === "saving" ? "กำลังบันทึก…" : "บันทึกวง"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
