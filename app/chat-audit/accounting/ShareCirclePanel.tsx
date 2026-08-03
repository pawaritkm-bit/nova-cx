"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createShareCircleEntryAction,
  updateShareCircleEntryAction,
  softDeleteShareCircleEntryAction,
  restoreShareCircleEntryAction,
  extractShareCircleFromTextAction,
  extractShareCircleFromImagesAction,
  type ShareCircleFields,
} from "./share-circle-actions";
import { createBillUploadUrlAction } from "./actions";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { validateUpload } from "@/lib/accounting/upload";
import {
  computeSbtMonthly,
  computeYearSummary,
  type ShareCircleEntry,
} from "@/lib/share-circles/queries";

/** bucket รูป (ตรงกับ actions.ts / storage) */
const BILLS_BUCKET = "bills";

/**
 * แท็บ "วงแชร์" (client) ในการ์ดลูกค้าของหน้าลงบันทึกบัญชี
 *
 *   ★ นักบัญชีต้องแก้/เพิ่ม/ลบเองได้ (เผื่อ AI ดึงผิด/ไม่หมด):
 *     - กดแถวเพื่อแก้ทุกช่อง inline → บันทึกผ่าน updateEntry
 *     - "+ เพิ่มวง" (source='manual') กรณี AI ดึงไม่หมด
 *     - ลบวง (soft-delete) + แถบ "เลิกทำ" (undo)
 *   ★ การ์ดสรุป ภธ.40 (รายเดือน) + ภงด.90 (ปลายปี) คำนวณจาก entries ที่ยังไม่ลบ
 *     — reflect ทันทีหลังแก้/เพิ่ม/ลบ (คิดจาก state ปัจจุบัน)
 *   ★ ปุ่ม "อ่านวงแชร์จากไลน์" → เรียก route AI (async) แล้ว refresh
 */

/** ค่าที่แก้ได้ใน 1 แถว (string เพื่อผูก input) */
type Draft = {
  periodMonth: string;
  circleName: string;
  roundNote: string;
  memberCount: string;
  principalPerHead: string;
  taoIncome: string;
  mgmtFee: string;
  operationFee: string;
  interestIncome: string;
  expense: string;
};

const NEW_ID = "__new__";

