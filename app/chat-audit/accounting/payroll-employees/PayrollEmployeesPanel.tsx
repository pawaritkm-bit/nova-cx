"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  upsertEmployeeAction,
  deleteEmployeeAction,
  revealIdCardAction,
  upsertSettingsAction,
  listDeductionsAction,
  upsertDeductionAction,
  deleteDeductionAction,
  bulkImportEmployeesAction,
  downloadEmployeeImportTemplateAction,
  type BulkImportRowResult,
} from "./actions";
import type { PayrollEmployee } from "@/lib/accounting/payroll-employees";
import type { PayrollSettings } from "@/lib/accounting/payroll-settings";
import {
  DEDUCTION_TYPES,
  CHILD_ALLOWANCE_AMOUNTS,
  type PayrollEmployeeDeduction,
  type DeductionType,
} from "@/lib/accounting/payroll-deductions";
import { ENABLE_EXTRA_DEDUCTIONS_IN_PIT } from "@/lib/accounting/payroll-tax";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import AccountCombobox from "../AccountCombobox";

const DEDUCTION_TYPE_LABELS: Record<DeductionType, string> = {
  spouse_no_income: "คู่สมรสไม่มีเงินได้ (ไม่เกิน 60,000 บาท)",
  child: "บุตร (30,000 หรือ 60,000 บาทต่อคน)",
  // ★ แยกเป็น 2 ประเภท cap อิสระคนละก้อน (แก้บั๊ก QC ที่เดิมเก็บก้อนเดียวแล้ว cap จากยอดรวมผิดกฎหมาย)
  life_insurance_self: "เบี้ยประกันชีวิตของผู้มีเงินได้เอง (ไม่เกิน 100,000 บาท)",
  life_insurance_spouse: "เบี้ยประกันชีวิตของคู่สมรส (ไม่เกิน 10,000 บาท — หักได้เฉพาะกรณีมีรายการ \"คู่สมรสไม่มีเงินได้\" ของปีภาษีนี้ด้วย)",
  provident_fund: "PVD/RMF/กบข รวมกัน (ไม่เกิน 500,000 บาท และไม่เกิน 30% ของเงินได้ทั้งปี)",
  mortgage_interest: "ดอกเบี้ยกู้ยืมเพื่อที่อยู่อาศัย (ไม่เกิน 100,000 บาท)",
};

function currentBuddhistYear(): number {
  return new Date().getFullYear() + 543;
}

/**
 * PayrollEmployeesPanel — ตั้ง/แก้/ลบทะเบียนพนักงานของลูกค้า 1 ราย (0.2, 0.12) + ตั้งค่าบัญชี 6 ช่อง
 *   ที่ใช้เมื่อสร้างรายการบัญชีจากรอบเงินเดือน (0.11) — เฟส 9 ส่วน AC
 *
 * ★ 0.12 PDPA: เลขบัตรประชาชนที่ได้รับจาก server (props) มาสก์มาแล้วเสมอ (page.tsx ทำก่อนส่งลงมา) —
 *   ปุ่ม "เผยเลขเต็ม" เรียก revealIdCardAction ต่อแถวเอง เก็บผลไว้ใน state ชั่วคราว (ไม่ persist/ไม่ log)
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 */

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateThai(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : "—";
}

type FormState = {
  employeeCode: string;
  fullName: string;
  idCardNo: string;
  passportNo: string;
  position: string;
  baseSalary: string;
  startDate: string;
  resignDate: string;
  isActive: boolean;
  /** ★ wishlist ข้อ 6 — ปลายทางส่งสลิปเงินเดือน PDF */
  email: string;
  /** ★ เฟส 9b กลุ่ม BA (0.3) — นักบัญชีพิจารณาเงื่อนไขเอง ไม่ผูกเหตุผลทางกฎหมายในระบบ */
  ssoExempt: boolean;
  /** ★ เฟส 9b กลุ่ม BD (0.4) — อ้างอิงเพื่อพิมพ์ 50 ทวิเท่านั้น ไม่กระทบการคำนวณภาษีหัก ณ ที่จ่ายรายเดือน */
  priorEmployerYtdGross: string;
  priorEmployerYtdPitWithheld: string;
  priorEmployerYtdSsoEmployee: string;
  priorEmployerNote: string;
  /** ★ เฟส 9b กลุ่ม BE (0.2) — ฐานคำนวณเพดาน PVD/RMF/กบข เท่านั้น ไม่กระทบสูตรคำนวณภาษีตรง ๆ */
  annualIncomeEstimateOverride: string;
};

