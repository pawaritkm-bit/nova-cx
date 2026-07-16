import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./_form";

export const dynamic = "force-dynamic";

/**
 * หน้าเข้าสู่ระบบพนักงาน (Supabase Auth)
 * - ถ้ามี session อยู่แล้ว → เด้งเข้า /dashboard เลย
 * - รับ ?redirect= เพื่อพากลับปลายทางเดิมหลัง login สำเร็จ
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect: redirectParam } = await searchParams;
  // ยอมรับเฉพาะ path ภายใน (กัน open-redirect)
  const redirectTo =
    redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
      ? redirectParam
      : "/dashboard";

  // ถ้าตั้ง env แล้วและมี session อยู่ → ข้ามหน้า login
  if (getSupabaseEnv()) {
    try {
      const db = await createClient();
      const {
        data: { user },
      } = await db.auth.getUser();
      if (user) redirect(redirectTo);
    } catch {
      // อ่าน session ไม่ได้ → แสดงฟอร์ม login ตามปกติ
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/5">
        <p className="mb-2 inline-block rounded-full bg-brand-light/10 px-3 py-1 text-sm font-medium text-brand-light">
          NOVA-CX สำหรับพนักงาน
        </p>
        <h1 className="text-2xl font-bold text-brand">เข้าสู่ระบบ</h1>
        <p className="mt-1 text-sm text-brand/60">
          ใช้บัญชีอีเมลพนักงาน Finovas เพื่อดู dashboard ตามบทบาทของคุณ
        </p>

        <LoginForm redirectTo={redirectTo} />
      </div>

      <p className="mt-6 text-center text-sm text-brand/40">
        Finovas · Multi-tenant SaaS · PDPA-aware
      </p>
    </main>
  );
}
