import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  csvBufferToEmployeeRows,
  excelBufferToEmployeeRows,
  rawRowToEmployeeInput,
  buildEmployeeImportTemplate,
  MAX_IMPORT_ROWS,
} from "@/lib/accounting/payroll-employee-import";
import { validatePayrollEmployeeInput } from "@/lib/accounting/payroll-employees";

/**
 * เทสต์ `payroll-employee-import.ts` (wishlist ข้อ 2) — นำเข้าทะเบียนพนักงานเป็นชุดจาก Excel/CSV
 */

describe("csvBufferToEmployeeRows", () => {
  it("จับคู่หัวคอลัมน์ไทยที่รองรับ + parse แถวข้อมูลถูกต้อง", () => {
    const csv =
      "รหัสพนักงาน,ชื่อ-นามสกุล,เลขบัตรประชาชน,เลขพาสปอร์ต,ตำแหน่ง,เงินเดือน,วันที่เริ่มงาน,วันที่ลาออก\n" +
      "EMP001,สมชาย ใจดี,1234567890123,,พนักงานบัญชี,20000,2026-01-01,\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toEqual({
      employeeCode: "EMP001",
      fullName: "สมชาย ใจดี",
      idCardNo: "1234567890123",
      passportNo: "",
      position: "พนักงานบัญชี",
      baseSalary: "20000",
      startDate: "2026-01-01",
      resignDate: "",
    });
  });

  it("คอลัมน์ที่ไม่รู้จัก → ข้าม (ไม่ throw) ส่วนคอลัมน์ที่รู้จักยัง map ถูก", () => {
    const csv = "แผนก,ชื่อ-นามสกุล,เงินเดือน\nบัญชี,สมหญิง ดีใจ,25000\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows[0].fullName).toBe("สมหญิง ดีใจ");
    expect(r.rows[0].baseSalary).toBe("25000");
  });

  it("แถวว่างล้วน → ข้าม ไม่นับเป็นแถวข้อมูล", () => {
    const csv = "ชื่อ-นามสกุล,เงินเดือน\nสมชาย,20000\n,,\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(1);
  });

  it("มีแถวว่างคั่นระหว่างข้อมูล → sourceRowNumbers ของแถวถัดไปยังตรงกับเลขแถวจริงในไฟล์ (ไม่เลื่อนตาม index หลังกรองแถวว่างทิ้ง)", () => {
    const csv = "ชื่อ-นามสกุล,เงินเดือน\nสมชาย,20000\n,,\nสมหญิง,25000\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(2);
    expect(r.rows[1].fullName).toBe("สมหญิง");
    // แถวที่ 1=header, 2=สมชาย, 3=แถวว่าง(คั่น, ถูกกรองทิ้ง), 4=สมหญิง — ต้องได้ [2,4] ไม่ใช่ [2,3]
    expect(r.sourceRowNumbers).toEqual([2, 4]);
  });

  it("field ที่มี comma ภายใน quote → parse ถูกต้อง (ไม่แตกเป็นหลายคอลัมน์)", () => {
    const csv = 'ชื่อ-นามสกุล,ตำแหน่ง,เงินเดือน\n"สมชาย, ใจดี",ผู้จัดการ,30000\n';
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows[0].fullName).toBe("สมชาย, ใจดี");
  });

  it("ไฟล์ไม่มีแถวข้อมูล (มีแต่หัวคอลัมน์) → rows ว่าง", () => {
    const csv = "ชื่อ-นามสกุล,เงินเดือน\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows).toEqual([]);
    expect(r.totalRows).toBe(0);
  });

  it("แถวเกิน MAX_IMPORT_ROWS → ตัดเหลือเพดาน + truncated=true", () => {
    const header = "ชื่อ-นามสกุล,เงินเดือน\n";
    const dataRows = Array.from({ length: MAX_IMPORT_ROWS + 100 }, (_, i) => `พนักงาน ${i},20000`).join("\n");
    const buf = Buffer.from(header + dataRows, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(MAX_IMPORT_ROWS);
    expect(r.totalRows).toBe(MAX_IMPORT_ROWS + 100);
    expect(r.truncated).toBe(true);
  });

  it("ตัด BOM ของไฟล์ CSV ได้ถูกต้อง", () => {
    const csv = "﻿ชื่อ-นามสกุล,เงินเดือน\nสมชาย,20000\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToEmployeeRows(buf);
    expect(r.rows[0].fullName).toBe("สมชาย");
  });
});

