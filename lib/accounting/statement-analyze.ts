/**
 * วิเคราะห์รายการสเตทเมนต์ (bank statement) — pure helpers (ทดสอบได้ ไม่แตะ DB/network)
 *
 * ใช้กับฟีเจอร์ "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (Phase 1) — รับลิสต์ธุรกรรมที่ AI สกัดมาแล้ว
 * แล้วจัดกลุ่ม:
 *   1) สรุปรายเดือน (ยอดเข้ารวม/ออกรวม + จำนวนรายการ) — เดือนตัดตามเวลาไทย (Asia/Bangkok)
 *   2) จับคู่คนที่โอนเข้า/ออก "ซ้ำ" (>= MIN_REPEAT ครั้ง) — group by ชื่อคู่ค้า (normalize)
 *
 * ★ PDPA: ที่นี่ไม่ log อะไรเลย (รับ/คืน plain value) — caller เป็นคน gate สิทธิ์
 */

/** ทิศทางเงิน: in=เงินเข้า/ฝาก · out=เงินออก/ถอน */
export type TxnDirection = "in" | "out";

/** 1 ธุรกรรมในสเตทเมนต์ (ช่องที่ AI ไม่มั่นใจ = null) */
export type StatementTxn = {
  /** วันที่ 'YYYY-MM-DD' (ค.ศ.) หรือ timestamp ISO · null = อ่านไม่ได้ */
  date: string | null;
  description: string | null;
  /** ชื่อคู่ค้า (คนโอนเข้า/ผู้รับโอน) · null = ระบุไม่ได้ */
  counterparty_name: string | null;
  /** ★ 2026-08-12 (แก้บั๊ก B) — เลขบัญชี/เลขที่บัตรของคู่ค้า ตามที่สเตทเมนต์แสดง (อาจปิดบังบางส่วน เช่น
   *  "x-xxxx-x1234-x") ใช้แม่นกว่าชื่ออย่างเดียวตอนจับกลุ่มคนโอนซ้ำ · null = ไม่มี/อ่านไม่ได้ */
  counterparty_account_no: string | null;
  /** in/out · null = ระบุทิศทางไม่ได้ (ไม่นับในสรุป) */
  direction: TxnDirection | null;
  /** ยอดเงิน (บวกเสมอ) · null = อ่านตัวเลขไม่ได้ */
  amount: number | null;
  /** ★ 2026-09-01 — เวลาโอน 'HH:MM' ตามที่พิมพ์ในสเตทเมนต์ · ไม่มี/อ่านไม่ได้ = null/undefined
   *  (optional เพื่อ backward-compat กับผล AI/ไฟล์เดิมที่ไม่มี field นี้) */
  time?: string | null;
  /** ★ 2026-09-02 — ยอดคงเหลือ "หลังรายการนี้" จากคอลัมน์ balance ของสเตทเมนต์ (deterministic เท่านั้น
   *  — AI/ไฟล์เดิมไม่มี = null/undefined) ใช้คำนวณยอดยกมา/ยกไปต่อเดือน */
  balance?: number | null;
};

/** จำนวนครั้งขั้นต่ำที่ถือว่า "โอนซ้ำ" (ลูกค้าประจำ/จ่ายประจำ) */
export const MIN_REPEAT = 2;

/** สรุปยอดต่อเดือน */
export type MonthlySummary = {
  /** 'YYYY-MM' (เวลาไทย) */
  month: string;
  inTotal: number;
  outTotal: number;
  inCount: number;
  outCount: number;
  /** จำนวนรายการทั้งหมดของเดือน (รวมที่ระบุทิศทางไม่ได้) */
  count: number;
  /** ★ 2026-09-02 — ยอดยกมา (ต้นงวด) / ยอดยกไป (ปลายงวด) จากคอลัมน์ balance ของสเตทเมนต์
   *  · null = รายการเดือนนี้ไม่มี balance ติดมา (เช่นอ่านด้วย AI) — UI fallback โชว์สุทธิแบบเดิม
   *  ยกไป = balance ของรายการ "ล่าสุด" ของเดือน (เรียง วันที่ → เวลา → ลำดับที่เจอ)
   *  ยกมา = ยกไป − (เข้า − ออก) ของเดือน (สมการ balance chain — ไม่ต้องพึ่งรายการแรก) */
  openBalance: number | null;
  closeBalance: number | null;
};

