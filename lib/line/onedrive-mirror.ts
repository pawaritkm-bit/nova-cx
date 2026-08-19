/**
 * onedrive-mirror.ts — สำเนาไฟล์จากแชท LINE OA "sale" (สำนักงานบัญชี Finovas) ไป OneDrive
 *   แยกโฟลเดอร์ตาม "ชื่อไลน์ลูกค้า" ให้นักบัญชีเปิดดูง่าย
 *
 * ★ ADDITIVE + best-effort: ไฟล์ยังเก็บ Supabase เหมือนเดิม (ตัวอ่านสเตทเมนต์/แพลตฟอร์มไม่กระทบ)
 *   ตัวนี้แค่ "สำเนาเพิ่ม" ขึ้น OneDrive — ★ ห้าม throw ออกไปหา caller (LINE ingest ต้องไม่ล้มเพราะ OneDrive)
 * ★ เฉพาะ oa_type === 'sale' เท่านั้น (care/บิล ไม่แตะ — ยังเก็บ Supabase)
 * ★ ชื่อโฟลเดอร์ = ชื่อไลน์ (decrypt จาก display_name_enc) + suffix 4 ตัวท้าย ref กันชื่อซ้ำ
 *   ไม่มีชื่อ → customer_code → 'ไม่ระบุ (xxxx)'
 * ★ PDPA: ไม่ log ชื่อ/เนื้อไฟล์ — log แค่ error สั้น ๆ · ชื่อไทยเป็น PII แต่เก็บใน OneDrive ภายในบริษัท
 */
import { decryptField } from "@/lib/crypto/field";
import { isOneDriveEnabled, uploadOneDriveFile } from "@/lib/storage/onedrive";

/** context ขั้นต่ำที่ต้องใช้ (subset ของ GroupContext ใน attachments.ts) */
export type MirrorGroupContext = {
  id: string | null;
  group_ref?: string | null;
  display_name_enc?: string | null;
  customers?: { customer_code: string | null } | null;
  chat_channels?: { oa_type: string | null } | null;
} | null;

/** อักขระที่ OneDrive/Windows ห้ามในชื่อโฟลเดอร์ + control chars (คงไทย/ตัวเลข/วงเล็บ/จุดไว้) */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\/:*?"<>|\x00-\x1f\\]/g;

/** sanitize ชื่อโฟลเดอร์: ตัดอักขระต้องห้าม → เว้นวรรค, ยุบช่องว่างซ้ำ, trim, จำกัดความยาว */
function sanitizeFolderName(raw: string): string {
  return raw.replace(FORBIDDEN_NAME_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** 4 ตัวท้ายของ ref/id ไว้กันชื่อไลน์ซ้ำ/เปลี่ยน (เช่น "บ.วรรณนัช (aB3d)") */
function shortSuffix(group: NonNullable<MirrorGroupContext>): string {
  const src = (group.group_ref || group.id || "").trim();
  const tail = src.slice(-4);
  return tail ? ` (${tail})` : "";
}

/** ชื่อโฟลเดอร์ลูกค้าใน OneDrive: ชื่อไลน์ (decrypt) > customer_code > 'ไม่ระบุ' + suffix กันซ้ำ */
function resolveOneDriveFolder(group: NonNullable<MirrorGroupContext>): string {
  let base = "";
  if (group.display_name_enc) {
    try {
      base = sanitizeFolderName(decryptField(group.display_name_enc));
    } catch {
      base = "";
    }
  }
  if (!base) base = sanitizeFolderName(group.customers?.customer_code?.trim() || "");
  if (!base) base = "ไม่ระบุ";
  return base + shortSuffix(group);
}

/**
 * สำเนาไฟล์ขึ้น OneDrive แยกโฟลเดอร์ชื่อไลน์ (เฉพาะ sale OA) — best-effort, ไม่ throw
 *   @returns true ถ้าอัปสำเร็จ · false ถ้าไม่เข้าเงื่อนไข/ล้มเหลว (caller ไม่ต้องสนใจผล)
 */
export async function mirrorSaleAttachmentToOneDrive(params: {
  group: MirrorGroupContext;
  month: string;
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<boolean> {
  try {
    const { group } = params;
    if (!group) return false;
    // เฉพาะ OA "sale" (สำนักงานบัญชี Finovas) เท่านั้น
    if ((group.chat_channels?.oa_type || "") !== "sale") return false;
    if (!isOneDriveEnabled()) return false;

    const folder = resolveOneDriveFolder(group);
    const saved = await uploadOneDriveFile({
      folderParts: [folder, params.month],
      fileName: params.fileName,
      mime: params.mime,
      data: params.data,
    });
    return saved !== null;
  } catch {
    console.warn("[onedrive-mirror] mirror failed");
    return false;
  }
}
