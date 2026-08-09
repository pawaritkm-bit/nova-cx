"use client";

import { useMemo, useState, useTransition } from "react";
import {
  upsertAccountMapAction,
  deleteAccountMapAction,
  upsertProductMapAction,
  deleteProductMapAction,
} from "./flowaccount-map-actions";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import type { Product } from "@/lib/accounting/products";
import type { AccountMapRow, ProductMapRow } from "@/lib/accounting/flowaccount-map";

/**
 * FlowAccountMapPanel — จัดการ mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ของลูกค้า 1 ราย (เฟส 5 ส่วน Q)
 *   - ตารางผังบัญชี (จาก listChartOfAccounts เดิม) — กรอกรหัสบัญชีฝั่ง FlowAccount ต่อแถว
 *   - ตารางสินค้า/บริการ (จาก listProducts เดิม) — กรอก id สินค้าฝั่ง FlowAccount ต่อแถว
 *
 * ★ กรอกแบบ manual text-entry (decision 0.12 ของเฟส 5) — validate แค่ความยาว/ไม่ว่างฝั่ง server
 * ★ ไม่ตั้ง mapping ก็ยังใช้งานเอกสารขายได้ตามปกติ (mapping เป็น enhancement ไม่ใช่ prerequisite)
 * ★ ทุกการเขียนผ่าน server action (guard สิทธิ์ + customer scope + service-role)
 */

type AccountRow = {
  code: string;
  name: string;
  category: string;
  mapId: string | null;
  value: string;
};

type ProductRowUi = {
  id: string;
  name: string;
  sku: string | null;
  mapId: string | null;
  value: string;
};

function buildAccountRows(chart: ChartAccount[], accountMap: AccountMapRow[]): AccountRow[] {
  const byCode = new Map(accountMap.map((m) => [m.accountCode, m]));
  return chart.map((a) => {
    const m = byCode.get(a.code);
    return {
      code: a.code,
      name: a.name,
      category: a.category,
      mapId: m?.id ?? null,
      value: m?.flowaccountAccountCode ?? "",
    };
  });
}

function buildProductRows(products: Product[], productMap: ProductMapRow[]): ProductRowUi[] {
  const byId = new Map(productMap.map((m) => [m.productId, m]));
  return products.map((p) => {
    const m = byId.get(p.id);
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      mapId: m?.id ?? null,
      value: m?.flowaccountProductId ?? "",
    };
  });
}

