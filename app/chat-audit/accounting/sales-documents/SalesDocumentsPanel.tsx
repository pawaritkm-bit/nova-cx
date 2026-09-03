"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createDraftAction,
  updateDraftAction,
  deleteDraftAction,
  issueDocumentAction,
  voidDocumentAction,
  type UpsertSalesDocLineActionInput,
} from "./actions";
import {
  DOC_TYPE_LABELS,
  type SalesDocType,
} from "@/lib/accounting/doc-format";
import { lineTotal, type SalesDocument, type SalesDocumentLine, type BillingCandidate } from "@/lib/accounting/sales-documents";
import { searchProducts, type Product } from "@/lib/accounting/products";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import SalesDocumentPrintDoc from "./SalesDocumentPrintDoc";

/**
 * SalesDocumentsPanel — สร้าง/แก้/ออกเอกสาร/ยกเลิก ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล ของลูกค้า 1 ราย (เฟส 3 ส่วน K)
 *   - แท็บ 3 ประเภท (สลับในจอ — เหมือน CustomerTabs) → list เอกสารของประเภทนั้น
 *   - ฟอร์มสร้าง/แก้ไข draft (header + บรรทัด) — billing_note มีปุ่ม "ดึงจากบิลค้างชำระ"
 *   - ปุ่ม "ออกเอกสาร" (issue, เฉพาะ draft) / "ยกเลิก" (void, เฉพาะ issued) / ลิงก์พิมพ์ (issued/void)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role,
 *   re-validate ที่ server เสมอ — ไม่เชื่อ client)
 */

const TABS: SalesDocType[] = ["quotation", "purchase_order", "billing_note"];

type LineRow = {
  key: string;
  description: string;
  productId: string | null;
  sourceBillEntryId: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatAmount: string;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `sd${keySeq}`;
}

