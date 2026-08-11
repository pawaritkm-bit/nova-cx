"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveEntryAction, deleteEntryAction, fetchBotRateAction, type SaveEntryInput } from "./actions";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { searchProducts, type Product } from "@/lib/accounting/products";
import AccountCombobox from "./AccountCombobox";
import CurrencyCombobox from "./CurrencyCombobox";
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
import { taxMonthOptions, taxMonthLabel } from "@/lib/accounting/tax-month";
import { validateFxRate, fxRatePlausibilityWarning, deriveThbAmount } from "@/lib/accounting/currency";

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
 * ★ entry ที่ยืนยันแล้ว = เริ่มต้นอ่านอย่างเดียว (กันแก้พลาด) — กดปุ่ม "✏️ แก้ไข" เพื่อ
 *   ปลดล็อกทั้งใบ (unlocked) แล้วแก้ทุกช่องได้ · บันทึกแล้วยัง "คงสถานะยืนยัน" (ไม่ปลดเป็นร่าง)
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
  /** สินค้า/บริการที่เลือกไว้ (เฟส 1 ส่วน B) — แค่ tag อ้างอิง เอาออกได้โดยไม่กระทบ description/accountCode ที่เติมไว้แล้ว */
  productId: string | null;
  /**
   * จำนวนที่รับ/จ่ายสต็อกจากบรรทัดนี้ (เฟส 8 ส่วน Y) — ไม่บังคับ, เก็บเป็นข้อความเหมือน amount/vatAmount
   *   โชว์เฉพาะบรรทัดที่เลือกสินค้าไว้แล้ว (mirror เงื่อนไข ProductCell) — ปล่อยว่างได้ตามปกติ
   */
  quantity: string;
  /** เฟส 10 ส่วน Z — ยอดต้นฉบับสกุลต่างประเทศ (มีความหมายเฉพาะเมื่อหัวบิลตั้ง currency ไว้) */
  fxAmount: string;
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

/** ISO (2026-06-01) → ไทย วว/ดด/ปปปป พ.ศ. (01/06/2569) สำหรับแสดง/แก้ */
function isoToThai(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "";
}

