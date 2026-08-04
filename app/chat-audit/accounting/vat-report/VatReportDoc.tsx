"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMoney, parseAmountInput, round2 } from "@/lib/accounting/calc";
import { downloadExcelFromPost } from "@/lib/accounting/excel-download";
import { updateCustomerFieldsAction } from "../customer-admin-actions";
import type { VatReportKind, VatReportRow, VatReportTotals } from "@/lib/accounting/vat-report";

/** แถวตารางแบบแก้ได้ (client-only) — เงินเก็บเป็นข้อความเพื่อแก้อิสระ, parse ตอนคิดยอด */
type EditRow = {
  key: number;
  dateText: string;
  docNo: string;
  partyName: string;
  partyTaxId: string;
  ho: string;
  branch: string;
  baseVat: string;
  baseExempt: string;
  vat: string;
};

/** วันที่ ISO (YYYY-MM-DD) → dd/mm/พ.ศ. (คืน "-" ถ้าไม่มี/พัง) */
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * รายงานภาษีซื้อ / รายงานภาษีขาย — เอกสารพิมพ์/บันทึก PDF (ตามฟอร์มราชการ)
 *
 * โครงหัวรายงาน (3 คอลัมน์):
 *   ซ้าย = วันที่/เวลาพิมพ์ · กลาง = ชื่อรายงาน + ชื่อบริษัท + เดือนภาษี · ขวา = Page/สนญ./เลขภาษีลูกค้า
 * ตาราง: ลำดับ | ใบกำกับ(วดป/เลขที่) | ชื่อคู่ค้า | เลขภาษีคู่ค้า | สถานประกอบการ(สนญ./สาขา) |
 *        มูลค่าคิด VAT | มูลค่ายกเว้น VAT | ภาษีมูลค่าเพิ่ม
 * footer: รวมทั้งสิ้น N รายการ + ยอดรวม 3 คอลัมน์
 *
 * ★ .no-print ซ่อนตอนพิมพ์ (แถบเครื่องมือ) · prefix vr- กันชนสไตล์เดิม (acc- / rcv-)
 * ★ ไม่ยิง network — render จากข้อมูลที่ server ส่งมา (Excel เป็นลิงก์ route แยก)
 */
