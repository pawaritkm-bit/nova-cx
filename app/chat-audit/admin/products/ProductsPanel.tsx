"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import {
  createProductAction,
  updateProductAction,
  toggleProductActiveAction,
  deleteProductAction,
  createProductUnitAction,
  updateProductUnitAction,
  deleteProductUnitAction,
  type ActionResult,
} from "./actions";
import type { ProductRow } from "@/lib/accounting/products";
import type { ProductUnit } from "@/lib/accounting/product-units";
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

/** dropdown เลือกสินค้าทดแทน (ตัวเลือกจากสินค้าอื่นทั้งหมด ยกเว้นตัวเอง) */
function ReplacementSelect({
  products,
  excludeId,
  defaultValue,
}: {
  products: ProductRow[];
  excludeId?: string;
  defaultValue: string;
}) {
  return (
    <select name="replacementProductId" defaultValue={defaultValue} style={{ width: 160 }}>
      <option value="">— ไม่มีสินค้าทดแทน —</option>
      {products
        .filter((p) => p.id !== excludeId)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.sku ? `${p.sku} · ` : ""}
            {p.name}
          </option>
        ))}
    </select>
  );
}

/** dropdown ประเภท VAT เริ่มต้นของสินค้า — ใช้ prefill vat_type ต่อบรรทัดบิลตอนเลือกสินค้า */
function VatTypeSelect({ defaultValue }: { defaultValue: string }) {
  return (
    <select name="defaultVatType" defaultValue={defaultValue} style={{ width: 150 }}>
      <option value="">— ไม่ตั้งค่า —</option>
      <option value="vat">VAT นอก (ค่าเริ่มต้น)</option>
      <option value="novat">ไม่มี VAT</option>
    </select>
  );
}

/** ฟอร์มเพิ่มสินค้า/บริการใหม่ */
function AddProductForm({ chart, products }: { chart: ChartAccount[]; products: ProductRow[] }) {
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
      <input name="barcode" placeholder="บาร์โค้ด (ถ้ามี)" maxLength={60} style={{ width: 130 }} />
      <input name="name" placeholder="ชื่อสินค้า/บริการ" maxLength={200} required style={{ width: 220 }} />
      <input name="nameEn" placeholder="ชื่อภาษาอังกฤษ (ไม่บังคับ)" maxLength={200} style={{ width: 180 }} />
      <input name="unit" placeholder="หน่วย เช่น ชิ้น, ชม." maxLength={30} style={{ width: 110 }} />
      <input
        name="defaultPrice"
        type="number"
        step="0.01"
        min="0"
        placeholder="ราคาขาย 1"
        style={{ width: 110 }}
      />
      <input name="price2" type="number" step="0.01" min="0" placeholder="ราคาขาย 2" style={{ width: 110 }} />
      <input name="price3" type="number" step="0.01" min="0" placeholder="ราคาขาย 3" style={{ width: 110 }} />
      <input name="price4" type="number" step="0.01" min="0" placeholder="ราคาขาย 4" style={{ width: 110 }} />
      <input name="price5" type="number" step="0.01" min="0" placeholder="ราคาขาย 5" style={{ width: 110 }} />
      <input name="category" placeholder="หมวดสินค้า (ไม่บังคับ)" maxLength={100} style={{ width: 150 }} />
      <AccountCodeSelect chart={chart} defaultValue="" />
      <VatTypeSelect defaultValue="" />
      <ReplacementSelect products={products} defaultValue="" />
      <button type="submit" className="btn">เพิ่มสินค้า</button>
      <Msg state={state} />
    </form>
  );
}

