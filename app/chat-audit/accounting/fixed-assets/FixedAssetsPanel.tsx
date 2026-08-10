"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  upsertAssetAction,
  deleteAssetAction,
  generateNowAction,
  disposeAssetAction,
  undisposeAssetAction,
} from "./actions";
import {
  monthlyDepreciationAmount,
  netBookValue,
  type FixedAsset,
  type FixedAssetOccurrence,
  type DepreciationLogEntry,
} from "@/lib/accounting/fixed-assets";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import AccountCombobox from "../AccountCombobox";

/**
 * FixedAssetsPanel — ตั้ง/แก้/ลบทะเบียนทรัพย์สินถาวรของลูกค้า 1 ราย + สร้างค่าเสื่อมราคาตอนนี้ (เฟส 7 ส่วน V)
 *   - ฟอร์ม: ชื่อทรัพย์สิน, รหัสบัญชี 3 ตัว (สินทรัพย์/ค่าเสื่อมสะสม/ค่าเสื่อมราคา — AccountCombobox เดิม),
 *     วันที่ซื้อ, ราคาทุน, มูลค่าซาก, อายุการใช้งาน (เดือน) — พรีวิวค่าเสื่อมต่อเดือนแบบเส้นตรง (client hint)
 *   - ★ 0.12: ทรัพย์สินที่มีประวัติค่าเสื่อมแล้ว (accumulatedDepreciation>0) ล็อกแก้ราคาทุน/มูลค่าซาก/
 *     อายุการใช้งาน/วันที่ซื้อ — แก้ได้แค่ชื่อ/รหัสบัญชี (server validate ซ้ำเสมออยู่แล้ว — client แค่ช่วยกัน
 *     กดพลาดตั้งแต่ต้น)
 *   - รายการทะเบียนเดิม: แยกกลุ่ม "ใช้งานอยู่" / "จำหน่ายแล้ว" (เฟส 7-W ด้านล่าง — ปุ่มจำหน่าย/ยกเลิกจำหน่าย
 *     ทำให้กลุ่มนี้ไม่ว่างได้) — แสดง NBV ปัจจุบัน, ปุ่ม "สร้างค่าเสื่อมตอนนี้" (บังคับ today ฝั่ง server),
 *     ประวัติค่าเสื่อมต่อชิ้น (badge เชื่อม occurrence + ลิงก์กลับ journal-entry)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 * ★ 0.3 ไม่มีปุ่ม "ยืนยัน" ในหน้านี้ — occurrence ที่สร้างเป็น draft เสมอ ต้องไปยืนยันที่หน้าลงบันทึกบัญชีเอง
 * ★ 0.7/0.8 (เฟส 7-W): ปุ่ม "จำหน่ายทรัพย์สิน" (ทรัพย์สินที่ active) เปิด dialog กรอกวันที่จำหน่าย/ราคาที่ได้
 *   รับ/รหัสบัญชีที่รับเงิน/รหัสบัญชีกำไร-ขาดทุน (AccountCombobox เดิม) และปุ่ม "ยกเลิกการจำหน่าย" (ทรัพย์สินที่
 *   disposed) — ทั้งคู่สร้าง/ลบ draft JE ผ่าน server action เท่านั้น (0.3 ไม่มีทาง auto-confirm)
 */

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) */
function formatDateThai(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "—";
}

type FormState = {
  name: string;
  assetAccountCode: string;
  assetAccountName: string;
  accumDepAccountCode: string;
  accumDepAccountName: string;
  depExpenseAccountCode: string;
  depExpenseAccountName: string;
  acquisitionDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: string;
};

function blankForm(): FormState {
  return {
    name: "",
    assetAccountCode: "",
    assetAccountName: "",
    accumDepAccountCode: "",
    accumDepAccountName: "",
    depExpenseAccountCode: "",
    depExpenseAccountName: "",
    acquisitionDate: todayIso(),
    cost: "",
    salvageValue: "0",
    usefulLifeMonths: "",
  };
}

/** ฟอร์ม dialog "จำหน่ายทรัพย์สิน" (0.7) */
type DisposeFormState = {
  disposalDate: string;
  proceeds: string;
  cashAccountCode: string;
  cashAccountName: string;
  gainLossAccountCode: string;
  gainLossAccountName: string;
};

function blankDisposeForm(): DisposeFormState {
  return {
    disposalDate: todayIso(),
    proceeds: "",
    cashAccountCode: "",
    cashAccountName: "",
    gainLossAccountCode: "",
    gainLossAccountName: "",
  };
}

