/**
 * Backfill ชื่อกลุ่ม LINE — ดึงชื่อกลุ่มที่ "ยังไม่มีชื่อ" (display_name_enc null) มาเก็บ
 *   ใช้กับกลุ่มเก่าที่บอทเข้าไปก่อนมีฟีเจอร์ fetch-if-missing (เชิญไว้แล้วแต่ยังไม่มีชื่อ)
 *
 * flow:
 *   1) loop chat_groups ที่ display_name_enc null ใน tenant (group_kind='group' เท่านั้น — room ไม่มี summary)
 *   2) หา OA ของกลุ่มจาก chat_channels.oa_type (ไม่รู้ → ลองทุก OA ที่มี credential)
 *   3) getGroupSummary → เข้ารหัสด้วย encryptField → update display_name_enc (guard .is null)
 *   4) audit_logs 1 แถว (สรุปจำนวนที่ backfill ได้)
 *
 * ★ ต้องมีคีย์เข้ารหัส (hasEncKey) — ไม่มีคีย์ = ไม่เก็บ (ตาม pattern เดิม)
 * ★ best-effort ต่อกลุ่ม: ดึงไม่ได้/error = ข้าม ไม่ล้มทั้ง batch
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import { encryptField, hasEncKey } from "@/lib/crypto/field";

type DB = SupabaseClient;

/** OA ทั้งหมดที่รองรับ — ใช้ลองไล่เมื่อกลุ่มไม่รู้ oa_type */
const ALL_OAS: LineOa[] = ["care", "sale"];

export type BackfillGroupNamesResult = {
  /** จำนวนกลุ่มที่ดึงชื่อ+เก็บสำเร็จรอบนี้ */
  updated: number;
  /** จำนวนกลุ่มที่ยังไม่มีชื่อทั้งหมด (candidate) */
  scanned: number;
  /** เหตุผลถ้าข้ามทั้ง batch (เช่นไม่มีคีย์) */
  reason?: string;
};

type GroupRaw = {
  id: string;
  group_ref: string;
  group_kind: string;
  chat_channels: { oa_type?: string | null } | { oa_type?: string | null }[] | null;
};

/** อ่าน oa_type ของ chat_channel ที่ join มา (best-effort) — null ถ้าไม่รู้ */
function channelOa(row: GroupRaw): LineOa | null {
  const ch = Array.isArray(row.chat_channels) ? row.chat_channels[0] : row.chat_channels;
  const oa = ch?.oa_type;
  return oa === "care" || oa === "sale" ? oa : null;
}

/**
 * backfill ชื่อกลุ่มที่ยังว่างใน tenant
 *   getClient: factory คืน LineClient ต่อ OA (null = ไม่มี credential) — inject เพื่อ test
 */
export async function backfillGroupNames(
  db: DB,
  tenantId: string,
  getClient: (oa: LineOa) => LineClient | null,
  actorUserId: string | null,
  opts: { limit?: number } = {}
): Promise<BackfillGroupNamesResult> {
  // ไม่มีคีย์เข้ารหัส = เก็บชื่อไม่ได้ (ไม่มี plaintext) → ไม่ทำ (ตาม pattern เดิม)
  if (!hasEncKey()) {
    return { updated: 0, scanned: 0, reason: "ยังไม่ได้ตั้งค่าคีย์เข้ารหัส (CREDENTIAL_ENC_KEY)" };
  }

  const limit = opts.limit ?? 500;

  const { data, error } = await db
    .from("chat_groups")
    .select("id, group_ref, group_kind, chat_channels(oa_type)")
    .eq("tenant_id", tenantId)
    .eq("group_kind", "group") // room ไม่มี summary API
    .is("display_name_enc", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as GroupRaw[];
  let updated = 0;

  for (const row of rows) {
    try {
      // ลำดับ OA ที่จะลอง: oa ของ channel ก่อน แล้ว fallback OA อื่นที่มี credential
      const preferred = channelOa(row);
      const candidates = preferred
        ? [preferred, ...ALL_OAS.filter((o) => o !== preferred)]
        : [...ALL_OAS];

      let groupName: string | null = null;
      for (const oa of candidates) {
        const client = getClient(oa);
        if (!client) continue;
        const summary = await client.getGroupSummary(row.group_ref);
        if (summary?.groupName) {
          groupName = summary.groupName;
          break;
        }
      }
      if (!groupName) continue; // ดึงไม่ได้ทุก OA → ข้าม

      const { error: updErr } = await db
        .from("chat_groups")
        .update({ display_name_enc: encryptField(groupName) })
        .eq("id", row.id)
        .eq("tenant_id", tenantId)
        .is("display_name_enc", null); // เขียนเฉพาะตอนยังว่าง (กันทับ + กัน race)
      if (!updErr) updated += 1;
    } catch {
      // best-effort ต่อกลุ่ม — ข้ามกลุ่มที่ error (ไม่ log ชื่อ/plaintext)
      continue;
    }
  }

  // audit (append-only) — บันทึกสรุปการ backfill (ไม่มี PII)
  await db.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action: "chat_group_names_backfilled",
    resource: "chat_group",
    resource_id: null,
    meta: { scanned: rows.length, updated },
  });

  return { updated, scanned: rows.length };
}
