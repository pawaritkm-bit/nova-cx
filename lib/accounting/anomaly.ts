/**
 * ตรวจความผิดปกติของบิล (Anomaly detector) — deterministic ล้วน ไม่ใช้ AI = ฟรี
 *   จับ "ยอดผิดปกติ" (VAT/WHT ไม่ตรงสูตร, ยอดติดลบ) + "เอกสารขาด" (บิล VAT แต่ไม่มีเลขที่/วันที่)
 *   เพื่อเตือนนักบัญชี "ตรวจก่อนยืนยัน" — ไม่บล็อกการยืนยันทีละใบ (advisory) แต่กัน batch-confirm
 *   ระดับ error (ยอดน่าจะผิด) ออกไปให้คนตรวจเอง
 *
 * ★ ใช้สูตรเดียวกับ engine (calc.ts: VAT 7% ของฐาน, WHT = ฐาน×อัตรา) เพื่อไม่ให้เตือนขัดกับที่ระบบคำนวณ
 */
import { VAT_RATE, round2 } from "@/lib/accounting/calc";

export type AnomalySeverity = "error" | "warn";

export type AnomalyCode =
  | "negative_total" // ยอดรวมติดลบ (ผิดแน่)
  | "vat_mismatch" // VAT ที่บิลแสดง ไม่ตรง 7% ของฐาน
  | "wht_mismatch" // ยอดหัก ณ ที่จ่าย ไม่ตรง อัตรา×ฐาน
  | "wht_rate_nonstandard" // อัตรา WHT ไม่อยู่ในชุดมาตรฐาน
  | "missing_tax_doc_fields"; // บิล VAT แต่ขาดเลขที่/วันที่เอกสาร (ยื่น ภพ.30 ไม่ครบ)

export type Anomaly = { code: AnomalyCode; severity: AnomalySeverity; message: string };

/** รูปข้อมูลขั้นต่ำที่ใช้ตรวจ — ใช้ได้ทั้งจาก BillEntry (list) และ row ดิบ (server action) */
export type AnomalyInput = {
  entryType: "purchase" | "sale" | "unspecified";
  docNo: string | null;
  docDate: string | null;
  lines: {
    vatType: "vat" | "novat";
    amount: number;
    vatAmount: number;
    whtRate: number;
    whtAmount: number;
  }[];
};

/** อัตรา WHT มาตรฐานตามกฎหมาย (ท.ป.4/2528 + ม.3เตรส) — นอกชุดนี้ = ควรตรวจ */
const STANDARD_WHT_RATES = new Set([0, 1, 1.5, 2, 3, 5, 10, 15]);

/** ผ่อนผัน: ต่างได้ ≤ 1 บาท หรือ ≤ 2% ของค่าที่คาด (กันปัดเศษ/ส่วนลดเล็กน้อย) */
function withinTolerance(actual: number, expected: number): boolean {
  const diff = Math.abs(actual - expected);
  return diff <= Math.max(1, expected * 0.02);
}

/**
 * ตรวจ 1 บิล → คืนรายการ anomaly (ว่าง = ปกติ)
 *   ★ ตรวจเฉพาะ "บิลที่มีมูลค่า" — บิลว่าง (draft ยังไม่เติม) ไม่ถือว่าผิดปกติ (แค่ยังไม่พร้อม)
 */
export function detectAnomalies(e: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const lines = e.lines ?? [];
  const totalAmount = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const totalVat = lines.reduce((s, l) => s + (Number(l.vatAmount) || 0), 0);
  const hasValue = totalAmount > 0 || totalVat > 0;
  if (!hasValue) return out; // บิลว่าง — ไม่ตรวจ

  // 1) ยอดรวมติดลบ
  if (totalAmount < 0) {
    out.push({ code: "negative_total", severity: "error", message: "ยอดรวมติดลบ" });
  }

  // 2) VAT ไม่ตรง 7% (เฉพาะบรรทัดที่ "บิลแสดง VAT มาเอง" — vatAmount>0 · ที่ปล่อย 0 ระบบคิด 7% ให้เอง)
  for (const l of lines) {
    const amt = Number(l.amount) || 0;
    const vat = Number(l.vatAmount) || 0;
    if (l.vatType === "vat" && amt > 0 && vat > 0) {
      const expected = round2((amt * VAT_RATE) / 100);
      if (!withinTolerance(vat, expected)) {
        out.push({
          code: "vat_mismatch",
          severity: "error",
          message: `VAT ${vat.toLocaleString()} ไม่ตรง 7% ของฐาน (ควร ~${expected.toLocaleString()})`,
        });
        break; // เตือนครั้งเดียวพอ
      }
    }
  }

  // 3) WHT: อัตรานอกมาตรฐาน (warn) + ยอดหักไม่ตรง อัตรา×ฐาน (error)
  for (const l of lines) {
    const rate = Number(l.whtRate) || 0;
    if (rate > 0 && !STANDARD_WHT_RATES.has(rate)) {
      out.push({
        code: "wht_rate_nonstandard",
        severity: "warn",
        message: `อัตราหัก ณ ที่จ่าย ${rate}% ไม่อยู่ในชุดมาตรฐาน`,
      });
      break;
    }
  }
  for (const l of lines) {
    const rate = Number(l.whtRate) || 0;
    const amt = Number(l.amount) || 0;
    const wht = Number(l.whtAmount) || 0;
    if (rate > 0 && wht > 0 && amt > 0) {
      const expected = round2((amt * rate) / 100);
      if (!withinTolerance(wht, expected)) {
        out.push({
          code: "wht_mismatch",
          severity: "error",
          message: `ยอดหัก ณ ที่จ่าย ${wht.toLocaleString()} ไม่ตรง ${rate}%×ฐาน (ควร ~${expected.toLocaleString()})`,
        });
        break;
      }
    }
  }

  // 4) เอกสารขาด — บิล VAT (ใบกำกับภาษี) ต้องมีเลขที่ + วันที่ ไม่งั้นยื่น ภพ.30 ไม่ครบ
  const isTaxInvoice = lines.some((l) => l.vatType === "vat");
  if (isTaxInvoice) {
    const missing: string[] = [];
    if (!e.docNo || !e.docNo.trim()) missing.push("เลขที่เอกสาร");
    if (!e.docDate || !e.docDate.trim()) missing.push("วันที่");
    if (missing.length > 0) {
      out.push({
        code: "missing_tax_doc_fields",
        severity: "warn",
        message: `บิลภาษี (VAT) ขาด ${missing.join(" / ")} — ยื่น ภพ.30 ไม่ครบ`,
      });
    }
  }

  return out;
}

/** มี anomaly ระดับ error ไหม (ใช้กัน batch-confirm) */
export function hasErrorAnomaly(anomalies: Anomaly[]): boolean {
  return anomalies.some((a) => a.severity === "error");
}