/** 1 แถวหน่วยนับเพิ่มเติม — แก้ไข/ลบ (mirror ProductRowItem แบบย่อ) */
function ProductUnitRow({ unit }: { unit: ProductUnit }) {
  const [editing, setEditing] = useState(false);
  const [updState, updAction] = useActionState(updateProductUnitAction, null);
  const [delState, delAction] = useActionState(deleteProductUnitAction, null);
  const delFormRef = useRef<HTMLFormElement>(null);

  function confirmDelete() {
    if (window.confirm(`ลบหน่วยนับ "${unit.unitName}" ? (บรรทัดบิลเก่าที่ใช้หน่วยนี้ไม่หาย)`)) {
      delFormRef.current?.requestSubmit();
    }
  }

  if (editing) {
    return (
      <form action={updAction} className="inline-form" style={{ flexWrap: "wrap" }}>
        <input type="hidden" name="id" value={unit.id} />
        <input name="unitName" defaultValue={unit.unitName} maxLength={30} required style={{ width: 100 }} />
        <span>=</span>
        <input
          name="factorToBase"
          type="number"
          step="0.0001"
          min="0.0001"
          defaultValue={unit.factorToBase}
          required
          style={{ width: 100 }}
        />
        <span className="muted">หน่วยหลัก</span>
        <button type="submit" className="btn btn-sm">บันทึก</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>ยกเลิก</button>
        <Msg state={updState} />
      </form>
    );
  }

  return (
    <div className="inline-form" style={{ flexWrap: "wrap" }}>
      <span>
        1 {unit.unitName} = {unit.factorToBase.toLocaleString("th-TH")} หน่วยหลัก
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>แก้ไข</button>
      <form action={delAction} ref={delFormRef}>
        <input type="hidden" name="id" value={unit.id} />
        <button type="button" className="btn danger btn-sm" onClick={confirmDelete}>ลบ</button>
      </form>
      <Msg state={delState} />
    </div>
  );
}

/** จัดการหน่วยนับเพิ่มเติมของสินค้า 1 รายการ (wishlist backlog ข้อ 2) — โหลดครั้งเดียวจาก page.tsx */
function ProductUnitsManager({ productId, baseUnitLabel, units }: { productId: string; baseUnitLabel: string; units: ProductUnit[] }) {
  const [state, formAction] = useActionState(createProductUnitAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div style={{ padding: "8px 0", borderTop: "1px dashed var(--line, #d9dee6)" }}>
      <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        หน่วยหลักของสินค้านี้: <strong>{baseUnitLabel}</strong> — เพิ่มหน่วยอื่นที่แปลงกลับเป็นหน่วยหลักได้ตามตัวคูณ
        (เช่น 1 โหล = 12 {baseUnitLabel})
      </p>
      {units.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>ยังไม่มีหน่วยนับอื่น</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {units.map((u) => (
            <ProductUnitRow key={u.id} unit={u} />
          ))}
        </div>
      )}
      <form
        action={formAction}
        ref={formRef}
        className="inline-form"
        style={{ flexWrap: "wrap" }}
        onSubmit={() => requestAnimationFrame(() => formRef.current?.reset())}
      >
        <input type="hidden" name="productId" value={productId} />
        <input name="unitName" placeholder="ชื่อหน่วย เช่น โหล, ลัง" maxLength={30} required style={{ width: 120 }} />
        <span>=</span>
        <input name="factorToBase" type="number" step="0.0001" min="0.0001" placeholder="ตัวคูณ" required style={{ width: 100 }} />
        <span className="muted">{baseUnitLabel}</span>
        <button type="submit" className="btn btn-sm">+ เพิ่มหน่วย</button>
      </form>
      <Msg state={state} />
    </div>
  );
}

