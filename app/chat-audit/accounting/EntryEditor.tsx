"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveEntryAction, deleteEntryAction, type SaveEntryInput } from "./actions";
import { searchChartNonBankGrouped } from "@/lib/accounting/chart-of-accounts";
import { lineBadge } from "@/lib/accounting/line-status";
import {
  parseAmountInput,
  calcVat,
  calcWht,
  calcNet,
  formatMoney,
} from "@/lib/accounting/calc";
import type { BillEntry, EntryType, VatType, WhtForm, PaymentMethod } from "@/lib/accounting/queries";
import { resolveEntryNav } from "@/lib/accounting/entry-nav";
import { contraAccountFor, paymentMethodLabel } from "@/lib/accounting/payment";

/**
 * EntryEditor — หน้าต่างตรวจ/แก้บิล (verify panel)
 *   ซ้าย = รูปบิลจริง (signed URL, กดซูม/เปิดเต็มได้) · ขวา = ฟอร์มแก้ได้ "ทุกช่อง"
 *
 * ★ auto-คำนวณฝั่ง client (robust — parse comma/เลขไทยผ่าน calc.ts):
 *     - ใส่ amount → VAT 7% (ถ้าเป็น VAT) + หัก ณ ที่จ่าย (จาก rate) คำนวณให้
 *     - ใส่ wht_rate → wht_amount คำนวณ
 *     - net = amount + vat − wht (อัปเดตสด)
 *     - "พิมพ์ทับได้ทุกช่อง" — แก้ VAT/หักเองได้ (ไม่ถูก override กลับ)
 * ★ เปลี่ยนประเภท ซื้อ↔ขาย (แก้ AI ผิด) ในฟอร์ม → บันทึกแล้วย้ายแท็บเอง
 * ★ ทุกการเขียนผ่าน server action (guard admin + service-role) — client แค่ช่วยแสดง/กรอก
 * ★ entry ที่ยืนยันแล้ว = อ่านอย่างเดียว (ปิดการแก้) เหลือแค่ปุ่มลบ
 */

type LineRow = {
  key: string;
  id?: string;
  vatType: VatType;
  /** รายละเอียดเดิม (คงไว้เพื่อความเข้ากันได้ย้อนหลัง — ตอนบันทึก sync = accountName) */
  description: string;
  /** รหัสบัญชีจากผังบัญชี (ล็อกเมื่อเลือกแล้ว) · "" = ยังไม่เลือก */
  accountCode: string;
  /** ชื่อบัญชี (prefill จากผัง แก้ได้ต่อบรรทัด) */
  accountName: string;
  amount: string;
  vatAmount: string;
  whtRate: string;
  whtAmount: string;
  /** AI เติมค่าบรรทัดนี้ไหม (จากผลสกัด) — ใช้ทำป้าย 🟢/🟡 ช่วยตรวจ · บรรทัดที่คนเพิ่ม = false */
  aiFilled: boolean;
  /** AI "เดาเติม" ช่องเสี่ยง (conf ต่ำ) — แยกป้าย "AI เดา — ตรวจ" (🟡) ออกจาก "มั่นใจ" (🟢) */
  aiLowConfidence: boolean;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `n${keySeq}`;
}

/** number → ค่าที่โชว์ในช่อง input (0 → ว่าง เพื่อให้พิมพ์ง่าย) */
function numToInput(n: number): string {
  return n ? String(n) : "";
}

/** ISO (2026-06-01) → ไทย วว/ดด/ปปปป (01/06/2026) สำหรับแสดง/แก้ */
function isoToThai(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso ?? "";
}