/** ไทย วว/ดด/ปปปป (พ.ศ.) → ISO (2026-06-01) สำหรับเก็บ · รูปผิด/ยังพิมพ์ไม่ครบ = "" */
function thaiToIso(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  if (!m) return "";
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let year = Number(m[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
  // ปี >= 2500 = พ.ศ. → แปลงเป็น ค.ศ. (เผื่อกรอก ค.ศ. มาก็ยังรับได้)
  if (year >= 2500) year -= 543;
  return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ตัวเลือก/ป้าย "เดือนที่ใช้ภาษีซื้อ" — ย้ายไป lib/accounting/tax-month.ts (ใช้ร่วมกับ list/รายงาน)

function initLines(entry: BillEntry): LineRow[] {
  if (entry.lines.length === 0) {
    return [
      { key: newKey(), vatType: "vat", description: "", accountCode: "", accountName: "", productId: null, quantity: "", fxAmount: "", amount: "", vatAmount: "", whtRate: "", whtAmount: "", aiFilled: false, aiLowConfidence: false },
    ];
  }
  return entry.lines.map((l) => ({
    key: l.id,
    id: l.id,
    vatType: l.vatType,
    description: l.description ?? "",
    accountCode: l.accountCode ?? "",
    accountName: l.accountName ?? "",
    productId: l.productId ?? null,
    // จำนวนสต็อก (เฟส 8 ส่วน Y) — reuse numToInput เหมือนช่องตัวเลขอื่น (null/0 → ว่าง)
    quantity: numToInput(l.quantity ?? 0),
    // ยอดต้นฉบับสกุลต่างประเทศ (เฟส 10 ส่วน Z)
    fxAmount: numToInput(l.fxAmount ?? 0),
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
  onNavigate,
  chart,
  products,
  fxLocked = false,
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
  /** ★ ถ้าส่งมา (จาก pager) → prev/next เลื่อนแบบ client (ไม่โหลดหน้าใหม่ · รูป preload ไว้) แทน navigate */
  onNavigate?: (id: string) => void;
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) — ใช้ทั้ง combobox เลือกบัญชี + hint บัญชีคู่ */
  chart: ChartAccount[];
  /**
   * สินค้า/บริการของ tenant (เฟส 1 ส่วน B, โหลดจาก DB ครั้งเดียวโดย page.tsx) — ใช้ทำ picker เลือกสินค้า
   *   ต่อบรรทัด (เลือกแล้ว prefill description+account_code/name ให้ — ไม่ auto-fill amount)
   */
  products: Product[];
  /**
   * เฟส 10 ส่วน Z (0.9) — บิลนี้มีการรับ/จ่ายเงินไปแล้ว ≥1 รายการ → ล็อกช่อง currency/fx_rate เท่านั้น
   *   (คำนวณจาก DB โดย page.tsx ครั้งเดียว — แค่ hint ของ UI, guard จริงอยู่ที่ actions-lib.ts::upsertEntry)
   */
  fxLocked?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // บิลยืนยันแล้ว = readOnly (เริ่มต้นล็อก) · กด "แก้ไข" → unlocked → ปลดล็อกทั้งใบ
  //   locked = "ล็อกอยู่จริงตอนนี้" (ใช้คุม disabled/ซ่อนปุ่มทั้งฟอร์ม)
  const readOnly = entry.status === "confirmed";
  const [unlocked, setUnlocked] = useState(false);
  const locked = readOnly && !unlocked;
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
  // เดือนที่ใช้ภาษีซื้อ (เฉพาะบิลซื้อ) — 'YYYY-MM' ค.ศ. · default = เดือนของ doc_date
  const [inputTaxMonth, setInputTaxMonth] = useState<string>(
    entry.inputTaxMonth || (entry.docDate ? entry.docDate.slice(0, 7) : "")
  );
  const [partyName, setPartyName] = useState<string>(entry.counterpartyName ?? "");
  const [partyTaxId, setPartyTaxId] = useState<string>(entry.counterpartyTaxId ?? "");
  const [whtForm, setWhtForm] = useState<WhtForm | "">(entry.whtForm ?? "");
  // วิธีจ่าย/รับเงิน (บัญชีคู่ฝั่งเครดิต)
  //   ★ บัญชีเงินฝาก (transfer) ใช้ default 1020 — เลิก UI เลือกบัญชีธนาคารต่อลูกค้าแล้ว
  //     แต่คง entry.paymentBankAccountId เดิมไว้ตอนบันทึก (กันข้อมูลเดิมหาย)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">(entry.paymentMethod ?? "");
  // วันครบกำหนดชำระ (เฟส 2 ส่วน E/F) — เก็บเป็นข้อความไทย เหมือน docDate · แสดงเฉพาะบิลเชื่อ (payment_method='credit')
  //   ★ ค่าไม่ถูกล้างเมื่อเปลี่ยนวิธีจ่ายไปมา (state คงอยู่ ซ่อน/โชว์แค่ UI เท่านั้น)
  const [dueDate, setDueDate] = useState<string>(entry.dueDate ? isoToThai(entry.dueDate) : "");
  // เฟส 10 ส่วน Z — สกุลเงินต่างประเทศ + อัตราแลกเปลี่ยนตอนออกบิล ("" = บิล THB ปกติ)
  const [currency, setCurrency] = useState<string>(entry.currency ?? "");
  const [fxRate, setFxRate] = useState<string>(entry.fxRate ? String(entry.fxRate) : "");
  const [fxMsg, setFxMsg] = useState<string | null>(null);
  const [botFetching, setBotFetching] = useState(false);
  // ล็อกเฉพาะช่อง currency/fx_rate (0.9) — มีการรับ/จ่ายเงินไปแล้ว ล็อกแม้กำลังแก้บิลที่ยืนยันแล้วอยู่ก็ตาม
  const fxFieldsReadOnly = locked || fxLocked;

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
    // ★ perf: force-dynamic → push ดึงข้อมูลสดอยู่แล้ว ไม่ต้อง refresh ซ้ำ (ปิดเร็วขึ้น)
    router.push(closeHref);
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

  /**
   * เฟส 10 ส่วน Z (0.6) — บิล FX: ยอดต้นฉบับสกุลต่างประเทศต่อบรรทัดเปลี่ยน → derive `amount` (THB) ใหม่
   *   ด้วยอัตราแลกเปลี่ยนของหัวบิล (currency ตั้งไว้เท่านั้นถึงมีผล) + คำนวณ VAT/หัก ณ ที่จ่ายต่อจาก amount ใหม่
   */
  const onFxAmountChange = (l: LineRow, raw: string) => {
    const fxAmt = parseAmountInput(raw);
    const rate = parseAmountInput(fxRate);
    const amt = deriveThbAmount(fxAmt, rate);
    const vat = calcVat(amt, l.vatType);
    const wht = calcWht(amt, parseAmountInput(l.whtRate));
    patchLine(l.key, { fxAmount: raw, amount: numToInput(amt), vatAmount: numToInput(vat), whtAmount: numToInput(wht) });
  };

  // fx_rate ของหัวบิลเปลี่ยน → derive amount ของทุกบรรทัดใหม่ (ยึด fx_amount เดิมของแต่ละบรรทัด)
  const onFxRateChange = (raw: string) => {
    setFxRate(raw);
    const rate = parseAmountInput(raw);
    setLines((prev) =>
      prev.map((l) => {
        const amt = deriveThbAmount(parseAmountInput(l.fxAmount), rate);
        return { ...l, amount: numToInput(amt), vatAmount: numToInput(calcVat(amt, l.vatType)) };
      })
    );
    const check = validateFxRate(raw);
    setFxMsg(check.ok ? fxRatePlausibilityWarning(currency, check.value) : null);
  };

  // ปุ่ม "ดึงอัตรา ธปท." — best-effort prefill (0.12) ไม่ block การบันทึกบิลเลยถ้าล้ม
  const onFetchBotRate = () => {
    if (!currency) return;
    const iso = thaiToIso(docDate) || entry.docDate || "";
    if (!iso) {
      setFxMsg("กรุณาระบุวันที่เอกสารก่อนดึงอัตรา ธปท.");
      return;
    }
    setBotFetching(true);
    setFxMsg(null);
    fetchBotRateAction(currency, iso)
      .then((res) => {
        if (res.ok) {
          onFxRateChange(String(res.rate));
        } else {
          setFxMsg("ดึงอัตราอัตโนมัติไม่สำเร็จ กรุณากรอกเอง");
        }
      })
      .finally(() => setBotFetching(false));
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { key: newKey(), vatType: "vat", description: "", accountCode: "", accountName: "", productId: null, quantity: "", fxAmount: "", amount: "", vatAmount: "", whtRate: "", whtAmount: "", aiFilled: false, aiLowConfidence: false },
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

  // ผังบัญชีของ tenant (map รหัส→บัญชี) — คำนวณครั้งเดียวจาก prop chart
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);

  // hint บัญชีคู่ (เครดิต) — transfer ใช้บัญชีเงินฝากเดิมถ้าผูกไว้ (paymentBankAccountCode) มิฉะนั้น default 1020
  const contraHint = useMemo(() => {
    if (!paymentMethod) return null;
    return contraAccountFor(chartByCode, paymentMethod, entryType, entry.paymentBankAccountCode);
  }, [chartByCode, paymentMethod, entryType, entry.paymentBankAccountCode]);

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
      // วันครบกำหนดชำระ (เฟส 2 ส่วน E/F) — มีผลเชิงความหมายเฉพาะบิลเชื่อ แต่เก็บค่าที่กรอกไว้เสมอ
      dueDate: thaiToIso(dueDate) || null,
      // เดือนที่ใช้ภาษีซื้อ — เฉพาะบิลซื้อ (ขาย/รอระบุ = null)
      inputTaxMonth: entryType === "purchase" ? (inputTaxMonth || null) : null,
      // เฟส 10 ส่วน Z (0.3/0.9) — สกุลเงินต่างประเทศ + อัตราแลกเปลี่ยนตอนออกบิล ("" = บิล THB ปกติ)
      currency: currency || null,
      fxRate: currency ? parseAmountInput(fxRate) || null : null,
      lines: lines.map((l) => ({
        id: l.id,
        vatType: l.vatType,
        // ★ sync description = ชื่อบัญชี (ถ้าเลือกบัญชี) เพื่อให้ Excel/รายงานเดิม (คอลัมน์ "รายการ")
        //   ยังมีข้อความ · ถ้ายังไม่เลือกบัญชี คงรายละเอียดเดิมไว้
        description: (l.accountName.trim() || l.description) || null,
        accountCode: l.accountCode.trim() || null,
        accountName: l.accountName.trim() || null,
        productId: l.productId,
        // จำนวนสต็อก (เฟส 8 ส่วน Y) — reuse parseAmountInput เหมือน amount/vatAmount (server จะเช็ค ≤0 → null)
        quantity: parseAmountInput(l.quantity),
        // ยอดต้นฉบับสกุลต่างประเทศ (เฟส 10 ส่วน Z) — server derive amount (THB) จากค่านี้เมื่อ currency ตั้งไว้
        fxAmount: currency ? parseAmountInput(l.fxAmount) : null,
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
  function saveThenGo(id: string) {
    // ★ เลื่อนไปบิล id: ถ้ามี onNavigate (pager) → เลื่อนแบบ client (instant · รูป preload ไว้)
    //   ไม่มี → navigate ตามเดิม (SSR)
    const go = () => {
      if (onNavigate) {
        onNavigate(id);
      } else {
        router.push(editHrefFor(id));
        router.refresh();
      }
    };
    // ล็อกอยู่ (ยืนยันแล้วยังไม่กดแก้) หรือ "ยังไม่ได้แก้อะไร" → เลื่อนเลย ไม่ต้อง save (เร็วขึ้น)
    const unchanged =
      initialInputRef.current !== null && initialInputRef.current === JSON.stringify(buildInput(false));
    if (locked || unchanged) {
      go();
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await saveEntryAction(buildInput(false));
      if (res.ok) {
        go();
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
                onClick={() => nav.prevId && saveThenGo(nav.prevId)}
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
                onClick={() => nav.nextId && saveThenGo(nav.nextId)}
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

        {readOnly && !unlocked ? (
          <div className="acc-note">รายการนี้ยืนยันแล้ว — กด “✏️ แก้ไข” เพื่อปรับแก้ (หรือลบได้)</div>
        ) : null}
        {readOnly && unlocked ? (
          <div className="acc-note">กำลังแก้บิลที่ยืนยันแล้ว — บันทึกแล้วยัง “คงสถานะยืนยัน”</div>
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
                    // ★ perf: โหลดรูปบิลก่อนสิ่งอื่น (priority สูง) + decode แบบ async — เลื่อนเปลี่ยนบิลเห็นรูปไวขึ้น
                    fetchPriority="high"
                    decoding="async"
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
                  disabled={locked}
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
                  disabled={locked}
                  placeholder="วว/ดด/ปปปป เช่น 01/06/2569"
                />
              </label>
              <label className="acc-field">
                <span>เลขที่เอกสาร {aiSrc && entry.docNo ? <AiTag /> : null}</span>
                <input type="text" value={docNo} onChange={(e) => setDocNo(e.target.value)} disabled={locked} placeholder="เช่น INV-001" />
              </label>
              {/* ยื่นภาษีในเดือน — เฉพาะบิลซื้อ (ยกภาษีซื้อไปยื่นเดือนอื่นได้ ตามกฎหมาย ≤ 6 เดือน) */}
              {entryType === "purchase" ? (
                <label className="acc-field">
                  <span>ยื่นภาษีในเดือน</span>
                  {(() => {
                    const docIso = thaiToIso(docDate);
                    const baseYm = docIso ? docIso.slice(0, 7) : entry.docDate ? entry.docDate.slice(0, 7) : inputTaxMonth;
                    const opts = taxMonthOptions(baseYm);
                    if (inputTaxMonth && !opts.includes(inputTaxMonth)) opts.unshift(inputTaxMonth);
                    return (
                      <select value={inputTaxMonth} onChange={(e) => setInputTaxMonth(e.target.value)} disabled={locked}>
                        {opts.length === 0 ? <option value="">— ตามวันที่บิล —</option> : null}
                        {opts.map((ym) => (
                          <option key={ym} value={ym}>{taxMonthLabel(ym)}</option>
                        ))}
                      </select>
                    );
                  })()}
                </label>
              ) : null}
              <label className="acc-field">
                <span>ภ.ง.ด.</span>
                <select value={whtForm} onChange={(e) => setWhtForm(e.target.value as WhtForm | "")} disabled={locked}>
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
                  disabled={locked}
                >
                  <option value="">— ยังไม่ระบุ —</option>
                  <option value="cash">{paymentMethodLabel("cash", entryType)}</option>
                  <option value="cheque">{paymentMethodLabel("cheque", entryType)}</option>
                  <option value="transfer">{paymentMethodLabel("transfer", entryType)}</option>
                  <option value="credit">{paymentMethodLabel("credit", entryType)}</option>
                </select>
              </label>

              {/* วันครบกำหนดชำระ — เฉพาะบิลเชื่อ (payment_method='credit', เฟส 2 ส่วน E/F)
                  ★ ไม่ auto-คำนวณเทอมเครดิต — นักบัญชีกรอกเองตามเงื่อนไขจริงของบิลนั้น (0.7) */}
              {paymentMethod === "credit" ? (
                <label className="acc-field">
                  <span>วันครบกำหนดชำระ (วว/ดด/ปปปป)</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    disabled={locked}
                    placeholder="วว/ดด/ปปปป เช่น 01/07/2569"
                  />
                </label>
              ) : null}

              {/* เฟส 10 ส่วน Z (0.3/0.9/0.12) — สกุลเงินต่างประเทศ + อัตราแลกเปลี่ยนตอนออกบิล
                  ★ ล็อกเฉพาะ 2 ช่องนี้เมื่อบิลมีการรับ/จ่ายเงินไปแล้ว (fxLocked) — ฟิลด์อื่นแก้ได้ตามปกติ */}
              <label className="acc-field">
                <span>สกุลเงิน {fxFieldsReadOnly ? <span title="ล็อกสกุลเงิน/อัตราแลกเปลี่ยน — มีการรับ/จ่ายเงินแล้ว">🔒</span> : null}</span>
                <CurrencyCombobox
                  currency={currency}
                  readOnly={fxFieldsReadOnly}
                  onSelect={(code) => {
                    setCurrency(code);
                    setFxMsg(null);
                  }}
                  onClear={() => {
                    setCurrency("");
                    setFxRate("");
                    setFxMsg(null);
                  }}
                />
              </label>
              {currency ? (
                <label className="acc-field">
                  <span>อัตราแลกเปลี่ยนตอนออกบิล ({currency} → THB)</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="num"
                      inputMode="decimal"
                      value={fxRate}
                      onChange={(e) => onFxRateChange(e.target.value)}
                      placeholder="เช่น 35.500000"
                      disabled={fxFieldsReadOnly}
                    />
                    {!fxFieldsReadOnly ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={onFetchBotRate} disabled={botFetching}>
                        {botFetching ? "กำลังดึง…" : "ดึงอัตรา ธปท."}
                      </button>
                    ) : null}
                  </div>
                </label>
              ) : null}
              {fxFieldsReadOnly && currency ? (
                <div className="acc-field acc-field-wide acc-contra-hint">
                  🔒 ล็อกสกุลเงิน/อัตราแลกเปลี่ยน — มีการรับ/จ่ายเงินแล้ว
                </div>
              ) : null}
              {fxMsg ? <div className="acc-field acc-field-wide action-msg err">{fxMsg}</div> : null}

              {/* hint บัญชีคู่ที่จะเป็นเครดิต (ช่วยตรวจ — ยังไม่ลงจริง แค่บอกให้เห็น)
                  เงินโอน → บัญชีคู่ = เงินฝากธนาคาร (default 1020) */}
              {contraHint ? (
                <div className="acc-field acc-field-wide acc-contra-hint">
                  บัญชีคู่ (เครดิต): {contraHint.code ? <b>{contraHint.code}</b> : null} {contraHint.name}
                </div>
              ) : null}
              <label className="acc-field acc-field-wide">
                <span>คู่ค้า {aiSrc && entry.counterpartyName ? <AiTag /> : null}</span>
                <input type="text" value={partyName} onChange={(e) => setPartyName(e.target.value)} disabled={locked} placeholder="ชื่อผู้ขาย/ผู้ซื้อ" />
              </label>
              <label className="acc-field">
                <span>เลขผู้เสียภาษี {aiSrc && entry.counterpartyTaxId ? <AiTag /> : null}</span>
                <input type="text" value={partyTaxId} onChange={(e) => setPartyTaxId(e.target.value)} disabled={locked} placeholder="13 หลัก" />
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
                const badge = !locked
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
                      {!locked ? (
                        <ProductCell
                          line={l}
                          products={products}
                          onPick={(p) => {
                            // ★ เลือกสินค้า → prefill รายละเอียด + รหัส/ชื่อบัญชี (ถ้าสินค้ามี default_account_code)
                            //   ★ ไม่ auto-fill amount (คนยังต้องกรอกยอดจริงเอง กันเผลอใช้ default_price ผิด)
                            //   ★ ยังแก้ต่อได้ทุกช่องตามปกติ (ไม่ล็อก)
                            const acct = p.defaultAccountCode ? chartByCode[p.defaultAccountCode] : undefined;
                            patchLine(l.key, {
                              productId: p.id,
                              description: p.name,
                              accountCode: p.defaultAccountCode || l.accountCode,
                              accountName: acct ? acct.name : l.accountName,
                            });
                          }}
                          onClear={() => patchLine(l.key, { productId: null })}
                        />
                      ) : null}
                      {/* จำนวนสต็อก (เฟส 8 ส่วน Y) — โชว์เฉพาะบรรทัดที่เลือกสินค้าไว้แล้ว (mirror เงื่อนไข ProductCell ด้านบน) */}
                      {!locked && l.productId ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          className="acc-qty-input"
                          value={l.quantity}
                          onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                          placeholder="จำนวน"
                          aria-label="จำนวนสต็อก"
                          title="จำนวนที่รับ/จ่ายสต็อกจากบรรทัดนี้ (ไม่บังคับ)"
                        />
                      ) : null}
                      {/* ยอดต้นฉบับสกุลต่างประเทศ (เฟส 10 ส่วน Z) — โชว์เฉพาะบิลที่ตั้ง currency ไว้ */}
                      {!locked && currency ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          className="acc-qty-input"
                          value={l.fxAmount}
                          onChange={(e) => onFxAmountChange(l, e.target.value)}
                          placeholder={`0.00 ${currency}`}
                          aria-label={`ยอดต้นฉบับ (${currency})`}
                          title={`ยอดต้นฉบับสกุล ${currency} ก่อน VAT — ระบบแปลงเป็นบาทให้อัตโนมัติด้วยอัตราแลกเปลี่ยนของหัวบิล`}
                        />
                      ) : null}
                      <select
                        value={l.vatType}
                        onChange={(e) => onVatSelect(l, e.target.value)}
                        disabled={locked}
                        aria-label="ประเภท VAT"
                        title="VAT นอก = บวก 7% เพิ่ม · VAT ใน = บิลรวม VAT แล้ว (เลือกเพื่อถอด VAT ออกจากยอด)"
                        className="acc-vat-sel"
                      >
                        <option value="vat">VAT นอก</option>
                        <option value="vat_in">VAT ใน (ถอด)</option>
                        <option value="novat">ไม่ VAT</option>
                      </select>
                      <AccountCombobox
                        accountCode={l.accountCode}
                        accountName={l.accountName}
                        fallbackLabel={l.description}
                        chart={chart}
                        readOnly={locked}
                        onSelect={(code, name) => patchLine(l.key, { accountCode: code, accountName: name })}
                        onNameChange={(name) => patchLine(l.key, { accountName: name })}
                        onClear={() => patchLine(l.key, { accountCode: "", accountName: "" })}
                      />
                    </div>
                    {currency ? (
                      // เฟส 10 ส่วน Z (0.6) — บิล FX: มูลค่า (THB) เป็นค่า derived อย่างเดียว (ไม่ให้กรอกตรงอีก)
                      <span className="num acc-net" title="แปลงจากยอดต้นฉบับสกุลต่างประเทศ × อัตราแลกเปลี่ยนของหัวบิล — แก้ไม่ได้ตรง (แก้ที่ช่องยอดต้นฉบับด้านซ้าย)">
                        {formatMoney(amt)}
                      </span>
                    ) : (
                      <input className="num" inputMode="decimal" value={l.amount} onChange={(e) => onAmountChange(l, e.target.value)} disabled={locked} placeholder="0.00" aria-label="มูลค่า" />
                    )}
                    <input className="num" inputMode="decimal" value={l.vatAmount} onChange={(e) => patchLine(l.key, { vatAmount: e.target.value })} disabled={locked} placeholder="0.00" aria-label="VAT" />
                    <input className="num" inputMode="decimal" value={l.whtRate} onChange={(e) => onWhtRateChange(l, e.target.value)} disabled={locked} placeholder="0" aria-label="อัตราหัก %" />
                    <input className="num" inputMode="decimal" value={l.whtAmount} onChange={(e) => patchLine(l.key, { whtAmount: e.target.value })} disabled={locked} placeholder="0.00" aria-label="หัก ณ ที่จ่าย" />
                    <span className="num acc-net">{formatMoney(net)}</span>
                    {!locked ? (
                      <button type="button" className="acc-line-del" onClick={() => removeLine(l)} aria-label="ลบบรรทัด" title="ลบบรรทัด">✕</button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}

              {!locked ? (
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
                /* บิลร่าง — บันทึกร่าง / ยืนยัน (flow เดิม) */
                <>
                  <button type="button" className="btn" onClick={() => save(false)} disabled={pending}>
                    {pending ? "กำลังบันทึก…" : "บันทึกร่าง"}
                  </button>
                  <button type="button" className="btn green" onClick={() => save(true)} disabled={pending}>
                    ยืนยัน
                  </button>
                </>
              ) : !unlocked ? (
                /* บิลยืนยันแล้ว (ล็อก) — กดเพื่อปลดล็อกทั้งใบ */
                <button type="button" className="btn" onClick={() => { setUnlocked(true); setMsg(null); }} disabled={pending}>
                  ✏️ แก้ไข
                </button>
              ) : (
                /* บิลยืนยันแล้ว + ปลดล็อก — บันทึกการแก้ไข (คงสถานะยืนยัน) / ยกเลิก (กลับไปล็อก) */
                <>
                  <button type="button" className="btn green" onClick={() => save(false)} disabled={pending}>
                    {pending ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => { setUnlocked(false); setMsg(null); }} disabled={pending}>
                    ยกเลิก
                  </button>
                </>
              )}
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
 * ProductCell — ตัวเลือก "สินค้า/บริการ" ต่อ 1 บรรทัด (เฟส 1 ส่วน B, docs/06 หมวด B)
 *   เลือกแล้ว prefill description + account_code/account_name (ถ้าสินค้ามี default_account_code) —
 *   ★ ไม่ล็อกอะไร — เอาสินค้าออก (✕) ได้โดยไม่กระทบรายละเอียด/บัญชีที่เติมไว้แล้ว (แค่ล้าง tag อ้างอิง)
 *   ★ ไม่มีสินค้าในระบบ (tenant ยังไม่เพิ่ม) และบรรทัดนี้ไม่ได้ผูกสินค้าไว้ → ไม่โชว์ปุ่ม (กันรก UI เปล่า ๆ)
 */
function ProductCell({
  line,
  products,
  onPick,
  onClear,
}: {
  line: LineRow;
  /** สินค้า/บริการของ tenant (โหลดจาก DB โดย page.tsx → EntryEditor → ที่นี่) */
  products: Product[];
  onPick: (product: Product) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchProducts(products, q).slice(0, 30), [products, q]);
  // สินค้าที่เลือกไว้ — หาชื่อจาก products (ถ้าปิดใช้งาน/ถูกลบไปแล้ว จะหาไม่เจอ → โชว์ป้ายทั่วไปแทน)
  const selected = line.productId ? products.find((p) => p.id === line.productId) ?? null : null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (products.length === 0 && !line.productId) return null;

  if (line.productId) {
    return (
      <span
        className="acc-product-tag"
        title="สินค้าที่เลือกไว้ — เอาออกได้โดยไม่กระทบรายละเอียด/บัญชีที่เติมไว้แล้ว"
      >
        📦 {selected ? selected.name : "สินค้า (ไม่พบ/ปิดใช้งาน)"}
        <button type="button" className="acc-product-clear" onClick={onClear} aria-label="เอาสินค้าออก">
          ✕
        </button>
      </span>
    );
  }

  return (
    <div className="acc-product-combo" ref={boxRef}>
      <button
        type="button"
        className="acc-product-pick-btn"
        onClick={() => setOpen((o) => !o)}
        title="เลือกสินค้า/บริการ (เติมรายละเอียด+บัญชีให้อัตโนมัติ)"
      >
        📦 เลือกสินค้า
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
