/**
 * statement-deterministic.ts — อ่านสเตทเมนต์ธนาคาร "ทุกธนาคาร" ด้วยโค้ดล้วน (ไม่ใช้ AI)
 *
 * ★ แนวคิดหลัก (bank-agnostic): ทุกสเตทเมนต์มีคอลัมน์ "ยอดคงเหลือ" (running balance)
 *   → ใช้เลขคณิต `คงเหลือใหม่ − คงเหลือเดิม = ±จำนวนเงิน` จับทั้ง layout + ทิศทาง (เข้า/ออก)
 *   อัตโนมัติ โดยไม่ต้องรู้ว่าธนาคารไหนวางคอลัมน์อย่างไร → รองรับทุกแบงก์ด้วย engine เดียว
 *
 * พิสูจน์แล้วกับ 5 ธนาคาร (กสิกร/ttb/กรุงไทย/KKP/SCB): ยอด reconcile ตรงกับที่ธนาคารสรุปเอง
 *   และสเกลได้ (ทดสอบไฟล์กรุงไทย 1.84MB → 13,285 รายการ)
 *
 * หน้าที่: รับ "ข้อความ" ที่ดึงจาก PDF ดิจิทัลแล้ว → StatementTxn[] (+ ชื่อธนาคาร + ผล reconcile)
 *   ★ ใช้กับ PDF ดิจิทัลที่มี text layer เท่านั้น (สแกน/รูป → ตกไปใช้ AI OCR path เดิม)
 * ★ PDPA: ไม่ log เนื้อสเตทเมนต์/ชื่อ/ยอด
 */
import type { StatementTxn, TxnDirection } from "@/lib/accounting/statement-analyze";

/** ชื่อเดือนไทยย่อ (ไว้เช็ค date "DD mon YY") */
const TH_MON: Record<string, number> = {
  "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
  "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
};
const TH_MON_ALT = "ม\\.ค\\.|ก\\.พ\\.|มี\\.ค\\.|เม\\.ย\\.|พ\\.ค\\.|มิ\\.ย\\.|ก\\.ค\\.|ส\\.ค\\.|ก\\.ย\\.|ต\\.ค\\.|พ\\.ย\\.|ธ\\.ค\\.";

/** จำนวนเงินในข้อความ: ต้องมีทศนิยม .NN เสมอ (กันไปโดนเลขที่บัญชี/รหัสอ้างอิง/รหัสสาขา) */
const MONEY_RE = /-?\d{1,3}(?:,\d{3})*\.\d{2}/g;

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

type MoneyTok = { val: number; neg: boolean };
function moneyTokens(s: string): MoneyTok[] {
  const m = s.match(MONEY_RE);
  if (!m) return [];
  return m.map((x) => ({ val: parseFloat(x.replace(/,/g, "")), neg: x.trim().startsWith("-") }));
}

type ParsedDate = { y: number; m: number; d: number };

/**
 * แปลงวันที่ต้นบรรทัด → {y(ค.ศ.),m,d} · รองรับ DD/MM/YYYY, DD/MM/YY, DD-MM-YY, "DD ม.ค. YY"
 *   ★ ปีตัดสิน พ.ศ./ค.ศ. อัตโนมัติ: 4 หลัก >=2500 → −543 · 2 หลัก >=50 → พ.ศ.(2500+yy−543) ไม่งั้น ค.ศ.(2000+yy)
 */
function parseDate(line: string): ParsedDate | null {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s|$)/))) {
    let y = +m[3];
    if (y >= 2500) y -= 543;
    return { y, m: +m[2], d: +m[1] };
  }
  if ((m = line.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})(?:\s|$)/))) {
    const yy = +m[3];
    const y = yy >= 50 ? 2500 + yy - 543 : 2000 + yy;
    return { y, m: +m[2], d: +m[1] };
  }
  if ((m = line.match(new RegExp(`^(\\d{1,2})\\s+(${TH_MON_ALT})\\s+(\\d{2})(?:\\s|$)`)))) {
    const yy = +m[3];
    const y = yy >= 50 ? 2500 + yy - 543 : 2000 + yy;
    return { y, m: TH_MON[m[2]], d: +m[1] };
  }
  return null;
}