export default function FlowAccountMapPanel({
  customerId,
  chart,
  products,
  initialAccountMap,
  initialProductMap,
}: {
  customerId: string;
  /** ผังบัญชีของ tenant (active เท่านั้น) — โหลดครั้งเดียวโดย flowaccount-map/page.tsx */
  chart: ChartAccount[];
  /** สินค้า/บริการของ tenant (active เท่านั้น) */
  products: Product[];
  initialAccountMap: AccountMapRow[];
  initialProductMap: ProductMapRow[];
}) {
  const [accountRows, setAccountRows] = useState<AccountRow[]>(() =>
    buildAccountRows(chart, initialAccountMap)
  );
  const [productRows, setProductRows] = useState<ProductRowUi[]>(() =>
    buildProductRows(products, initialProductMap)
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [productQuery, setProductQuery] = useState("");

  const filteredAccountRows = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    if (!q) return accountRows;
    return accountRows.filter(
      (r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
    );
  }, [accountRows, accountQuery]);

  const filteredProductRows = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return productRows;
    return productRows.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q)
    );
  }, [productRows, productQuery]);

  const patchAccountValue = (code: string, value: string) =>
    setAccountRows((prev) => prev.map((r) => (r.code === code ? { ...r, value } : r)));
  const patchProductValue = (id: string, value: string) =>
    setProductRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));

  const saveAccountRow = (row: AccountRow) => {
    if (!row.value.trim()) {
      setMsg({ ok: false, text: "กรุณากรอกรหัสบัญชีฝั่ง FlowAccount ก่อนบันทึก" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await upsertAccountMapAction({
        customerId,
        accountCode: row.code,
        flowaccountAccountCode: row.value,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok && res.id) {
        setAccountRows((prev) => prev.map((r) => (r.code === row.code ? { ...r, mapId: res.id! } : r)));
      }
    });
  };

  const clearAccountRow = (row: AccountRow) => {
    if (!row.mapId) {
      patchAccountValue(row.code, "");
      return;
    }
    if (!window.confirm("ลบ mapping รหัสบัญชีนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteAccountMapAction(row.mapId!);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setAccountRows((prev) =>
          prev.map((r) => (r.code === row.code ? { ...r, mapId: null, value: "" } : r))
        );
      }
    });
  };

  const saveProductRow = (row: ProductRowUi) => {
    const trimmed = row.value.trim();
    if (!trimmed) {
      setMsg({ ok: false, text: "กรุณากรอกรหัสสินค้าฝั่ง FlowAccount ก่อนบันทึก" });
      return;
    }
    // ★ hint ฝั่ง client ให้ผู้ใช้เห็นเร็ว — validation จริง (บังคับใช้จริง) อยู่ที่ server เสมอ (upsertProductMap)
    if (!/^[1-9]\d*$/.test(trimmed)) {
      setMsg({ ok: false, text: "รหัสสินค้าฝั่ง FlowAccount ต้องเป็นตัวเลข (เช่น 12345) เท่านั้น" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await upsertProductMapAction({
        customerId,
        productId: row.id,
        flowaccountProductId: row.value,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok && res.id) {
        setProductRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, mapId: res.id! } : r)));
      }
    });
  };

  const clearProductRow = (row: ProductRowUi) => {
    if (!row.mapId) {
      patchProductValue(row.id, "");
      return;
    }
    if (!window.confirm("ลบ mapping สินค้านี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteProductMapAction(row.mapId!);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setProductRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, mapId: null, value: "" } : r))
        );
      }
    });
  };

  return (
    <div className="acc-famap">
      <p className="acc-bank-hint">
        กรอกรหัสบัญชี/รหัสสินค้าฝั่ง FlowAccount ของลูกค้ารายนี้ (คัดลอกจากหน้าจอ FlowAccount ของลูกค้ามาวาง) —
        ไม่ตั้ง mapping ก็ยังส่งเอกสารได้ตามปกติ mapping เป็นตัวช่วยให้รายการลงบัญชี/สินค้าถูกหมวดฝั่ง FlowAccount เท่านั้น
      </p>

      {/* ---- ผังบัญชี ---- */}
      <section className="acc-famap-section">
        <div className="acc-famap-section-head">
          <h3>ผังบัญชี</h3>
          <input
            type="text"
            placeholder="ค้นรหัส/ชื่อบัญชี"
            value={accountQuery}
            onChange={(e) => setAccountQuery(e.target.value)}
            className="acc-famap-search"
            aria-label="ค้นผังบัญชี"
          />
        </div>
        <div className="acc-famap-list">
          <div className="acc-famap-row acc-famap-head">
            <span>รหัส</span>
            <span>ชื่อบัญชี</span>
            <span>รหัสฝั่ง FlowAccount</span>
            <span />
          </div>
          {filteredAccountRows.length === 0 ? (
            <div className="acc-bank-empty">ไม่พบผังบัญชีที่ตรงกับคำค้น</div>
          ) : (
            filteredAccountRows.map((row) => (
              <div className="acc-famap-row" key={row.code}>
                <span className="mono">{row.code}</span>
                <span>{row.name}</span>
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => patchAccountValue(row.code, e.target.value)}
                  placeholder="เช่น 1010"
                  maxLength={60}
                  disabled={pending}
                  aria-label={`รหัสฝั่ง FlowAccount ของ ${row.name}`}
                />
                <span className="acc-famap-row-actions">
                  <button
                    type="button"
                    className="btn acc-bank-save"
                    onClick={() => saveAccountRow(row)}
                    disabled={pending}
                    title="บันทึก"
                  >
                    บันทึก
                  </button>
                  <button
                    type="button"
                    className="acc-line-del"
                    onClick={() => clearAccountRow(row)}
                    disabled={pending}
                    aria-label="ลบ"
                    title="ลบ"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- สินค้า/บริการ ---- */}
      <section className="acc-famap-section">
        <div className="acc-famap-section-head">
          <h3>สินค้า/บริการ</h3>
          <input
            type="text"
            placeholder="ค้นชื่อ/SKU สินค้า"
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
            className="acc-famap-search"
            aria-label="ค้นสินค้า"
          />
        </div>
        <div className="acc-famap-list">
          <div className="acc-famap-row acc-famap-head">
            <span>SKU</span>
            <span>ชื่อสินค้า/บริการ</span>
            <span>id ฝั่ง FlowAccount</span>
            <span />
          </div>
          {products.length === 0 ? (
            <div className="acc-bank-empty">ยังไม่มีสินค้า/บริการในระบบ — เพิ่มที่หน้าจัดการสินค้าก่อน</div>
          ) : filteredProductRows.length === 0 ? (
            <div className="acc-bank-empty">ไม่พบสินค้าที่ตรงกับคำค้น</div>
          ) : (
            filteredProductRows.map((row) => (
              <div className="acc-famap-row" key={row.id}>
                <span className="mono">{row.sku || "—"}</span>
                <span>{row.name}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  value={row.value}
                  onChange={(e) => patchProductValue(row.id, e.target.value)}
                  placeholder="เช่น 12345 (ต้องเป็นตัวเลขเท่านั้น)"
                  maxLength={60}
                  disabled={pending}
                  aria-label={`id ฝั่ง FlowAccount ของ ${row.name} (ต้องเป็นตัวเลข)`}
                />
                <span className="acc-famap-row-actions">
                  <button
                    type="button"
                    className="btn acc-bank-save"
                    onClick={() => saveProductRow(row)}
                    disabled={pending}
                    title="บันทึก"
                  >
                    บันทึก
                  </button>
                  <button
                    type="button"
                    className="acc-line-del"
                    onClick={() => clearProductRow(row)}
                    disabled={pending}
                    aria-label="ลบ"
                    title="ลบ"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}
    </div>
  );
}
