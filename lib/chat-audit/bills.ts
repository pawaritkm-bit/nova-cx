/**
 * Bills (หน้า "บิลลูกค้า") — logic กรอง/จัดกลุ่ม/สรุป ฝั่ง pure function
 *
 * แยกออกมาเป็น pure function เพื่อ:
 *   - เทสต์ได้โดยไม่ต้องพึ่ง Supabase/next
 *   - หน้า server component เหลือแค่ดึงข้อมูล + สร้าง signed URL + render
 *
 * ★ ไม่มี dependency ภายนอก (ไม่ import supabase/crypto) — รับ/คืน plain object เท่านั้น
 * ★ PDPA: ไม่มีการ log ที่นี่ (เป็น logic ล้วน) — ผู้เรียกห้าม log ชื่อ/ไฟล์/URL
 */

/** ชนิดเอกสารบิล (message_attachments.doc_kind) — null = ยังไม่คัด/ไม่รู้จัก */
export type DocKind = "slip" | "handwritten" | "cash" | "purchase" | "sale" | "other";

/** ลำดับชนิดเอกสารที่ใช้แสดงป้าย (สลิปโอน → ขาย → เขียนมือ → ซื้อ → เงินสด → อื่นๆ) */
export const DOC_KINDS: DocKind[] = ["slip", "sale", "handwritten", "purchase", "cash", "other"];

/** เป็นค่า doc_kind ที่รู้จักไหม (กัน query param / ค่า DB แปลกปลอม) */
export function isDocKind(v: unknown): v is DocKind {
  return typeof v === "string" && (DOC_KINDS as string[]).includes(v);
}

/** normalize ค่า doc_kind ดิบ → DocKind หรือ null (ค่าที่ไม่รู้จัก/ว่าง = null = ยังไม่คัด) */
export function normalizeDocKind(v: string | null | undefined): DocKind | null {
  return isDocKind(v) ? v : null;
}

/** รายการบิล 1 ใบ (normalize จากแถว message_attachments + join แล้ว) */
export type BillItem = {
  /** message_attachments.id */
  id: string;
  /** object path ใน bucket `bills` (drive_file_id) — null = ไม่มี ref (เปิดไม่ได้) */
  objectPath: string | null;
  /** เวลาบิล = chat_messages.sent_at (fallback = created_at ของ attachment) รูปแบบ ISO */
  billDate: string;
  /** customer_id (null = กลุ่มยังไม่จับคู่ลูกค้า) */
  customerId: string | null;
  /** รหัสลูกค้า (เช่น N023) — null ถ้ายังไม่จับคู่/ไม่มีรหัส */
  customerCode: string | null;
  /** ชื่อลูกค้า — null ถ้ายังไม่จับคู่ */
  customerName: string | null;
  /** ชนิดเอกสาร (slip/sale/...) — null = ยังไม่คัด/ไม่รู้จัก (ไฟล์ = null เสมอ) */
  docKind: DocKind | null;
  /** ชนิดไฟล์แนบ: 'image' = รูปบิล · 'file' = ไฟล์ (PDF/เอกสาร) */
  attachmentType: "image" | "file";
  /** ชื่อไฟล์เดิม (file เท่านั้น) — ไว้โชว์บนการ์ดไฟล์ · null = ไม่มีชื่อ */
  originalName: string | null;
};

/** ตัวเลือกใน dropdown ลูกค้า (เฉพาะลูกค้าที่มีบิล) */
export type CustomerOption = {
  id: string;
  code: string | null;
  name: string | null;
  /** จำนวนบิลของลูกค้ารายนี้ */
  count: number;
};

/** สรุป KPI + ตัวเลือกตัวกรอง (คำนวณครั้งเดียวจากบิลทั้งหมดในสำนักงาน) */
export type BillStats = {
  /** บิลที่เก็บแล้วทั้งหมด */
  total: number;
  /** จำนวนลูกค้าที่มีบิล (นับ customer_id ไม่ซ้ำ; กลุ่มยังไม่จับคู่ไม่นับ) */
  customerCount: number;
  /** จำนวนบิลที่ยังไม่จับคู่ลูกค้า (customer_id null) — เป็น "ใบ" ไม่ใช่ "ราย" */
  unassignedCount: number;
  /** บิลของเดือนปัจจุบัน (ตาม billDate) */
  thisMonth: number;
  /** ตัวเลือกลูกค้าใน dropdown (เรียงตามรหัสลูกค้าแบบ natural) */
  customerOptions: CustomerOption[];
  /** ตัวเลือกเดือน YYYY-MM (ใหม่→เก่า) */
  monthOptions: string[];
};

