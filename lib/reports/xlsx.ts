/**
 * ตัวสร้างไฟล์ .xlsx จริง แบบ "ไม่พึ่ง dependency" (Phase 5b — ปิดหนี้ XLSX export)
 *
 * เหตุผลที่เขียนเอง (ไม่เพิ่ม lib):
 *   - .xlsx = ไฟล์ ZIP ที่ห่อ XML ตามสเปก OpenXML (SpreadsheetML)
 *   - ต้องการ dependency น้อยสุด + เชื่อถือได้ + unit test ได้ (มาตรฐานทีม §1/§4)
 *   - เราสร้าง ZIP แบบ "stored" (ไม่บีบอัด) เอง โดยใช้ CRC32 + local/central header
 *     → ไฟล์เปิดได้จริงใน Excel/Google Sheets/LibreOffice
 *
 * ★ ใช้ inlineStr สำหรับ cell ข้อความ (เลี่ยง sharedStrings ที่ซับซ้อน) และ number cell
 *   ปกติ — ครอบคลุมรายงานประเมิน (ข้อความไทย + ตัวเลข)
 */

// ---------------------------------------------------------------------
// CRC32 (ต้องมีแม้ ZIP แบบ stored) — table-based
// ---------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------
// XML escape (สำหรับ inline string) — กัน & < > " ' ทำ XML พัง
// ---------------------------------------------------------------------
export function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------
// โครงข้อมูล worksheet
// ---------------------------------------------------------------------
export type XlsxCell = string | number | null | undefined;
export type XlsxRow = XlsxCell[];
export type XlsxSheet = {
  /** ชื่อชีต (Excel จำกัด 31 ตัวอักษร, ห้าม : \ / ? * [ ]) */
  name: string;
  rows: XlsxRow[];
};

/** แปลง index คอลัมน์ (0-based) → ตัวอักษร Excel (A, B, ..., Z, AA, ...) */
export function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** ทำชื่อชีตให้ถูกกติกา Excel (ตัดอักขระต้องห้าม + จำกัด 31 ตัว) */
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim() || "Sheet1";
  return cleaned.slice(0, 31);
}

/** สร้าง XML ของ 1 worksheet (inlineStr สำหรับข้อความ, number สำหรับตัวเลข) */
function sheetXml(sheet: XlsxSheet): string {
  const rowsXml = sheet.rows
    .map((row, rIdx) => {
      const cellsXml = row
        .map((cell, cIdx) => {
          const ref = `${colLetter(cIdx)}${rIdx + 1}`;
          if (cell === null || cell === undefined || cell === "") {
            return "";
          }
          if (typeof cell === "number" && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          const text = escapeXml(String(cell));
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join("");
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml}</sheetData></worksheet>`
  );
}

/** ประกอบ XML ส่วนกลางของ workbook จากรายชื่อชีต */
function buildParts(sheets: XlsxSheet[]): Record<string, string> {
  const safeSheets = sheets.map((s, i) => ({
    ...s,
    name: sanitizeSheetName(s.name || `Sheet${i + 1}`),
  }));

  const sheetEntries = safeSheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");

  const workbookRels = safeSheets
    .map(
      (_s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("");

  const overrides = safeSheets
    .map(
      (_s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("");

  const parts: Record<string, string> = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      overrides +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheetEntries}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      workbookRels +
      `</Relationships>`,
  };

  safeSheets.forEach((s, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s);
  });

  return parts;
}

// ---------------------------------------------------------------------
// ZIP writer (stored / ไม่บีบอัด) — พอสำหรับไฟล์ XML ขนาดเล็ก
// ---------------------------------------------------------------------
type ZipEntry = { name: string; data: Buffer; crc: number; offset: number };

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(parts: Record<string, string>): Buffer {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const entries: ZipEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const [name, xml] of Object.entries(parts)) {
    const data = Buffer.from(xml, "utf8");
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size (= size for stored)
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    entries.push({ name, data, crc, offset });
    chunks.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }

  // central directory
  const centralChunks: Buffer[] = [];
  let centralSize = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(e.offset, 42); // offset of local header
    centralChunks.push(central, nameBuf);
    centralSize += central.length + nameBuf.length;
  }

  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8); // entries on disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...centralChunks, end]);
}

/**
 * สร้าง buffer ของไฟล์ .xlsx จากชุด worksheet
 *   - อย่างน้อยต้องมี 1 ชีต (ถ้าไม่ส่ง จะสร้างชีตว่างชื่อ Sheet1)
 */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const sheetsToUse = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }];
  const parts = buildParts(sheetsToUse);
  return buildZip(parts);
}

/** MIME type มาตรฐานของ .xlsx (ใช้ตอบ response) */
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