/** ไทย วว/ดด/ปปปป → ISO (2026-06-01) สำหรับเก็บ · รูปผิด/ยังพิมพ์ไม่ครบ = "" */
function thaiToIso(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  if (!m) return "";
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function initLines(entry: BillEntry): LineRow[] {
  if (entry.lines.length === 0) {
    return [
      { key: newKey(), vatType: "vat", description: "", accountCode: "", accountName: "", amount: "", vatAmount: "", whtRate: "", whtAmount: "", aiFilled: false, aiLowConfidence: false },
    ];
  }
  return entry.lines.map((l) => ({
    key: l.id,
    id: l.id,
    vatType: l.vatType,
    description: l.description ?? "",
    accountCode: l.accountCode ?? "",
    accountName: l.accountName ?? "",
    amount: numToInput(l.amount),
    vatAmount: numToInput(l.vatAmount),
    whtRate: numToInput(l.whtRate),
    whtAmount: numToInput(l.whtAmount),
    aiFilled: l.aiFilled,
    aiLowConfidence: l.aiLowConfidence,
  }));
}

export default function EntryEditor({
  entry,
  viewUrl,
  viewIsImage = true,
  fileName = null,
  customerLabel,
  closeHref,
  orderIds = [],
}: {
  entry: BillEntry;
  viewUrl: string | null;
  /** ไฟล์ที่แนบเป็น "รูป" ไหม (บิลไลน์=รูป · ไฟล์อัปเอง pdf/excel/csv=false → โชว์ปุ่มเปิด/ดาวน์โหลด) */
  viewIsImage?: boolean;
  /** ชื่อไฟล์อัปเอง (ไว้โชว์/ตั้งชื่อดาวน์โหลด) */
  fileName?: string | null;
  customerLabel: string;
  closeHref: string;
  /**
   * ลำดับ entry id ของบริบทที่กำลังดู (ลูกค้าเดียวกัน + แท็บ/type เดียวกัน) เรียงเหมือนตาราง
   *   — page.tsx (server) เป็นผู้ส่งมา เพื่อทำปุ่ม "ก่อนหน้า/ถัดไป" (กรอกต่อเนื่อง)
   */
  orderIds?: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const readOnly = entry.status === "confirmed";
  // บิลนี้ AI เป็นคนลงให้ (source='ai') → โชว์ป้าย 🤖 บนช่องหัวที่ AI เติม + ป้าย 🟢/🟡 ต่อบรรทัด
  const aiSrc = entry.source === "ai";

  // ---- นำทาง ก่อนหน้า/ถัดไป ในบริบทนี้ ----
  const nav = resolveEntryNav(orderIds, entry.id);
  // href ของบิลอีกใบ = closeHref (คงบริบท open/type/accountant/customer) + edit=<id>
  const editHrefFor = useCallback(
    (id: string) => `${closeHref}${closeHref.includes("?") ? "&" : "?"}edit=${id}`,
    [closeHref]
  );

  // ---- header state ----
  const [entryType, setEntryType] = useState<EntryType>(entry.entryType);
  // ★ เก็บเป็นข้อความ วว/ดด/ปปปป (ไทย) เพื่อแสดง/แก้ตามที่ผู้ใช้ต้องการ — แปลงเป็น ISO ตอนบันทึก
  const [docDate, setDocDate] = useState<string>(entry.docDate ? isoToThai(entry.docDate) : "");
  const [docNo, setDocNo] = useState<string>(entry.docNo ?? "");
  const [partyName, setPartyName] = useState<string>(entry.counterpartyName ?? "");
  const [partyTaxId, setPartyTaxId] = useState<string>(entry.counterpartyTaxId ?? "");
  const [whtForm, setWhtForm] = useState<WhtForm | "">(entry.whtForm ?? "");
  // วิธีจ่าย/รับเงิน (บัญชีคู่ฝั่งเครดิต)
  //   ★ บัญชีเงินฝาก (transfer) ใช้ default 1020 — เลิก UI เลือกบัญชีธนาคารต่อลูกค้าแล้ว
  //     แต่คง entry.paymentBankAccountId เดิมไว้ตอนบันทึก (กันข้อมูลเดิมหาย)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">(entry.paymentMethod ?? "");

  // ---- lines state ----
  const [lines, setLines] = useState<LineRow[]>(() => initLines(entry));
  const [deletedLineIds, setDeletedLineIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(false);
  const [rotation, setRotation] = useState(0); // องศาหมุนรูปบิล (0/90/180/270) — บิลถ่ายตะแคง
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // สแนปช็อตค่าเริ่มต้น (ครั้งแรกที่ mount) — ใช้เช็ค "แก้ไขหรือยัง"
  //   ★ เลื่อนบิล (ก่อนหน้า/ถัดไป) ถ้ายังไม่ได้แก้ → ข้าม auto-save (ไม่ยิง DB) = เลื่อนเร็วขึ้นมาก
  const initialInputRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialInputRef.current === null) initialInputRef.current = JSON.stringify(buildInput(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    router.push(closeHref);
    router.refresh();
  }, [router, closeHref]);

  // ปิดด้วย Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const patchLine = (key: string, patch: Partial<LineRow>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  // amount เปลี่ยน → คำนวณ VAT (ตามชนิด) + หัก (จาก rate) ให้ใหม่ (ยังพิมพ์ทับได้ทีหลัง)
  const onAmountChange = (l: LineRow, raw: string) => {
    const amt = parseAmountInput(raw);
    const vat = calcVat(amt, l.vatType);
    const wht = calcWht(amt, parseAmountInput(l.whtRate));
    patchLine(l.key, { amount: raw, vatAmount: numToInput(vat), whtAmount: numToInput(wht) });
  };

  // ชนิด VAT เปลี่ยน → คำนวณ VAT ใหม่
  const onVatTypeChange = (l: LineRow, vatType: VatType) => {
    const amt = parseAmountInput(l.amount);
    patchLine(l.key, { vatType, vatAmount: numToInput(calcVat(amt, vatType)) });
  };

  /**
   * เลือกชนิด VAT จากดรอปดาวน์ 3 ตัวเลือก:
   *   'vat'    = VAT นอก (ยอด=ฐานก่อน VAT · VAT = ยอด×7% บวกเพิ่ม)
   *   'vat_in' = VAT ใน (บิลรวม VAT แล้ว) → ★ ถอด VAT: ยอดปัจจุบัน=รวม VAT → ฐาน + VAT
   *              แล้วตั้ง vat_type='vat' (เก็บเป็น "ฐาน+VAT" เหมือนกัน · ตัวเลือกนี้เป็น "การกระทำ")
   *   'novat'  = ไม่มี VAT
   */
  const onVatSelect = (l: LineRow, val: string) => {
    if (val === "vat_in") {
      const incl = parseAmountInput(l.amount);
      const base = incl > 0 ? Math.round((incl / 1.07) * 100) / 100 : 0;
      const vat = incl > 0 ? Math.round((incl - base) * 100) / 100 : 0;
      patchLine(l.key, { vatType: "vat", amount: numToInput(base), vatAmount: numToInput(vat) });
      return;
    }
    onVatTypeChange(l, val === "novat" ? "novat" : "vat");
  };

  // wht_rate เปลี่ยน → คำนวณ wht_amount ใหม่
  const onWhtRateChange = (l: LineRow, raw: string) => {
    const amt = parseAmountInput(l.amount);
    patchLine(l.key, { whtRate: raw, whtAmount: numToInput(calcWht(amt, parseAmountInput(raw))) });
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { key: newKey(), vatType: "vat", description: "", accountCode: "", accountName: "", amount: "", vatAmount: "", whtRate: "", whtAmount: "", aiFilled: false, aiLowConfidence: false },
    ]);
  };

  const removeLine = (l: LineRow) => {
    setLines((prev) => prev.filter((x) => x.key !== l.key));
    if (l.id) setDeletedLineIds((prev) => [...prev, l.id!]);
  };

  // ---- ยอดรวมสด ----
  const totals = useMemo(() => {
    let amount = 0;
    let vat = 0;
    let wht = 0;
    for (const l of lines) {
      amount += parseAmountInput(l.amount);
      vat += parseAmountInput(l.vatAmount);
      wht += parseAmountInput(l.whtAmount);
    }
    return { amount, vat, wht, net: calcNet(amount, vat, wht) };
  }, [lines]);

  // hint บัญชีคู่ (เครดิต) — transfer ใช้บัญชีเงินฝากเดิมถ้าผูกไว้ (paymentBankAccountCode) มิฉะนั้น default 1020
  const contraHint = useMemo(() => {
    if (!paymentMethod) return null;
    return contraAccountFor(paymentMethod, entryType, entry.paymentBankAccountCode);
  }, [paymentMethod, entryType, entry.paymentBankAccountCode]);

  function buildInput(confirm: boolean): SaveEntryInput {
    return {
      id: entry.id,
      entryType,
      customerId: entry.customerId,
      attachmentId: entry.attachmentId,
      docDate: thaiToIso(docDate) || null,
      docNo: docNo || null,
      counterpartyName: partyName || null,
      counterpartyTaxId: partyTaxId || null,
      whtForm: whtForm || null,
      paymentMethod: paymentMethod || null,
      // คงบัญชีเงินฝากที่ผูกไว้เดิม (ถ้ามี) — เลิก UI เลือกแล้ว แต่ไม่ล้างข้อมูลเดิม
      paymentBankAccountId: entry.paymentBankAccountId ?? null,
      lines: lines.map((l) => ({
        id: l.id,
        vatType: l.vatType,
        // ★ sync description = ชื่อบัญชี (ถ้าเลือกบัญชี) เพื่อให้ Excel/รายงานเดิม (คอลัมน์ "รายการ")
        //   ยังมีข้อความ · ถ้ายังไม่เลือกบัญชี คงรายละเอียดเดิมไว้
        description: (l.accountName.trim() || l.description) || null,
        accountCode: l.accountCode.trim() || null,
        accountName: l.accountName.trim() || null,
        amount: parseAmountInput(l.amount),
        vatAmount: parseAmountInput(l.vatAmount),
        whtRate: parseAmountInput(l.whtRate),
        whtAmount: parseAmountInput(l.whtAmount),
      })),
      deletedLineIds,
      confirm,
    };
  }

  function save(confirm: boolean) {
    setMsg(null);
    startTransition(async () => {
      const res = await saveEntryAction(buildInput(confirm));
      if (res.ok) {
        close();
      } else {
        setMsg({ ok: false, text: res.message });
        router.refresh(); // ให้ list ตรง (เผื่อ save สำเร็จบางส่วน)
      }
    });
  }

  // บันทึกร่างใบปัจจุบันอัตโนมัติก่อน แล้วเด้งไปบิลที่ href (ใช้กับ ก่อนหน้า/ถัดไป)
  //   - ยืนยันแล้ว (readOnly): แก้ไม่ได้ → ไปเลยไม่ต้องบันทึก
  //   - บันทึกไม่ผ่าน (validate ฯลฯ): ค้างที่ใบเดิม โชว์ error ให้แก้ก่อน
  function saveThenGo(href: string) {
    // ยืนยันแล้ว (อ่านอย่างเดียว) หรือ "ยังไม่ได้แก้อะไร" → เลื่อนเลย ไม่ต้อง save (เร็วขึ้น)
    const unchanged =
      initialInputRef.current !== null && initialInputRef.current === JSON.stringify(buildInput(false));
    if (readOnly || unchanged) {
      router.push(href);
      router.refresh();
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await saveEntryAction(buildInput(false));
      if (res.ok) {
        router.push(href);
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.message });
        router.refresh();
      }
    });
  }

  function remove() {
    if (!window.confirm("ลบบิลนี้? (กดผิดกู้คืนได้ด้วยปุ่ม “เลิกทำ”)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteEntryAction(entry.id);
      if (res.ok) {
        // เด้งกลับหน้ารายการพร้อม ?undo=<id> → โชว์แถบ "เลิกทำ" ให้กู้คืนได้ทันที
        const sep = closeHref.includes("?") ? "&" : "?";
        router.push(`${closeHref}${sep}undo=${entry.id}`);
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.message });
      }
    });
  }

  return (
    <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="ตรวจ/แก้บิล">
      {/* คลิกพื้นหลังเพื่อปิด */}
      <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={close} />

      <div className="acc-modal">
        <div className="acc-modal-head">
          <div>
            <div className="acc-modal-title">ตรวจ / แก้บิล</div>
            <div className="acc-modal-sub">{customerLabel}</div>
          </div>

          {/* นำทางบิลในบริบทนี้ (กรอกต่อเนื่อง) — บันทึกร่างอัตโนมัติก่อนเปลี่ยนใบ */}
          {nav.total > 1 ? (
            <div className="acc-nav" aria-label="สลับบิลก่อนหน้า/ถัดไป">
              <button
                type="button"
                className="btn btn-ghost acc-nav-btn"
                onClick={() => nav.prevId && saveThenGo(editHrefFor(nav.prevId))}
                disabled={pending || !nav.prevId}
                aria-label="บิลก่อนหน้า"
                title="บันทึกร่างแล้วไปบิลก่อนหน้า"
              >
                ◀ ก่อนหน้า
              </button>
              <span className="acc-nav-pos" aria-live="polite">
                บิล {nav.position} / {nav.total}
              </span>
              <button
                type="button"
                className="btn btn-ghost acc-nav-btn"
                onClick={() => nav.nextId && saveThenGo(editHrefFor(nav.nextId))}
                disabled={pending || !nav.nextId}
                aria-label="บิลถัดไป"
                title="บันทึกร่างแล้วไปบิลถัดไป"
              >
                ถัดไป ▶
              </button>
            </div>
          ) : null}

          <button type="button" className="acc-modal-close" onClick={close} aria-label="ปิด">✕</button>
        </div>

        {readOnly ? (
          <div className="acc-note">รายการนี้ยืนยันแล้ว — แก้ไขไม่ได้ (ลบได้)</div>
        ) : null}

        <div className="acc-modal-body">
          {/* ---- ซ้าย: รูปบิล / ไฟล์แนบจริง ---- */}
          <div className="acc-bill-pane">
            {viewUrl && viewIsImage ? (
              <>
                {/* แถวปุ่มอยู่บนสุดเสมอ — กันรูปที่หมุนแล้วสูงล้นมาทับ (ปุ่มหาย) */}
                <div className="acc-bill-tools">
                  <button type="button" className="btn btn-ghost" onClick={() => setZoom((z) => !z)}>
                    {zoom ? "ย่อ" : "ซูม"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setRotation((r) => (r + 90) % 360)}
                    title="หมุนรูป 90°"
                  >
                    ↻ หมุน
                  </button>
                  <a href={viewUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">เปิดรูปเต็ม</a>
                </div>
                <div className={`acc-bill-stage${rotation % 180 ? " rot" : ""}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={viewUrl}
                    alt="รูปบิล"
                    className={`acc-bill-img${zoom ? " zoom" : ""}`}
                    style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
                    onClick={() => setZoom((z) => !z)}
                  />
                </div>
              </>
            ) : viewUrl ? (
              /* ไฟล์ที่ไม่ใช่รูป (PDF/Excel/CSV) — เปิด/ดาวน์โหลด (sign URL อายุสั้น) */
              <div className="acc-bill-file">
                <span className="acc-bill-file-icon" aria-hidden="true">📄</span>
                <div className="acc-bill-file-name" title={fileName ?? undefined}>{fileName || "ไฟล์แนบ"}</div>
                <div className="acc-bill-tools">
                  <a href={viewUrl} target="_blank" rel="noopener noreferrer" className="btn">เปิดไฟล์</a>
                  <a href={`${viewUrl}&download`} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">ดาวน์โหลด</a>
                </div>
              </div>
            ) : (
              <div className="acc-bill-empty">ไม่มีไฟล์แนบ (รายการคีย์เอง หรือไฟล์ถูกลบ)</div>
            )}
          </div>

          {/* ---- ขวา: ฟอร์มแก้ได้ทุกช่อง ---- */}
          <div className="acc-form-pane">
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>ประเภท {aiSrc && entry.entryType !== "unspecified" ? <AiTag /> : null}</span>
                <select
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value as EntryType)}
                  disabled={readOnly}
                >
                  <option value="purchase">บิลซื้อ</option>
                  <option value="sale">บิลขาย</option>
                  <option value="unspecified">รอระบุ</option>
                </select>
              </label>
              <label className="acc-field">
                <span>วันที่เอกสาร (วว/ดด/ปปปป) {aiSrc && entry.docDate ? <AiTag /> : null}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={docDate}
                  onChange={(e) => setDocDate(e.target.value)}
                  disabled={readOnly}
                  placeholder="วว/ดด/ปปปป เช่น 01/06/2026"
                />
              </label>
              <label className="acc-field">
                <span>เลขที่เอกสาร {aiSrc && entry.docNo ? <AiTag /> : null}</span>
                <input type="text" value={docNo} onChange={(e) => setDocNo(e.target.value)} disabled={readOnly} placeholder="เช่น INV-001" />
              </label>
              <label className="acc-field">
                <span>ภ.ง.ด.</span>
                <select value={whtForm} onChange={(e) => setWhtForm(e.target.value as WhtForm | "")} disabled={readOnly}>
                  <option value="">— ไม่มี —</option>
                  <option value="pnd3">ภ.ง.ด.3</option>
                  <option value="pnd53">ภ.ง.ด.53</option>
                </select>
              </label>

              {/* วิธีจ่าย/รับเงิน → บัญชีคู่ (เครดิต) สำหรับ double-entry
                  ★ 4 ตัวเลือก · label ตามฝั่งบิล (credit = ลูกหนี้ เมื่อขาย / เจ้าหนี้ เมื่อซื้อ) */}
              <label className="acc-field">
                <span>วิธีจ่าย/รับเงิน</span>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | "")}
                  disabled={readOnly}
                >
                  <option value="">— ยังไม่ระบุ —</option>
                  <option value="cash">{paymentMethodLabel("cash", entryType)}</option>
                  <option value="cheque">{paymentMethodLabel("cheque", entryType)}</option>
                  <option value="transfer">{paymentMethodLabel("transfer", entryType)}</option>
                  <option value="credit">{paymentMethodLabel("credit", entryType)}</option>
                </select>
              </label>

              {/* hint บัญชีคู่ที่จะเป็นเครดิต (ช่วยตรวจ — ยังไม่ลงจริง แค่บอกให้เห็น)
                  เงินโอน → บัญชีคู่ = เงินฝากธนาคาร (default 1020) */}
              {contraHint ? (
                <div className="acc-field acc-field-wide acc-contra-hint">
                  บัญชีคู่ (เครดิต): {contraHint.code ? <b>{contraHint.code}</b> : null} {contraHint.name}
                </div>
              ) : null}
              <label className="acc-field acc-field-wide">
                <span>คู่ค้า {aiSrc && entry.counterpartyName ? <AiTag /> : null}</span>
                <input type="text" value={partyName} onChange={(e) => setPartyName(e.target.value)} disabled={readOnly} placeholder="ชื่อผู้ขาย/ผู้ซื้อ" />
              </label>
              <label className="acc-field">
                <span>เลขผู้เสียภาษี {aiSrc && entry.counterpartyTaxId ? <AiTag /> : null}</span>
                <input type="text" value={partyTaxId} onChange={(e) => setPartyTaxId(e.target.value)} disabled={readOnly} placeholder="13 หลัก" />
              </label>
            </div>

            {/* ---- บรรทัดรายการ (บิลผสม VAT/ไม่VAT/หัก) ---- */}
            <div className="acc-lines">
              <div className="acc-lines-head">
                <span>รายการ</span>
                <span className="num">มูลค่า</span>
                <span className="num">VAT</span>
                <span className="num">อัตราหัก %</span>
                <span className="num">หัก ณ ที่จ่าย</span>
                <span className="num">รวมจ่ายจริง</span>
                <span />
              </div>

              {lines.map((l) => {
                const amt = parseAmountInput(l.amount);
                const vat = parseAmountInput(l.vatAmount);
                const wht = parseAmountInput(l.whtAmount);
                const net = calcNet(amt, vat, wht);
                // ป้ายช่วยตรวจ 3 สถานะ (เฉพาะบิล AI ที่ยังแก้ได้):
                //   🟢 มั่นใจ (confident) · 🟡 AI เดา—ตรวจ (guess) · 🟡 โปรดตรวจ/เติม (check)
                const badge = !readOnly
                  ? lineBadge(
                      { accountCode: l.accountCode, amount: amt, aiFilled: l.aiFilled, aiLowConfidence: l.aiLowConfidence },
                      entry.source
                    )
                  : null;
                return (
                  <div className="acc-line" key={l.key}>
                    <div className="acc-line-desc">
                      {badge ? (
                        <span
                          className={`acc-line-flag ${badge === "confident" ? "ok" : badge === "guess" ? "guess" : "warn"}`}
                          title={
                            badge === "confident"
                              ? "AI เติมครบ (บัญชี + ยอด) มั่นใจสูง — ช่วยตรวจให้ถูก"
                              : badge === "guess"
                                ? "AI เดา (ความมั่นใจต่ำ) — โปรดตรวจให้ถูกก่อนยืนยัน"
                                : "โปรดตรวจ: ยังมีช่องสำคัญว่าง (ยอด/บัญชี)"
                          }
                          aria-label={
                            badge === "confident" ? "AI มั่นใจ" : badge === "guess" ? "AI เดา ตรวจ" : "โปรดตรวจ"
                          }
                        >
                          {badge === "confident" ? "🟢" : "🟡"}
                        </span>
                      ) : null}
                      <select
                        value={l.vatType}
                        onChange={(e) => onVatSelect(l, e.target.value)}
                        disabled={readOnly}
                        aria-label="ประเภท VAT"
                        title="VAT นอก = บวก 7% เพิ่ม · VAT ใน = บิลรวม VAT แล้ว (เลือกเพื่อถอด VAT ออกจากยอด)"
                        className="acc-vat-sel"
                      >
                        <option value="vat">VAT นอก</option>
                        <option value="vat_in">VAT ใน (ถอด)</option>
                        <option value="novat">ไม่ VAT</option>
                      </select>
                      <AccountCell
                        line={l}
                        readOnly={readOnly}
                        onSelect={(code, name) => patchLine(l.key, { accountCode: code, accountName: name })}
                        onNameChange={(name) => patchLine(l.key, { accountName: name })}
                        onClear={() => patchLine(l.key, { accountCode: "", accountName: "" })}
                      />
                    </div>
                    <input className="num" inputMode="decimal" value={l.amount} onChange={(e) => onAmountChange(l, e.target.value)} disabled={readOnly} placeholder="0.00" aria-label="มูลค่า" />
                    <input className="num" inputMode="decimal" value={l.vatAmount} onChange={(e) => patchLine(l.key, { vatAmount: e.target.value })} disabled={readOnly} placeholder="0.00" aria-label="VAT" />
                    <input className="num" inputMode="decimal" value={l.whtRate} onChange={(e) => onWhtRateChange(l, e.target.value)} disabled={readOnly} placeholder="0" aria-label="อัตราหัก %" />
                    <input className="num" inputMode="decimal" value={l.whtAmount} onChange={(e) => patchLine(l.key, { whtAmount: e.target.value })} disabled={readOnly} placeholder="0.00" aria-label="หัก ณ ที่จ่าย" />
                    <span className="num acc-net">{formatMoney(net)}</span>
                    {!readOnly ? (
                      <button type="button" className="acc-line-del" onClick={() => removeLine(l)} aria-label="ลบบรรทัด" title="ลบบรรทัด">✕</button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}

              {!readOnly ? (
                <button type="button" className="acc-add-line" onClick={addLine}>+ เพิ่มบรรทัด</button>
              ) : null}

              {/* รวมสด */}
              <div className="acc-line acc-line-total">
                <div className="acc-line-desc strong">รวม</div>
                <span className="num strong">{formatMoney(totals.amount)}</span>
                <span className="num strong">{formatMoney(totals.vat)}</span>
                <span className="num" />
                <span className="num strong">{formatMoney(totals.wht)}</span>
                <span className="num strong">{formatMoney(totals.net)}</span>
                <span />
              </div>
            </div>

            {msg && !msg.ok ? <div className="action-msg err">{msg.text}</div> : null}

            {/* ---- ปุ่ม ---- */}
            <div className="acc-modal-actions">
              {!readOnly ? (
                <>
                  <button type="button" className="btn" onClick={() => save(false)} disabled={pending}>
                    {pending ? "กำลังบันทึก…" : "บันทึกร่าง"}
                  </button>
                  <button type="button" className="btn green" onClick={() => save(true)} disabled={pending}>
                    ยืนยัน
                  </button>
                </>
              ) : null}
              <button type="button" className="btn danger" onClick={remove} disabled={pending}>ลบ</button>
              <span className="acc-toolbar-spacer" />
              <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>ปิด</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ป้ายเล็ก "🤖 AI" — บอกว่าช่องหัวนี้ AI เป็นคนเติมให้ (นักบัญชีตรวจ/แก้ได้) */
function AiTag() {
  return (
    <span className="acc-ai-tag" title="AI เติมให้ — ช่วยตรวจ">
      🤖 AI
    </span>
  );
}

/**
 * AccountCell — ตัวเลือก "บัญชี" จากผังบัญชีมาตรฐานกลาง ต่อ 1 บรรทัด
 *   3 โหมด:
 *     - readOnly (ยืนยันแล้ว) : แสดงรหัส + ชื่อ อ่านอย่างเดียว
 *     - ยังไม่เลือก           : combobox ค้นหา (พิมพ์กรอง → คลิก/Enter เลือก · Esc ปิด)
 *     - เลือกแล้ว             : รหัส (badge ล็อก อ่านอย่างเดียว) + ชื่อบัญชี (แก้ได้) + ปุ่ม "เปลี่ยน"
 *   ★ รหัสล็อกเสมอ — เปลี่ยนได้เฉพาะกด "เปลี่ยน" (ล้าง code+name) แล้วเลือกใหม่
 *   ★ เขียน combobox เองด้วย state (ไม่พึ่งไลบรารีนอก)
 */
function AccountCell({
  line,
  readOnly,
  onSelect,
  onNameChange,
  onClear,
}: {
  line: LineRow;
  readOnly: boolean;
  onSelect: (code: string, name: string) => void;
  onNameChange: (name: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  // ผังกลางจัดกลุ่มตามหมวด (รวมบัญชีเงินฝากธนาคารในหมวด 1 แล้ว)
  //   ★ พิมพ์เลข 1–6 = เด้งทั้งหมวดนั้นมาให้เลื่อนเลือก · อย่างอื่น = ค้น substring ตามเดิม
  const chartGroups = useMemo(() => searchChartNonBankGrouped(q), [q]);
  const selected = !!line.accountCode;

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
        {line.accountCode ? <span className="acc-acct-code">{line.accountCode}</span> : null}
        <span className="acc-acct-name-ro">{line.accountName || line.description || "—"}</span>
      </div>
    );
  }

  // เลือกแล้ว → 2 ช่องแยกไม่ชนกัน: แถวบน = รหัส (ล็อก) + ปุ่มเปลี่ยน · แถวล่าง = ชื่อ (แก้ได้)
  if (selected) {
    return (
      <div className="acc-acct acc-acct-picked">
        <div className="acc-acct-toprow">
          <span className="acc-acct-code" title="รหัสบัญชี (ล็อก — กด 'เปลี่ยน' เพื่อเลือกใหม่)">
            🔒 {line.accountCode}
          </span>
          <button type="button" className="acc-acct-change" onClick={onClear} title="เลือกบัญชีใหม่">
            เปลี่ยน
          </button>
        </div>
        <input
          type="text"
          className="acc-acct-name"
          value={line.accountName}
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
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // เลือกรายการแรกในผลค้นด้วย Enter
            const firstChart = chartGroups[0]?.accounts[0];
            if (firstChart) pick(firstChart.code, firstChart.name);
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
                {grp.accounts.map((a) => (
                  <button
                    key={a.code}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="acc-acct-opt"
                    onClick={() => pick(a.code, a.name)}
                  >
                    <span className="acc-acct-opt-code">{a.code}</span>
                    <span className="acc-acct-opt-name">{a.name}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
