"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createAdjustmentAction,
  deleteMovementAction,
  upsertOpeningBalanceAction,
} from "./actions";
import type { Product } from "@/lib/accounting/products";
import type {
  StockCardRow,
  OpeningBalance,
  InventoryValuationReport,
} from "@/lib/accounting/product-stock";
import { formatMoney, parseAmountInput } from "@/lib/accounting/calc";

/**
 * InventoryPanel — สต็อกสินค้าคงเหลือของลูกค้า 1 ราย (เฟส 8 ส่วน X, T72)
 *   แท็บ "บัตรสต็อก" (เลือกสินค้า) / "สินค้าคงเหลือแยกหมวด" (ทั้งหมด ณ วันนี้ — server คำนวณมาแล้ว)
 *   ปุ่ม "บันทึกปรับปรุงสต็อก" (manual adjustment เข้า/ออก) + ฟอร์มยอดยกมาต่อสินค้า + badge เตือนติดลบ (0.12)
 *
 * ★ stockCardsByProduct/valuationReport คำนวณจาก server (computeStockLedger — replay ล้วน ไม่มี cache, 0.5)
 *   สลับสินค้า/แท็บ "ในจอ" (client) ไม่ต้อง round-trip เพราะ server ส่งบัตรสต็อกของทุกสินค้ามาให้แล้ว
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + IDOR-safe)
 */

type Tab = "card" | "valuation";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) — '' (แถวยอดยกมา) → "ยอดยกมา" */
function formatDateThai(iso: string): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

function productLabel(p: Product): string {
  return p.sku ? `${p.sku} · ${p.name}` : p.name;
}

type AdjustForm = {
  movementType: "adjustment_in" | "adjustment_out";
  quantity: string;
  unitCost: string;
  movementDate: string;
  memo: string;
};

function blankAdjustForm(): AdjustForm {
  return { movementType: "adjustment_in", quantity: "", unitCost: "", movementDate: todayIso(), memo: "" };
}

type OpeningForm = { quantity: string; unitCost: string; note: string };

function blankOpeningForm(opening?: OpeningBalance): OpeningForm {
  return {
    quantity: opening ? String(opening.quantity) : "",
    unitCost: opening ? String(opening.unitCost) : "",
    note: opening?.note ?? "",
  };
}