export default function VatReportDoc({
  customerId,
  kind,
  companyName,
  companyTaxId,
  companyAddress,
  periodLabel,
  fromDate,
  toDate,
  selectedMonth,
  monthOptions,
  printedAt,
  rows,
  backHref,
}: {
  /** id ลูกค้า — ใช้สร้าง URL เปลี่ยนช่วงวัน + บันทึกที่อยู่ถาวร */
  customerId: string;
  kind: VatReportKind;
  companyName: string;
  companyTaxId: string;
  /** ที่อยู่บริษัทลูกค้า (จาก customers.address) · "" = ยังไม่กรอก → เว้น/ขีดเส้น */
  companyAddress: string;
  /** ป้ายช่วงหัวรายงาน เช่น "เดือนภาษี มิถุนายน ปี พ.ศ. 2569" หรือ "ตั้งแต่ … ถึง …" */
  periodLabel: string;
  /** ช่วงวันที่ที่เลือกอยู่ (YYYY-MM-DD) สำหรับช่อง date input */
  fromDate: string;
  toDate: string;
  /** เดือนอ้างอิงของปุ่มลัด "ทั้งเดือน" (YYYY-MM) */
  selectedMonth: string;
  /** ตัวเลือกเดือนย้อนหลังสำหรับปุ่มลัด "ทั้งเดือน" */
  monthOptions: { value: string; label: string }[];
  /** วันที่/เวลาพิมพ์ (เวลาไทย) เช่น "04/08/2569 09:30" */
  printedAt: string;
  rows: VatReportRow[];
  totals: VatReportTotals;
  excelHref: string;
  backHref: string;
}) {
  const router = useRouter();
  const title = kind === "purchase" ? "- รายงานภาษีซื้อ -" : "- รายงานภาษีขาย -";
  const partyHeader =
    kind === "purchase" ? "ชื่อผู้ขายสินค้า/ผู้ให้บริการ" : "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ";

  // ---- หัวรายงานแก้ได้ inline (prints) — prefill จากข้อมูลลูกค้า ----
  const [name, setName] = useState(companyName);
  const [taxId, setTaxId] = useState(companyTaxId);
  const [address, setAddress] = useState(companyAddress);

  // ---- บันทึกที่อยู่ถาวรให้ลูกค้า (optional) ----
  const [saving, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ---- แถวตารางแก้ได้ (client-only, พิมพ์/Excel ตามที่แก้ · ไม่บันทึกกลับบิล) ----
  //   init ครั้งเดียวจาก props rows · เงินเก็บเป็นข้อความ (parse ตอนคิดยอด)
  const [editRows, setEditRows] = useState<EditRow[]>(() =>
    rows.map((r, i) => ({
      key: i,
      dateText: thaiDate(r.docDate),
      docNo: r.docNo,
      partyName: r.partyName,
      partyTaxId: r.partyTaxId ?? "",
      ho: r.isHeadOffice ? "X" : "",
      branch: r.isHeadOffice ? "" : "-",
      baseVat: formatMoney(r.baseVat),
      baseExempt: formatMoney(r.baseExempt),
      vat: formatMoney(r.vat),
    }))
  );
  const [nextKey, setNextKey] = useState(rows.length);

  // ยอดรวมท้าย 3 คอลัมน์ + จำนวนรายการ — คิดใหม่สดจากที่แก้บนจอ
  const liveTotals = useMemo(() => {
    let baseVat = 0;
    let baseExempt = 0;
    let vat = 0;
    for (const r of editRows) {
      baseVat += parseAmountInput(r.baseVat);
      baseExempt += parseAmountInput(r.baseExempt);
      vat += parseAmountInput(r.vat);
    }
    return {
      count: editRows.length,
      baseVat: round2(baseVat),
      baseExempt: round2(baseExempt),
      vat: round2(vat),
    };
  }, [editRows]);

  function updateRow(key: number, patch: Partial<EditRow>) {
    setEditRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setEditRows((prev) => [
      ...prev,
      { key: nextKey, dateText: "", docNo: "", partyName: "", partyTaxId: "", ho: "X", branch: "", baseVat: "", baseExempt: "", vat: "" },
    ]);
    setNextKey((k) => k + 1);
  }
  function removeRow(key: number) {
    setEditRows((prev) => prev.filter((r) => r.key !== key));
  }

  // ---- Excel: ส่งค่าที่แก้บนจอไป POST → server สร้าง .xlsx ให้ตรงที่เห็น ----
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelErr, setExcelErr] = useState<string | null>(null);
  async function onExportExcel() {
    setExcelErr(null);
    setExcelBusy(true);
    try {
      const payload = {
        customer: customerId,
        kind,
        from: fromDate,
        to: toDate,
        header: { companyName: name, companyTaxId: taxId, companyAddress: address },
        rows: editRows.map((r) => ({
          dateText: r.dateText,
          docNo: r.docNo,
          partyName: r.partyName,
          partyTaxId: r.partyTaxId,
          // รวม 2 คอลัมน์หน้าจอ (สนญ./สาขา) เป็นข้อความสถานประกอบการเดียวใน Excel
          estab: r.ho.trim()
            ? "สำนักงานใหญ่"
            : r.branch.trim() && r.branch.trim() !== "-"
            ? `สาขา ${r.branch.trim()}`
            : "",
          baseVat: parseAmountInput(r.baseVat),
          baseExempt: parseAmountInput(r.baseExempt),
          vat: parseAmountInput(r.vat),
        })),
      };
      const err = await downloadExcelFromPost(
        "/chat-audit/accounting/vat-report/export",
        payload,
        "vat-report.xlsx"
      );
      if (err) setExcelErr(err);
    } finally {
      setExcelBusy(false);
    }
  }

  /** นำทางไปช่วงวันใหม่ (คง customer/type) เพื่อ re-query ตามช่วง [from, to] */
  function pushRange(from: string, to: string) {
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("type", kind);
    params.set("from", from);
    params.set("to", to);
    router.push(`/chat-audit/accounting/vat-report?${params.toString()}`);
  }

  /** ปุ่มลัด "ทั้งเดือน": เลือกเดือน YYYY-MM → from=วันที่1, to=วันสุดท้ายของเดือนนั้น */
  function onWholeMonth(month: string) {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // วันสุดท้ายของเดือน
    pushRange(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
  }

  // ลิงก์ไปสมุดรายวันเล่มที่ตรงกัน (ภาษีขาย→เล่มขาย, ภาษีซื้อ→เล่มซื้อ) ลูกค้า+ช่วงเดียวกัน
  const jbParams = new URLSearchParams({
    customer: customerId,
    from: fromDate,
    to: toDate,
    book: kind, // "purchase" | "sale"
  });
  const journalHref = `/chat-audit/accounting/journal-books?${jbParams.toString()}`;
  const journalLabel = kind === "sale" ? "→ สมุดรายวันขาย" : "→ สมุดรายวันซื้อ";

  /** บันทึกที่อยู่ปัจจุบันให้ลูกค้าถาวร (customers.address) */
  function saveAddress() {
    setSaveMsg(null);
    startSave(async () => {
      const res = await updateCustomerFieldsAction(customerId, { address });
      setSaveMsg({ ok: res.ok, text: res.ok ? "บันทึกที่อยู่ให้ลูกค้าแล้ว" : res.message });
    });
  }

  return (
    <div className="vr-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="vr-toolbar no-print">
        <a href={backHref} className="vr-btn vr-btn-ghost">← กลับ</a>
        <label className="vr-month-picker">
          <span>ตั้งแต่</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => e.target.value && pushRange(e.target.value, toDate)}
            aria-label="วันเริ่มต้น"
          />
        </label>
        <label className="vr-month-picker">
          <span>ถึง</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => e.target.value && pushRange(fromDate, e.target.value)}
            aria-label="วันสิ้นสุด"
          />
        </label>
        <label className="vr-month-picker">
          <span>ทั้งเดือน</span>
          <select
            className="vr-select"
            value={selectedMonth}
            onChange={(e) => onWholeMonth(e.target.value)}
            aria-label="เลือกทั้งเดือน"
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <span className="vr-toolbar-hint">
          เลือกช่วงวัน หรือกด “ทั้งเดือน” · แก้ตัวเลข/ข้อความในตารางได้ แล้วพิมพ์/บันทึก PDF หรือ Excel
          (ทั้งพิมพ์และ Excel = ตามที่แก้บนจอ)
        </span>
        <a href={journalHref} className="vr-btn vr-btn-ghost">{journalLabel}</a>
        <button
          type="button"
          className="vr-btn vr-btn-ghost"
          onClick={onExportExcel}
          disabled={excelBusy}
          title="ออก Excel ตามค่าที่แก้บนจอ"
        >
          {excelBusy ? "กำลังสร้าง…" : "⬇ Excel"}
        </button>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
        {excelErr && <span className="vr-save-err">{excelErr}</span>}
      </div>

      {/* ================= ตัวเอกสาร ================= */}
      <div className="vr-page">
        {/* หัวรายงาน 3 คอลัมน์ */}
        <div className="vr-head">
          <div className="vr-head-left">
            <div>วันที่พิมพ์ {printedAt}</div>
          </div>
          <div className="vr-head-center">
            <div className="vr-title">{title}</div>
            <input
              className="vr-in vr-company-in"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อกิจการ"
              aria-label="ชื่อกิจการ"
            />
            {/* ที่อยู่บริษัทลูกค้า — แก้ได้ (prints) · textarea ตัดบรรทัดเองเมื่อยาว (กันตกขอบ) */}
            <textarea
              className="vr-in vr-address-in"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="ที่อยู่กิจการ (พิมพ์ใส่ได้)"
              aria-label="ที่อยู่กิจการ"
              rows={1}
            />
            <div className="vr-month">{periodLabel}</div>
          </div>
          <div className="vr-head-right">
            <div>Page 1</div>
            <div>สำนักงานใหญ่</div>
            <div className="vr-taxid-line">
              เลขประจำตัวผู้เสียภาษี{" "}
              <input
                className="vr-in vr-taxid-in"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                placeholder="-"
                aria-label="เลขประจำตัวผู้เสียภาษี"
              />
            </div>
          </div>
        </div>

        {/* แถวช่วยเหลือใต้หัว (ซ่อนตอนพิมพ์): บันทึกที่อยู่ถาวรให้ลูกค้า */}
        <div className="vr-addr-actions no-print">
          <button
            type="button"
            className="vr-btn vr-btn-ghost vr-btn-sm"
            onClick={saveAddress}
            disabled={saving}
          >
            {saving ? "กำลังบันทึก…" : "💾 บันทึกที่อยู่นี้ให้ลูกค้า"}
          </button>
          {saveMsg && (
            <span className={saveMsg.ok ? "vr-save-ok" : "vr-save-err"}>{saveMsg.text}</span>
          )}
        </div>

        {/* ตารางรายการ */}
        <table className="vr-table">
          <thead>
            <tr>
              <th rowSpan={2} className="vr-col-seq">ลำดับที่</th>
              <th colSpan={2} className="vr-col-inv">ใบกำกับภาษี</th>
              <th rowSpan={2} className="vr-col-party">{partyHeader}</th>
              <th rowSpan={2} className="vr-col-tax">เลขประจำตัว<br />ผู้เสียภาษีอากร</th>
              <th colSpan={2} className="vr-col-estab">สถานประกอบการ</th>
              <th rowSpan={2} className="vr-col-money">มูลค่าสินค้า/บริการ<br />ที่คิด VAT</th>
              <th rowSpan={2} className="vr-col-money">มูลค่าสินค้า/บริการ<br />ที่ยกเว้น VAT</th>
              <th rowSpan={2} className="vr-col-money">จำนวนเงิน<br />ภาษีมูลค่าเพิ่ม</th>
              <th rowSpan={2} className="vr-col-del no-print" aria-label="ลบ" />
            </tr>
            <tr>
              <th className="vr-col-date">วัน/เดือน/ปี</th>
              <th className="vr-col-no">เลขที่</th>
              <th className="vr-col-ho">สำนักงานใหญ่</th>
              <th className="vr-col-branch">สาขาที่</th>
            </tr>
          </thead>
          <tbody>
            {editRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="vr-empty">ไม่มีรายการในช่วงวันที่นี้ — กด “＋ เพิ่มรายการ” เพื่อพิมพ์เพิ่มได้</td>
                <td className="vr-col-del no-print" />
              </tr>
            ) : (
              editRows.map((r, i) => (
                <tr key={r.key}>
                  <td className="vr-c-seq">{i + 1}</td>
                  <td className="vr-c-date">
                    <input
                      className="vr-in vr-cell vr-cell-center"
                      value={r.dateText}
                      onChange={(e) => updateRow(r.key, { dateText: e.target.value })}
                      placeholder="วว/ดด/ปปปป"
                      aria-label={`วันที่รายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-no">
                    <input
                      className="vr-in vr-cell vr-cell-center"
                      value={r.docNo}
                      onChange={(e) => updateRow(r.key, { docNo: e.target.value })}
                      aria-label={`เลขที่ใบกำกับรายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-party">
                    <input
                      className="vr-in vr-cell"
                      value={r.partyName}
                      onChange={(e) => updateRow(r.key, { partyName: e.target.value })}
                      aria-label={`ชื่อคู่ค้ารายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-tax">
                    <input
                      className="vr-in vr-cell vr-cell-center"
                      value={r.partyTaxId}
                      onChange={(e) => updateRow(r.key, { partyTaxId: e.target.value })}
                      aria-label={`เลขภาษีคู่ค้ารายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-ho">
                    <input
                      className="vr-in vr-cell vr-cell-center"
                      value={r.ho}
                      onChange={(e) => updateRow(r.key, { ho: e.target.value })}
                      aria-label={`สำนักงานใหญ่รายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-branch">
                    <input
                      className="vr-in vr-cell vr-cell-center"
                      value={r.branch}
                      onChange={(e) => updateRow(r.key, { branch: e.target.value })}
                      aria-label={`สาขาที่รายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-money">
                    <input
                      className="vr-in vr-cell vr-cell-money"
                      value={r.baseVat}
                      onChange={(e) => updateRow(r.key, { baseVat: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`มูลค่าคิด VAT รายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-money">
                    <input
                      className="vr-in vr-cell vr-cell-money"
                      value={r.baseExempt}
                      onChange={(e) => updateRow(r.key, { baseExempt: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`มูลค่ายกเว้น VAT รายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-c-money">
                    <input
                      className="vr-in vr-cell vr-cell-money"
                      value={r.vat}
                      onChange={(e) => updateRow(r.key, { vat: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`ภาษีมูลค่าเพิ่มรายการที่ ${i + 1}`}
                    />
                  </td>
                  <td className="vr-col-del no-print">
                    <button
                      type="button"
                      className="vr-row-del"
                      onClick={() => removeRow(r.key)}
                      aria-label="ลบแถว"
                      title="ลบแถว"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="vr-total">
              <td colSpan={7} className="vr-total-label">
                รวมทั้งสิ้น {liveTotals.count.toLocaleString("th-TH")} รายการ
              </td>
              <td className="vr-c-money">{formatMoney(liveTotals.baseVat)}</td>
              <td className="vr-c-money">{formatMoney(liveTotals.baseExempt)}</td>
              <td className="vr-c-money">{formatMoney(liveTotals.vat)}</td>
              <td className="vr-col-del no-print" />
            </tr>
          </tfoot>
        </table>

        {/* ปุ่มเพิ่มแถว + ข้อความเตือน (ซ่อนตอนพิมพ์) */}
        <div className="vr-addrow-wrap no-print">
          <button type="button" className="vr-btn vr-btn-ghost vr-btn-sm" onClick={addRow}>
            ＋ เพิ่มรายการ
          </button>
          <span className="vr-editnote">
            การแก้ในหน้านี้ใช้เฉพาะตอนพิมพ์/ออก Excel เท่านั้น — ไม่กระทบข้อมูลบิลจริง
            (ต้องการแก้ข้อมูลจริงให้ไปที่ “ตรวจ/แก้” ที่บิล)
          </span>
        </div>
      </div>
    </div>
  );
}
