/**
 * statement-password-memory.ts — จำรหัส PDF สเตทเมนต์ที่ "ปลดสำเร็จ" ไว้ลองครั้งต่อไป
 *   ★ ผูกกับ "ชื่อบัญชี" (account_name) + กลุ่ม/ลูกค้า — ไม่เอารหัสของบัญชีหนึ่งไปใช้ผิดบัญชี
 *   ★ เก็บรหัสแบบ "เข้ารหัส" (CREDENTIAL_ENC_KEY) · ตาราง RLS-on ไม่มี policy → service role เท่านั้น
 *
 * flow:
 *   - ปลดสำเร็จ (โน้ตนักบัญชี/แชทลูกค้า/รหัสที่จำไว้) + อ่านชื่อบัญชีได้ → remember (upsert)
 *   - เจอไฟล์ติดรหัสใหม่ → ดึงรหัสที่จำไว้ของกลุ่มนั้นมาลอง (ควบคู่แชท/โน้ต)
 *
 * ★ PDPA: ไม่ log รหัส/ชื่อบัญชี — เก็บ ciphertext เท่านั้น
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptField, decryptField, hasEncKey } from "@/lib/crypto/field";

const TABLE = "statement_password_memory";

/** normalize ชื่อบัญชีให้เทียบตรงกันได้ (ยุบช่องว่าง + trim + lower) — คงอักษรไทยไว้ */
export function normalizeAccountName(name: string): string {
  return (name || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * จำรหัสที่ปลดสำเร็จ (เข้ารหัสก่อนเก็บ) — best-effort ไม่ throw
 *   ต้องมี: ชื่อบัญชี + กลุ่ม + tenant + คีย์เข้ารหัส (ขาดอย่างใด = ไม่จำ)
 */
export async function rememberStatementPassword(
  db: SupabaseClient,
  params: { tenantId: string; chatGroupId: string; accountName: string | null; bank?: string | null; password: string },
): Promise<void> {
  try {
    const name = normalizeAccountName(params.accountName || "");
    if (!name || !params.tenantId || !params.chatGroupId || !params.password || !hasEncKey()) return;
    await db.from(TABLE).upsert(
      {
        tenant_id: params.tenantId,
        chat_group_id: params.chatGroupId,
        account_name_norm: name,
        bank: params.bank ?? null,
        password_enc: encryptField(params.password),
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,chat_group_id,account_name_norm" },
    );
  } catch {
    /* best-effort — จำไม่ได้ไม่กระทบการอ่าน */
  }
}

/**
 * ดึงรหัสที่จำไว้ของกลุ่มนี้ (ถอดรหัสแล้ว) — ไว้เป็น candidate ลองปลดไฟล์ติดรหัสใหม่
 *   ★ scope แค่กลุ่มเดียว (ไม่ข้ามลูกค้า) — ชื่อบัญชีที่ผูกไว้การันตีว่าเป็นรหัสของลูกค้ารายนี้
 */
export async function getRememberedPasswords(
  db: SupabaseClient,
  params: { tenantId: string; chatGroupId: string },
): Promise<string[]> {
  try {
    if (!params.tenantId || !params.chatGroupId || !hasEncKey()) return [];
    const { data } = await db
      .from(TABLE)
      .select("password_enc")
      .eq("tenant_id", params.tenantId)
      .eq("chat_group_id", params.chatGroupId)
      .limit(50);
    const out: string[] = [];
    for (const r of (data as { password_enc: string }[] | null) ?? []) {
      try {
        const pw = decryptField(r.password_enc);
        if (pw) out.push(pw);
      } catch {
        /* ข้ามแถวที่ถอดรหัสไม่ได้ */
      }
    }
    return out;
  } catch {
    return [];
  }
}
