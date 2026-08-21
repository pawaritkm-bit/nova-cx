"use server";

import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { encryptField } from "@/lib/crypto/field";
import { renameGroupFolderNow, oaOneDriveRoot, type MirrorGroupContext } from "@/lib/line/onedrive-mirror";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * เปลี่ยน "ชื่อลูกค้า" ในระบบ CX → อัปเดต display_name_enc ทุกกลุ่มของลูกค้ารายนี้
 *   + rename โฟลเดอร์ OneDrive ทันที (ไม่ต้องรอไฟล์ใหม่)
 *
 * ★ ทำไมต้องพิมพ์ในระบบ ไม่ sync จาก LINE: ชื่อ "แก้ไขชื่อ" ใน LINE OA เป็น label ฝั่ง LINE
 *   ที่ Messaging API ไม่ส่งมาให้ระบบเรา → อ่านอัตโนมัติไม่ได้ ต้องตั้งชื่อในระบบเอง
 * ★ guard: ต้องมีสิทธิ์บัญชี + ลูกค้าอยู่ในสโคป · PDPA: ไม่ log ชื่อ
 */
export async function renameCustomerDisplayNameAction(
  customerId: string,
  newName: string
): Promise<{ ok: boolean; message: string }> {
  const name = (newName || "").trim().slice(0, 80);
  if (!UUID_RE.test(customerId)) return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
  if (name.length < 1) return { ok: false, message: "กรุณาใส่ชื่อ" };

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) return { ok: false, message: "ไม่มีสิทธิ์" };
  if (!customerInScope(access, customerId)) return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };

  const tenantId = access.tenantId;
  // ทุกกลุ่ม/แชทของลูกค้ารายนี้ (1:1 มักมีกลุ่มเดียว · เผื่อมีหลายกลุ่ม rename ให้หมด)
  const { data, error } = await service
    .from("chat_groups")
    .select("id, group_ref, display_name_enc, chat_channels(oa_type)")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "อ่านข้อมูลกลุ่มไม่สำเร็จ" };

  type ChanRef = { oa_type: string | null } | { oa_type: string | null }[] | null;
  const groups = (data ?? []) as unknown as {
    id: string;
    group_ref: string | null;
    display_name_enc: string | null;
    chat_channels: ChanRef;
  }[];
  if (groups.length === 0) return { ok: false, message: "ไม่พบกลุ่มไลน์ของลูกค้ารายนี้" };

  const oaTypeOf = (c: ChanRef): string | null | undefined => (Array.isArray(c) ? c[0]?.oa_type : c?.oa_type);

  let renamed = 0;
  const enc = encryptField(name);
  for (const g of groups) {
    // อัปเดตชื่อในระบบ (ใช้เป็นชื่อโฟลเดอร์ + โชว์ในระบบ)
    await service.from("chat_groups").update({ display_name_enc: enc }).eq("id", g.id).eq("tenant_id", tenantId);
    // rename โฟลเดอร์ OneDrive ทันที (root ตาม OA: sale→NOVA-Bills · care→NOVA-Care)
    const ctx: NonNullable<MirrorGroupContext> = { id: g.id, group_ref: g.group_ref, display_name_enc: enc };
    const ok = await renameGroupFolderNow(ctx, name, oaOneDriveRoot(oaTypeOf(g.chat_channels)));
    if (ok) renamed++;
  }

  return { ok: true, message: `เปลี่ยนชื่อเป็น "${name}" แล้ว (โฟลเดอร์อัปเดต ${renamed}/${groups.length})` };
}