function isoDate(d: ParsedDate): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** หา "ยอดยกมา" (opening balance) จากหัวสเตทเมนต์ — ใช้เป็นจุดตั้งต้นของ balance-delta */
function findOpeningBalance(text: string): number | null {
  const m =
    text.match(/ยอดยกมา[^\d\-]{0,20}(-?\d{1,3}(?:,\d{3})*\.\d{2})/) ||
    text.match(/(-?\d{1,3}(?:,\d{3})*\.\d{2})[^\d\n]{0,6}ยอดยกมา/) ||
    text.match(/BROUGHT\s+FORWARD[^\d\-]{0,20}(-?\d{1,3}(?:,\d{3})*\.\d{2})/i);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

/** เดาชื่อธนาคารไทยมาตรฐานจากหัวสเตทเมนต์ (คำ/โค้ดย่อ) — ไม่รู้จัก → null */
//   ★ strong = ชื่อเต็ม/โดเมนบนหัวจดหมาย (เจ้าของบัญชี) · weak = โค้ดย่อ (KBANK/SCB/BAY…)
//     โค้ดย่อโผล่ใน "รายการคู่ค้า" ด้วย → จับ strong ก่อนเสมอ กันระบุเป็นธนาคารคู่ค้าผิดตัว
//     และห้ามใช้ "กรุงเทพ" เดี่ยว ๆ (ชนที่อยู่ "กรุงเทพฯ")
const BANK_HINTS: { std: string; strong: RegExp; weak: RegExp }[] = [
  { std: "กสิกรไทย", strong: /ธนาคารกสิกร|kasikornbank|k\s?plus/i, weak: /\bkbank\b|kkapi/i },
  { std: "ไทยพาณิชย์", strong: /ไทยพาณิชย์|siam commercial bank/i, weak: /\bscb\b/i },
  { std: "ทหารไทยธนชาต", strong: /ทหารไทยธนชาต|ธนาคารทหารไทย|ทีทีบี|ttbbank|thanachart/i, weak: /\bttb\b|\btmb\b/i },
  { std: "เกียรตินาคินภัทร", strong: /เกียรตินาคิน|kiatnakin|\bdime\b/i, weak: /\bkkp\b/i },
  { std: "กรุงไทย", strong: /ธนาคารกรุงไทย|krungthai|krung thai/i, weak: /\bktb\b/i },
  { std: "กรุงศรีอยุธยา", strong: /ธนาคารกรุงศรี|กรุงศรีอยุธยา|ayudhya|krungsri/i, weak: /\bbay\b/i },
  { std: "ออมสิน", strong: /ธนาคารออมสิน|government savings/i, weak: /\bgsb\b/i },
  { std: "กรุงเทพ", strong: /ธนาคารกรุงเทพ|bangkok bank/i, weak: /\bbbl\b/i },
  { std: "ยูโอบี", strong: /ยูโอบี|united overseas/i, weak: /\buobt?\b/i },
  { std: "ซีไอเอ็มบี ไทย", strong: /ซีไอเอ็มบี|cimb thai/i, weak: /\bcimb\b/i },
];
function detectBank(text: string): string {
  const head = text.slice(0, 1500);
  const tail = text.slice(-1500);
  // pass 1: ชื่อเต็ม/โดเมน (หัวก่อน แล้วท้าย) — แม่นสุด ไม่ชนคู่ค้า
  for (const b of BANK_HINTS) if (b.strong.test(head)) return b.std;
  for (const b of BANK_HINTS) if (b.strong.test(tail)) return b.std;
  // pass 2: โค้ดย่อ (เผื่อหัวจดหมายมีแต่โค้ด) — last resort
  for (const b of BANK_HINTS) if (b.weak.test(head)) return b.std;
  return "ไม่ระบุธนาคาร";
}

/** โค้ดธนาคารย่อ (ปรากฏหน้าเลขบัญชีคู่ค้า เช่น "BBL X9860") — คงตัวพิมพ์ตามที่เห็น */
const BANK_CODE_RE = /\b(KBANK|KBNK|SCB|BBL|KTB|TTB|TMB|BAY|UOB|UOBT|GSB|KKP|CIMB|LHBK|LHBANK|TISCO|BAAC|GHB|TCRB|ICBC|CITI|KTC)\b/i;

/**
 * ประกอบ "คำอธิบายมาตรฐาน" + เลขบัญชีคู่ค้า จากรายละเอียดดิบ ตามสไตล์ NOVA Sales
 *   เข้า → "รับโอนเงินจาก [CODE ]X####" · ออก → "โอนไป [CODE ]X####"
 *   ไม่มีเลขบัญชี: QR → "รับโอนเงินผ่าน QR" · ไม่งั้น = รายละเอียดดิบที่ตัดวันที่/เวลา/ยอดแล้ว
 *   ★ ตัด "ชื่อบุคคล" ทิ้ง จับกลุ่มด้วยเลขบัญชี (ตรงกับ output NOVA Sales + กฎ "ไม่มีชื่อ→เลขบัญชี")
 */
function describe(rawDetail: string, dir: TxnDirection): { description: string; acct: string | null } {
  let clean = rawDetail.replace(/\s+/g, " ").trim();
  // ตัดวันที่/เวลา/รหัสสาขา/รหัสอ้างอิงที่ปนหัวบรรทัด
  clean = clean
    .replace(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\s*/, "")
    .replace(new RegExp(`^\\d{1,2}\\s+(?:${TH_MON_ALT})\\s+\\d{2}\\s*`), "")
    .replace(/^\d{1,2}:\d{2}\s*/, "");

  const codeM = clean.match(BANK_CODE_RE);
  const code = codeM ? codeM[1].toUpperCase() : null;

  // เลขบัญชีคู่ค้า: X#### (masked) · KB###### · เลขยาว ≥4 (mask เป็น X+4ท้าย)
  let acct: string | null = null;
  const xM = clean.match(/\bX\d{3,}\b/i);
  const kbM = clean.match(/\bKB\d{6,}\b/);
  const walletM = clean.match(/\b(?:EWALLETID|MSISDN)\s*(\d{6,})\b/i);
  const longNum = clean.match(/\b\d{9,}\b/);
  if (xM) acct = "X" + xM[0].slice(1);
  else if (kbM) acct = kbM[0];
  else if (walletM) acct = "X" + walletM[1].slice(-4);
  else if (longNum) acct = "X" + longNum[0].slice(-4);

  const isQr = /\bQR\b|thai qr|k shop|myqr|พร้อมเพย์.*ขาย|รับเงินจากการขาย/i.test(clean);
  const isCash = /ฝากเงินสด|เงินสด|\bCDM\b|\bATM\b.*ฝาก|deposit cash/i.test(clean);

  if (acct) {
    const who = code ? `${code} ${acct}` : acct;
    return { description: dir === "in" ? `รับโอนเงินจาก ${who}` : `โอนไป ${who}`, acct };
  }
  if (isQr) return { description: dir === "in" ? "รับโอนเงินผ่าน QR" : "ชำระเงินผ่าน QR", acct: null };
  if (isCash) return { description: dir === "in" ? "ฝากเงินสด" : "ถอนเงินสด", acct: null };
  // ไม่มีเลขบัญชี/QR/เงินสด → คืนรายละเอียดดิบ แต่ตัด "ยอดเงิน/รหัสอ้างอิง/เวลา" ที่ปนมา ให้อ่านสะอาด
  const memo = clean
    .replace(/-?\d{1,3}(?:,\d{3})*\.\d{2}/g, "")           // ตัดยอดเงิน/คงเหลือที่ปน
    .replace(/รหัสอ้างอิง\s*\S+/g, "")                      // ตัด "รหัสอ้างอิง XXX"
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, "")               // ตัดเวลา
    .replace(/\s+/g, " ")
    .trim();
  return { description: memo.slice(0, 50) || (dir === "in" ? "รับเงินเข้า" : "โอนออก"), acct: null };
}

