import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveViewer } from "@/lib/dashboard/session";
import { resolveHomePath } from "@/lib/auth/home";
import { LoginForm } from "./_form";

export const dynamic = "force-dynamic";

/**
 * หน้าเข้าสู่ระบบพนักงาน (Supabase Auth)
 * - ถ้ามี session อยู่แล้ว → เด้งไป "หน้าออดิทตามบทบาท" (resolveHomePath) เลย
 *   (เว้นมี ?redirect= ระบุปลายทางชัดเจน → ไปตามนั้น)
 * - รับ ?redirect= เพื่อพากลับปลายทางเดิมหลัง login สำเร็จ (กัน open-redirect)
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect: redirectParam } = await searchParams;
  // ยอมรับเฉพาะ path ภายใน (กัน open-redirect) — null = ไม่มีปลายทางชัดเจน
  const explicitRedirect =
    redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
      ? redirectParam
      : null;

  // ถ้าตั้ง env แล้ว → เช็ก session; ★ resolve นอก try/catch เพื่อไม่ให้ catch กลืน
  //   NEXT_REDIRECT ที่ redirect() โยนออกมา
  let viewer: Awaited<ReturnType<typeof resolveViewer>> | null = null;
  if (getSupabaseEnv()) {
    try {
      const db = await createClient();
      viewer = await resolveViewer(db);
    } catch {
      // อ่าน session ไม่ได้ → แสดงฟอร์ม login ตามปกติ
      viewer = null;
    }
  }

  // มี session อยู่แล้ว → ข้ามหน้า login ไปปลายทาง (explicit) หรือหน้าออดิทตามบทบาท
  if (viewer?.hasSession) {
    redirect(explicitRedirect ?? resolveHomePath(viewer.role));
  }

  // ยังไม่ login: ถ้ามีปลายทางชัดเจนให้กลับไปหลัง login; ไม่งั้นส่งไป "/login" ให้ server
  //   resolve บทบาทแล้วเด้งต่อ (form เป็น client — resolve role ที่นี่ไม่สะดวก)
  const redirectTo = explicitRedirect ?? "/login";

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
