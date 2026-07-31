/**
 * ลงบันทึกบัญชี ภาษีซื้อ/ขาย — จัดกลุ่ม "ตามลูกค้า" + สรุปยอด (pure, ทดสอบได้)
 *
 * ★ ลูกค้าเป็นตัวจัดกลุ่มหลัก — เพราะแต่ละลูกค้ายื่นภาษี (ภพ.30/ภ.ง.ด.) แยกกัน
 *   นักบัญชีทำทีละลูกค้า (โครงเดียวกับหน้า /chat-audit/bills groupBillsByCustomer)
 * ★ ในลูกค้า 1 ราย: สรุปแยก ภาษีซื้อ / ภาษีขาย / รอระบุ + ยอดรวมทั้งราย
 * ★ ไม่มี dependency ภายนอก (รับ/คืน plain object) — ผู้เรียกกรอง (เดือน/ค้นหา) มาก่อน
 */
import type { BillEntry, EntrySummary, EntryType } from "@/lib/accounting/queries";
import { round2, summarizeEntry } from "@/lib/accounting/queries";

/** ค่าคีย์พิเศษของกลุ่ม "ยังไม่จับคู่ลูกค้า" (customer_id = null) — จัดไว้ท้ายสุดเสมอ */
export const UNASSIGNED_CUSTOMER = "unassigned";

/** สรุปยอดของลูกค้า 1 ราย แยกตามประเภท + รวมทั้งราย */
export type GroupSummary = {
  purchase: EntrySummary;
  sale: EntrySummary;
  unspecified: EntrySummary;
  /** รวมทุกประเภท (ใช้โชว์ KPI ระดับลูกค้า) */
  all: EntrySummary;
};

/** กลุ่มรายการบัญชีของลูกค้า 1 ราย (customerId null = ยังไม่จับคู่) */
export type CustomerEntryGroup = {
  customerId: string | null;
  name: string | null;
  /** จำนวน entry รวมทั้งราย */
  count: number;
  purchaseCount: number;
  saleCount: number;
  /** จำนวน entry ที่ยัง "รอระบุประเภท" (ต้องเน้น amber ให้คนมาเลือก) */
  unspecifiedCount: number;
  summary: GroupSummary;
  /** วันที่ล่าสุดในกลุ่ม (docDate หรือ createdAt) — ใช้เรียง/โชว์ */
  latestAt: string;
  /** entry ทั้งหมดของลูกค้ารายนี้ (เรียงใหม่→เก่า) */
  entries: BillEntry[];
};

function zeroSummary(): EntrySummary {
  return { count: 0, amount: 0, vat: 0, wht: 0, net: 0 };
}

/** บวกสรุป b เข้า a (คืน a ที่ปัดแล้ว) */
function addSummary(a: EntrySummary, b: EntrySummary): EntrySummary {
  a.count += b.count;
  a.amount = round2(a.amount + b.amount);
  a.vat = round2(a.vat + b.vat);
  a.wht = round2(a.wht + b.wht);
  a.net = round2(a.net + b.net);
  return a;
}

/** สรุปยอดรวมของ entry หลายใบ (รวมทุกประเภท) — ใช้ทำ KPI ระดับหน้า/ลูกค้า */
export function summarizeAll(entries: BillEntry[]): EntrySummary {
  const acc = zeroSummary();
  for (const e of entries) addSummary(acc, summarizeEntry(e.lines));
  return acc;
}

/** วันที่อ้างอิงของ entry (docDate ก่อน, ไม่มีค่อยใช้ createdAt) */
export function entryLatest(e: BillEntry): string {
  return e.docDate || e.createdAt || "";
}

/**
 * จัดกลุ่ม entry ตามลูกค้า แล้วเรียง "จำนวนรายการมาก→น้อย"
 *   - ลูกค้าจับคู่แล้ว: total desc → ล่าสุดก่อน → ชื่อ
 *   - กลุ่ม "ยังไม่จับคู่" (customerId null): รวมการ์ดเดียว ท้ายสุดเสมอ
 *   ★ pure — ผู้เรียกต้องกรอง (เดือน/ค้นหา) มาก่อน
 */
export function groupEntriesByCustomer(entries: BillEntry[]): CustomerEntryGroup[] {
  const assigned = new Map<string, CustomerEntryGroup>();
  let unassigned: CustomerEntryGroup | null = null;

  const makeGroup = (customerId: string | null, name: string | null): CustomerEntryGroup => ({
    customerId,
    name,
    count: 0,
    purchaseCount: 0,
    saleCount: 0,
    unspecifiedCount: 0,
    summary: {
      purchase: zeroSummary(),
      sale: zeroSummary(),
      unspecified: zeroSummary(),
      all: zeroSummary(),
    },
    latestAt: "",
    entries: [],
  });

  for (const e of entries) {
    let g: CustomerEntryGroup;
    if (e.customerId) {
      g = assigned.get(e.customerId) ?? makeGroup(e.customerId, e.customerName);
      // ชื่อ: เก็บชื่อล่าสุดที่ไม่ว่าง (เผื่อบางแถวไม่มีชื่อ)
      if (!g.name && e.customerName) g.name = e.customerName;
      assigned.set(e.customerId, g);
    } else {
      unassigned = unassigned ?? makeGroup(null, null);
      g = unassigned;
    }

    const s = summarizeEntry(e.lines);
    g.count += 1;
    if (e.entryType === "purchase") {
      g.purchaseCount += 1;
      addSummary(g.summary.purchase, s);
    } else if (e.entryType === "sale") {
      g.saleCount += 1;
      addSummary(g.summary.sale, s);
    } else {
      g.unspecifiedCount += 1;
      addSummary(g.summary.unspecified, s);
    }
    addSummary(g.summary.all, s);

    const d = entryLatest(e);
    if (d > g.latestAt) g.latestAt = d;
    g.entries.push(e);
  }

  // เรียง entry ในแต่ละกลุ่มใหม่→เก่า
  for (const g of assigned.values()) sortEntriesDesc(g.entries);
  if (unassigned) sortEntriesDesc(unassigned.entries);

  const sorted = [...assigned.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count; // มาก→น้อย
    const t = (b.latestAt || "").localeCompare(a.latestAt || ""); // ล่าสุดก่อน
    if (t !== 0) return t;
    return (a.name ?? "").localeCompare(b.name ?? "", "th");
  });
  if (unassigned) sorted.push(unassigned); // ยังไม่จับคู่ = ท้ายสุด
  return sorted;
}

function sortEntriesDesc(entries: BillEntry[]): void {
  entries.sort((a, b) => (entryLatest(b) || "").localeCompare(entryLatest(a) || ""));
}

/** ดึง entry ของประเภทที่เลือกจากกลุ่ม (purchase/sale/unspecified) */
export function entriesOfType(group: CustomerEntryGroup, type: EntryType): BillEntry[] {
  return group.entries.filter((e) => e.entryType === type);
}

/** จำนวน entry ของประเภทในกลุ่ม (ใช้ทำ badge บนหัวการ์ด/แท็บย่อย) */
export function countOfType(group: CustomerEntryGroup, type: EntryType): number {
  if (type === "purchase") return group.purchaseCount;
  if (type === "sale") return group.saleCount;
  return group.unspecifiedCount;
}