/** ตัวกรองที่รับจาก query param */
export type BillFilter = {
  /** customer_id ที่เลือก (null/undefined = ไม่กรอง) — ค่า "unassigned" = เฉพาะบิลที่ยังไม่จับคู่ */
  customerId?: string | null;
  /** เดือน YYYY-MM ที่เลือก (null/undefined = ไม่กรอง) */
  month?: string | null;
  /** ชนิดเอกสาร (null/undefined = ทุกประเภท) */
  docKind?: DocKind | null;
  /** ค้นหาลูกค้า/รหัส (substring ไม่สนตัวพิมพ์; ว่าง = ไม่กรอง) */
  search?: string | null;
};

/** ค่า customer filter พิเศษ = เฉพาะบิลที่กลุ่มยังไม่จับคู่ลูกค้า */
export const UNASSIGNED_CUSTOMER = "unassigned";

/** เดือนปัจจุบันรูปแบบ YYYY-MM (อิง UTC ให้ตรงกับที่เก็บ timestamp) */
export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ดึง YYYY-MM จาก ISO date string — คืน null ถ้า parse ไม่ได้ */
export function monthKeyOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ตรวจรูปแบบเดือน YYYY-MM (กัน query param ปลอม) */
export function isValidMonth(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/**
 * เรียงรหัสลูกค้าแบบ natural (prefix ตัวอักษร + เลข) — ลูกค้าไม่มีรหัสไปท้ายสุด (เรียงตามชื่อไทย)
 *   เช่น N003 < N026 < N160 < P139 < P510
 */
function compareCustomerOption(a: CustomerOption, b: CustomerOption): number {
  const ca = a.code ?? "";
  const cb = b.code ?? "";
  if (!ca && !cb) return (a.name ?? "").localeCompare(b.name ?? "", "th");
  if (!ca) return 1;
  if (!cb) return -1;
  return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * สรุป KPI + ตัวเลือกตัวกรอง จากบิลทั้งหมด (ก่อนกรอง)
 *   - total          : จำนวนบิลทั้งหมด
 *   - customerCount  : จำนวน customer_id ไม่ซ้ำ (กลุ่มยังไม่จับคู่ = customer_id null ไม่นับ)
 *   - thisMonth      : บิลของเดือนปัจจุบัน
 *   - customerOptions: ลูกค้าที่มีบิล (+จำนวนบิล) เรียงตามรหัส
 *   - monthOptions   : เดือนที่มีบิล (ใหม่→เก่า)
 */
export function computeBillStats(items: BillItem[], now: Date = new Date()): BillStats {
  const thisKey = currentMonthKey(now);
  const byCustomer = new Map<string, CustomerOption>();
  const months = new Set<string>();
  let thisMonth = 0;
  let unassignedCount = 0;

  for (const it of items) {
    const mk = monthKeyOf(it.billDate);
    if (mk) {
      months.add(mk);
      if (mk === thisKey) thisMonth++;
    }
    if (!it.customerId) unassignedCount++;
    if (it.customerId) {
      const existing = byCustomer.get(it.customerId);
      if (existing) {
        existing.count++;
      } else {
        byCustomer.set(it.customerId, {
          id: it.customerId,
          code: it.customerCode,
          name: it.customerName,
          count: 1,
        });
      }
    }
  }

  return {
    total: items.length,
    customerCount: byCustomer.size,
    unassignedCount,
    thisMonth,
    customerOptions: [...byCustomer.values()].sort(compareCustomerOption),
    monthOptions: [...months].sort((a, b) => b.localeCompare(a)),
  };
}

/**
 * กรองบิลตามลูกค้า + เดือน แล้วเรียงตามวันที่บิล (ใหม่→เก่า)
 *   - customerId = UNASSIGNED_CUSTOMER → เฉพาะบิลที่ยังไม่จับคู่ (customerId null)
 *   - customerId อื่น                 → เฉพาะลูกค้ารายนั้น
 *   - month (YYYY-MM)                  → เฉพาะเดือนนั้น
 */
export function filterBills(items: BillItem[], filter: BillFilter): BillItem[] {
  const { customerId, month, docKind, search } = filter;
  const q = (search ?? "").trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (customerId) {
      if (customerId === UNASSIGNED_CUSTOMER) {
        if (it.customerId) return false;
      } else if (it.customerId !== customerId) {
        return false;
      }
    }
    if (month && monthKeyOf(it.billDate) !== month) return false;
    if (docKind && it.docKind !== docKind) return false;
    if (q) {
      const hay = `${it.customerCode ?? ""} ${it.customerName ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // เรียงใหม่→เก่า ตามวันที่บิล (ค่าว่าง/ผิดรูปไปท้าย)
  return filtered.sort((a, b) => (b.billDate || "").localeCompare(a.billDate || ""));
}

/** จำนวนบิลแยกตามชนิดเอกสารในกลุ่มลูกค้าหนึ่ง (บิล doc_kind=null ไม่เข้าช่องไหน แต่ยังนับใน total) */
export type BillKindCounts = {
  slip: number;
  sale: number;
  handwritten: number;
  purchase: number;
  cash: number;
  other: number;
};

/** กลุ่มบิลของลูกค้า 1 ราย (customerId null = กลุ่ม "ยังไม่จับคู่ลูกค้า") */
export type CustomerBillGroup = {
  /** customer_id (null = ยังไม่จับคู่ — จัดไว้ท้ายสุดเสมอ) */
  customerId: string | null;
  code: string | null;
  name: string | null;
  /** จำนวนบิลรวมในกลุ่ม (รวมรูป + ไฟล์) */
  total: number;
  /** จำนวนแยกตามชนิดเอกสาร (เฉพาะรูปที่คัดชนิดแล้ว) */
  kinds: BillKindCounts;
  /** จำนวน "ไฟล์" (attachment_type='file') ในกลุ่ม — โชว์เป็นป้ายแยก */
  fileCount: number;
  /** วันที่บิลล่าสุดในกลุ่ม (ISO; "" ถ้าไม่มี/ผิดรูป) */
  latestAt: string;
};

function emptyKindCounts(): BillKindCounts {
  return { slip: 0, sale: 0, handwritten: 0, purchase: 0, cash: 0, other: 0 };
}

/**
 * จัดกลุ่มบิลตามลูกค้า แล้วเรียง "จำนวนบิลมาก→น้อย"
 *   - ลูกค้าที่จับคู่แล้ว: เรียง total desc → บิลล่าสุดก่อน → รหัสลูกค้า (natural)
 *   - กลุ่ม "ยังไม่จับคู่" (customerId null): รวมเป็นการ์ดเดียว จัดไว้ท้ายสุดเสมอ (ไม่ว่ามีกี่ใบ)
 *   - kinds: นับแยกตาม doc_kind (บิลที่ doc_kind=null นับใน total แต่ไม่เข้า kinds ใด)
 *   ★ pure — ผู้เรียกต้อง filter (ประเภท/เดือน/ค้นหา) ก่อนแล้วค่อยส่งเข้ามา
 */
export function groupBillsByCustomer(items: BillItem[]): CustomerBillGroup[] {
  const assigned = new Map<string, CustomerBillGroup>();
  let unassigned: CustomerBillGroup | null = null;

  for (const it of items) {
    let g: CustomerBillGroup;
    if (it.customerId) {
      const existing = assigned.get(it.customerId);
      if (existing) {
        g = existing;
      } else {
        g = {
          customerId: it.customerId,
          code: it.customerCode,
          name: it.customerName,
          total: 0,
          kinds: emptyKindCounts(),
          fileCount: 0,
          latestAt: "",
        };
        assigned.set(it.customerId, g);
      }
    } else {
      if (!unassigned) {
        unassigned = {
          customerId: null,
          code: null,
          name: null,
          total: 0,
          kinds: emptyKindCounts(),
          fileCount: 0,
          latestAt: "",
        };
      }
      g = unassigned;
    }
    g.total++;
    if (it.attachmentType === "file") g.fileCount++;
    else if (it.docKind) g.kinds[it.docKind]++;
    const d = it.billDate || "";
    if (d > g.latestAt) g.latestAt = d;
  }

  const sorted = [...assigned.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total; // จำนวนมาก→น้อย
    const t = (b.latestAt || "").localeCompare(a.latestAt || ""); // ล่าสุดก่อน
    if (t !== 0) return t;
    return (a.code ?? "").localeCompare(b.code ?? "", undefined, { numeric: true, sensitivity: "base" });
  });
  if (unassigned) sorted.push(unassigned); // ยังไม่จับคู่ = ท้ายสุดเสมอ
  return sorted;
}

/** ผลลัพธ์แบ่งหน้า */
export type Paged<T> = {
  items: T[];
  /** หน้าปัจจุบัน (เริ่ม 1) หลัง clamp ให้อยู่ในช่วง */
  page: number;
  /** จำนวนหน้าทั้งหมด (อย่างน้อย 1) */
  totalPages: number;
  /** จำนวนรายการทั้งหมดก่อนตัดหน้า */
  totalItems: number;
};

/** แบ่งหน้า (clamp page ให้อยู่ในช่วง 1..totalPages) */
export function paginate<T>(items: T[], page: number, pageSize: number): Paged<T> {
  const size = Math.max(1, pageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (safePage - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: safePage,
    totalPages,
    totalItems,
  };
}