/** 1 แถวสินค้า/บริการ — แก้ไข/สลับสถานะ/ลบ */
function ProductRowItem({
  product,
  chart,
  units,
  products,
}: {
  product: ProductRow;
  chart: ChartAccount[];
  units: ProductUnit[];
  products: ProductRow[];
}) {
  const [editing, setEditing] = useState(false);
  const [showUnits, setShowUnits] = useState(false);
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
        <td colSpan={8}>
          <form action={updAction} className="inline-form" style={{ flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={product.id} />
            <input name="sku" defaultValue={product.sku ?? ""} placeholder="รหัส/SKU" maxLength={60} style={{ width: 110 }} />
            <input name="barcode" defaultValue={product.barcode ?? ""} placeholder="บาร์โค้ด" maxLength={60} style={{ width: 110 }} />
            <input name="name" defaultValue={product.name} maxLength={200} required style={{ width: 220 }} />
            <input name="nameEn" defaultValue={product.nameEn ?? ""} placeholder="ชื่อภาษาอังกฤษ" maxLength={200} style={{ width: 160 }} />
            <input name="unit" defaultValue={product.unit ?? ""} placeholder="หน่วย" maxLength={30} style={{ width: 100 }} />
            <input
              name="defaultPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={product.defaultPrice ?? ""}
              placeholder="ราคาขาย 1"
              style={{ width: 100 }}
            />
            <input name="price2" type="number" step="0.01" min="0" defaultValue={product.price2 ?? ""} placeholder="ราคาขาย 2" style={{ width: 100 }} />
            <input name="price3" type="number" step="0.01" min="0" defaultValue={product.price3 ?? ""} placeholder="ราคาขาย 3" style={{ width: 100 }} />
            <input name="price4" type="number" step="0.01" min="0" defaultValue={product.price4 ?? ""} placeholder="ราคาขาย 4" style={{ width: 100 }} />
            <input name="price5" type="number" step="0.01" min="0" defaultValue={product.price5 ?? ""} placeholder="ราคาขาย 5" style={{ width: 100 }} />
            <input
              name="category"
              defaultValue={product.category ?? ""}
              placeholder="หมวดสินค้า (ไม่บังคับ)"
              maxLength={100}
              style={{ width: 140 }}
            />
            <AccountCodeSelect chart={chart} defaultValue={product.defaultAccountCode ?? ""} />
            <VatTypeSelect defaultValue={product.defaultVatType ?? ""} />
            <ReplacementSelect products={products} excludeId={product.id} defaultValue={product.replacementProductId ?? ""} />
            <button type="submit" className="btn">บันทึก</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>ยกเลิก</button>
          </form>
          <Msg state={updState} />
        </td>
      </tr>
    );
  }

  return (
    <Fragment>
      <tr>
        <td>{product.sku || "—"}</td>
        <td>{product.barcode || "—"}</td>
        <td>{product.name}</td>
        <td>{product.unit || "—"}</td>
        <td className="num">{product.defaultPrice != null ? product.defaultPrice.toLocaleString("th-TH") : "—"}</td>
        <td>{product.defaultAccountCode || "—"}</td>
        <td>{product.category || "—"}</td>
        <td className="center">
          <div className="inline-form" style={{ justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => setEditing(true)}>แก้ไข</button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowUnits((s) => !s)}>
              หน่วยนับ{units.length > 0 ? ` (${units.length})` : ""}
            </button>
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
      {showUnits ? (
        <tr>
          <td colSpan={8}>
            <ProductUnitsManager productId={product.id} baseUnitLabel={product.unit || "หน่วยหลัก"} units={units} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export default function ProductsPanel({
  products,
  chart,
  productUnits,
}: {
  products: ProductRow[];
  /** ผังบัญชีของ tenant (โหลดจาก DB โดย page.tsx) — ใช้ทำ dropdown เลือกรหัสบัญชีเริ่มต้น */
  chart: ChartAccount[];
  /** หน่วยนับเพิ่มเติมต่อสินค้า (wishlist backlog ข้อ 2, โหลดจาก DB โดย page.tsx) — key = productId */
  productUnits: Map<string, ProductUnit[]>;
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
      <AddProductForm chart={chart} products={products} />
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
            <th>บาร์โค้ด</th>
            <th>ชื่อสินค้า/บริการ</th>
            <th>หน่วย</th>
            <th className="num">ราคาเริ่มต้น</th>
            <th>รหัสบัญชี</th>
            <th>หมวดสินค้า</th>
            <th className="center">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <ProductRowItem key={p.id} product={p} chart={chart} units={productUnits.get(p.id) ?? []} products={products} />
          ))}
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={8} className="muted center">ไม่พบสินค้าที่ตรงกับคำค้น</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
