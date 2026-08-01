/**
 * ลงบันทึกบัญชี — ตัวสร้างข้อมูล "ตรวจทานก่อนออก Excel" (pure, ทดสอบได้)
 *
 * ★ mirror ตรรกะ lib/accounting/excel.ts (writeSheet): แถว = แต่ละ line ของ entry
 *   (บิลผสมแตกหลายแถว · entry ไม่มี line → 1 แถวเปล่า) — โชว์ "ทุกบรรทัดที่จะเข้าไฟล์"
 * ★ เรียง ภาษีซื้อ (purchase) ก่อน แล้ว ภาษีขาย (sale) — ตรงกับ 2 ชีทของไฟล์จริง
 * ★ entry 'unspecified' (รอระบุ) ไม่เข้าชีทซื้อ/ขาย → นับแยกไว้เตือน
 *   entry ที่จะเข้าไฟล์ (ซื้อ/ขาย) แต่ยัง 'draft' (ร่าง) → นับแยกไว้เตือนให้ยืนยันก่อน
 * ★ ไม่แตะ DB/network — รับ entries (จาก listEntries) แล้วคืน plain object
 */
import type { BillEntry, EntryStatus, VatType } from "@/lib/accounting/queries";
import { lineNet, round2 } from "@/lib/accounting/queries";

export type ReviewType = "purchase" | "sale";

/** 1 บรรทัดที่จะเข้าไฟล์ Excel (ตรงกับ 1 แถวใน writeSheet) */
export type ReviewRow = {
  entryId: string;
  type: ReviewType;
  docDate: string | null;
  docNo: string | null;
  counterparty: string | null;
  taxId: string | null;
  description: string | null;
  /** รหัส/ชื่อบัญชีจากผังบัญชี (ต่อ line) */
  accountCode: string | null;
  accountName: string | null;
  /** null = entry ไม่มี line (แถวเปล่า) */
  vatType: VatType | null;
  amount: number;
  vat: number;
  wht: number;
  net: number;
  status: EntryStatus;
  whtForm: string | null;
};

/** ยอดรวมของประเภทหนึ่ง (แถวรวมท้าย แยกซื้อ/ขาย) */
export type ReviewTypeTotal = {
  /** จำนวน "บิล" (entry) ของประเภทนี้ */
  count: number;
  amount: number;
  vat: number;
  wht: number;
  net: number;
};

export type ReviewData = {
  /** ทุกบรรทัดที่จะเข้าไฟล์ (ซื้อก่อน แล้วขาย) */
  rows: ReviewRow[];
  purchase: ReviewTypeTotal;
  sale: ReviewTypeTotal;
  /** จำนวน entry ที่ยัง 'รอระบุประเภท' (ไม่เข้าชีทซื้อ/ขาย) */
  unspecifiedCount: number;
  /** จำนวน entry ที่จะเข้าไฟล์ (ซื้อ/ขาย) แต่ยังเป็น 'ร่าง' (ควรยืนยันก่อน) */
  draftCount: number;
};

function zeroTotal(): ReviewTypeTotal {
  return { count: 0, amount: 0, vat: 0, wht: 0, net: 0 };
}

/**
 * สร้างข้อมูลตรวจทานจาก entries ทั้งชุด (ตามบริบท/ตัวกรองที่ผู้เรียกกรองมาแล้ว)
 */
export function buildReview(entries: BillEntry[]): ReviewData {
  const rows: ReviewRow[] = [];
  const purchase = zeroTotal();
  const sale = zeroTotal();
  let unspecifiedCount = 0;
  let draftCount = 0;

  const emit = (type: ReviewType, e: BillEntry, total: ReviewTypeTotal) => {
    total.count += 1;
    // entry ไม่มี line → 1 แถวเปล่า (ตรงกับ excel.ts: lines = [null])
    const lines = e.lines.length > 0 ? e.lines : [null];
    for (const l of lines) {
      const amount = l ? round2(l.amount) : 0;
      const vat = l ? round2(l.vatAmount) : 0;
      const wht = l ? round2(l.whtAmount) : 0;
      const net = l ? lineNet(l) : 0;
      total.amount = round2(total.amount + amount);
      total.vat = round2(total.vat + vat);
      total.wht = round2(total.wht + wht);
      total.net = round2(total.net + net);
      rows.push({
        entryId: e.id,
        type,
        docDate: e.docDate,
        docNo: e.docNo,
        counterparty: e.counterpartyName,
        taxId: e.counterpartyTaxId,
        description: l?.description ?? null,
        accountCode: l?.accountCode ?? null,
        accountName: l?.accountName ?? null,
        vatType: l ? l.vatType : null,
        amount,
        vat,
        wht,
        net,
        status: e.status,
        whtForm: e.whtForm,
      });
    }
  };

  // ซื้อก่อน แล้วขาย — ตรงลำดับ 2 ชีทของไฟล์จริง
  for (const e of entries) if (e.entryType === "purchase") emit("purchase", e, purchase);
  for (const e of entries) if (e.entryType === "sale") emit("sale", e, sale);

  // นับรายการที่ต้องเตือน
  for (const e of entries) {
    if (e.entryType === "unspecified") unspecifiedCount += 1;
    else if (e.status === "draft") draftCount += 1;
  }

  return { rows, purchase, sale, unspecifiedCount, draftCount };
}