function blankForm(): FormState {
  return {
    employeeCode: "",
    fullName: "",
    idCardNo: "",
    passportNo: "",
    position: "",
    baseSalary: "",
    startDate: todayIso(),
    resignDate: "",
    isActive: true,
    email: "",
    ssoExempt: false,
    priorEmployerYtdGross: "",
    priorEmployerYtdPitWithheld: "",
    priorEmployerYtdSsoEmployee: "",
    priorEmployerNote: "",
    annualIncomeEstimateOverride: "",
  };
}

type SettingsFormState = {
  salaryExpenseAccountCode: string;
  salaryExpenseAccountName: string;
  ssoEmployerExpenseAccountCode: string;
  ssoEmployerExpenseAccountName: string;
  ssoPayableAccountCode: string;
  ssoPayableAccountName: string;
  pitPayableAccountCode: string;
  pitPayableAccountName: string;
  otherDeductionsAccountCode: string;
  otherDeductionsAccountName: string;
  netPayAccountCode: string;
  netPayAccountName: string;
  netPayIsPaidImmediately: boolean;
  /** ★ เฟส 9b กลุ่ม BC (T140) */
  payFrequency: "monthly" | "non_monthly";
  /** ★ เฟส 9b กลุ่ม BF (T160/T165) — รหัสบัญชีค่าใช้จ่ายค่าชดเชยเลิกจ้าง (nullable, mirror otherDeductions) */
  severanceExpenseAccountCode: string;
  severanceExpenseAccountName: string;
};