/** คู่ค้าที่โอนซ้ำ (ต่อทิศทาง) */
export type RepeatParty = {
  /** ชื่อที่ใช้แสดง (original ที่พบบ่อยสุดในกลุ่ม) */
  name: string;
  /** ★ 2026-08-12 — เลขบัญชีที่ใช้แสดง (original ที่พบบ่อยสุดในกลุ่ม) · null = ไม่มีเลขบัญชีเลยในกลุ่มนี้ */
  accountNo: string | null;
  direction: TxnDirection;
  count: number;
  total: number;
};

/**
 * normalize ชื่อคู่ค้าเพื่อ "จับคู่ซ้ำ" — ให้ชื่อที่เป็นคนเดียวกันแต่พิมพ์ต่างเล็กน้อยจับเข้ากลุ่มเดียว
 *   - ตัดคำนำหน้าไทย (นาย/นาง/นางสาว/น.ส./ด.ช./ด.ญ.) + คำนำหน้า transfer (โอนจาก/โอนไป/รับโอนจาก ฯลฯ)
 *   - ยุบช่องว่างซ้ำ/ตัดวรรคตอนหัวท้าย · latin → ตัวพิมพ์เล็ก
 *   คืน "" ถ้าเหลือแต่ค่าว่าง (caller ข้าม — จับคู่ไม่ได้)
 */
export function normalizeCounterparty(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // ตัดคำนำหน้าที่เป็น "กริยาโอน" ที่ธนาคารมักเติมหน้าชื่อ
  s = s.replace(/^(รับโอนจาก|โอนเงินจาก|โอนเงินไป|โอนจาก|โอนไป|เงินโอนจาก|ค่าโอนจาก|from|to)\s*/i, "");
  // ตัดคำนำหน้าชื่อบุคคล
  s = s.replace(/^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, "");
  // ยุบช่องว่าง (รวม tab/newline) + ตัดวรรคตอนหัวท้าย
  s = s.replace(/\s+/g, " ").replace(/^[\s.,\-–—:]+|[\s.,\-–—:]+$/g, "").trim();
  return s.toLowerCase();
}

/** ความยาวขั้นต่ำ (หลัง normalize) ที่ถือว่าเป็นเลขบัญชีจริง — กันตัวเลข/ขยะสั้น ๆ จับคู่มั่ว */
const MIN_ACCOUNT_DIGITS = 6;

/**
 * normalize เลขบัญชีเพื่อ "จับคู่ซ้ำ" — เก็บเฉพาะตัวเลข/x (ตัวปิดบังที่ธนาคารใส่ เช่น "x-xxxx-x1234-x")
 *   ตัดขีด/วรรค/สัญลักษณ์อื่นทิ้ง แล้วเทียบตรง ๆ (ธนาคารเดียวกัน mask รูปแบบเดิมซ้ำสำหรับบัญชีเดียวกันเสมอ)
 *   คืน "" ถ้าสั้นกว่า MIN_ACCOUNT_DIGITS (ไม่น่าเชื่อถือพอจะใช้จับคู่)
 */
export function normalizeAccountNo(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/[^0-9x]/g, "");
  return s.length >= MIN_ACCOUNT_DIGITS ? s : "";
}

/**
 * เดือน 'YYYY-MM' ตามเวลาไทย (Asia/Bangkok, UTC+7)
 *   - 'YYYY-MM-DD' (ไม่มีเวลา) = วันที่ตามปฏิทินอยู่แล้ว → ตัดเอา YYYY-MM ตรง ๆ
 *   - timestamp ISO (มี T/Z/offset) = แปลงเป็นเวลาไทยก่อนแล้วค่อยตัดเดือน (กันคร่อมวันตอนเที่ยงคืน)
 *   คืน null ถ้า parse ไม่ได้
 */
