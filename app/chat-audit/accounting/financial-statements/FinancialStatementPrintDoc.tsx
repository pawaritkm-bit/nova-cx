"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/accounting/calc";
import { mergeCompareLines, sumCompareLines, type CompareLine } from "@/lib/accounting/statement-compare";
import type { IncomeStatement, BalanceSheet } from "@/lib/accounting/financial-statements";
import { aggregateCashFlowLines, type CashFlowStatement } from "@/lib/accounting/cash-flow";

/**
 * เอกสารพิมพ์งบการเงินฉบับทางการ (เฟส 4 ส่วน N2) — mirror WhtCertDoc.tsx/SalesDocumentPrintDoc.tsx
 *
 * โครง: หัวกระดาษ (ชื่อกิจการ/เลขผู้เสียภาษี/ที่อยู่) → ชื่อรายงาน+งวด → ช่องผู้จัดทำ/ผู้สอบทาน (0.2 — กรอก
 *   อิสระ ไม่ persist ลง DB) → ตารางงบกำไรขาดทุน → ตารางงบแสดงฐานะการเงิน (เทียบงวดถ้ามี) → ปุ่มพิมพ์
 *
 * ★ ไม่ยิง network — ทำงานฝั่ง client ล้วน (print-only ไม่บันทึก DB, mirror wht-cert 0.2)
 * ★ [⚠️ FLAG] รูปแบบเอกสารเป็นรูปแบบที่พบบ่อยตามงบการเงินไทยทั่วไป ไม่ใช่แบบฟอร์มยื่นกรมพัฒนาธุรกิจการค้า/
 *   สภาวิชาชีพบัญชีเป๊ะ 100% (0.2)
 */

function CompareRows({ rows, showCompare }: { rows: CompareLine[]; showCompare: boolean }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.code}>
          <td>{r.code} · {r.name}</td>
          <td className="fs-num">{formatMoney(r.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(r.compare ?? 0)}</td> : null}
        </tr>
      ))}
    </>
  );
}