/** number|null → string */
function n2s(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

/** จำนวนเงินแบบไทย (null → "—") */
function money(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function money2(v: number): string {
  return v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 'YYYY-MM' → 'เดือน ปีพ.ศ.' */
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function monthLabel(m: string): string {
  const mm = /^(\d{4})-(\d{2})$/.exec(m);
  if (!mm) return m;
  const y = parseInt(mm[1], 10) + 543;
  const idx = parseInt(mm[2], 10) - 1;
  return `${TH_MONTHS[idx] ?? mm[2]} ${y}`;
}

/** สร้างรายการเดือนล่าสุด 24 เดือน (ค.ศ. YYYY-MM) + รวมเดือนที่มี entry อยู่แล้ว */
function buildMonthOptions(entries: ShareCircleEntry[]): string[] {
  const set = new Set<string>();
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    set.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  for (const e of entries) set.add(e.periodMonth);
  return [...set].sort((a, b) => b.localeCompare(a));
}

function draftFromEntry(e: ShareCircleEntry): Draft {
  return {
    periodMonth: e.periodMonth,
    circleName: e.circleName,
    roundNote: e.roundNote ?? "",
    memberCount: n2s(e.memberCount),
    principalPerHead: n2s(e.principalPerHead),
    taoIncome: n2s(e.taoIncome),
    mgmtFee: n2s(e.mgmtFee),
    operationFee: n2s(e.operationFee),
    interestIncome: n2s(e.interestIncome),
    expense: n2s(e.expense),
  };
}

function draftToFields(d: Draft): ShareCircleFields {
  return {
    periodMonth: d.periodMonth,
    circleName: d.circleName,
    roundNote: d.roundNote || null,
    memberCount: d.memberCount || null,
    principalPerHead: d.principalPerHead || null,
    taoIncome: d.taoIncome || null,
    mgmtFee: d.mgmtFee || null,
    operationFee: d.operationFee || null,
    interestIncome: d.interestIncome || null,
    expense: d.expense || null,
  };
}

export default function ShareCirclePanel({
  customerId,
  entries: entriesProp,
  exportHref,
}: {
  customerId: string;
  entries: ShareCircleEntry[];
  exportHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // ★ state ปัจจุบัน (seed จาก props) — แก้/เพิ่ม/ลบ อัปเดตตรงนี้ → การ์ดสรุปคิดใหม่ทันที
  const [entries, setEntries] = useState<ShareCircleEntry[]>(entriesProp);
  useEffect(() => {
    setEntries(entriesProp);
  }, [entriesProp]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);

  // เดือนสำหรับ "อ่านจากไลน์"
  const monthOptions = useMemo(() => buildMonthOptions(entries), [entries]);
  const [readMonth, setReadMonth] = useState<string>(monthOptions[0] ?? "");
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!readMonth && monthOptions[0]) setReadMonth(monthOptions[0]);
  }, [monthOptions, readMonth]);

  // สรุปภาษี (คิดจาก entries ปัจจุบัน)
  const sbt = useMemo(() => computeSbtMonthly(entries), [entries]);
  const years = useMemo(() => computeYearSummary(entries), [entries]);

  function beginEdit(e: ShareCircleEntry) {
    setErr(null);
    setMsg(null);
    setEditingId(e.id);
    setDraft(draftFromEntry(e));
  }

  function beginAdd() {
    setErr(null);
    setMsg(null);
    setEditingId(NEW_ID);
    setDraft({
      periodMonth: readMonth || monthOptions[0] || "",
      circleName: "",
      roundNote: "",
      memberCount: "",
      principalPerHead: "",
      taoIncome: "",
      mgmtFee: "",
      operationFee: "",
      interestIncome: "",
      expense: "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setErr(null);
  }

  function patch(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function save() {
    if (!draft) return;
    setErr(null);
    startTransition(async () => {
      const fields = draftToFields(draft);
      if (editingId === NEW_ID) {
        const res = await createShareCircleEntryAction(customerId, fields);
        if (!res.ok) {
          setErr(res.message);
          return;
        }
        // เติม entry ใหม่ลง state ทันที (id จาก server)
        const newEntry: ShareCircleEntry = {
          id: res.id ?? `tmp-${Date.now()}`,
          tenantId: "",
          customerId,
          periodMonth: fields.periodMonth,
          entryDate: null,
          circleName: fields.circleName,
          roundNote: draft.roundNote || null,
          memberCount: draft.memberCount ? Math.round(Number(draft.memberCount)) : null,
          principalPerHead: draft.principalPerHead ? Number(draft.principalPerHead) : null,
          taoIncome: draft.taoIncome ? Number(draft.taoIncome) : null,
          mgmtFee: draft.mgmtFee ? Number(draft.mgmtFee) : null,
          operationFee: draft.operationFee ? Number(draft.operationFee) : null,
          interestIncome: draft.interestIncome ? Number(draft.interestIncome) : null,
          expense: draft.expense ? Number(draft.expense) : null,
          source: "manual",
          status: "active",
          createdAt: new Date().toISOString(),
        };
        setEntries((list) => [newEntry, ...list]);
        setMsg("เพิ่มวงแล้ว");
      } else if (editingId) {
        const id = editingId;
        const res = await updateShareCircleEntryAction(id, fields);
        if (!res.ok) {
          setErr(res.message);
          return;
        }
        setEntries((list) =>
          list.map((e) =>
            e.id === id
              ? {
                  ...e,
                  periodMonth: fields.periodMonth,
                  circleName: fields.circleName,
                  roundNote: draft.roundNote || null,
                  memberCount: draft.memberCount ? Math.round(Number(draft.memberCount)) : null,
                  principalPerHead: draft.principalPerHead ? Number(draft.principalPerHead) : null,
                  taoIncome: draft.taoIncome ? Number(draft.taoIncome) : null,
                  mgmtFee: draft.mgmtFee ? Number(draft.mgmtFee) : null,
                  operationFee: draft.operationFee ? Number(draft.operationFee) : null,
                  interestIncome: draft.interestIncome ? Number(draft.interestIncome) : null,
                  expense: draft.expense ? Number(draft.expense) : null,
                }
              : e
          )
        );
        setMsg("บันทึกแล้ว");
      }
      cancelEdit();
      router.refresh(); // sync กับ server (best-effort)
    });
  }

  function remove(id: string) {
    setErr(null);
    startTransition(async () => {
      const res = await softDeleteShareCircleEntryAction(id);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setEntries((list) => list.filter((e) => e.id !== id));
      setUndoId(id);
      setMsg(null);
      router.refresh();
    });
  }

  function undo() {
    if (!undoId) return;
    const id = undoId;
    startTransition(async () => {
      const res = await restoreShareCircleEntryAction(id);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setUndoId(null);
      router.refresh();
    });
  }

  function readFromLine() {
    if (!readMonth) {
      setErr("กรุณาเลือกเดือนก่อน");
      return;
    }
    setErr(null);
    setMsg(null);
    setReading(true);
    (async () => {
      try {
        const r = await fetch("/api/accounting/extract-share-circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId, month: readMonth }),
        });
        const j = (await r.json().catch(() => ({}))) as { extracted?: boolean; count?: number };
        if (j.extracted && (j.count ?? 0) > 0) {
          setMsg(`AI อ่านวงแชร์เดือน ${monthLabel(readMonth)} ได้ ${j.count} วง — ตรวจ/แก้ได้ในตาราง`);
        } else {
          setMsg(
            `ยังไม่พบลิสต์วงแชร์ในไลน์เดือน ${monthLabel(readMonth)} (หรือ AI อ่านไม่ออก) — เพิ่ม/คีย์เองได้`
          );
        }
        router.refresh();
      } catch {
        setErr("อ่านจากไลน์ไม่สำเร็จ กรุณาลองใหม่ หรือคีย์เอง");
      } finally {
        setReading(false);
      }
    })();
  }

  // ---- กรอกเอง: วางข้อความ ----
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteForce, setPasteForce] = useState(false); // โชว์ปุ่ม "วางซ้ำอยู่ดี"

  function runPasteExtract(force: boolean) {
    if (!pasteText.trim()) {
      setErr("กรุณาวางข้อความลิสต์วงแชร์ก่อน");
      return;
    }
    setErr(null);
    setMsg(null);
    setPasteBusy(true);
    startTransition(async () => {
      const res = await extractShareCircleFromTextAction(customerId, readMonth, pasteText, { force });
      setPasteBusy(false);
      if (!res.ok) {
        setErr(res.message);
        // ข้อความซ้ำ → เปิดปุ่มยืนยันเพิ่มซ้ำ
        setPasteForce(res.message.includes("เคยวาง"));
        return;
      }
      setPasteForce(false);
      setPasteText("");
      setMsg(res.message);
      router.refresh();
    });
  }

  // ---- กรอกเอง: อัปรูป ----
  const [imgBusy, setImgBusy] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  // เก็บ path ที่อัปแล้ว เผื่อกด "อัปซ้ำอยู่ดี" (ไม่ต้องอัปใหม่)
  const [uploadedPaths, setUploadedPaths] = useState<string[] | null>(null);
  const [imgForce, setImgForce] = useState(false);

  /** เรียก action ด้วย paths ที่อัปแล้ว */
  function extractFromPaths(paths: string[], force: boolean) {
    startTransition(async () => {
      const res = await extractShareCircleFromImagesAction(customerId, readMonth, paths, { force });
      setImgBusy(false);
      if (!res.ok) {
        setErr(res.message);
        setImgForce(res.message.includes("เคยอัป"));
        return;
      }
      setImgForce(false);
      setUploadedPaths(null);
      setMsg(res.message);
      router.refresh();
    });
  }

  async function runImageUpload() {
    const files = Array.from(imgRef.current?.files ?? []);
    if (files.length === 0) {
      setErr("กรุณาเลือกรูปวงแชร์ก่อน");
      return;
    }
    setErr(null);
    setMsg(null);
    setImgBusy(true);
    try {
      const supabase = createBrowserSupabase();
      const paths: string[] = [];
      for (const file of files.slice(0, 12)) {
        const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
        if (!v.ok) {
          setErr(v.error);
          setImgBusy(false);
          return;
        }
        const prep = await createBillUploadUrlAction({
          customerId,
          entryType: "unspecified",
          fileName: file.name,
          mime: file.type,
          size: file.size,
        });
        if (!prep.ok) {
          setErr(prep.message);
          setImgBusy(false);
          return;
        }
        const { error: upErr } = await supabase.storage
          .from(BILLS_BUCKET)
          .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined });
        if (upErr) {
          setErr(`อัปโหลดรูปไม่สำเร็จ: ${upErr.message || "กรุณาลองใหม่"}`);
          setImgBusy(false);
          return;
        }
        paths.push(prep.path);
      }
      if (imgRef.current) imgRef.current.value = "";
      setUploadedPaths(paths);
      extractFromPaths(paths, false);
    } catch {
      setErr("อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่");
      setImgBusy(false);
    }
  }

  const busy = pending || reading || pasteBusy || imgBusy;

  return (
    <div className="acc-sharecircle">
      {/* ---- toolbar ---- */}
      <div className="acc-subtabs" style={{ marginBottom: 12 }}>
        <label style={{ fontWeight: 600, fontSize: 14 }}>เดือน:</label>
        <select value={readMonth} onChange={(e) => setReadMonth(e.target.value)} disabled={busy}>
          {monthOptions.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={readFromLine} disabled={busy}>
          {reading ? "🤖 AI กำลังอ่าน…" : "🤖 อ่านวงแชร์จากไลน์ (รูป+คำพิม)"}
        </button>
        <span className="acc-toolbar-spacer" />
        <button type="button" className="btn btn-ghost" onClick={beginAdd} disabled={busy}>
          + เพิ่มวง
        </button>
        <a href={exportHref} className="btn btn-ghost">
          ⬇ ภธ.40 (Excel)
        </a>
      </div>

      {/* ---- กรอกเอง: วางข้อความ / อัปรูป (ยึดเดือนที่เลือกด้านบน) ---- */}
      <div className="card" style={{ marginBottom: 12, padding: 12 }}>
        <div className="section-title" style={{ marginBottom: 8 }}>
          <span>กรอกเอง (เดือน {monthLabel(readMonth)})</span>
          <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
            วางคำ/อัปรูปเอง → AI แยกเข้าเดือนที่เลือก · กันบันทึกซ้ำอัตโนมัติ
          </span>
        </div>

        {/* วางข้อความ */}
        <label className="acc-field acc-field-wide" style={{ display: "block" }}>
          <span>วางคำจากไลน์วงแชร์ (วางหลายวงรวดเดียวได้)</span>
          <textarea
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteForce(false);
            }}
            rows={5}
            placeholder={"วงบิท รายเดือน 21 มือ ต้น 100,000\nรายได้ท้าว 50,000 ค่าดูแล 0 ดอกเบี้ย 1,500\n\nวงคริสต์มาส ..."}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid var(--line, #d9dee6)",
              borderRadius: 10,
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </label>
        <div className="acc-subtabs" style={{ marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => runPasteExtract(false)} disabled={busy}>
            {pasteBusy ? "🤖 AI กำลังแยก…" : "🤖 แยกด้วย AI"}
          </button>
          {pasteForce ? (
            <button type="button" className="btn btn-ghost" onClick={() => runPasteExtract(true)} disabled={busy}>
              วางซ้ำอยู่ดี
            </button>
          ) : null}

          <span className="acc-toolbar-spacer" />

          {/* อัปรูป (หลายรูป) */}
          <label className="btn btn-ghost" style={{ cursor: busy ? "default" : "pointer", margin: 0 }}>
            ＋ เพิ่มรูปวงแชร์
            <input
              ref={imgRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              disabled={busy}
              onChange={() => {
                setImgForce(false);
                runImageUpload();
              }}
            />
          </label>
          {imgBusy ? <span className="muted" style={{ fontSize: 13 }}>กำลังอัป/แยกรูป…</span> : null}
          {imgForce && uploadedPaths ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setImgBusy(true);
                extractFromPaths(uploadedPaths, true);
              }}
              disabled={busy}
            >
              อัปซ้ำอยู่ดี
            </button>
          ) : null}
        </div>
      </div>

      {err ? <div className="action-msg err">{err}</div> : null}
      {msg ? <div className="action-msg" style={{ color: "#166534" }}>{msg}</div> : null}

      {/* ---- ตารางวง ---- */}
      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>เดือน</th>
              <th>ชื่อวง</th>
              <th>รอบเปีย</th>
              <th className="num">สมาชิก</th>
              <th className="num">ต้น/คน</th>
              <th className="num">รายได้ท้าว (G)</th>
              <th className="num">ค่าบริหาร (H)</th>
              <th className="num">ค่าดำเนินการ (I)</th>
              <th className="num">ดอกเบี้ย (J)</th>
              <th className="num">ค่าใช้จ่าย (K)</th>
              <th className="center">ที่มา</th>
              <th className="center">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {/* แถวเพิ่มใหม่ (โผล่บนสุดเมื่อกด +เพิ่มวง) */}
            {editingId === NEW_ID && draft ? (
              <EditRow
                draft={draft}
                monthOptions={monthOptions}
                onPatch={patch}
                onSave={save}
                onCancel={cancelEdit}
                busy={busy}
                isNew
              />
            ) : null}

            {entries.length === 0 && editingId !== NEW_ID ? (
              <tr>
                <td colSpan={12}>
                  <p className="empty" style={{ margin: "10px 0" }}>
                    ยังไม่มีวงแชร์ — กด “🤖 อ่านวงแชร์จากไลน์” หรือ “+ เพิ่มวง” เพื่อคีย์เอง
                  </p>
                </td>
              </tr>
            ) : (
              entries.map((e) =>
                editingId === e.id && draft ? (
                  <EditRow
                    key={e.id}
                    draft={draft}
                    monthOptions={monthOptions}
                    onPatch={patch}
                    onSave={save}
                    onCancel={cancelEdit}
                    busy={busy}
                  />
                ) : (
                  <tr
                    key={e.id}
                    className="acc-sc-row"
                    onClick={() => !busy && beginEdit(e)}
                    style={{ cursor: "pointer" }}
                    title="กดเพื่อแก้ไข"
                  >
                    <td>{monthLabel(e.periodMonth)}</td>
                    <td>{e.circleName}</td>
                    <td>{e.roundNote || "—"}</td>
                    <td className="num">{e.memberCount ?? "—"}</td>
                    <td className="num">{money(e.principalPerHead)}</td>
                    <td className="num">{money(e.taoIncome)}</td>
                    <td className="num">{money(e.mgmtFee)}</td>
                    <td className="num">{money(e.operationFee)}</td>
                    <td className="num">{money(e.interestIncome)}</td>
                    <td className="num">{money(e.expense)}</td>
                    <td className="center">
                      <span className={`vat-badge ${e.source === "manual" ? "no" : "yes"}`}>
                        {e.source === "manual" ? "คีย์เอง" : "AI"}
                      </span>
                    </td>
                    <td className="center" onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="btn btn-ghost" onClick={() => beginEdit(e)} disabled={busy}>
                        แก้
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          if (window.confirm("ลบวงนี้?")) remove(e.id);
                        }}
                        disabled={busy}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                )
              )
            )}
          </tbody>
        </table>
      </div>

      {/* ---- แถบเลิกทำ (undo) หลังลบ ---- */}
      {undoId ? (
        <div className="action-msg" style={{ marginTop: 8 }}>
          ลบวงแล้ว —{" "}
          <button type="button" className="btn btn-ghost" onClick={undo} disabled={busy}>
            เลิกทำ (กู้คืน)
          </button>
        </div>
      ) : null}

      {/* ---- การ์ดสรุป ภธ.40 (รายเดือน) ---- */}
      <div className="section-title" style={{ marginTop: 18 }}>
        <span>ภธ.40 — ภาษีธุรกิจเฉพาะ (รายเดือน)</span>
        <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
          ฐาน = รายได้ท้าว (G) + ค่าดำเนินการ (I) · เสียภาษี 3.3% (SBT 3% + ท้องถิ่น 10%)
        </span>
      </div>
      {sbt.length === 0 ? (
        <p className="empty">ยังไม่มีข้อมูลคิด ภธ.40</p>
      ) : (
        <div className="table-wrap">
          <table className="dlv-table acc-table">
            <thead>
              <tr>
                <th>เดือน</th>
                <th className="num">รายได้ท้าว (ΣG)</th>
                <th className="num">ค่าดำเนินการ (ΣI)</th>
                <th className="num">ฐานภาษี</th>
                <th className="num">SBT 3%</th>
                <th className="num">ท้องถิ่น 10%</th>
                <th className="num">รวมเสียภาษี</th>
              </tr>
            </thead>
            <tbody>
              {sbt.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="num">{money2(r.baseG)}</td>
                  <td className="num">{money2(r.baseI)}</td>
                  <td className="num strong">{money2(r.base)}</td>
                  <td className="num">{money2(r.sbt3)}</td>
                  <td className="num">{money2(r.local)}</td>
                  <td className="num strong">{money2(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- การ์ดสรุป ภงด.90 (ปลายปี) ---- */}
      <div className="section-title" style={{ marginTop: 18 }}>
        <span>ภงด.90 — ปลายปี (ตัวประเมินเบื้องต้น)</span>
        <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
          รายได้ธุรกิจ (G+H+I) หักเหมา 40% · ดอกเบี้ย (J) ม.40(4) ไม่หักเหมา — บวกเต็ม
        </span>
      </div>
      {years.length === 0 ? (
        <p className="empty">ยังไม่มีข้อมูลคิด ภงด.90</p>
      ) : (
        <>
          <div className="kpi-grid">
            {years.map((y) => (
              <div className="kpi" key={y.year}>
                <div className="label">ปี {parseInt(y.year, 10) + 543}</div>
                <div className="value">
                  {money2(y.totalIncome)}
                  <span className="unit">รายได้รวม</span>
                </div>
                <div className="label" style={{ marginTop: 6 }}>
                  รายได้ธุรกิจ หัก 40% = <b>{money2(y.businessAfterFlat)}</b> บาท
                </div>
                <div className="label">
                  ดอกเบี้ยรับ (ไม่หักเหมา) = <b>{money2(y.interestIncome)}</b> บาท
                </div>
                <div className="label" style={{ marginTop: 4, color: "#166534" }}>
                  รวมประเมิน = <b>{money2(y.afterDeduction)}</b> บาท
                </div>
              </div>
            ))}
          </div>
          <p className="acc-month-hint" style={{ marginTop: 8 }}>
            ★ เป็น <b>ตัวประเมินเบื้องต้น</b> เท่านั้น — ค่าลดหย่อน (ส่วนตัว 30,000 ฯลฯ) และภาษีขั้นบันได
            ให้นักบัญชีคิดต่อ
          </p>
        </>
      )}
    </div>
  );
}

/** แถวแก้ไข inline (ทุกช่อง) — ใช้ทั้งเพิ่มใหม่และแก้ของเดิม */
function EditRow({
  draft,
  monthOptions,
  onPatch,
  onSave,
  onCancel,
  busy,
  isNew,
}: {
  draft: Draft;
  monthOptions: string[];
  onPatch: (p: Partial<Draft>) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  isNew?: boolean;
}) {
  const numStyle = { width: 84, textAlign: "right" as const };
  // เผื่อเดือนของ entry ไม่อยู่ใน 24 เดือนล่าสุด → เติมเข้า option
  const months = monthOptions.includes(draft.periodMonth)
    ? monthOptions
    : [draft.periodMonth, ...monthOptions];
  return (
    <tr className="acc-sc-edit" style={{ background: "#f8fafc" }}>
      <td>
        <select value={draft.periodMonth} onChange={(e) => onPatch({ periodMonth: e.target.value })}>
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          value={draft.circleName}
          onChange={(e) => onPatch({ circleName: e.target.value })}
          placeholder="ชื่อวง"
          style={{ width: "100%", minWidth: 120 }}
        />
      </td>
      <td>
        <input
          value={draft.roundNote}
          onChange={(e) => onPatch({ roundNote: e.target.value })}
          placeholder="รายเดือน / ราย 15 วัน"
          style={{ width: 120 }}
        />
      </td>
      <td className="num">
        <input inputMode="numeric" value={draft.memberCount} onChange={(e) => onPatch({ memberCount: e.target.value })} style={{ width: 60, textAlign: "right" }} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.principalPerHead} onChange={(e) => onPatch({ principalPerHead: e.target.value })} style={numStyle} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.taoIncome} onChange={(e) => onPatch({ taoIncome: e.target.value })} style={numStyle} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.mgmtFee} onChange={(e) => onPatch({ mgmtFee: e.target.value })} style={numStyle} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.operationFee} onChange={(e) => onPatch({ operationFee: e.target.value })} style={numStyle} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.interestIncome} onChange={(e) => onPatch({ interestIncome: e.target.value })} style={numStyle} />
      </td>
      <td className="num">
        <input inputMode="decimal" value={draft.expense} onChange={(e) => onPatch({ expense: e.target.value })} style={numStyle} />
      </td>
      <td className="center">{isNew ? "ใหม่" : ""}</td>
      <td className="center">
        <button type="button" className="btn" onClick={onSave} disabled={busy}>
          {busy ? "…" : "บันทึก"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          ยกเลิก
        </button>
      </td>
    </tr>
  );
}
