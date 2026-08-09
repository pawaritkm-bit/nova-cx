"use client";

import { useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import {
  createProductAction,
  updateProductAction,
  toggleProductActiveAction,
  deleteProductAction,
  type ActionResult,
} from "./actions";
import type { ProductRow } from "@/lib/accounting/products";
import { searchChartNonBankGrouped, type ChartAccount } from "@/lib/accounting/chart-of-accounts";

/** ข้อความผลลัพธ์ของ action (ok/err) */
function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`action-msg ${state.ok ? "ok" : "err"}`}>{state.message}</p>;
}

/** dropdown เลือกรหัสบัญชี (ผังบัญชี, จัดกลุ่มตามหมวด) — ใช้ทั้งฟอร์มเพิ่ม/แก้ */
function AccountCodeSelect({
  chart,
  defaultValue,
  disabled,
}: {
  chart: ChartAccount[];
  defaultValue: string;
  disabled?: boolean;
}) {
  const groups = useMemo(() => searchChartNonBankGrouped(chart, ""), [chart]);
  return (
    <select name="defaultAccountCode" defaultValue={defaultValue} disabled={disabled} style={{ width: 220 }}>
      <option value="">— ไม่ผูกบัญชี —</option>
      {groups.map((g) => (
        <optgroup key={g.digit} label={`${g.digit} ${g.category}`}>
          {g.accounts.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} {a.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** ฟอร์มเพิ่มสินค้า/บริการใหม่ */
function AddProductForm({ chart }: { chart: ChartAccount[] }) {
  const [state, formAction] = useActionState(createProductAction, null);
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
      <input name="sku" placeholder="รหัส/SKU (ถ้ามี)" maxLength={60} style={{ width: 130 }} />
      <input name="name" placeholder="ชื่อสินค้า/บริการ" maxLength={200} required style={{ width: 220 }} />
      <input name="unit" placeholder="หน่วย เช่น ชิ้น, ชม." maxLength={30} style={{ width: 110 }} />
      <input
        name="defaultPrice"
        type="number"
        step="0.01"
        min="0"
        placeholder="ราคาเริ่มต้น"
        style={{ width: 130 }}
      />
      <AccountCodeSelect chart={chart} defaultValue="" />
      <button type="submit" className="btn">เพิ่มสินค้า</button>
      <Msg state={state} />
    </form>
  );
}

/** 1 แถวสินค้า/บริการ — แก้ไข/สลับสถานะ/ลบ */
function ProductRowItem({ product, chart }: { product: ProductRow; chart: ChartAccount[] }) {
  const [editing, setEditing] = useState(false);
  const [updState, updAction] = useActionState(updateProductAction, null);
  const [toggleState, toggleAction] = useActionState(toggleProductActiveAction, null);
  const [delState, delAction] = useActionState(deleteProductAction, null);
  const delFormRef = useRef<HTMLFormElement>(null);

  function confirmDelete() {
    if (window.confirm(`ลบสินค้า "${product.name}" ? (ซ่อนจากรายการ — บิลเก่าที่เคยเลือกไว้ไม่หาย)`)) {
      delFormRef.current?.requestSubmit();
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={6}>
          <form action={updAction} className="inline-form" style={{ flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={product.id} />
            <input name="sku" defaultValue={product.sku ?? ""} placeholder="รหัส/SKU" maxLength={60} style={{ width: 110 }} />
            <input name="name" defaultValue={product.name} maxLength={200} required style={{ width: 220 }} />
            <input name="unit" defaultValue={product.unit ?? ""} placeholder="หน่วย" maxLength={30} style={{ width: 100 }} />
            <input
              name="defaultPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={product.defaultPrice ?? ""}
              style={{ width: 120 }}
            />
            <AccountCodeSelect chart={chart} defaultValue={product.defaultAccountCode ?? ""} />
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
      <td>{product.sku || "—"}</td>
      <td>{product.name}</td>
      <td>{product.unit || "—"}</td>
      <td className="num">{product.defaultPrice != null ? product.defaultPrice.toLocaleString("th-TH") : "—"}</td>
      <td>{product.defaultAccountCode || "—"}</td>
      <td className="center">
        <div className="inline-form" style={{ justifyContent: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>แก้ไข</button>
          <form action={toggleAction}>
            <input type="hidden" name="id" value={product.id} />
            <input type="hidden" name="isActive" value={product.isActive ? "0" : "1"} />
            <button type="submit" className="btn btn-ghost">
              {product.isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"}
            </button>
          </form>
          <form action={delAction} ref={delFormRef}>
            <input type="hidden" name="id" value={product.id} />
            <button type="button" className="btn danger" onClick={confirmDelete}>ลบ</button>
          </form>
        </div>
        <Msg state={toggleState} />
        <Msg state={delState} />
      </td>
    </tr>
  );
}

export default function ProductsPanel({
  products,
  chart,
}: {
  products: ProductRow[];
  /** ผังบัญชีของ tenant (โหลดจาก DB โดย page.tsx) — ใช้ทำ dropdown เลือกรหัสบัญชีเริ่มต้น */
  chart: ChartAccount[];
}) {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    return products.filter((p) => {
      if (!showInactive && !p.isActive) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s);
    });
  }, [products, query, showInactive]);

  return (
    <div className="card">
      <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        สินค้า/บริการนี้ใช้ร่วมทุกลูกค้าภายในสำนักงานของคุณ — เลือกได้ในบรรทัดบิลของนักบัญชี (ช่วย prefill
        รายละเอียด+รหัสบัญชี แก้ต่อบรรทัดได้ปกติ)
      </p>
      <AddProductForm chart={chart} />
      <div className="inline-form" style={{ marginBottom: 8 }}>
        <input
          placeholder="ค้นชื่อ/รหัสสินค้า"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 240 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          แสดงสินค้าที่ปิดใช้งาน
        </label>
        <span className="muted" style={{ fontSize: 13 }}>{filtered.length} / {products.length} รายการ</span>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>ชื่อสินค้า/บริการ</th>
            <th>หน่วย</th>
            <th className="num">ราคาเริ่มต้น</th>
            <th>รหัสบัญชี</th>
            <th className="center">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <ProductRowItem key={p.id} product={p} chart={chart} />
          ))}
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted center">ไม่พบสินค้าที่ตรงกับคำค้น</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