/** เดาทิศทางจากคำในรายการ (ไว้ bootstrap opening ของสเตทเมนต์ที่ไม่พิมพ์ยอดยกมา) */
function dirHint(text: string): TxnDirection | null {
  if (/รับโอน|เงินเข้า|เงินโอนเข้า|ฝากเงิน|รับเงิน|ดอกเบี้ย|เงินปันผล|\bcredit\b|\bdeposit\b/i.test(text)) return "in";
  if (/โอนเงิน|โอนออก|โอนไป|ถอนเงิน|ถอน|จ่าย|ชำระ|\bwithdraw|\bdebit\b/i.test(text)) return "out";
  return null;
}

export type DeterministicParseResult = {
  transactions: StatementTxn[];
  bank: string;
  /** จำนวนแถวที่ประกอบได้ทั้งหมด (ก่อนคัดที่ไม่ใช่ธุรกรรม) */
  recordCount: number;
  /** สัดส่วนแถวที่ยอดคงเหลือไล่ต่อกันได้ (0–1) — ใกล้ 1 = มั่นใจสูง */
  reconcileRatio: number;
  /** true = มีรายการ + reconcile ผ่าน (≥0.9) → เชื่อถือได้สูง · false → caller ควร fallback AI */
  fullyReconciled: boolean;
};