function IncomeTable({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: IncomeStatement;
  compare: IncomeStatement | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const revenueRows = mergeCompareLines(current.revenues, compare?.revenues ?? null);
  const expenseRows = mergeCompareLines(current.expenses, compare?.expenses ?? null);
  const revenueTotal = sumCompareLines(revenueRows);
  const expenseTotal = sumCompareLines(expenseRows);
  const netCompare = showCompare ? (revenueTotal.compare ?? 0) - (expenseTotal.compare ?? 0) : null;

  return (
    <table className="fs-table">
      <thead>
        <tr>
          <th>รายการ</th>
          <th className="fs-num">{currentLabel}</th>
          {showCompare ? <th className="fs-num">{compareLabel}</th> : null}
        </tr>
      </thead>
      <tbody>
        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>รายได้</td></tr>
        <CompareRows rows={revenueRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมรายได้</td>
          <td className="fs-num">{formatMoney(revenueTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(revenueTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>ค่าใช้จ่าย</td></tr>
        <CompareRows rows={expenseRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมค่าใช้จ่าย</td>
          <td className="fs-num">{formatMoney(expenseTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(expenseTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-total fs-net">
          <td>กำไร(ขาดทุน)สุทธิ</td>
          <td className="fs-num">{formatMoney(current.netProfit)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(netCompare ?? 0)}</td> : null}
        </tr>
      </tbody>
    </table>
  );
}

function BalanceTable({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: BalanceSheet;
  compare: BalanceSheet | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const assetRows = mergeCompareLines(current.assets, compare?.assets ?? null);
  const liabilityRows = mergeCompareLines(current.liabilities, compare?.liabilities ?? null);
  const equityRows = mergeCompareLines(current.equity, compare?.equity ?? null);
  const assetTotal = sumCompareLines(assetRows);
  const liabilityTotal = sumCompareLines(liabilityRows);
  const equityTotal = sumCompareLines(equityRows);
  const equityWithProfitCompare = showCompare ? (equityTotal.compare ?? 0) + (compare?.netProfit ?? 0) : null;
  const liabEquityCompare = showCompare ? (liabilityTotal.compare ?? 0) + (equityWithProfitCompare ?? 0) : null;

  return (
    <table className="fs-table">
      <thead>
        <tr>
          <th>รายการ</th>
          <th className="fs-num">{currentLabel}</th>
          {showCompare ? <th className="fs-num">{compareLabel}</th> : null}
        </tr>
      </thead>
      <tbody>
        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>สินทรัพย์</td></tr>
        <CompareRows rows={assetRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมสินทรัพย์</td>
          <td className="fs-num">{formatMoney(assetTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(assetTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>หนี้สิน</td></tr>
        <CompareRows rows={liabilityRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมหนี้สิน</td>
          <td className="fs-num">{formatMoney(liabilityTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(liabilityTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>ส่วนของผู้ถือหุ้น</td></tr>
        <CompareRows rows={equityRows} showCompare={showCompare} />
        <tr>
          <td>กำไร(ขาดทุน)สุทธิของงวด</td>
          <td className="fs-num">{formatMoney(current.netProfit)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(compare?.netProfit ?? 0)}</td> : null}
        </tr>
        <tr className="fs-total">
          <td>รวมส่วนของผู้ถือหุ้น</td>
          <td className="fs-num">{formatMoney(current.totalEquityWithProfit)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(equityWithProfitCompare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-total fs-net">
          <td>รวมหนี้สินและส่วนของผู้ถือหุ้น</td>
          <td className="fs-num">{formatMoney(current.totalLiabilities + current.totalEquityWithProfit)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(liabEquityCompare ?? 0)}</td> : null}
        </tr>
      </tbody>
    </table>
  );
}

function CashFlowTable({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: CashFlowStatement;
  compare: CashFlowStatement | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const operatingRows = mergeCompareLines(
    aggregateCashFlowLines(current.operating),
    compare ? aggregateCashFlowLines(compare.operating) : null
  );
  const investingRows = mergeCompareLines(
    aggregateCashFlowLines(current.investing),
    compare ? aggregateCashFlowLines(compare.investing) : null
  );
  const financingRows = mergeCompareLines(
    aggregateCashFlowLines(current.financing),
    compare ? aggregateCashFlowLines(compare.financing) : null
  );
  const operatingTotal = sumCompareLines(operatingRows);
  const investingTotal = sumCompareLines(investingRows);
  const financingTotal = sumCompareLines(financingRows);

  return (
    <table className="fs-table">
      <thead>
        <tr>
          <th>รายการ</th>
          <th className="fs-num">{currentLabel}</th>
          {showCompare ? <th className="fs-num">{compareLabel}</th> : null}
        </tr>
      </thead>
      <tbody>
        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>กิจกรรมดำเนินงาน</td></tr>
        <CompareRows rows={operatingRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมกิจกรรมดำเนินงาน</td>
          <td className="fs-num">{formatMoney(operatingTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(operatingTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>กิจกรรมลงทุน</td></tr>
        <CompareRows rows={investingRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมกิจกรรมลงทุน</td>
          <td className="fs-num">{formatMoney(investingTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(investingTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-section"><td colSpan={showCompare ? 3 : 2}>กิจกรรมจัดหาเงิน</td></tr>
        <CompareRows rows={financingRows} showCompare={showCompare} />
        <tr className="fs-total">
          <td>รวมกิจกรรมจัดหาเงิน</td>
          <td className="fs-num">{formatMoney(financingTotal.current)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(financingTotal.compare ?? 0)}</td> : null}
        </tr>

        <tr className="fs-total fs-net">
          <td>เงินสดเพิ่มขึ้น(ลดลง)สุทธิ</td>
          <td className="fs-num">{formatMoney(current.netChange)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(compare?.netChange ?? 0)}</td> : null}
        </tr>
        <tr>
          <td>เงินสดต้นงวด</td>
          <td className="fs-num">{formatMoney(current.openingCash)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(compare?.openingCash ?? 0)}</td> : null}
        </tr>
        <tr className="fs-total">
          <td>เงินสดปลายงวด</td>
          <td className="fs-num">{formatMoney(current.closingCash)}</td>
          {showCompare ? <td className="fs-num">{formatMoney(compare?.closingCash ?? 0)}</td> : null}
        </tr>
      </tbody>
    </table>
  );
}

export default function FinancialStatementPrintDoc({
  businessName,
  taxId,
  address,
  periodLabel,
  comparePeriodLabel,
  income,
  compareIncome,
  balance,
  compareBalance,
  cashFlow,
  compareCashFlow,
  skippedCount,
  backHref,
}: {
  businessName: string;
  taxId: string;
  address: string;
  periodLabel: string;
  comparePeriodLabel: string | null;
  income: IncomeStatement;
  compareIncome: IncomeStatement | null;
  balance: BalanceSheet;
  compareBalance: BalanceSheet | null;
  cashFlow: CashFlowStatement;
  compareCashFlow: CashFlowStatement | null;
  /** จำนวนบิลที่ยังไม่เข้างบ (ตกหล่น) — เตือนผู้จัดทำ/ผู้สอบทานก่อนเซ็นพิมพ์ */
  skippedCount: number;
  backHref: string;
}) {
  const [preparer, setPreparer] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [docDate, setDocDate] = useState("");

  return (
    <div className="fs-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="fs-toolbar no-print">
        <a href={backHref} className="fs-btn fs-btn-ghost">
          ← กลับ
        </a>
        <span className="fs-toolbar-hint">กรอกผู้จัดทำ/ผู้สอบทาน แล้วกด “พิมพ์ / บันทึก PDF”</span>
        <button type="button" className="fs-btn fs-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {skippedCount > 0 ? (
        <div className="fs-warn no-print">
          ⚠️ มี {skippedCount.toLocaleString("th-TH")} บิลที่ยังไม่เข้างบ (ตกหล่น) — ตรวจที่หน้า “งบการเงินฉบับทางการ” ก่อนพิมพ์จริง
        </div>
      ) : null}

      {/* ================= ตัวเอกสาร (A4) — งบกำไรขาดทุน ================= */}
      <div className="fs-page">
        <FsLetterhead businessName={businessName} taxId={taxId} address={address} />
        <h1 className="fs-title">งบกำไรขาดทุน</h1>
        <p className="fs-period">สำหรับงวด {periodLabel}</p>
        <IncomeTable current={income} compare={compareIncome} currentLabel={periodLabel} compareLabel={comparePeriodLabel} />
        <FsSignBlock
          docDate={docDate}
          setDocDate={setDocDate}
          preparer={preparer}
          setPreparer={setPreparer}
          reviewer={reviewer}
          setReviewer={setReviewer}
        />
      </div>

      {/* ================= ตัวเอกสาร (A4) — งบแสดงฐานะการเงิน (ขึ้นหน้าใหม่ตอนพิมพ์) ================= */}
      <div className="fs-page fs-page-break">
        <FsLetterhead businessName={businessName} taxId={taxId} address={address} />
        <h1 className="fs-title">งบแสดงฐานะการเงิน</h1>
        <p className="fs-period">ณ วันสิ้นงวด {periodLabel}</p>
        <BalanceTable current={balance} compare={compareBalance} currentLabel={periodLabel} compareLabel={comparePeriodLabel} />
        {!balance.balanced ? (
          <p className="fs-warn-inline">
            ⚠️ งบยังไม่สมดุล — ผลต่าง {formatMoney(balance.difference)} บาท (ตรวจยอดยกมา/รายการตกหล่นก่อนใช้งบ)
          </p>
        ) : null}
        <FsSignBlock
          docDate={docDate}
          setDocDate={setDocDate}
          preparer={preparer}
          setPreparer={setPreparer}
          reviewer={reviewer}
          setReviewer={setReviewer}
        />
      </div>

      {/* ================= ตัวเอกสาร (A4) — งบกระแสเงินสด (ขึ้นหน้าใหม่ตอนพิมพ์, ส่วน O4) ================= */}
      <div className="fs-page fs-page-break">
        <FsLetterhead businessName={businessName} taxId={taxId} address={address} />
        <h1 className="fs-title">งบกระแสเงินสด</h1>
        <p className="fs-period">สำหรับงวด {periodLabel}</p>
        <CashFlowTable current={cashFlow} compare={compareCashFlow} currentLabel={periodLabel} compareLabel={comparePeriodLabel} />
        {!cashFlow.reconciled ? (
          <p className="fs-warn-inline">
            ⚠️ งบกระแสเงินสดยังไม่สมดุล (reconciled=false) — ตรวจการจัดหมวดรายการเงินสดก่อนใช้งบ
          </p>
        ) : null}
        <FsSignBlock
          docDate={docDate}
          setDocDate={setDocDate}
          preparer={preparer}
          setPreparer={setPreparer}
          reviewer={reviewer}
          setReviewer={setReviewer}
        />
      </div>
    </div>
  );
}

/** หัวกระดาษกิจการ (business_name/tax_id/address) — ใช้ซ้ำทั้ง 2 งบ */
function FsLetterhead({ businessName, taxId, address }: { businessName: string; taxId: string; address: string }) {
  return (
    <div className="fs-letterhead">
      <div className="fs-letterhead-name">{businessName || "—"}</div>
      {taxId ? <div className="fs-letterhead-sub">เลขประจำตัวผู้เสียภาษีอากร: {taxId}</div> : null}
      {address ? <div className="fs-letterhead-sub">{address}</div> : null}
    </div>
  );
}

/** ช่องวันที่จัดทำ + ผู้จัดทำ/ผู้สอบทาน (กรอกอิสระ ไม่ persist ลง DB, 0.2) */
function FsSignBlock({
  docDate,
  setDocDate,
  preparer,
  setPreparer,
  reviewer,
  setReviewer,
}: {
  docDate: string;
  setDocDate: (v: string) => void;
  preparer: string;
  setPreparer: (v: string) => void;
  reviewer: string;
  setReviewer: (v: string) => void;
}) {
  return (
    <div className="fs-signblock">
      <label className="fs-signdate">
        วันที่จัดทำ:{" "}
        <input
          className="fs-in"
          value={docDate}
          onChange={(e) => setDocDate(e.target.value)}
          placeholder="วว/ดด/ปปปป"
          aria-label="วันที่จัดทำ"
        />
      </label>
      <div className="fs-sign">
        <div className="fs-sign-box">
          <input
            className="fs-in fs-sign-in"
            value={preparer}
            onChange={(e) => setPreparer(e.target.value)}
            placeholder="ชื่อผู้จัดทำ"
            aria-label="ผู้จัดทำ"
          />
          <div className="fs-sign-line" />
          <div className="fs-sign-label">ผู้จัดทำ</div>
        </div>
        <div className="fs-sign-box">
          <input
            className="fs-in fs-sign-in"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            placeholder="ชื่อผู้สอบทาน"
            aria-label="ผู้สอบทาน"
          />
          <div className="fs-sign-line" />
          <div className="fs-sign-label">ผู้สอบทาน</div>
        </div>
      </div>
    </div>
  );
}