function StockCardTable({
  rows,
  pending,
  onDelete,
}: {
  rows: StockCardRow[];
  pending: boolean;
  onDelete: (movementId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="empty">ยังไม่มียอดยกมา/รายการเคลื่อนไหวของสินค้านี้</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>วันที่</th>
            <th>รายการ</th>
            <th>อ้างอิง</th>
            <th className="num">รับ (จำนวน)</th>
            <th className="num">รับ (ราคา/หน่วย)</th>
            <th className="num">รับ (มูลค่า)</th>
            <th className="num">จ่าย (จำนวน)</th>
            <th className="num">จ่าย (ราคา/หน่วย)</th>
            <th className="num">จ่าย (มูลค่า)</th>
            <th className="num">คงเหลือ (จำนวน)</th>
            <th className="num">คงเหลือ (ราคา/หน่วย)</th>
            <th className="num">คงเหลือ (มูลค่า)</th>
            <th>จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.movementId ?? `opening-${idx}`}>
              <td>{formatDateThai(r.date)}</td>
              <td>{r.docLabel}</td>
              <td>{r.reference || "—"}</td>
              <td className="num">{r.inQuantity != null ? r.inQuantity.toLocaleString("th-TH") : "—"}</td>
              <td className="num">{r.inUnitCost != null ? formatMoney(r.inUnitCost) : "—"}</td>
              <td className="num">{r.inValue != null ? formatMoney(r.inValue) : "—"}</td>
              <td className="num">{r.outQuantity != null ? r.outQuantity.toLocaleString("th-TH") : "—"}</td>
              <td className="num">{r.outUnitCost != null ? formatMoney(r.outUnitCost) : "—"}</td>
              <td className="num">{r.outValue != null ? formatMoney(r.outValue) : "—"}</td>
              <td className={`num strong${r.negativeWarning ? " acc-budget-diff-neg" : ""}`}>
                {r.balanceQuantity.toLocaleString("th-TH")}
                {r.negativeWarning ? (
                  <span className="vat-badge no" title="คงเหลือติดลบ — ตรวจสอบรายการที่ตกหล่น" style={{ marginLeft: 6 }}>
                    ติดลบ
                  </span>
                ) : null}
              </td>
              <td className="num">{formatMoney(r.balanceUnitCost)}</td>
              <td className="num">{formatMoney(r.balanceValue)}</td>
              <td>
                {r.movementId ? (
                  <button
                    type="button"
                    className="btn btn-sm danger"
                    disabled={pending}
                    onClick={() => onDelete(r.movementId!)}
                  >
                    ยกเลิกรายการ
                  </button>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValuationView({ report }: { report: InventoryValuationReport }) {
  if (report.groups.length === 0) {
    return <p className="empty">ยังไม่มีสินค้าที่มียอดยกมา/รายการเคลื่อนไหวของลูกค้ารายนี้</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>สินค้า</th>
            <th className="num">จำนวนคงเหลือ</th>
            <th className="num">ราคาต่อหน่วยเฉลี่ย</th>
            <th className="num">มูลค่ารวม</th>
          </tr>
        </thead>
        <tbody>
          {report.groups.map((g) => (
            <Fragment key={g.category}>
              <tr className="acc-jrow-sep">
                <td colSpan={4} className="strong">{g.category}</td>
              </tr>
              {g.items.map((it) => (
                <tr key={it.productId}>
                  <td>{it.productName}</td>
                  <td className={`num${it.negativeWarning ? " acc-budget-diff-neg" : ""}`}>
                    {it.quantity.toLocaleString("th-TH")}
                    {it.negativeWarning ? (
                      <span className="vat-badge no" title="คงเหลือติดลบ" style={{ marginLeft: 6 }}>ติดลบ</span>
                    ) : null}
                  </td>
                  <td className="num">{formatMoney(it.unitCost)}</td>
                  <td className="num">{formatMoney(it.value)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="strong">รวม {g.category}</td>
                <td className="num strong">{formatMoney(g.totalValue)}</td>
              </tr>
            </Fragment>
          ))}
          <tr className="acc-total">
            <td colSpan={3} className="strong">รวมทั้งสิ้น</td>
            <td className="num strong">{formatMoney(report.grandTotalValue)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function InventoryPanel({
  customerId,
  products,
  stockCardsByProduct,
  openingByProduct,
  valuationReport,
}: {
  customerId: string;
  products: Product[];
  stockCardsByProduct: Record<string, StockCardRow[]>;
  openingByProduct: Record<string, OpeningBalance>;
  valuationReport: InventoryValuationReport;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("card");
  const [productId, setProductId] = useState<string>(products[0]?.id ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [adjustForm, setAdjustForm] = useState<AdjustForm>(() => blankAdjustForm());
  const [openingForm, setOpeningForm] = useState<OpeningForm>(() => blankOpeningForm(openingByProduct[productId]));

  const selectedProduct = useMemo(() => products.find((p) => p.id === productId) ?? null, [products, productId]);
  const cardRows = stockCardsByProduct[productId] ?? [];
  const hasNegative = cardRows.some((r) => r.negativeWarning);

  function selectProduct(id: string) {
    setProductId(id);
    setOpeningForm(blankOpeningForm(openingByProduct[id]));
    setMsg(null);
  }

  function submitAdjustment() {
    if (!productId) {
      setMsg({ ok: false, text: "กรุณาเลือกสินค้าก่อน" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await createAdjustmentAction({
        customerId,
        productId,
        movementType: adjustForm.movementType,
        quantity: parseAmountInput(adjustForm.quantity),
        unitCost: adjustForm.movementType === "adjustment_in" ? parseAmountInput(adjustForm.unitCost) : undefined,
        movementDate: adjustForm.movementDate,
        memo: adjustForm.memo,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setAdjustForm(blankAdjustForm());
        router.refresh();
      }
    });
  }

  function onDeleteMovement(movementId: string) {
    if (!window.confirm("ยกเลิกรายการเคลื่อนไหวสต็อกนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteMovementAction(movementId, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function submitOpening() {
    if (!productId) {
      setMsg({ ok: false, text: "กรุณาเลือกสินค้าก่อน" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await upsertOpeningBalanceAction({
        customerId,
        productId,
        quantity: parseAmountInput(openingForm.quantity),
        unitCost: parseAmountInput(openingForm.unitCost),
        note: openingForm.note,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      <div className="acc-subtabs" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={`acc-subtab${tab === "card" ? " active" : ""}`}
          onClick={() => setTab("card")}
        >
          บัตรสต็อก
        </button>
        <button
          type="button"
          className={`acc-subtab${tab === "valuation" ? " active" : ""}`}
          onClick={() => setTab("valuation")}
        >
          สินค้าคงเหลือแยกหมวด
        </button>
      </div>

      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {tab === "valuation" ? (
        <ValuationView report={valuationReport} />
      ) : products.length === 0 ? (
        <p className="empty">ยังไม่มีสินค้า/บริการในสำนักงานของคุณ — เพิ่มได้ที่หน้า &quot;จัดการสินค้า/บริการ&quot; (admin)</p>
      ) : (
        <>
          <div className="acc-field-grid" style={{ marginBottom: 12 }}>
            <label className="acc-field acc-field-wide">
              <span>เลือกสินค้า</span>
              <select value={productId} onChange={(e) => selectProduct(e.target.value)} disabled={pending}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{productLabel(p)}</option>
                ))}
              </select>
            </label>
            {selectedProduct ? (
              <div className="acc-field">
                <span className="muted">หมวด: {selectedProduct.category || "สินค้า"} · หน่วย: {selectedProduct.unit || "—"}</span>
              </div>
            ) : null}
            {productId ? (
              <a
                href={`/chat-audit/accounting/inventory/export?customerId=${customerId}&productId=${productId}`}
                className="btn btn-ghost"
                style={{ alignSelf: "flex-end" }}
              >
                ⬇ Export บัตรสต็อกนี้
              </a>
            ) : null}
            {hasNegative ? (
              <div className="action-msg err" style={{ margin: 0 }}>
                ⚠ คงเหลือติดลบ — ตรวจสอบรายการที่ตกหล่น
              </div>
            ) : null}
          </div>

          <StockCardTable rows={cardRows} pending={pending} onDelete={onDeleteMovement} />

          <div className="acc-je-form" style={{ marginTop: 16 }}>
            <div className="acc-je-form-head">
              <span className="strong">ยอดยกมา (ก่อนรายการเคลื่อนไหวทั้งหมด)</span>
            </div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>จำนวน</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={openingForm.quantity}
                  onChange={(e) => setOpeningForm((f) => ({ ...f, quantity: e.target.value }))}
                  placeholder="0"
                  disabled={pending}
                />
              </label>
              <label className="acc-field">
                <span>ราคาต่อหน่วย</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={openingForm.unitCost}
                  onChange={(e) => setOpeningForm((f) => ({ ...f, unitCost: e.target.value }))}
                  placeholder="0.00"
                  disabled={pending}
                />
              </label>
              <label className="acc-field acc-field-wide">
                <span>หมายเหตุ</span>
                <input
                  type="text"
                  value={openingForm.note}
                  onChange={(e) => setOpeningForm((f) => ({ ...f, note: e.target.value }))}
                  maxLength={300}
                  disabled={pending}
                />
              </label>
            </div>
            <div className="acc-modal-actions">
              <button type="button" className="btn" onClick={submitOpening} disabled={pending}>
                {pending ? "กำลังบันทึก…" : "บันทึกยอดยกมา"}
              </button>
            </div>
          </div>

          <div className="acc-je-form" style={{ marginTop: 16 }}>
            <div className="acc-je-form-head">
              <span className="strong">บันทึกปรับปรุงสต็อก (สินค้าเสียหาย/นับสต็อกจริงต่างจากระบบ ฯลฯ)</span>
            </div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>ประเภท</span>
                <select
                  value={adjustForm.movementType}
                  onChange={(e) =>
                    setAdjustForm((f) => ({ ...f, movementType: e.target.value as AdjustForm["movementType"] }))
                  }
                  disabled={pending}
                >
                  <option value="adjustment_in">ปรับปรุงเพิ่ม (รับเข้า)</option>
                  <option value="adjustment_out">ปรับปรุงลด (จ่ายออก)</option>
                </select>
              </label>
              <label className="acc-field">
                <span>วันที่</span>
                <input
                  type="date"
                  value={adjustForm.movementDate}
                  onChange={(e) => setAdjustForm((f) => ({ ...f, movementDate: e.target.value }))}
                  disabled={pending}
                />
              </label>
              <label className="acc-field">
                <span>จำนวน</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={adjustForm.quantity}
                  onChange={(e) => setAdjustForm((f) => ({ ...f, quantity: e.target.value }))}
                  placeholder="0"
                  disabled={pending}
                />
              </label>
              {adjustForm.movementType === "adjustment_in" ? (
                <label className="acc-field">
                  <span>ราคาต่อหน่วย</span>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={adjustForm.unitCost}
                    onChange={(e) => setAdjustForm((f) => ({ ...f, unitCost: e.target.value }))}
                    placeholder="0.00"
                    disabled={pending}
                  />
                </label>
              ) : null}
              <label className="acc-field acc-field-wide">
                <span>หมายเหตุ</span>
                <input
                  type="text"
                  value={adjustForm.memo}
                  onChange={(e) => setAdjustForm((f) => ({ ...f, memo: e.target.value }))}
                  maxLength={300}
                  disabled={pending}
                />
              </label>
            </div>
            <div className="acc-modal-actions">
              <button type="button" className="btn" onClick={submitAdjustment} disabled={pending}>
                {pending ? "กำลังบันทึก…" : "บันทึกปรับปรุงสต็อก"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