export default function PayrollEmployeesPanel({
  customerId,
  employees,
  settings,
  chart,
}: {
  customerId: string;
  /** ★ เลขบัตรประชาชนมาสก์มาแล้วจาก page.tsx เสมอ (0.12) */
  employees: PayrollEmployee[];
  settings: PayrollSettings;
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);

  const [tab, setTab] = useState<"employees" | "settings">("employees");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => blankForm());
  const [revealed, setRevealed] = useState<Record<string, { idCardNo: string | null; passportNo: string | null }>>({});

  // ★ นำเข้าพนักงานเป็นชุด (wishlist ข้อ 2) — pending แยกจาก pending ของฟอร์มทีละคน กันปุ่มติดกัน
  const [importPending, startImportTransition] = useTransition();
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [importResults, setImportResults] = useState<BulkImportRowResult[] | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  async function downloadImportTemplate() {
    const res = await downloadEmployeeImportTemplateAction();
    if (!res.ok) {
      setImportMsg({ ok: false, text: res.message });
      return;
    }
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "เทมเพลตนำเข้าพนักงาน.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  function submitImport() {
    const file = importFileRef.current?.files?.[0];
    if (!file) {
      setImportMsg({ ok: false, text: "กรุณาเลือกไฟล์ Excel (.xlsx) หรือ CSV" });
      return;
    }
    setImportMsg(null);
    setImportResults(null);
    startImportTransition(async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await bulkImportEmployeesAction(customerId, fd);
      if (!res.ok) {
        setImportMsg({ ok: false, text: res.message });
        return;
      }
      setImportResults(res.results);
      setImportMsg({
        ok: res.successCount === res.results.length,
        text:
          `นำเข้าสำเร็จ ${res.successCount}/${res.results.length} รายการ` +
          (res.truncated ? ` (ไฟล์มี ${res.totalRows} แถว — ตัดเหลือ ${res.results.length} แถวแรกตามเพดาน)` : ""),
      });
      if (importFileRef.current) importFileRef.current.value = "";
      router.refresh();
    });
  }

  const activeEmployees = useMemo(() => employees.filter((e) => e.isActive), [employees]);
  const inactiveEmployees = useMemo(() => employees.filter((e) => !e.isActive), [employees]);

  const resetForm = () => {
    setEditingId(null);
    setForm(blankForm());
  };

  const startEdit = (e: PayrollEmployee) => {
    setMsg(null);
    setTab("employees");
    setEditingId(e.id);
    setForm({
      employeeCode: e.employeeCode ?? "",
      fullName: e.fullName,
      // ★ 0.12: ปล่อยว่างตอนแก้ไข = คงเลขบัตร/passport เดิมไว้ (server-side preserve — ดู actions.ts)
      idCardNo: "",
      passportNo: "",
      position: e.position ?? "",
      baseSalary: String(e.baseSalary),
      startDate: e.startDate ?? "",
      resignDate: e.resignDate ?? "",
      isActive: e.isActive,
      email: e.email ?? "",
      ssoExempt: e.ssoExempt,
      priorEmployerYtdGross: e.priorEmployerYtdGross !== null ? String(e.priorEmployerYtdGross) : "",
      priorEmployerYtdPitWithheld: e.priorEmployerYtdPitWithheld !== null ? String(e.priorEmployerYtdPitWithheld) : "",
      priorEmployerYtdSsoEmployee: e.priorEmployerYtdSsoEmployee !== null ? String(e.priorEmployerYtdSsoEmployee) : "",
      priorEmployerNote: e.priorEmployerNote ?? "",
      annualIncomeEstimateOverride: e.annualIncomeEstimateOverride !== null ? String(e.annualIncomeEstimateOverride) : "",
    });
  };

  const submitEmployee = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await upsertEmployeeAction({
        id: editingId ?? undefined,
        customerId,
        employeeCode: form.employeeCode,
        fullName: form.fullName,
        idCardNo: form.idCardNo,
        passportNo: form.passportNo,
        position: form.position,
        baseSalary: parseAmountInput(form.baseSalary),
        startDate: form.startDate || null,
        resignDate: form.resignDate || null,
        isActive: form.isActive,
        email: form.email || null,
        ssoExempt: form.ssoExempt,
        priorEmployerYtdGross: form.priorEmployerYtdGross.trim() === "" ? null : parseAmountInput(form.priorEmployerYtdGross),
        priorEmployerYtdPitWithheld:
          form.priorEmployerYtdPitWithheld.trim() === "" ? null : parseAmountInput(form.priorEmployerYtdPitWithheld),
        priorEmployerYtdSsoEmployee:
          form.priorEmployerYtdSsoEmployee.trim() === "" ? null : parseAmountInput(form.priorEmployerYtdSsoEmployee),
        priorEmployerNote: form.priorEmployerNote || null,
        annualIncomeEstimateOverride:
          form.annualIncomeEstimateOverride.trim() === "" ? null : parseAmountInput(form.annualIncomeEstimateOverride),
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        resetForm();
        router.refresh();
      }
    });
  };

  const removeEmployee = (id: string) => {
    if (!confirm("ยืนยันลบทะเบียนพนักงานนี้?")) return;
    startTransition(async () => {
      const res = await deleteEmployeeAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  const reveal = (id: string) => {
    startTransition(async () => {
      const res = await revealIdCardAction(id, customerId);
      if (res.ok) setRevealed((m) => ({ ...m, [id]: { idCardNo: res.idCardNo, passportNo: res.passportNo } }));
      else setMsg({ ok: false, text: res.message });
    });
  };

  // ---- ตั้งค่าบัญชี ----
  const [settingsForm, setSettingsForm] = useState<SettingsFormState>(() => ({
    salaryExpenseAccountCode: settings.salaryExpenseAccountCode,
    salaryExpenseAccountName: chartByCode[settings.salaryExpenseAccountCode]?.name ?? settings.salaryExpenseAccountCode,
    ssoEmployerExpenseAccountCode: settings.ssoEmployerExpenseAccountCode,
    ssoEmployerExpenseAccountName:
      chartByCode[settings.ssoEmployerExpenseAccountCode]?.name ?? settings.ssoEmployerExpenseAccountCode,
    ssoPayableAccountCode: settings.ssoPayableAccountCode,
    ssoPayableAccountName: chartByCode[settings.ssoPayableAccountCode]?.name ?? settings.ssoPayableAccountCode,
    pitPayableAccountCode: settings.pitPayableAccountCode,
    pitPayableAccountName: chartByCode[settings.pitPayableAccountCode]?.name ?? settings.pitPayableAccountCode,
    otherDeductionsAccountCode: settings.otherDeductionsAccountCode ?? "",
    otherDeductionsAccountName: settings.otherDeductionsAccountCode
      ? chartByCode[settings.otherDeductionsAccountCode]?.name ?? settings.otherDeductionsAccountCode
      : "",
    netPayAccountCode: settings.netPayAccountCode ?? "",
    netPayAccountName: settings.netPayAccountCode ? chartByCode[settings.netPayAccountCode]?.name ?? settings.netPayAccountCode : "",
    netPayIsPaidImmediately: settings.netPayIsPaidImmediately,
    payFrequency: settings.payFrequency,
    severanceExpenseAccountCode: settings.severanceExpenseAccountCode ?? "",
    severanceExpenseAccountName: settings.severanceExpenseAccountCode
      ? chartByCode[settings.severanceExpenseAccountCode]?.name ?? settings.severanceExpenseAccountCode
      : "",
  }));

  const submitSettings = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await upsertSettingsAction({
        customerId,
        salaryExpenseAccountCode: settingsForm.salaryExpenseAccountCode,
        ssoEmployerExpenseAccountCode: settingsForm.ssoEmployerExpenseAccountCode,
        ssoPayableAccountCode: settingsForm.ssoPayableAccountCode,
        pitPayableAccountCode: settingsForm.pitPayableAccountCode,
        otherDeductionsAccountCode: settingsForm.otherDeductionsAccountCode || null,
        netPayAccountCode: settingsForm.netPayAccountCode || null,
        netPayIsPaidImmediately: settingsForm.netPayIsPaidImmediately,
        payFrequency: settingsForm.payFrequency,
        severanceExpenseAccountCode: settingsForm.severanceExpenseAccountCode || null,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  return (
    <div>
      <div className="acc-subtabs">
        <button type="button" className={`acc-subtab${tab === "employees" ? " active" : ""}`} onClick={() => setTab("employees")}>
          ทะเบียนพนักงาน <span className="acc-subtab-n">{employees.length}</span>
        </button>
        <button type="button" className={`acc-subtab${tab === "settings" ? " active" : ""}`} onClick={() => setTab("settings")}>
          ตั้งค่าบัญชี
        </button>
      </div>

      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {tab === "employees" ? (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="section-title"><span>นำเข้าพนักงานเป็นชุด (Excel/CSV)</span></div>
            <p className="empty" style={{ marginBottom: 8 }}>
              ดาวน์โหลดเทมเพลตก่อน กรอกรายชื่อพนักงาน แล้วอัปโหลดกลับมา — เพิ่มพนักงานใหม่เท่านั้น (ไม่แก้ทะเบียนเดิม)
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={downloadImportTemplate}>
                ดาวน์โหลดเทมเพลต
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.csv" disabled={importPending} />
              <button type="button" className="btn" onClick={submitImport} disabled={importPending}>
                {importPending ? "กำลังนำเข้า…" : "นำเข้าพนักงาน"}
              </button>
            </div>
            {importMsg ? <div className={`action-msg ${importMsg.ok ? "ok" : "err"}`}>{importMsg.text}</div> : null}
            {importResults && importResults.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: 10, maxHeight: 260, overflowY: "auto" }}>
                <table className="dlv-table acc-table">
                  <thead>
                    <tr>
                      <th>แถวที่</th>
                      <th>ชื่อ</th>
                      <th>ผลลัพธ์</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResults.map((r) => (
                      <tr key={r.rowNumber}>
                        <td>{r.rowNumber}</td>
                        <td>{r.fullName}</td>
                        <td style={{ color: r.ok ? "#157347" : "#b02a37" }}>{r.ok ? "✓ สำเร็จ" : `✕ ${r.message}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="section-title"><span>{editingId ? "แก้ไขพนักงาน" : "เพิ่มพนักงานใหม่"}</span></div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>รหัสพนักงาน</span>
                <input value={form.employeeCode} onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>ชื่อ-นามสกุล *</span>
                <input value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>เลขบัตรประชาชน (13 หลัก){editingId ? " — ปล่อยว่าง = ไม่เปลี่ยน" : ""}</span>
                <input
                  value={form.idCardNo}
                  onChange={(e) => setForm((f) => ({ ...f, idCardNo: e.target.value }))}
                  placeholder={editingId ? "(ไม่เปลี่ยน)" : "เช่น 1-2345-67890-12-3"}
                />
              </label>
              <label className="acc-field">
                <span>เลข Passport (ต่างชาติ){editingId ? " — ปล่อยว่าง = ไม่เปลี่ยน" : ""}</span>
                <input
                  value={form.passportNo}
                  onChange={(e) => setForm((f) => ({ ...f, passportNo: e.target.value }))}
                  placeholder={editingId ? "(ไม่เปลี่ยน)" : ""}
                />
              </label>
              <label className="acc-field">
                <span>ตำแหน่ง</span>
                <input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>อีเมล (สำหรับส่งสลิปเงินเดือน)</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="เช่น somchai@example.com"
                />
              </label>
              <label className="acc-field">
                <span>เงินเดือนฐาน (บาท) *</span>
                <input className="num" inputMode="decimal" value={form.baseSalary} onChange={(e) => setForm((f) => ({ ...f, baseSalary: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>วันที่เริ่มงาน</span>
                <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>วันที่ลาออก</span>
                <input type="date" value={form.resignDate} onChange={(e) => setForm((f) => ({ ...f, resignDate: e.target.value }))} />
              </label>
              <label className="acc-field">
                <span>สถานะ</span>
                <span>
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} /> ยังทำงานอยู่ (active)
                </span>
              </label>
              <label className="acc-field">
                <span>ประกันสังคม</span>
                <span>
                  <input
                    type="checkbox"
                    checked={form.ssoExempt}
                    onChange={(e) => setForm((f) => ({ ...f, ssoExempt: e.target.checked }))}
                  />{" "}
                  ยกเว้นเงินสมทบประกันสังคม (นักบัญชีพิจารณาเงื่อนไขเอง)
                </span>
              </label>
            </div>
            <div className="section-title" style={{ marginTop: 14 }}>
              <span>ยอดยกมาจากนายจ้างเดิม (สำหรับพิมพ์ 50 ทวิ เท่านั้น ไม่กระทบการคำนวณภาษีหัก ณ ที่จ่ายรายเดือน)</span>
            </div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>เงินได้ยกมา (บาท)</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={form.priorEmployerYtdGross}
                  onChange={(e) => setForm((f) => ({ ...f, priorEmployerYtdGross: e.target.value }))}
                  placeholder="ไม่มี = เว้นว่าง"
                />
              </label>
              <label className="acc-field">
                <span>ภาษีหัก ณ ที่จ่ายยกมา (บาท)</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={form.priorEmployerYtdPitWithheld}
                  onChange={(e) => setForm((f) => ({ ...f, priorEmployerYtdPitWithheld: e.target.value }))}
                  placeholder="ไม่มี = เว้นว่าง"
                />
              </label>
              <label className="acc-field">
                <span>ประกันสังคม (ลูกจ้าง) ยกมา (บาท)</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={form.priorEmployerYtdSsoEmployee}
                  onChange={(e) => setForm((f) => ({ ...f, priorEmployerYtdSsoEmployee: e.target.value }))}
                  placeholder="ไม่มี = เว้นว่าง"
                />
              </label>
              <label className="acc-field">
                <span>หมายเหตุ (เช่น ชื่อนายจ้างเดิม)</span>
                <input
                  value={form.priorEmployerNote}
                  onChange={(e) => setForm((f) => ({ ...f, priorEmployerNote: e.target.value }))}
                />
              </label>
            </div>
            <div className="section-title" style={{ marginTop: 14 }}>
              <span>ค่าลดหย่อนภาษีอื่น (เฟส 9b — {ENABLE_EXTRA_DEDUCTIONS_IN_PIT ? "มีผลต่อยอดภาษีหัก ณ ที่จ่ายจริงแล้ว" : "preview เท่านั้น ยังไม่มีผลต่อยอดหักภาษีจริงจนกว่าจะ verify"})</span>
            </div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>ยอดประมาณเงินได้ทั้งปี (บาท) — ใช้คำนวณเพดาน PVD/RMF/กบข เท่านั้น</span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={form.annualIncomeEstimateOverride}
                  onChange={(e) => setForm((f) => ({ ...f, annualIncomeEstimateOverride: e.target.value }))}
                  placeholder="ไม่กรอก = ระบบประมาณจากเงินเดือนปัจจุบันเอง"
                />
              </label>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button type="button" className="btn" disabled={pending} onClick={submitEmployee}>
                {editingId ? "บันทึกการแก้ไข" : "เพิ่มพนักงาน"}
              </button>
              {editingId ? (
                <button type="button" className="btn btn-ghost" onClick={resetForm}>ยกเลิก</button>
              ) : null}
            </div>
            {editingId ? (
              <EmployeeDeductionsEditor employeeId={editingId} customerId={customerId} pendingOuter={pending} />
            ) : (
              <p className="muted" style={{ marginTop: 10 }}>บันทึกพนักงานก่อน แล้วกด &ldquo;แก้ไข&rdquo; อีกครั้งเพื่อกรอกค่าลดหย่อนภาษีอื่นของพนักงานคนนี้</p>
            )}
          </div>

          <EmployeeTable
            title="พนักงานที่ยังทำงานอยู่"
            list={activeEmployees}
            revealed={revealed}
            onEdit={startEdit}
            onDelete={removeEmployee}
            onReveal={reveal}
            pending={pending}
            formatDateThai={formatDateThai}
          />
          {inactiveEmployees.length > 0 ? (
            <EmployeeTable
              title="พนักงานที่ไม่ทำงานแล้ว (inactive)"
              list={inactiveEmployees}
              revealed={revealed}
              onEdit={startEdit}
              onDelete={removeEmployee}
              onReveal={reveal}
              pending={pending}
              formatDateThai={formatDateThai}
            />
          ) : null}
        </>
      ) : (
        <div className="card">
          <div className="section-title"><span>ตั้งค่าบัญชี — ใช้เมื่อสร้างรายการบัญชีจากรอบเงินเดือน</span></div>
          <div className="acc-field-grid">
            <label className="acc-field">
              <span>รหัสบัญชีเงินเดือน/ค่าจ้าง (ค่าใช้จ่าย)</span>
              <AccountCombobox
                accountCode={settingsForm.salaryExpenseAccountCode}
                accountName={settingsForm.salaryExpenseAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, salaryExpenseAccountCode: code, salaryExpenseAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, salaryExpenseAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, salaryExpenseAccountCode: "", salaryExpenseAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>รหัสบัญชีประกันสังคม (ส่วนนายจ้าง — ค่าใช้จ่าย)</span>
              <AccountCombobox
                accountCode={settingsForm.ssoEmployerExpenseAccountCode}
                accountName={settingsForm.ssoEmployerExpenseAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, ssoEmployerExpenseAccountCode: code, ssoEmployerExpenseAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, ssoEmployerExpenseAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, ssoEmployerExpenseAccountCode: "", ssoEmployerExpenseAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>รหัสบัญชีประกันสังคมค้างนำส่ง (หนี้สิน)</span>
              <AccountCombobox
                accountCode={settingsForm.ssoPayableAccountCode}
                accountName={settingsForm.ssoPayableAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, ssoPayableAccountCode: code, ssoPayableAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, ssoPayableAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, ssoPayableAccountCode: "", ssoPayableAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>รหัสบัญชีภาษีหัก ณ ที่จ่ายค้างจ่าย (หนี้สิน)</span>
              <AccountCombobox
                accountCode={settingsForm.pitPayableAccountCode}
                accountName={settingsForm.pitPayableAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, pitPayableAccountCode: code, pitPayableAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, pitPayableAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, pitPayableAccountCode: "", pitPayableAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>รหัสบัญชีหักอื่น ๆ ค้างจ่าย (หนี้สิน, ไม่บังคับ)</span>
              <AccountCombobox
                accountCode={settingsForm.otherDeductionsAccountCode}
                accountName={settingsForm.otherDeductionsAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, otherDeductionsAccountCode: code, otherDeductionsAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, otherDeductionsAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, otherDeductionsAccountCode: "", otherDeductionsAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>
                รหัสบัญชีค่าชดเชยเลิกจ้าง (ค่าใช้จ่าย, ไม่บังคับ — บังคับก่อนสร้าง JE ได้จริงเฉพาะรอบที่มีค่าชดเชยเลิกจ้าง)
              </span>
              <AccountCombobox
                accountCode={settingsForm.severanceExpenseAccountCode}
                accountName={settingsForm.severanceExpenseAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, severanceExpenseAccountCode: code, severanceExpenseAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, severanceExpenseAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, severanceExpenseAccountCode: "", severanceExpenseAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>รหัสบัญชีเงินเดือนสุทธิ (หนี้สินค้างจ่าย หรือเงินสด/ธนาคารถ้าโอนทันที — บังคับก่อนสร้าง JE ได้จริง)</span>
              <AccountCombobox
                accountCode={settingsForm.netPayAccountCode}
                accountName={settingsForm.netPayAccountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => setSettingsForm((f) => ({ ...f, netPayAccountCode: code, netPayAccountName: name }))}
                onNameChange={(name) => setSettingsForm((f) => ({ ...f, netPayAccountName: name }))}
                onClear={() => setSettingsForm((f) => ({ ...f, netPayAccountCode: "", netPayAccountName: "" }))}
              />
            </label>
            <label className="acc-field">
              <span>โอนเงินเดือนวันเดียวกับปิดรอบทันที</span>
              <span>
                <input
                  type="checkbox"
                  checked={settingsForm.netPayIsPaidImmediately}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, netPayIsPaidImmediately: e.target.checked }))}
                />{" "}
                เลือกรหัสบัญชีเงินสด/ธนาคารด้านบนแทนบัญชีค้างจ่าย
              </span>
            </label>
          </div>

          {/* ★ เฟส 9b กลุ่ม BC (T140) — ความถี่จ่ายเงินเดือน */}
          <div className="section-title" style={{ marginTop: 14 }}>
            <span>รอบจ่ายเงินเดือน</span>
          </div>
          <div className="acc-field-grid">
            <label className="acc-field">
              <span>ความถี่จ่าย</span>
              <select
                value={settingsForm.payFrequency}
                onChange={(e) => setSettingsForm((f) => ({ ...f, payFrequency: e.target.value === "non_monthly" ? "non_monthly" : "monthly" }))}
              >
                <option value="monthly">รายเดือน (ปกติ — 1 รอบ/เดือนเท่านั้น)</option>
                <option value="non_monthly">ไม่ใช่รายเดือน (เช่น รายสัปดาห์/รายปักษ์ — สร้างหลายรอบ/เดือนได้)</option>
              </select>
            </label>
          </div>
          {settingsForm.payFrequency === "non_monthly" ? (
            <p className="muted" style={{ marginTop: 6 }}>
              ⚠️ เปิดโหมดนี้แล้วจะสร้างรอบเงินเดือนหลายรอบในเดือน/ปีเดียวกันได้ — ภ.ง.ด.1/สปส.1-10 ยังยื่นรวมเป็นชุดเดียวต่อเดือนเสมอ
              (ดูที่หน้า &quot;สรุปการยื่นรายเดือน&quot;) เปลี่ยนกลับเป็น &quot;รายเดือน&quot; ได้ตลอดโดยไม่กระทบรอบที่สร้างไปแล้ว
            </p>
          ) : null}

          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={pending} onClick={submitSettings}>บันทึกตั้งค่าบัญชี</button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmployeeTable({
  title,
  list,
  revealed,
  onEdit,
  onDelete,
  onReveal,
  pending,
  formatDateThai,
}: {
  title: string;
  list: PayrollEmployee[];
  revealed: Record<string, { idCardNo: string | null; passportNo: string | null }>;
  onEdit: (e: PayrollEmployee) => void;
  onDelete: (id: string) => void;
  onReveal: (id: string) => void;
  pending: boolean;
  formatDateThai: (iso: string | null) => string;
}) {
  if (list.length === 0) return null;
  return (
    <div className="table-wrap" style={{ marginBottom: 16 }}>
      <div className="section-title"><span>{title}</span></div>
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>รหัส</th>
            <th>ชื่อ-นามสกุล</th>
            <th>เลขบัตร/Passport</th>
            <th>ตำแหน่ง</th>
            <th className="num">เงินเดือนฐาน</th>
            <th>เริ่มงาน</th>
            <th>ลาออก</th>
            <th className="center">ประกันสังคม</th>
            <th className="center">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {list.map((e) => {
            const r = revealed[e.id];
            const idDisplay = r ? r.idCardNo ?? "—" : e.idCardNo ?? "—";
            const passportDisplay = r ? r.passportNo : e.passportNo;
            return (
              <tr key={e.id}>
                <td>{e.employeeCode || "—"}</td>
                <td>{e.fullName}</td>
                <td>
                  {e.idCardNo ? idDisplay : passportDisplay || "—"}
                  {e.idCardNo && !r ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReveal(e.id)} disabled={pending} style={{ marginLeft: 6 }}>
                      เผยเลขเต็ม
                    </button>
                  ) : null}
                </td>
                <td>{e.position || "—"}</td>
                <td className="num">{formatMoney(e.baseSalary)}</td>
                <td>{formatDateThai(e.startDate)}</td>
                <td>{e.resignDate ? formatDateThai(e.resignDate) : "—"}</td>
                <td className="center">{e.ssoExempt ? "ยกเว้น" : "—"}</td>
                <td className="center">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(e)}>แก้ไข</button>{" "}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(e.id)}>ลบ</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * EmployeeDeductionsEditor — ฟอร์มค่าลดหย่อนภาษีอื่นต่อพนักงาน/ปีภาษี (เฟส 9b กลุ่ม BE, T155)
 *   ★ โหลดข้อมูลผ่าน server action เอง (ไม่ผ่าน props จาก page.tsx) เพราะเลือกปีภาษีเปลี่ยนได้อิสระต่อพนักงาน
 *     ที่กำลังแก้ไข — ไม่กระทบ initial load ของหน้าทะเบียนพนักงานหลัก
 */
function EmployeeDeductionsEditor({
  employeeId,
  customerId,
  pendingOuter,
}: {
  employeeId: string;
  customerId: string;
  pendingOuter: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [taxYear, setTaxYear] = useState(String(currentBuddhistYear()));
  const [loadedYear, setLoadedYear] = useState<string | null>(null);
  const [rows, setRows] = useState<PayrollEmployeeDeduction[]>([]);

  const [newType, setNewType] = useState<DeductionType>("spouse_no_income");
  const [newAmount, setNewAmount] = useState("");
  const [newNote, setNewNote] = useState("");

  const load = (year: string) => {
    setMsg(null);
    startTransition(async () => {
      const res = await listDeductionsAction(employeeId, customerId, Number(year));
      if (res.ok) {
        setRows(res.deductions);
        setLoadedYear(year);
      } else {
        setMsg({ ok: false, text: res.message });
      }
    });
  };

  const addRow = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await upsertDeductionAction({
        employeeId,
        customerId,
        taxYear: Number(taxYear),
        deductionType: newType,
        amount: newType === "child" ? Number(newAmount) : parseAmountInput(newAmount),
        note: newNote || null,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setNewAmount("");
        setNewNote("");
        load(taxYear);
        router.refresh();
      }
    });
  };

  const removeRow = (id: string) => {
    if (!confirm("ยืนยันลบค่าลดหย่อนรายการนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteDeductionAction(id, employeeId, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        load(taxYear);
        router.refresh();
      }
    });
  };

  const busy = pending || pendingOuter;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="section-title"><span>ค่าลดหย่อนภาษีอื่นของพนักงานคนนี้ (ต่อปีภาษี)</span></div>
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}
      <div className="acc-field-grid">
        <label className="acc-field">
          <span>ปีภาษี (พ.ศ.)</span>
          <input value={taxYear} onChange={(e) => setTaxYear(e.target.value)} inputMode="numeric" style={{ width: 90 }} />
        </label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => load(taxYear)}>
            โหลดค่าลดหย่อนปีนี้
          </button>
        </div>
      </div>

      {loadedYear !== null ? (
        <>
          <table className="dlv-table acc-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>ประเภท</th>
                <th className="num">จำนวนเงิน</th>
                <th>หมายเหตุ</th>
                <th className="center">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={4}><p className="empty">ยังไม่มีค่าลดหย่อนของปีภาษี {loadedYear}</p></td></tr>
              ) : (
                rows.map((d) => (
                  <tr key={d.id}>
                    <td>{DEDUCTION_TYPE_LABELS[d.deductionType]}</td>
                    <td className="num">{formatMoney(d.amount)}</td>
                    <td>{d.note || "—"}</td>
                    <td className="center">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => removeRow(d.id)}>ลบ</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="section-title" style={{ marginTop: 10 }}><span>เพิ่มค่าลดหย่อนใหม่ (ปีภาษี {taxYear})</span></div>
          <div className="acc-field-grid">
            <label className="acc-field">
              <span>ประเภท</span>
              <select value={newType} onChange={(e) => setNewType(e.target.value as DeductionType)}>
                {DEDUCTION_TYPES.map((t) => (
                  <option key={t} value={t}>{DEDUCTION_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            {newType === "child" ? (
              <label className="acc-field">
                <span>จำนวนเงิน (บาท)</span>
                <select value={newAmount} onChange={(e) => setNewAmount(e.target.value)}>
                  <option value="">— เลือก —</option>
                  {CHILD_ALLOWANCE_AMOUNTS.map((a) => (
                    <option key={a} value={a}>{formatMoney(a)}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="acc-field">
                <span>จำนวนเงิน (บาท)</span>
                <input className="num" inputMode="decimal" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
              </label>
            )}
            <label className="acc-field">
              <span>หมายเหตุ (ไม่บังคับ)</span>
              <input value={newNote} onChange={(e) => setNewNote(e.target.value)} />
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn" disabled={busy || !newAmount} onClick={addRow}>เพิ่มค่าลดหย่อน</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
