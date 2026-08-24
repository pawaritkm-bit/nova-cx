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
import { isOneDriveEnabled, uploadOneDriveFile, listOneDriveChildren, getOneDriveConfig, renameOneDriveFile } from "@/lib/storage/onedrive";

/** OA id สำหรับ LINE OA Manager (chat.line.biz) = channel_ref ของ sale OA (สนง.บัญชี Finovas) · override ด้วย env LINE_OA_CHAT_ID */
const LINE_OA_CHAT_ID = process.env.LINE_OA_CHAT_ID || "Uddc05724cf745e4e56d49a90dbc9f521";
/** ลิงก์เปิดแชทลูกค้าใน LINE OA Manager · chatId = group_ref (LINE user id, Uxxx) · null ถ้าไม่มี id */
export function lineChatUrl(chatId: string | null | undefined): string | null {
  const id = (chatId || "").trim();
  return /^U[0-9a-f]{20,}$/i.test(id) ? `https://chat.line.biz/${LINE_OA_CHAT_ID}/chat/${id}` : null;
}

/** โฟลเดอร์รากบน OneDrive ตามชนิด OA: care → "NOVA-Care" · อื่น (sale) → ONEDRIVE_ROOT ("NOVA-Bills") */
export const CARE_ONEDRIVE_ROOT = "NOVA-Care";
export function oaOneDriveRoot(oaType: string | null | undefined): string {
  if (oaType === "care") return CARE_ONEDRIVE_ROOT;
  return getOneDriveConfig()?.root ?? "NOVA-Bills";
}

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

/** 4 ตัวท้ายของ ref/id (ดิบ) — ใช้เป็น "กุญแจ" จับคู่โฟลเดอร์กับลูกค้า แม้ชื่อโฟลเดอร์ถูกเปลี่ยน */
function refTail(group: NonNullable<MirrorGroupContext>): string {
  return (group.group_ref || group.id || "").trim().slice(-4);
}

/** 4 ตัวท้ายของ ref/id ไว้กันชื่อไลน์ซ้ำ/เปลี่ยน (เช่น "บ.วรรณนัช (aB3d)") */
function shortSuffix(group: NonNullable<MirrorGroupContext>): string {
  const tail = refTail(group);
  return tail ? ` (${tail})` : "";
}

/** มี "ชื่อไลน์จริง" ไหม (display_name อ่านได้ หรือมี customer_code) — ใช้ตัดสินว่าจะ rename ตามชื่อไลน์
 *   (กันเคส decrypt ไม่ได้ → desired = "ไม่ระบุ" แล้วเผลอ rename โฟลเดอร์ที่มีชื่อจริงอยู่ทิ้ง) */
function hasRealLineName(group: NonNullable<MirrorGroupContext>): boolean {
  if (group.display_name_enc) {
    try {
      if (sanitizeFolderName(decryptField(group.display_name_enc))) return true;
    } catch {
      /* decrypt ไม่ได้ */
    }
  }
  return !!group.customers?.customer_code?.trim();
}

/**
 * หาโฟลเดอร์ลูกค้าใน OneDrive แบบ "ยึด LINE id เป็นหลัก" (จับด้วยเลข "(xxxx)" ท้ายชื่อ)
 *   ★ ชื่อโฟลเดอร์ = ตามชื่อไลน์ปัจจุบันเสมอ — ถ้าชื่อไลน์เปลี่ยน โฟลเดอร์เดิม (match ด้วย suffix)
 *     จะถูก rename ให้ตรงชื่อใหม่ตอน AI ดึงไฟล์ครั้งถัดไป (คงเนื้อในทั้งหมด · คง suffix)
 *   ไม่เจอโฟลเดอร์เดิม → คืนชื่อ default (ชื่อไลน์ + suffix) เพื่อสร้างใหม่
 */
export async function resolveSaleFolder(group: NonNullable<MirrorGroupContext>, root?: string): Promise<string> {
  const tail = refTail(group);
  const desired = resolveOneDriveFolder(group); // ชื่อไลน์ปัจจุบัน + suffix
  if (tail) {
    try {
      const existing = (await listOneDriveChildren([], root)).find(
        (c) => c.isFolder && c.name.includes(`(${tail})`)
      );
      if (existing) {
        // ชื่อไลน์เปลี่ยน + มีชื่อจริง → rename โฟลเดอร์เดิมให้ตรงชื่อปัจจุบัน (ค้นหาในไลน์ OA ง่ายขึ้น)
        if (existing.name !== desired && hasRealLineName(group)) {
          const ok = await renameOneDriveFile({ folderParts: [], fileName: existing.name, newName: desired, root });
          return ok ? desired : existing.name; // rename ไม่ได้ (ชื่อชน/สิทธิ์) → คงชื่อเดิม (ไม่แตกโฟลเดอร์)
        }
        return existing.name;
      }
    } catch {
      /* best-effort — ตกไปใช้ชื่อ default */
    }
  }
  return desired;
}

/**
 * เปลี่ยนชื่อโฟลเดอร์ลูกค้า "ทันที" ตามชื่อใหม่ (เรียกจาก action แก้ชื่อในระบบ CX)
 *   หาโฟลเดอร์เดิมด้วยเลข "(xxxx)" ท้าย → rename เป็น "<ชื่อใหม่> (xxxx)" (คงเนื้อในครบ)
 *   @returns true = สำเร็จ/ไม่ต้องทำ (ยังไม่มีโฟลเดอร์) · false = ล้มเหลว (ชื่อว่าง/rename ไม่ได้)
 */
export async function renameGroupFolderNow(
  group: NonNullable<MirrorGroupContext>,
  newName: string,
  root?: string
): Promise<boolean> {
  const tail = refTail(group);
  const base = sanitizeFolderName(newName || "");
  if (!tail || !base) return false;
  const desired = base + shortSuffix(group);
  try {
    const existing = (await listOneDriveChildren([], root)).find((c) => c.isFolder && c.name.includes(`(${tail})`));
    if (!existing) return true; // ยังไม่มีโฟลเดอร์ (ยังไม่เคยมีไฟล์) → ชื่อใหม่จะถูกใช้ตอนสร้างครั้งแรก
    if (existing.name === desired) return true;
    return await renameOneDriveFile({ folderParts: [], fileName: existing.name, newName: desired, root });
  } catch {
    return false;
  }
}

/** ชื่อโฟลเดอร์ลูกค้าใน OneDrive: ชื่อไลน์ (decrypt) > customer_code > 'ไม่ระบุ' + suffix กันซ้ำ
 *   export ให้ auto-read เซฟผลลัพธ์ลงโฟลเดอร์เดียวกับไฟล์ต้นฉบับ */
export function resolveOneDriveFolder(group: NonNullable<MirrorGroupContext>): string {
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