export function bkkMonthKey(date: string | null | undefined): string | null {
  const d = (date ?? "").trim();
  if (!d) return null;
  // วันที่ล้วน (ปฏิทิน) — ไม่ต้องขยับ timezone
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (plain) return `${plain[1]}-${plain[2]}`;
  // timestamp — เลื่อนไปเวลาไทยแล้วอ่าน UTC parts
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  const bkk = new Date(t + 7 * 60 * 60 * 1000);
  const y = bkk.getUTCFullYear();
  const m = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** ยอดเงินที่ใช้ได้ (บวก) — null/ผิดปกติ = 0 */
function safeAmount(v: number | null): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * สรุปยอดต่อเดือน (เวลาไทย) — เรียงเดือนล่าสุดก่อน
 *   รายการที่ไม่มีวันที่/parse ไม่ได้ → รวมไว้ในกลุ่ม "ไม่ระบุเดือน" (month='')
 */
export function summarizeByMonth(txns: StatementTxn[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary>();
  // รายการ "ล่าสุด" ที่มี balance ต่อเดือน (คีย์เรียง: วันที่|เวลา|ลำดับที่เจอ — ลำดับที่เจอกันเคสวันเวลาซ้ำ)
  const lastBal = new Map<string, { sortKey: string; balance: number }>();
  let seq = 0;
  for (const t of txns) {
    const key = bkkMonthKey(t.date) ?? "";
    let row = map.get(key);
    if (!row) {
      row = { month: key, inTotal: 0, outTotal: 0, inCount: 0, outCount: 0, count: 0, openBalance: null, closeBalance: null };
      map.set(key, row);
    }
    row.count += 1;
    const amt = safeAmount(t.amount);
    if (t.direction === "in") {
      row.inTotal += amt;
      row.inCount += 1;
    } else if (t.direction === "out") {
      row.outTotal += amt;
      row.outCount += 1;
    }
    if (typeof t.balance === "number" && Number.isFinite(t.balance)) {
      const sortKey = `${t.date ?? ""}|${t.time ?? "00:00"}|${String(seq).padStart(8, "0")}`;
      const cur = lastBal.get(key);
      if (!cur || sortKey > cur.sortKey) lastBal.set(key, { sortKey, balance: t.balance });
    }
    seq += 1;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const [key, row] of map) {
    const lb = lastBal.get(key);
    if (lb) {
      row.closeBalance = r2(lb.balance);
      row.openBalance = r2(lb.balance - (row.inTotal - row.outTotal));
    }
  }
  // เรียงเดือนใหม่→เก่า · กลุ่ม "ไม่ระบุเดือน" ('') ไว้ท้ายสุด
  return [...map.values()].sort((a, b) => {
    if (a.month === b.month) return 0;
    if (!a.month) return 1;
    if (!b.month) return -1;
    return a.month < b.month ? 1 : -1;
  });
}

/** original value ที่พบบ่อยสุดใน map (tie → ยาวกว่า = มีข้อมูลมากกว่า) · "" ถ้า map ว่าง */
function pickMostCommon(m: Map<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [v, n] of m) {
    if (n > bestN || (n === bestN && v.length > best.length)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * จับคู่ "คนโอนซ้ำ" — group by เลขบัญชี (ถ้ามี) เป็นหลัก, ชื่อคู่ค้า (normalize) เป็นรอง แยกทิศทาง
 *   ★★★ 2026-08-12 (แก้บั๊ก B — จับกลุ่มด้วยชื่ออย่างเดียวไม่แม่น) — ลำดับความสำคัญ:
 *   1) ถ้าธุรกรรมมีเลขบัญชี (normalize แล้วยาวพอ) → จับกลุ่มด้วยเลขบัญชีตรง ๆ (แม่นสุด ไม่มีปัญหาสะกดชื่อต่างกัน)
 *   2) ถ้าธุรกรรมไม่มีเลขบัญชีในแถวนั้น แต่ชื่อคู่ค้า (normalize) เคยปรากฏคู่กับเลขบัญชี "เดียว" เท่านั้นตลอด
 *      ทั้งไฟล์ (ทิศทางเดียวกัน — ไม่เคยเจอคู่กับเลขบัญชีอื่นเลย) → ผูกเข้ากลุ่มเลขบัญชีนั้นแทน (คนเดียวกัน
 *      แค่บางแถวไม่โชว์เลขบัญชี) — ★ ถ้าชื่อนี้เคยจับคู่กับเลขบัญชี **มากกว่า 1 เลข** (กำกวม — อาจเป็นคนละคนที่
 *      ชื่อซ้ำกันโดยบังเอิญ) จะไม่ผูกอัตโนมัติเด็ดขาด (ไม่เดา/ไม่โหวตเลือกเลขที่พบบ่อยสุด) กันเชื่อมผิดกลุ่มเงียบ ๆ
 *      (พบจาก independent review — เดิมใช้วิธี "โหวตเลือกเลขที่พบบ่อยสุด" ซึ่งกรณีกำกวมจริงจะเดาแบบไม่มีเหตุผล
 *      ทางธุรกิจรองรับ และไม่มีสัญญาณเตือนผู้ใช้เลย)
 *   3) ไม่มีทั้งเลขบัญชีและการเชื่อมโยง (หรือกำกวมตามข้อ 2) → fallback กลับไป group ด้วยชื่ออย่างเดียวเหมือนเดิม
 *      (backward compatible 100% กับสเตทเมนต์ที่ไม่มีเลขบัญชีเลย)
 *   คืนเฉพาะกลุ่มที่ count >= MIN_REPEAT · เรียงจำนวนครั้งมาก→น้อย แล้วยอดรวมมาก→น้อย
 *   ★ รายการที่ไม่มีทั้งชื่อคู่ค้าและเลขบัญชี/ระบุทิศทางไม่ได้ = ข้าม (จับคู่ไม่ได้)
 */
export function findRepeatCounterparties(txns: StatementTxn[]): RepeatParty[] {
  // ผ่านรอบแรก: หาว่าชื่อ (normalize) ไหนผูกกับเลขบัญชีไหนบ่อยที่สุด (โหวตจากแถวที่มีทั้งคู่)
  const nameToAcctVotes = new Map<string, Map<string, number>>(); // key: `${direction} ${nameNorm}`
  for (const t of txns) {
    if (t.direction !== "in" && t.direction !== "out") continue;
    const nameNorm = normalizeCounterparty(t.counterparty_name);
    const acctNorm = normalizeAccountNo(t.counterparty_account_no);
    if (!nameNorm || !acctNorm) continue;
    const key = `${t.direction} ${nameNorm}`;
    let votes = nameToAcctVotes.get(key);
    if (!votes) {
      votes = new Map();
      nameToAcctVotes.set(key, votes);
    }
    votes.set(acctNorm, (votes.get(acctNorm) ?? 0) + 1);
  }
  // ★ ผูกชื่อ↔เลขบัญชีอัตโนมัติเฉพาะกรณีไม่กำกวมเท่านั้น (ชื่อนี้เจอคู่กับเลขบัญชีเดียวตลอดทั้งไฟล์) — ถ้าเจอ
  //   มากกว่า 1 เลขบัญชีที่ต่างกันจริง (votes.size > 1) ถือว่ากำกวม ไม่เดา/ไม่โหวตเลือก ปล่อย fallback ไปกลุ่มชื่อ
  const bestAcctForName = new Map<string, string>();
  for (const [key, votes] of nameToAcctVotes) {
    if (votes.size !== 1) continue; // กำกวม (0 ไม่เกิดขึ้นจริงเพราะเข้า map ได้ต้องมีอย่างน้อย 1 vote)
    const [onlyAcct] = votes.keys();
    bestAcctForName.set(key, onlyAcct);
  }

  // ผ่านรอบสอง: จัดกลุ่มจริง — เลขบัญชีตรง ๆ > เลขบัญชีที่ผูกจากชื่อ > ชื่ออย่างเดียว
  type Agg = {
    direction: TxnDirection;
    count: number;
    total: number;
    names: Map<string, number>;
    accountNos: Map<string, number>;
  };
  const map = new Map<string, Agg>();

  for (const t of txns) {
    if (t.direction !== "in" && t.direction !== "out") continue;
    const nameNorm = normalizeCounterparty(t.counterparty_name);
    let acctNorm = normalizeAccountNo(t.counterparty_account_no);
    if (!acctNorm && nameNorm) {
      acctNorm = bestAcctForName.get(`${t.direction} ${nameNorm}`) ?? "";
    }
    if (!acctNorm && !nameNorm) continue; // จับคู่ไม่ได้ทั้งชื่อและเลขบัญชี

    const groupKey = acctNorm ? `${t.direction} acct:${acctNorm}` : `${t.direction} name:${nameNorm}`;
    let agg = map.get(groupKey);
    if (!agg) {
      agg = { direction: t.direction, count: 0, total: 0, names: new Map(), accountNos: new Map() };
      map.set(groupKey, agg);
    }
    agg.count += 1;
    agg.total += safeAmount(t.amount);
    const origName = (t.counterparty_name ?? "").trim();
    if (origName) agg.names.set(origName, (agg.names.get(origName) ?? 0) + 1);
    const origAcct = (t.counterparty_account_no ?? "").trim();
    if (origAcct) agg.accountNos.set(origAcct, (agg.accountNos.get(origAcct) ?? 0) + 1);
  }

  const result: RepeatParty[] = [];
  for (const agg of map.values()) {
    if (agg.count < MIN_REPEAT) continue;
    const bestName = pickMostCommon(agg.names);
    const bestAcct = pickMostCommon(agg.accountNos);
    result.push({
      name: bestName || "(ไม่ระบุชื่อ)",
      accountNo: bestAcct || null,
      direction: agg.direction,
      count: agg.count,
      total: agg.total,
    });
  }

  return result.sort((a, b) => b.count - a.count || b.total - a.total);
}