describe("excelBufferToEmployeeRows", () => {
  async function buildWorkbookBuffer(rows: (string | number)[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("พนักงาน");
    for (const r of rows) sheet.addRow(r);
    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer as ArrayBuffer);
  }

  it("อ่านชีทแรก + จับคู่หัวคอลัมน์ไทยถูกต้อง", async () => {
    const buf = await buildWorkbookBuffer([
      ["รหัสพนักงาน", "ชื่อ-นามสกุล", "เงินเดือน"],
      ["EMP002", "วิชัย มั่นคง", 22000],
    ]);
    const r = await excelBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].employeeCode).toBe("EMP002");
    expect(r.rows[0].fullName).toBe("วิชัย มั่นคง");
    expect(r.rows[0].baseSalary).toBe("22000");
  });

  it("ชีทว่างเปล่า (ไม่มีแถวเลย) → rows ว่าง ไม่ throw", async () => {
    const buf = await buildWorkbookBuffer([]);
    const r = await excelBufferToEmployeeRows(buf);
    expect(r.rows).toEqual([]);
  });
});

describe("rawRowToEmployeeInput + validatePayrollEmployeeInput (integration)", () => {
  it("แถวถูกต้องครบ → validate ผ่าน", () => {
    const input = rawRowToEmployeeInput({
      employeeCode: "EMP001",
      fullName: "สมชาย ใจดี",
      idCardNo: "1234567890123",
      passportNo: "",
      position: "พนักงานบัญชี",
      baseSalary: "20,000.00",
      startDate: "2026-01-01",
      resignDate: "",
    });
    const v = validatePayrollEmployeeInput(input);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.baseSalary).toBe(20000);
  });

  it("ไม่มีชื่อ → validate ปฏิเสธ (reuse validator เดิม ไม่มี fast-path ข้าม)", () => {
    const input = rawRowToEmployeeInput({
      employeeCode: "",
      fullName: "",
      idCardNo: "1234567890123",
      passportNo: "",
      position: "",
      baseSalary: "20000",
      startDate: "",
      resignDate: "",
    });
    const v = validatePayrollEmployeeInput(input);
    expect(v.ok).toBe(false);
  });

  it("ไม่มีทั้งเลขบัตรและ passport → validate ปฏิเสธ", () => {
    const input = rawRowToEmployeeInput({
      employeeCode: "",
      fullName: "สมชาย",
      idCardNo: "",
      passportNo: "",
      position: "",
      baseSalary: "20000",
      startDate: "",
      resignDate: "",
    });
    const v = validatePayrollEmployeeInput(input);
    expect(v.ok).toBe(false);
  });

  it("เงินเดือนมีลูกน้ำคั่นหลักพัน → parse เป็นตัวเลขถูกต้อง (ไม่ติด comma)", () => {
    const input = rawRowToEmployeeInput({
      employeeCode: "",
      fullName: "สมชาย",
      idCardNo: "1234567890123",
      passportNo: "",
      position: "",
      baseSalary: "1,234,567.89",
      startDate: "",
      resignDate: "",
    });
    const v = validatePayrollEmployeeInput(input);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.baseSalary).toBe(1234567.89);
  });
});

describe("buildEmployeeImportTemplate", () => {
  it("สร้างไฟล์ .xlsx ที่ excelBufferToEmployeeRows อ่านกลับมาแล้วได้แถวตัวอย่าง 1 แถวถูกต้อง (round-trip)", async () => {
    const buf = await buildEmployeeImportTemplate();
    const r = await excelBufferToEmployeeRows(buf);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].fullName).toBe("สมชาย ใจดี");
    expect(r.rows[0].employeeCode).toBe("EMP001");
  });
});