/**
 * อ่านสเตทเมนต์จากข้อความ (PDF ดิจิทัลที่ดึง text แล้ว) แบบ deterministic
 *   คืน [] เมื่อจับรูปแบบไม่ได้เลย (caller ตกไปใช้ AI แทน)
 */
export function parseStatementDeterministic(text: string): DeterministicParseResult {
  const bank = detectBank(text);
  const lines = (text ?? "").split(/\r?\n/);

  // 1) ประกอบเป็น "แถว" — แถวใหม่เริ่มเมื่อบรรทัดขึ้นต้นด้วยวันที่ · บรรทัดอื่นต่อท้ายแถวปัจจุบัน
  //   ★ กันหัวหน้า/ท้ายหน้า (ซ้ำทุกหน้า) มาปนเป็นธุรกรรม:
  //     - บรรทัด "ช่วงวันที่" (DD/MM/YYYY - DD/MM/YYYY) = หัวสเตทเมนต์ ไม่ใช่ธุรกรรม → ไม่เริ่มแถว
  //     - แถวที่มีคีย์เวิร์ดหัว/สรุป (ยอดยกมา/ยอดยกไป/รวมถอน/PAGE...) → คัดทิ้งภายหลัง
  const RANGE_LINE = /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\s*(?:[-–]|ถึง)\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/;
  const HEADER_KW =
    /รอบระหว่างวันที่|เลขที่บัญชี|เลขที่อ้างอิง|สาขาเจ้าของบัญชี|ยอดยกไป|ยอดยกมา|รวมถอนเงิน|รวมฝากเงิน|BROUGHT\s+FORWARD|TOTAL\s+AMOUNT|OUTSTANDING\s+BALANCE|PAGE\s?\/\s?OF|หน้าที่\s*\(/i;
  type Rec = { date: ParsedDate; text: string };
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (const ln of lines) {
    if (RANGE_LINE.test(ln)) { if (cur) { recs.push(cur); cur = null; } continue; } // ช่วงวันที่ = หัว → ปิดแถวเดิม ไม่เริ่มใหม่
    if (HEADER_KW.test(ln)) { if (cur) { recs.push(cur); cur = null; } continue; } // หัว/ท้าย/สรุป → ปิดแถว "ไม่ต่อท้าย" (กันยอดสรุปปนแถวสุดท้าย)
    const d = parseDate(ln);
    if (d) {
      if (cur) recs.push(cur);
      cur = { date: d, text: ln };
    } else if (cur) {
      cur.text += " " + ln;
    }
  }
  if (cur) recs.push(cur);

  // 2) ล็อก "ตำแหน่งคอลัมน์ยอดคงเหลือ" ของทั้งไฟล์ (first หรือ last money token)
  //   ★ ทำไมต้องล็อก: สมการแถวเดียว `prev − x = y` กำกวมได้ (ถ้า prev = amount + balance พอดี ทั้งสอง
  //     token ก็สอดคล้องหมด → greedy เลือกผิด → running balance หลุด sync ทั้งไฟล์)
  //     แก้ด้วยการดูทั้งไฟล์ว่าคอลัมน์ไหนเป็น "ยอดคงเหลือที่ไล่ต่อกันได้" (chain-consistency) แล้วล็อกไว้
  //   กสิกร = balance อยู่ token แรก · ธนาคารอื่นส่วนใหญ่ = token สุดท้าย → ตรวจเองต่อไฟล์
  const opening = findOpeningBalance(text);
  const rows = recs
    .map((r) => ({ date: r.date, text: r.text, toks: moneyTokens(r.text) }))
    .filter((r) => r.toks.length >= 2);

  // ★ บางธนาคาร (ttb ฯลฯ) เรียง "ใหม่→เก่า" (reverse chronological) → balance ไล่ถอยหลัง ทำให้
  //   ทิศทาง in/out กลับด้าน · ตรวจจากวันที่แถวแรกเทียบแถวสุดท้าย ถ้าถอยหลัง → พลิกลำดับให้เป็น เก่า→ใหม่
  if (rows.length >= 2) {
    const first = isoDate(rows[0].date);
    const last = isoDate(rows[rows.length - 1].date);
    if (first > last) rows.reverse();
  }

  const balAt = (toks: MoneyTok[], pos: "first" | "last") => (pos === "first" ? toks[0].val : toks[toks.length - 1].val);

  function scorePos(pos: "first" | "last"): number {
    let prev = opening;
    let score = 0;
    for (const r of rows) {
      const bal = balAt(r.toks, pos);
      if (prev != null) {
        const delta = Math.abs(bal - prev);
        // ต้องมี token อื่นในแถว (ไม่ใช่คอลัมน์ balance) ที่ = |Δbalance| → แถวนี้ "ไล่ต่อกันได้"
        const ok = delta > 0.001 && r.toks.some((t, i) => {
          const isBalCol = pos === "first" ? i === 0 : i === r.toks.length - 1;
          return !isBalCol && Math.abs(Math.abs(t.val) - delta) < 0.01;
        });
        if (ok) score++;
      }
      prev = bal;
    }
    return score;
  }

  const sFirst = scorePos("first");
  const sLast = scorePos("last");
  const pos: "first" | "last" = sFirst > sLast ? "first" : "last";
  // สัดส่วนแถวที่ "ยอดคงเหลือไล่ต่อกันได้" (|Δbalance| = จำนวนเงินที่ปรากฏในแถว) — สัญญาณ reconcile
  //   ★ ใกล้ 1.0 = สเตทเมนต์มีคอลัมน์คงเหลือจริง + อ่านถูก layout · ต่ำ = แบงก์แปลก/ไม่มีคอลัมน์คงเหลือ
  const reconcileRatio = rows.length > 1 ? Math.max(sFirst, sLast) / (rows.length - 1) : 0;

  // 3) หา opening ตั้งต้น — ถ้าสเตทเมนต์ไม่พิมพ์ "ยอดยกมา" ลอง bootstrap จากแถวแรก
  //    (amount = token ที่ไม่ใช่คอลัมน์ balance + ทิศทางจากคำในแถว) → opening = bal ∓ amount
  //    ทำให้ไม่ต้องทิ้งแถวแรก และไล่ balance ได้ครบทั้งไฟล์
  let prev = opening;
  if (prev == null && rows.length > 0 && rows[0].toks.length === 2) {
    const bal0 = balAt(rows[0].toks, pos);
    const other = Math.abs(pos === "last" ? rows[0].toks[0].val : rows[0].toks[1].val);
    const hint = dirHint(rows[0].text);
    if (hint && other > 0) prev = round2(hint === "in" ? bal0 - other : bal0 + other);
  }

  // 4) เดินไล่ balance ตามคอลัมน์ที่ล็อก → amount = |Δbalance|, direction = ทิศของ Δ (ไม่กำกวม)
  const txns: StatementTxn[] = [];
  let firstSkipped = false;

  for (const r of rows) {
    const bal = balAt(r.toks, pos);
    if (prev == null) { prev = bal; firstSkipped = true; continue; } // ไม่มี opening + เดาไม่ได้ → ตั้งต้นจากแถวแรก (เสียแถวแรก)
    const amount = round2(Math.abs(bal - prev));
    const dir: TxnDirection = bal >= prev ? "in" : "out";
    prev = bal;
    if (amount <= 0) continue;
    const { description, acct } = describe(r.text, dir);
    txns.push({
      date: isoDate(r.date),
      description,
      counterparty_name: null, // จับกลุ่มด้วยเลขบัญชี (ตรง output NOVA Sales)
      counterparty_account_no: acct,
      direction: dir,
      amount,
    });
  }

  return {
    transactions: txns,
    bank,
    recordCount: recs.length,
    reconcileRatio: Math.min(1, reconcileRatio),
    // เชื่อถือได้สูงเมื่อ (1) มีรายการ (2) ยอดคงเหลือไล่ต่อกันได้เกือบทุกแถว (≥0.9)
    //   ★ ถ้าไม่ผ่าน = แบงก์ที่ยังไม่เคยเห็น/layout แปลก → caller ควรตกไปให้ AI อ่านแทน (กันผลผิดเงียบ)
    fullyReconciled: txns.length > 0 && !firstSkipped && reconcileRatio >= 0.9,
  };
}