function blankLine(): LineRow {
  return {
    key: newKey(),
    description: "",
    productId: null,
    sourceBillEntryId: null,
    quantity: "1",
    unit: "",
    unitPrice: "",
    vatAmount: "",
  };
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO → ไทย วว/ดด/ปปปป (พ.ศ.) — คืน "—" ถ้าไม่มีค่า */
function formatDateThai(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

/** จำนวน x ราคาต่อหน่วย → ยอด (ปัด 2 ตำแหน่ง) — quantity ว่าง = ถือเป็น 1 */
function computeLineAmount(row: Pick<LineRow, "quantity" | "unitPrice">): number {
  const q = row.quantity.trim() === "" ? 1 : parseAmountInput(row.quantity);
  const price = parseAmountInput(row.unitPrice);
  return Math.round(q * price * 100) / 100;
}

function lineToRow(l: SalesDocumentLine): LineRow {
  return {
    key: newKey(),
    description: l.description ?? "",
    productId: l.productId,
    sourceBillEntryId: l.sourceBillEntryId,
    quantity: l.quantity ? String(l.quantity) : "1",
    unit: l.unit ?? "",
    unitPrice: l.unitPrice ? String(l.unitPrice) : "",
    vatAmount: l.vatAmount ? String(l.vatAmount) : "",
  };
}

type FormState = {
  editingId: string | null;
  docDate: string;
  validUntil: string;
  counterpartyName: string;
  counterpartyTaxId: string;
  counterpartyAddress: string;
  notes: string;
  lines: LineRow[];
};

function blankForm(): FormState {
  return {
    editingId: null,
    docDate: todayIso(),
    validUntil: "",
    counterpartyName: "",
    counterpartyTaxId: "",
    counterpartyAddress: "",
    notes: "",
    lines: [blankLine()],
  };
}

function docToForm(doc: SalesDocument): FormState {
  return {
    editingId: doc.id,
    docDate: doc.docDate,
    validUntil: doc.validUntil ?? "",
    counterpartyName: doc.counterpartyName ?? "",
    counterpartyTaxId: doc.counterpartyTaxId ?? "",
    counterpartyAddress: doc.counterpartyAddress ?? "",
    notes: doc.notes ?? "",
    lines: doc.lines.length > 0 ? doc.lines.map(lineToRow) : [blankLine()],
  };
}

const STATUS_LABELS: Record<SalesDocument["status"], string> = {
  draft: "ร่าง",
  issued: "ออกเอกสารแล้ว",
  void: "ยกเลิกแล้ว",
};

export default function SalesDocumentsPanel({
  customerId,
  documents,
  billingCandidates,
  products,
  issuerName = "",
  issuerTaxId = "",
  issuerAddress = "",
  issuerPhone = "",
  logoUrl = "",
  stampUrl = "",
}: {
  customerId: string;
  documents: SalesDocument[];
  billingCandidates: BillingCandidate[];
  products: Product[];
  /** ★ 2026-09-03 ตัวอย่างสดข้างฟอร์ม — ข้อมูลผู้ออก + โลโก้/ตรา (โหลดจาก server page) */
  issuerName?: string;
  issuerTaxId?: string;
  issuerAddress?: string;
  issuerPhone?: string;
  logoUrl?: string;
  stampUrl?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [type, setType] = useState<SalesDocType>("quotation");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [candidatesOpenFor, setCandidatesOpenFor] = useState(false);
  // ★ เอกสารที่เพิ่งออกเลขจากฟอร์ม — โชว์แบนเนอร์ "พิมพ์ / บันทึก PDF" ทันที
  const [justIssued, setJustIssued] = useState<{ id: string; docNo: string } | null>(null);

  const docsOfType = useMemo(
    () => documents.filter((d) => d.documentType === type).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [documents, type]
  );

  function switchType(t: SalesDocType) {
    setType(t);
    setShowForm(false);
    setMsg(null);
  }

  function openCreate() {
    setForm(blankForm());
    setShowForm(true);
    setMsg(null);
  }

  function openEdit(doc: SalesDocument) {
    if (doc.status !== "draft") {
      setMsg({ ok: false, text: "เอกสารนี้ออกเลขที่แล้ว — แก้ไขไม่ได้ (ยกเลิกแล้วสร้างใหม่แทน)" });
      return;
    }
    setForm(docToForm(doc));
    setShowForm(true);
    setMsg(null);
  }

  function patch(p: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }
  function patchLine(key: string, p: Partial<LineRow>) {
    setForm((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));
  }
  function addLine() {
    setForm((prev) => ({ ...prev, lines: [...prev.lines, blankLine()] }));
  }
  function removeLine(key: string) {
    setForm((prev) => (prev.lines.length <= 1 ? prev : { ...prev, lines: prev.lines.filter((l) => l.key !== key) }));
  }
  function pickProduct(key: string, p: Product) {
    patchLine(key, {
      productId: p.id,
      description: p.name,
      unit: p.unit ?? "",
      unitPrice: p.defaultPrice != null ? String(p.defaultPrice) : "",
    });
  }
  function pickBillingCandidate(c: BillingCandidate) {
    setForm((prev) => ({
      ...prev,
      lines: [
        ...prev.lines.filter((l) => l.description || l.unitPrice || l.sourceBillEntryId),
        {
          key: newKey(),
          description: `บิล ${c.docNo ?? "—"} วันที่ ${formatDateThai(c.docDate)}${c.counterpartyName ? " · " + c.counterpartyName : ""}`,
          productId: null,
          sourceBillEntryId: c.entryId,
          quantity: "1",
          unit: "",
          unitPrice: String(c.outstanding),
          vatAmount: "",
        },
      ],
    }));
    setCandidatesOpenFor(false);
  }

  const formTotal = useMemo(
    () =>
      lineTotal(
        form.lines.map((l) => ({ amount: computeLineAmount(l), vatAmount: parseAmountInput(l.vatAmount) }))
      ),
    [form.lines]
  );

  // ★ 2026-09-03 ผู้ใช้: "ระหว่างพิมพ์รายละเอียด มีตัวอย่างใบวางบิลข้าง ๆ ให้ดู" —
  //   ประกอบ SalesDocument จากค่าฟอร์มสด ๆ แล้วส่งเข้า SalesDocumentPrintDoc (markup เดียวกับ
  //   หน้าพิมพ์จริง 100%) → พิมพ์ปุ๊บตัวอย่างขวาเปลี่ยนปั๊บ รวมคำนวณยอด/VAT
  const previewDoc: SalesDocument = useMemo(() => {
    const lines: SalesDocumentLine[] = form.lines.map((l, i) => ({
      id: l.key,
      lineNo: i + 1,
      description: l.description || null,
      productId: l.productId,
      sourceBillEntryId: l.sourceBillEntryId,
      quantity: l.quantity.trim() === "" ? 1 : parseAmountInput(l.quantity),
      unit: l.unit || null,
      unitPrice: parseAmountInput(l.unitPrice),
      amount: computeLineAmount(l),
      vatAmount: parseAmountInput(l.vatAmount),
    }));
    return {
      id: form.editingId ?? "preview",
      tenantId: "",
      customerId,
      documentType: type,
      docNo: null,
      docDate: form.docDate,
      validUntil: type === "quotation" ? form.validUntil || null : null,
      counterpartyName: form.counterpartyName || null,
      counterpartyTaxId: form.counterpartyTaxId || null,
      counterpartyAddress: form.counterpartyAddress || null,
      notes: form.notes || null,
      status: "draft",
      createdAt: "",
      updatedAt: "",
      issuedAt: null,
      lines,
    };
  }, [form, type, customerId]);

  /** บันทึก (สร้าง/แก้) แล้วออกเอกสารต่อทันที — ปุ่ม "✓ ออกเอกสาร" ในฟอร์ม */
  function saveAndIssue() {
    if (!window.confirm("ออกเอกสารนี้? หลังออกเลขที่แล้วแก้ไขไม่ได้อีก (ผิดพลาดต้องยกเลิกแล้วสร้างใหม่)")) return;
    setMsg(null);
    const payload = {
      documentType: type,
      docDate: form.docDate,
      validUntil: type === "quotation" ? form.validUntil || null : null,
      counterpartyName: form.counterpartyName || null,
      counterpartyTaxId: form.counterpartyTaxId || null,
      counterpartyAddress: form.counterpartyAddress || null,
      notes: form.notes || null,
      lines: buildLinesPayload(),
    };
    startTransition(async () => {
      const saved = form.editingId
        ? await updateDraftAction(form.editingId, payload)
        : await createDraftAction(customerId, payload);
      if (!saved.ok || !saved.id) {
        setMsg({ ok: false, text: saved.message });
        return;
      }
      const issued = await issueDocumentAction(saved.id);
      if (!issued.ok) {
        // บันทึกร่างสำเร็จแต่ออกเลขไม่ผ่าน — คงฟอร์มไว้ให้แก้ (ร่างอยู่ในรายการแล้ว)
        setForm((prev) => ({ ...prev, editingId: saved.id ?? prev.editingId }));
        setMsg({ ok: false, text: issued.message });
        router.refresh();
        return;
      }
      setJustIssued({ id: saved.id, docNo: issued.docNo ?? "" });
      setMsg(null);
      setShowForm(false);
      router.refresh();
    });
  }

  function buildLinesPayload(): UpsertSalesDocLineActionInput[] {
    return form.lines.map((l) => ({
      description: l.description || null,
      productId: l.productId,
      sourceBillEntryId: l.sourceBillEntryId,
      quantity: parseAmountInput(l.quantity || "1"),
      unit: l.unit || null,
      unitPrice: parseAmountInput(l.unitPrice),
      amount: computeLineAmount(l),
      vatAmount: parseAmountInput(l.vatAmount),
    }));
  }

  function submit() {
    setMsg(null);
    const payload = {
      documentType: type,
      docDate: form.docDate,
      validUntil: type === "quotation" ? form.validUntil || null : null,
      counterpartyName: form.counterpartyName || null,
      counterpartyTaxId: form.counterpartyTaxId || null,
      counterpartyAddress: form.counterpartyAddress || null,
      notes: form.notes || null,
      lines: buildLinesPayload(),
    };
    startTransition(async () => {
      const res = form.editingId
        ? await updateDraftAction(form.editingId, payload)
        : await createDraftAction(customerId, payload);
      setMsg({ ok: res.ok, text: res.ok ? "บันทึกแล้ว" : res.message });
      if (res.ok) {
        setShowForm(false);
        router.refresh();
      }
    });
  }

  function onDelete(id: string) {
    if (!window.confirm("ลบเอกสารร่างนี้? (ยังไม่ออกเลขที่ — ลบแล้วไม่เสียเลข)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteDraftAction(id);
      setMsg({ ok: res.ok, text: res.ok ? "ลบแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  function onIssue(id: string) {
    if (!window.confirm("ออกเอกสารนี้? หลังออกเลขที่แล้วแก้ไขไม่ได้อีก (ผิดพลาดต้องยกเลิกแล้วสร้างใหม่)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await issueDocumentAction(id);
      setMsg({ ok: res.ok, text: res.ok ? res.message : res.message });
      if (res.ok) router.refresh();
    });
  }

  function onVoid(id: string) {
    if (!window.confirm("ยกเลิกเอกสารนี้? (เลขที่เดิมจะไม่ถูกนำกลับมาใช้ซ้ำ)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await voidDocumentAction(id);
      setMsg({ ok: res.ok, text: res.ok ? "ยกเลิกเอกสารแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      <div className="acc-subtabs" style={{ marginBottom: 12 }}>
        {TABS.map((t) => {
          const n = documents.filter((d) => d.documentType === t).length;
          const active = type === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => switchType(t)}
              className={`acc-subtab${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {DOC_TYPE_LABELS[t]} <span className="acc-subtab-n">{n}</span>
            </button>
          );
        })}
        <span className="acc-toolbar-spacer" />
        {!showForm ? (
          <button type="button" className="btn" onClick={openCreate} disabled={pending}>
            + สร้าง{DOC_TYPE_LABELS[type]}
          </button>
        ) : null}
      </div>

      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {/* ★ เพิ่งออกเอกสารจากฟอร์ม — ปุ่มพิมพ์ใหญ่ ๆ ทันที ไม่ต้องไปหาในตาราง */}
      {justIssued ? (
        <div className="sd-issued-banner">
          <span>✓ ออกเอกสารแล้ว เลขที่ <b>{justIssued.docNo || "—"}</b></span>
          <a
            href={`/chat-audit/accounting/sales-documents/${justIssued.id}/print`}
            className="sd-btn sd-live-print on"
            target="_blank"
            rel="noopener"
          >
            🖨 พิมพ์ / บันทึก PDF
          </a>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJustIssued(null)}>
            ปิด
          </button>
        </div>
      ) : null}

      {showForm ? (
        <div className="sd-live-grid">
        <div className="acc-je-form">
          <div className="acc-je-form-head">
            <span className="strong">{form.editingId ? `แก้ไข${DOC_TYPE_LABELS[type]} (ร่าง)` : `สร้าง${DOC_TYPE_LABELS[type]}ใหม่`}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} disabled={pending}>
              ปิดฟอร์ม
            </button>
          </div>

          <div className="acc-field-grid">
            <label className="acc-field">
              <span>วันที่เอกสาร</span>
              <input type="date" value={form.docDate} onChange={(e) => patch({ docDate: e.target.value })} disabled={pending} />
            </label>
            {type === "quotation" ? (
              <label className="acc-field">
                <span>ยืนราคาถึงวันที่</span>
                <input type="date" value={form.validUntil} onChange={(e) => patch({ validUntil: e.target.value })} disabled={pending} />
              </label>
            ) : null}
            <label className="acc-field acc-field-wide">
              <span>{type === "purchase_order" ? "ชื่อผู้ขาย/ซัพพลายเออร์" : "ชื่อลูกค้าปลายทาง"}</span>
              <input
                type="text"
                value={form.counterpartyName}
                onChange={(e) => patch({ counterpartyName: e.target.value })}
                placeholder="ชื่อกิจการ/บุคคล"
                maxLength={200}
                disabled={pending}
              />
            </label>
            <label className="acc-field">
              <span>เลขผู้เสียภาษี</span>
              <input
                type="text"
                value={form.counterpartyTaxId}
                onChange={(e) => patch({ counterpartyTaxId: e.target.value })}
                maxLength={20}
                disabled={pending}
              />
            </label>
            <label className="acc-field acc-field-wide">
              <span>ที่อยู่</span>
              <input
                type="text"
                value={form.counterpartyAddress}
                onChange={(e) => patch({ counterpartyAddress: e.target.value })}
                maxLength={300}
                disabled={pending}
              />
            </label>
            <label className="acc-field acc-field-wide">
              <span>หมายเหตุ</span>
              <input type="text" value={form.notes} onChange={(e) => patch({ notes: e.target.value })} maxLength={500} disabled={pending} />
            </label>
          </div>

          {type === "billing_note" ? (
            <div style={{ margin: "10px 0" }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCandidatesOpenFor((o) => !o)}
                disabled={pending}
              >
                ＋ ดึงจากบิลค้างชำระ
              </button>
              {candidatesOpenFor ? (
                <div className="sd-candidates">
                  {billingCandidates.length === 0 ? (
                    <div className="sd-candidates-empty">ไม่มีบิลเชื่อที่ยืนยันแล้วและยังค้างชำระของลูกค้ารายนี้</div>
                  ) : (
                    billingCandidates.map((c) => (
                      <button
                        type="button"
                        key={c.entryId}
                        className="sd-candidate-item"
                        onClick={() => pickBillingCandidate(c)}
                      >
                        <span>{c.docNo || "—"} · {formatDateThai(c.docDate)}</span>
                        <span>{c.counterpartyName || "—"}</span>
                        <span className="num">คงค้าง {formatMoney(c.outstanding)}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="acc-je-lines">
            <div className="sd-lines-head">
              <span>รายละเอียด</span>
              <span className="num">จำนวน</span>
              <span>หน่วย</span>
              <span className="num">ราคา/หน่วย</span>
              <span className="num">ยอด</span>
              <span className="num">VAT</span>
              <span />
            </div>
            {form.lines.map((l) => (
              <div className="sd-line" key={l.key}>
                <div className="sd-line-desc">
                  {type !== "billing_note" ? (
                    <ProductPickerButton products={products} line={l} onPick={(p) => pickProduct(l.key, p)} />
                  ) : null}
                  <input
                    type="text"
                    value={l.description}
                    onChange={(e) => patchLine(l.key, { description: e.target.value })}
                    placeholder="รายละเอียด"
                    maxLength={200}
                    disabled={pending}
                    aria-label="รายละเอียด"
                  />
                </div>
                <input
                  className="num"
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                  placeholder="1"
                  disabled={pending}
                  aria-label="จำนวน"
                />
                <input
                  type="text"
                  value={l.unit}
                  onChange={(e) => patchLine(l.key, { unit: e.target.value })}
                  placeholder="หน่วย"
                  maxLength={30}
                  disabled={pending}
                  aria-label="หน่วย"
                />
                <input
                  className="num"
                  inputMode="decimal"
                  value={l.unitPrice}
                  onChange={(e) => patchLine(l.key, { unitPrice: e.target.value })}
                  placeholder="0.00"
                  disabled={pending}
                  aria-label="ราคาต่อหน่วย"
                />
                <span className="num sd-line-amount">{formatMoney(computeLineAmount(l))}</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={l.vatAmount}
                  onChange={(e) => patchLine(l.key, { vatAmount: e.target.value })}
                  placeholder="0.00"
                  disabled={pending}
                  aria-label="VAT"
                />
                <button
                  type="button"
                  className="acc-line-del"
                  onClick={() => removeLine(l.key)}
                  disabled={pending || form.lines.length <= 1}
                  aria-label="ลบบรรทัด"
                  title="ลบบรรทัด"
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="acc-add-line" onClick={addLine} disabled={pending}>
              + เพิ่มบรรทัด
            </button>
          </div>

          <div className="sd-form-total">รวมทั้งสิ้น: <strong>{formatMoney(formTotal)}</strong> บาท</div>

          <div className="acc-modal-actions">
            <button type="button" className="btn" onClick={submit} disabled={pending}>
              {pending ? "กำลังบันทึก…" : form.editingId ? "บันทึกการแก้ไข (ร่าง)" : "บันทึกร่าง"}
            </button>
            {/* ★ 2026-09-03 ยืนยันจบในหน้าเดียว: บันทึก + ออกเลขที่ ในคลิกเดียว */}
            <button type="button" className="btn green" onClick={saveAndIssue} disabled={pending}>
              {pending ? "กำลังบันทึก…" : "✓ ออกเอกสาร (ยืนยัน + ได้เลขที่)"}
            </button>
            <span className="sd-issue-hint">ออกเอกสารแล้วแก้ไม่ได้ — ผิดต้องยกเลิกแล้วสร้างใหม่</span>
          </div>
        </div>

        {/* ---- ขวา: ตัวอย่างเอกสารจริง อัปเดตตามฟอร์มสด ๆ (markup เดียวกับหน้าพิมพ์) ---- */}
        <div className="sd-live-preview">
          <div className="sd-live-bar">
            <span className="sd-live-tag">ตัวอย่างเอกสารจริง</span>
            <span className="sd-live-dot">● อัปเดตตามที่พิมพ์ทันที</span>
            <span className="acc-toolbar-spacer" />
            <button
              type="button"
              className="sd-btn sd-live-print"
              disabled
              title="กด ✓ ออกเอกสาร ก่อน จึงพิมพ์/บันทึก PDF ได้"
            >
              🖨 พิมพ์ / บันทึก PDF
            </button>
          </div>
          <div className="sd-live-scroll">
            <SalesDocumentPrintDoc
              document={previewDoc}
              issuerName={issuerName}
              issuerTaxId={issuerTaxId}
              issuerAddress={issuerAddress}
              issuerPhone={issuerPhone}
              logoUrl={logoUrl}
              stampUrl={stampUrl}
              backHref=""
              preview
            />
          </div>
        </div>
        </div>
      ) : null}

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>เลขที่</th>
              <th>วันที่</th>
              <th>{type === "purchase_order" ? "ผู้ขาย/ซัพพลายเออร์" : "ลูกค้าปลายทาง"}</th>
              <th className="num">ยอดรวม</th>
              <th>สถานะ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {docsOfType.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">ยังไม่มี{DOC_TYPE_LABELS[type]}ของลูกค้ารายนี้</td>
              </tr>
            ) : (
              docsOfType.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.docNo || "ร่าง"}</td>
                  <td>{formatDateThai(doc.docDate)}</td>
                  <td>{doc.counterpartyName || "—"}</td>
                  <td className="num">{formatMoney(lineTotal(doc.lines))}</td>
                  <td>{STATUS_LABELS[doc.status]}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {doc.status === "draft" ? (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => openEdit(doc)} disabled={pending}>
                          แก้ไข
                        </button>
                        <button type="button" className="btn btn-sm green" onClick={() => onIssue(doc.id)} disabled={pending}>
                          ออกเอกสาร
                        </button>
                        <button type="button" className="btn btn-sm danger" onClick={() => onDelete(doc.id)} disabled={pending}>
                          ลบ
                        </button>
                      </>
                    ) : null}
                    {doc.status !== "draft" ? (
                      <a
                        href={`/chat-audit/accounting/sales-documents/${doc.id}/print`}
                        className="btn btn-sm"
                        target="_blank"
                        rel="noopener"
                      >
                        พิมพ์
                      </a>
                    ) : null}
                    {doc.status === "issued" ? (
                      <button type="button" className="btn btn-sm danger" onClick={() => onVoid(doc.id)} disabled={pending}>
                        ยกเลิก
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * ตัวเลือกสินค้า/บริการต่อ 1 บรรทัด (mirror ProductCell ของ EntryEditor.tsx เฟส 1 ส่วน B)
 *   เลือกแล้ว prefill description/unit/unitPrice — ไม่ล็อกอะไร แก้ต่อได้อิสระหลังเลือก
 */
function ProductPickerButton({
  products,
  onPick,
}: {
  products: Product[];
  line: LineRow;
  onPick: (p: Product) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchProducts(products, q).slice(0, 30), [products, q]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (products.length === 0) return null;

  return (
    <div className="acc-product-combo" ref={boxRef}>
      <button
        type="button"
        className="acc-product-pick-btn"
        onClick={() => setOpen((o) => !o)}
        title="เลือกสินค้า/บริการ (เติมรายละเอียด/ราคาให้อัตโนมัติ)"
      >
        📦
      </button>
      {open ? (
        <div className="acc-acct-list acc-product-list" role="listbox">
          <input
            type="text"
            className="acc-acct-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นชื่อ/รหัสสินค้า…"
            autoFocus
            aria-label="ค้นหาสินค้า"
          />
          {results.length === 0 ? (
            <div className="acc-acct-empty">ไม่พบสินค้าที่ค้นหา</div>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={false}
                className="acc-acct-opt"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                  setQ("");
                }}
              >
                <span className="acc-acct-opt-code">{p.sku || "—"}</span>
                <span className="acc-acct-opt-name">{p.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
