#!/usr/bin/env node
/**
 * seed-auth-users.mjs — สร้าง Supabase Auth user จริง 1 คนต่อบทบาท แล้วผูกกับ public.users
 *
 * ทำอะไร:
 *   1) อ่าน public.users (join roles) ของ tenant Finovas ที่ active
 *   2) สำหรับแต่ละ user: สร้าง auth user ด้วยอีเมลเดิมของ users row (email_confirm:true)
 *      - ถ้ามีอยู่แล้ว → reuse (idempotent) แล้วอัปเดตรหัสผ่านให้ตรง SEED_AUTH_PASSWORD
 *   3) UPDATE public.users.auth_user_id ให้ตรง id ของ auth user ที่สร้าง/พบ
 *
 * ความปลอดภัย:
 *   - ใช้ SUPABASE_SERVICE_ROLE_KEY (ข้าม RLS) — รันเฉพาะเบื้องหลัง ไม่ใช่จาก request
 *   - รหัสผ่านมาจาก env SEED_AUTH_PASSWORD เท่านั้น (ไม่ hardcode) — script จะ mask ทุกค่า
 *
 * วิธีรัน (จากโฟลเดอร์โปรเจกต์):
 *   SEED_AUTH_PASSWORD='รหัสที่ตั้งเอง' node scripts/seed-auth-users.mjs
 *   (อ่าน url/service_role จาก .env.local อัตโนมัติ)
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

// โหลด .env.local ก่อน แล้วค่อย .env (env ที่ส่งจาก command line ยังชนะได้)
loadEnv({ path: ".env.local" });
loadEnv();

const FINOVAS_TENANT_ID =
  process.env.SEED_TENANT_ID || "11111111-1111-1111-1111-111111111111";

/** mask ค่าอ่อนไหวสำหรับ log (เหลือหัว-ท้ายเล็กน้อยไว้ debug) */
function mask(v) {
  if (!v) return "(ไม่ได้ตั้ง)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = process.env.SEED_AUTH_PASSWORD;

  if (!url) fail("ยังไม่ได้ตั้ง NEXT_PUBLIC_SUPABASE_URL (.env.local)");
  if (!serviceKey) fail("ยังไม่ได้ตั้ง SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  if (!password || password.length < 8)
    fail(
      "ต้องตั้ง SEED_AUTH_PASSWORD (อย่างน้อย 8 ตัว) เช่น: SEED_AUTH_PASSWORD='...' node scripts/seed-auth-users.mjs"
    );

  console.log("• Supabase URL:", url);
  console.log("• service_role:", mask(serviceKey));
  console.log("• seed password:", mask(password), "\n");

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) ดึง users (1/role) ของ tenant Finovas พร้อม role code
  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, email, role:roles(code)")
    .eq("tenant_id", FINOVAS_TENANT_ID)
    .eq("is_active", true)
    .is("deleted_at", null);

  if (usersErr) fail(`อ่านตาราง users ไม่สำเร็จ: ${usersErr.message}`);
  if (!users || users.length === 0)
    fail("ไม่พบ users ของ tenant Finovas (apply seed.sql แล้วหรือยัง?)");

  // สร้าง index ของ auth user ที่มีอยู่แล้ว (map email → id) เพื่อ idempotent
  const existingByEmail = await listAllAuthUsers(supabase);

  let ok = 0;
  let errCount = 0;

  for (const u of users) {
    const email = u.email;
    const roleCode = Array.isArray(u.role)
      ? u.role[0]?.code
      : u.role?.code;
    const label = `${email} [${roleCode || "no-role"}]`;

    try {
      let authUserId = existingByEmail.get(email.toLowerCase());

      if (authUserId) {
        // มีอยู่แล้ว → อัปเดตรหัสผ่าน + ยืนยันอีเมล (idempotent)
        const { error: updErr } = await supabase.auth.admin.updateUserById(
          authUserId,
          { password, email_confirm: true }
        );
        if (updErr) throw new Error(`update auth user: ${updErr.message}`);
        console.log(`↺ reuse    ${label} (auth id ${mask(authUserId)})`);
      } else {
        // สร้างใหม่
        const { data: created, error: createErr } =
          await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          });
        if (createErr || !created?.user)
          throw new Error(
            `create auth user: ${createErr?.message || "no user returned"}`
          );
        authUserId = created.user.id;
        console.log(`＋ create   ${label} (auth id ${mask(authUserId)})`);
      }

      // 3) ผูก public.users.auth_user_id ให้ตรง auth user
      const { error: linkErr } = await supabase
        .from("users")
        .update({ auth_user_id: authUserId })
        .eq("id", u.id);
      if (linkErr) throw new Error(`link auth_user_id: ${linkErr.message}`);

      ok++;
    } catch (e) {
      errCount++;
      console.error(`✗ ${label}: ${e.message}`);
    }
  }

  console.log(`\nเสร็จสิ้น: สำเร็จ ${ok} / ล้มเหลว ${errCount} (ทั้งหมด ${users.length})`);
  if (errCount > 0) process.exit(1);
}

/** ดึง auth user ทั้งหมด (paginate) → Map<emailLower, id> */
async function listAllAuthUsers(supabase) {
  const map = new Map();
  let page = 1;
  const perPage = 200;
  // จำกัด 50 หน้า (กันวน) — โปรเจกต์นี้มี user น้อย
  for (; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const batch = data?.users || [];
    for (const user of batch) {
      if (user.email) map.set(user.email.toLowerCase(), user.id);
    }
    if (batch.length < perPage) break;
  }
  return map;
}

main().catch((e) => fail(e?.message || String(e)));