export default function FixedAssetsPanel({
  customerId,
  assets,
  occurrences,
  depreciationLog,
  chart,
}: {
  customerId: string;
  assets: FixedAsset[];
  /** occurrence (manual_journal_entries) ทั้งหมดของลูกค้ารายนี้ที่ผูกกับทรัพย์สินในลิสต์นี้ */
  occurrences: FixedAssetOccurrence[];
  /** ประวัติค่าเสื่อมต่อทรัพย์สิน (key = assetId) */
  depreciationLog: Record<string, DepreciationLogEntry[]>;
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) */
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const [form, setForm] = useState<FormState>(() => blankForm());

  // ---- dialog "จำหน่ายทรัพย์สิน" (0.7) ----
  const [disposingAsset, setDisposingAsset] = useState<FixedAsset | null>(null);
  const [disposeForm, setDisposeForm] = useState<DisposeFormState>(() => blankDisposeForm());
  const [disposeErr, setDisposeErr] = useState<string | null>(null);

  const activeAssets = useMemo(() => assets.filter((a) => a.status === "active"), [assets]);
  const disposedAssets = useMemo(() => assets.filter((a) => a.status === "disposed"), [assets]);

  const occurrencesByAsset = useMemo(() => {
    const m = new Map<string, FixedAssetOccurrence[]>();
    for (const o of occurrences) {
      const arr = m.get(o.assetId) ?? [];
      arr.push(o);
      m.set(o.assetId, arr);
    }
    return m;
  }, [occurrences]);

  const previewMonthly = useMemo(() => {
    const cost = parseAmountInput(form.cost);
    const salvage = parseAmountInput(form.salvageValue);
    const life = Number(form.usefulLifeMonths);
    if (!cost || !Number.isInteger(life) || life <= 0) return 0;
    return monthlyDepreciationAmount(cost, salvage, life);
  }, [form.cost, form.salvageValue, form.usefulLifeMonths]);

  const resetForm = () => {
    setEditingId(null);
    setEditingLocked(false);
    setForm(blankForm());
  };

  const startEdit = (a: FixedAsset) => {
    setMsg(null);
    setEditingId(a.id);
    setEditingLocked(a.accumulatedDepreciation > 0);
    setForm({
      name: a.name,
      assetAccountCode: a.assetAccountCode,
      assetAccountName: chartByCode[a.assetAccountCode]?.name ?? a.assetAccountCode,
      accumDepAccountCode: a.accumDepAccountCode,
      accumDepAccountName: chartByCode[a.accumDepAccountCode]?.name ?? a.accumDepAccountCode,
      depExpenseAccountCode: a.depExpenseAccountCode,
      depExpenseAccountName: chartByCode[a.depExpenseAccountCode]?.name ?? a.depExpenseAccountCode,
      acquisitionDate: a.acquisitionDate,
      cost: String(a.cost),
      salvageValue: String(a.salvageValue),
      usefulLifeMonths: String(a.usefulLifeMonths),
    });
  };

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await upsertAssetAction({
        id: editingId ?? undefined,
        customerId,
        name: form.name,
        assetAccountCode: form.assetAccountCode,
        accumDepAccountCode: form.accumDepAccountCode,
        depExpenseAccountCode: form.depExpenseAccountCode,
        acquisitionDate: form.acquisitionDate,
        cost: parseAmountInput(form.cost),
        salvageValue: parseAmountInput(form.salvageValue),
        usefulLifeMonths: Number(form.usefulLifeMonths),
      });
      if (res.ok) {
        resetForm();
        setMsg({ ok: true, text: res.message });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.message });
      }
    });
  }

  function onDelete(id: string) {
    if (!window.confirm("ลบทะเบียนทรัพย์สินนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteAssetAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        if (editingId === id) resetForm();
        router.refresh();
      }
    });
  }

  function onGenerateNow(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await generateNowAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function openDispose(a: FixedAsset) {
    setMsg(null);
    setDisposeErr(null);
    setDisposingAsset(a);
    setDisposeForm(blankDisposeForm());
  }

  function closeDispose() {
    setDisposingAsset(null);
    setDisposeErr(null);
  }

  function submitDispose() {
    if (!disposingAsset) return;
    setDisposeErr(null);
    startTransition(async () => {
      const res = await disposeAssetAction(disposingAsset.id, customerId, {
        disposalDate: disposeForm.disposalDate,
        proceeds: parseAmountInput(disposeForm.proceeds),
        cashAccountCode: disposeForm.cashAccountCode,
        gainLossAccountCode: disposeForm.gainLossAccountCode,
      });
      if (res.ok) {
        setDisposingAsset(null);
        setMsg({ ok: true, text: res.message });
        router.refresh();
      } else {
        setDisposeErr(res.message);
      }
    });
  }

  function onUndispose(id: string) {
    if (!window.confirm("ยกเลิกการจำหน่ายทรัพย์สินนี้? (ทำได้เฉพาะก่อนยืนยันรายการบัญชี)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await undisposeAssetAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function renderAssetRow(a: FixedAsset) {
    const occ = occurrencesByAsset.get(a.id) ?? [];
    const failedLogs = (depreciationLog[a.id] ?? []).filter((l) => l.status === "failed");
    const nbv = netBookValue(a);
    const doneDepreciating = a.status === "active" && !a.nextDepDate;
    return (
      <tr key={a.id}>
        <td>{a.name}</td>
        <td className="num">{formatMoney(a.cost)}</td>
        <td className="num">{formatMoney(a.accumulatedDepreciation)}</td>
        <td className="num strong">{formatMoney(nbv)}</td>
        <td>{a.nextDepDate ? formatDateThai(a.nextDepDate) : doneDepreciating ? "ตัดค่าเสื่อมครบแล้ว" : "—"}</td>
        <td>
          {occ.length === 0 ? (
            <span className="muted">ยังไม่มี</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {occ.slice(0, 5).map((o) => (
                <a
                  key={o.id}
                  href={`/chat-audit/accounting/journal-entry?customerId=${customerId}`}
                  className="vat-badge yes"
                  title={`${formatDateThai(o.docDate)} · ${o.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}`}
                >
                  ค่าเสื่อม · {formatDateThai(o.docDate)}
                </a>
              ))}
              {occ.length > 5 ? <span className="muted">และอีก {occ.length - 5} รายการ</span> : null}
            </div>
          )}
          {failedLogs.length > 0 ? (
            <div className="action-msg err" style={{ marginTop: 4 }}>
              สร้างไม่สำเร็จล่าสุด ({formatDateThai(failedLogs[0].period)}): {failedLogs[0].message || "ไม่ทราบสาเหตุ"}
            </div>
          ) : null}
        </td>
        <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm" onClick={() => startEdit(a)} disabled={pending}>
            แก้ไข
          </button>
          {a.status === "active" ? (
            <>
              <button
                type="button"
                className="btn btn-sm green"
                onClick={() => onGenerateNow(a.id)}
                disabled={pending || !a.nextDepDate}
                title={!a.nextDepDate ? "ตัดค่าเสื่อมครบแล้ว/ยังไม่ถึงรอบ" : "สร้างค่าเสื่อมทันที (ถ้าถึงกำหนด)"}
              >
                สร้างค่าเสื่อมตอนนี้
              </button>
              <button type="button" className="btn btn-sm" onClick={() => openDispose(a)} disabled={pending}>
                จำหน่ายทรัพย์สิน
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => onUndispose(a.id)} disabled={pending}>
              ยกเลิกการจำหน่าย
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm danger"
            onClick={() => onDelete(a.id)}
            disabled={pending || a.accumulatedDepreciation > 0}
            title={a.accumulatedDepreciation > 0 ? "มีประวัติค่าเสื่อมแล้ว — ลบไม่ได้" : "ลบทะเบียน"}
          >
            ลบ
          </button>
        </td>
      </tr>
    );
  }

  return (
    <div className="acc-je">
      {/* ---- ฟอร์ม สร้าง/แก้ไข ---- */}
      <div className="acc-je-form">
        <div className="acc-je-form-head">
          <span className="strong">{editingId ? "แก้ไขทะเบียนทรัพย์สิน" : "สร้างทะเบียนทรัพย์สินใหม่"}</span>
          {editingId ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetForm} disabled={pending}>
              + สร้างใหม่แทน
            </button>
          ) : null}
        </div>

        {editingLocked ? (
          <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
            ทรัพย์สินนี้มีประวัติค่าเสื่อมแล้ว — แก้ไขได้แค่ชื่อ/รหัสบัญชี (ราคาทุน/มูลค่าซาก/อายุการใช้งาน/
            วันที่ซื้อล็อกไว้ ต้องยกเลิกยืนยัน JE ค่าเสื่อมทุกใบก่อนถึงจะลบทะเบียนทั้งชิ้นแล้วสร้างใหม่ได้)
          </p>
        ) : null}

        <div className="acc-field-grid">
          <label className="acc-field acc-field-wide">
            <span>ชื่อทรัพย์สิน</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="เช่น คอมพิวเตอร์สำนักงาน"
              maxLength={200}
              disabled={pending}
            />
          </label>
          <label className="acc-field">
            <span>วันที่ซื้อ</span>
            <input
              type="date"
              value={form.acquisitionDate}
              onChange={(e) => setForm((f) => ({ ...f, acquisitionDate: e.target.value }))}
              disabled={pending || editingLocked}
            />
          </label>
          <label className="acc-field">
            <span>ราคาทุน</span>
            <input
              className="num"
              inputMode="decimal"
              value={form.cost}
              onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
              placeholder="0.00"
              disabled={pending || editingLocked}
            />
          </label>
          <label className="acc-field">
            <span>มูลค่าซาก</span>
            <input
              className="num"
              inputMode="decimal"
              value={form.salvageValue}
              onChange={(e) => setForm((f) => ({ ...f, salvageValue: e.target.value }))}
              placeholder="0.00"
              disabled={pending || editingLocked}
            />
          </label>
          <label className="acc-field">
            <span>อายุการใช้งาน (เดือน)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={form.usefulLifeMonths}
              onChange={(e) => setForm((f) => ({ ...f, usefulLifeMonths: e.target.value }))}
              placeholder="เช่น 36"
              disabled={pending || editingLocked}
            />
          </label>
        </div>

        <div className="acc-field-grid">
          <label className="acc-field">
            <span>บัญชีสินทรัพย์</span>
            <AccountCombobox
              accountCode={form.assetAccountCode}
              accountName={form.assetAccountName}
              chart={chart}
              readOnly={false}
              onSelect={(code, name) => setForm((f) => ({ ...f, assetAccountCode: code, assetAccountName: name }))}
              onNameChange={(name) => setForm((f) => ({ ...f, assetAccountName: name }))}
              onClear={() => setForm((f) => ({ ...f, assetAccountCode: "", assetAccountName: "" }))}
            />
          </label>
          <label className="acc-field">
            <span>บัญชีค่าเสื่อมสะสม</span>
            <AccountCombobox
              accountCode={form.accumDepAccountCode}
              accountName={form.accumDepAccountName}
              chart={chart}
              readOnly={false}
              onSelect={(code, name) => setForm((f) => ({ ...f, accumDepAccountCode: code, accumDepAccountName: name }))}
              onNameChange={(name) => setForm((f) => ({ ...f, accumDepAccountName: name }))}
              onClear={() => setForm((f) => ({ ...f, accumDepAccountCode: "", accumDepAccountName: "" }))}
            />
          </label>
          <label className="acc-field">
            <span>บัญชีค่าเสื่อมราคา (ค่าใช้จ่าย)</span>
            <AccountCombobox
              accountCode={form.depExpenseAccountCode}
              accountName={form.depExpenseAccountName}
              chart={chart}
              readOnly={false}
              onSelect={(code, name) => setForm((f) => ({ ...f, depExpenseAccountCode: code, depExpenseAccountName: name }))}
              onNameChange={(name) => setForm((f) => ({ ...f, depExpenseAccountName: name }))}
              onClear={() => setForm((f) => ({ ...f, depExpenseAccountCode: "", depExpenseAccountName: "" }))}
            />
          </label>
        </div>

        {previewMonthly > 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
            ค่าเสื่อมต่อเดือน (โดยประมาณ): {formatMoney(previewMonthly)} — งวดสุดท้ายจะปรับยอดให้ผลรวมค่าเสื่อม
            สะสมเท่ากับราคาทุน−มูลค่าซากเป๊ะ (ไม่มีเศษสตางค์ตกค้าง)
          </p>
        ) : null}

        {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

        <div className="acc-modal-actions">
          <button type="button" className="btn" onClick={save} disabled={pending}>
            {pending ? "กำลังบันทึก…" : editingId ? "บันทึกการแก้ไข" : "สร้างทะเบียน"}
          </button>
        </div>
      </div>

      {/* ---- รายการทะเบียนเดิมของลูกค้ารายนี้ ---- */}
      <div className="acc-je-list">
        <div className="strong" style={{ marginBottom: 8 }}>
          ทรัพย์สินที่ใช้งานอยู่ {activeAssets.length > 0 ? `(${activeAssets.length})` : ""}
        </div>
        {activeAssets.length === 0 ? (
          <p className="empty">ยังไม่มีทะเบียนทรัพย์สิน — สร้างทะเบียนแรกด้านบน</p>
        ) : (
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>ชื่อทรัพย์สิน</th>
                  <th className="num">ราคาทุน</th>
                  <th className="num">ค่าเสื่อมสะสม</th>
                  <th className="num">มูลค่าตามบัญชี (NBV)</th>
                  <th>รอบถัดไป</th>
                  <th>รายการที่สร้างแล้ว</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>{activeAssets.map(renderAssetRow)}</tbody>
            </table>
          </div>
        )}

        {/* กลุ่ม "จำหน่ายแล้ว" (เฟส 7-W, 0.7) — ปุ่ม "ยกเลิกการจำหน่าย" อยู่ในคอลัมน์จัดการของแต่ละแถว */}
        {disposedAssets.length > 0 ? (
          <>
            <div className="strong" style={{ marginTop: 16, marginBottom: 8 }}>
              จำหน่ายแล้ว ({disposedAssets.length})
            </div>
            <div className="table-wrap">
              <table className="dlv-table acc-table">
                <thead>
                  <tr>
                    <th>ชื่อทรัพย์สิน</th>
                    <th className="num">ราคาทุน</th>
                    <th className="num">ค่าเสื่อมสะสม</th>
                    <th className="num">มูลค่าตามบัญชี (NBV)</th>
                    <th>รอบถัดไป</th>
                    <th>รายการที่สร้างแล้ว</th>
                    <th>จัดการ</th>
                  </tr>
                </thead>
                <tbody>{disposedAssets.map(renderAssetRow)}</tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      {/* ---- dialog "จำหน่ายทรัพย์สิน" (0.7) ---- */}
      {disposingAsset ? (
        <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="จำหน่ายทรัพย์สิน">
          <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={closeDispose} />
          <div className="acc-modal acc-modal-sm">
            <div className="acc-modal-head">
              <div>
                <div className="acc-modal-title">จำหน่ายทรัพย์สิน</div>
                <div className="acc-modal-sub">{disposingAsset.name} — NBV ปัจจุบัน {formatMoney(netBookValue(disposingAsset))}</div>
              </div>
              <button type="button" className="acc-modal-close" onClick={closeDispose} aria-label="ปิด">✕</button>
            </div>

            <div className="acc-upload-form">
              <label className="acc-field">
                <span>วันที่จำหน่าย</span>
                <input
                  type="date"
                  value={disposeForm.disposalDate}
                  onChange={(e) => setDisposeForm((f) => ({ ...f, disposalDate: e.target.value }))}
                  disabled={pending}
                />
              </label>
              <label className="acc-field">
                <span>ราคาที่ได้รับจริง</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={disposeForm.proceeds}
                  onChange={(e) => setDisposeForm((f) => ({ ...f, proceeds: e.target.value }))}
                  placeholder="0.00"
                  disabled={pending}
                />
              </label>
              <label className="acc-field">
                <span>บัญชีที่รับเงิน (เงินสด/ธนาคาร/ลูกหนี้)</span>
                <AccountCombobox
                  accountCode={disposeForm.cashAccountCode}
                  accountName={disposeForm.cashAccountName}
                  chart={chart}
                  readOnly={false}
                  onSelect={(code, name) => setDisposeForm((f) => ({ ...f, cashAccountCode: code, cashAccountName: name }))}
                  onNameChange={(name) => setDisposeForm((f) => ({ ...f, cashAccountName: name }))}
                  onClear={() => setDisposeForm((f) => ({ ...f, cashAccountCode: "", cashAccountName: "" }))}
                />
              </label>
              <label className="acc-field">
                <span>บัญชีกำไร/ขาดทุนจากการจำหน่ายทรัพย์สิน</span>
                <AccountCombobox
                  accountCode={disposeForm.gainLossAccountCode}
                  accountName={disposeForm.gainLossAccountName}
                  chart={chart}
                  readOnly={false}
                  onSelect={(code, name) => setDisposeForm((f) => ({ ...f, gainLossAccountCode: code, gainLossAccountName: name }))}
                  onNameChange={(name) => setDisposeForm((f) => ({ ...f, gainLossAccountName: name }))}
                  onClear={() => setDisposeForm((f) => ({ ...f, gainLossAccountCode: "", gainLossAccountName: "" }))}
                />
              </label>

              <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
                ระบบคำนวณกำไร/ขาดทุนจากการจำหน่ายให้อัตโนมัติ (ราคาที่ได้รับ − มูลค่าตามบัญชี) แล้วสร้างรายการ
                บัญชีเป็นร่าง (draft) — ต้องไปยืนยันที่หน้าลงบันทึกบัญชีเองอีกครั้งก่อนมีผลจริง
              </p>

              {disposeErr ? <div className="action-msg err">{disposeErr}</div> : null}

              <div className="acc-modal-actions">
                <button type="button" className="btn" onClick={submitDispose} disabled={pending}>
                  {pending ? "กำลังบันทึก…" : "จำหน่ายทรัพย์สิน"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
