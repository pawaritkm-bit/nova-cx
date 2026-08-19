/**
 * locked-note.ts — ไฟล์โน้ต "ใส่รหัสผ่าน" สำหรับสเตทเมนต์ที่ติดรหัส (LINE sale OA)
 *
 * flow: auto-read เจอไฟล์ติดรหัสแต่ไม่มีรหัสในแชท → วางไฟล์โน้ตนี้ในโฟลเดอร์ลูกค้า
 *   → นักบัญชีพิมพ์รหัสในไฟล์ → cron `retry-locked` ค้นเจอ (ชื่อมี NOTE_MARKER) → ปลด+อ่าน+ลบโน้ต
 *
 * ★ แยกเป็น module กลาง เพื่อให้ "ผู้เขียนโน้ต" (auto-read) กับ "ผู้อ่านโน้ต" (retry cron) ตกลงรูปแบบตรงกัน
 */

/** คำในชื่อไฟล์โน้ต — ใช้ Graph search หา (ต้องไม่ซ้ำคำทั่วไป) */
export const NOTE_MARKER = "ใส่รหัสที่นี่";

/** เส้นคั่น: ทุกอย่างใต้บรรทัดนี้ = รหัสที่นักบัญชีพิมพ์ */
const SEP = "=========== พิมพ์รหัสใต้บรรทัดนี้ ===========";

/** ชื่อไฟล์โน้ตในโฟลเดอร์ลูกค้า (base = ชื่อไฟล์ต้นฉบับไม่รวมนามสกุล) */
export function lockedNoteFileName(base: string): string {
  return `🔑 ${NOTE_MARKER} - ${base}.txt`;
}

/** เนื้อไฟล์โน้ต (คำแนะนำ + ที่ให้พิมพ์รหัส) */
export function buildLockedNoteContent(sourceFileName: string): string {
  return [
    "📌 ไฟล์นี้ล็อกด้วยรหัสผ่าน ระบบเปิดอ่านอัตโนมัติไม่ได้ (ไม่พบรหัสในแชทลูกค้า)",
    "",
    "วิธีให้ระบบอ่านให้อัตโนมัติ:",
    "   1) พิมพ์รหัสผ่านของไฟล์ ใต้เส้นด้านล่าง (บรรทัดเดียว)",
    "   2) บันทึกไฟล์นี้",
    "   3) ระบบจะอ่านสเตทเมนต์ให้ภายใน ~10 นาที แล้วลบไฟล์นี้ทิ้ง + ติด ✅ ที่ไฟล์ต้นฉบับ",
    "",
    `ไฟล์ต้นฉบับ: ${sourceFileName}`,
    SEP,
    "",
  ].join("\r\n");
}

/** ข้อความแจ้งเมื่อรหัสที่พิมพ์มาเปิดไม่ได้ (เขียนทับโน้ตเดิม ให้ลองใหม่) */
export function buildWrongPasswordNote(sourceFileName: string): string {
  return [
    "❌ รหัสที่พิมพ์มาเปิดไฟล์ไม่ได้ กรุณาตรวจสอบแล้วพิมพ์ใหม่ใต้เส้นด้านล่าง",
    "",
    `ไฟล์ต้นฉบับ: ${sourceFileName}`,
    SEP,
    "",
  ].join("\r\n");
}

/**
 * แกะโน้ต → ชื่อไฟล์ต้นฉบับ + รหัสผู้สมัคร (บรรทัด/โทเคนใต้เส้นคั่น)
 *   ข้ามบรรทัดที่เป็นเส้น/ช่องว่างล้วน · คืน passwords=[] ถ้ายังไม่พิมพ์รหัส
 */
export function parseLockedNote(content: string): { sourceFileName: string | null; passwords: string[] } {
  const srcM = /ไฟล์ต้นฉบับ:\s*(.+)/.exec(content);
  const sourceFileName = srcM ? srcM[1].trim() : null;
  const idx = content.indexOf(SEP);
  const tail = idx >= 0 ? content.slice(idx + SEP.length) : "";
  const passwords: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const v = s.trim();
    if (v && v.length <= 64 && !/^[=\-–\s]+$/.test(v) && !seen.has(v)) {
      seen.add(v);
      passwords.push(v);
    }
  };
  for (const line of tail.split(/\r?\n/)) {
    add(line); // ทั้งบรรทัด (เผื่อรหัสมีช่องว่าง)
    for (const tok of line.split(/\s+/)) add(tok); // แต่ละโทเคน
  }
  return { sourceFileName, passwords };
}
