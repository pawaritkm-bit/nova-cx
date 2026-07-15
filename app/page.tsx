import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/5">
        <p className="mb-2 inline-block rounded-full bg-brand-light/10 px-3 py-1 text-sm font-medium text-brand-light">
          Milestone 1 — โครงหลักรันได้
        </p>
        <h1 className="text-3xl font-bold text-brand sm:text-4xl">NOVA-CX</h1>
        <p className="mt-2 text-lg text-brand/70">
          NOVA Customer Experience System — ระบบวัดและติดตามคุณภาพบริการของ
          Finovas Accounting ผ่าน LINE OA
        </p>

        <div className="mt-6 border-t border-black/5 pt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand/50">
            สถานะการพัฒนา (M1)
          </h2>
          <ul className="mt-3 space-y-2 text-brand/80">
            <li>✓ โครง Next.js (App Router + TypeScript + Tailwind)</li>
            <li>✓ Database Migration + RLS + RBAC (Supabase)</li>
            <li>✓ Seed data: 1 tenant, 7 บทบาท, แบบประเมิน A/B/C/D</li>
            <li>✓ Health check endpoint</li>
            <li className="text-brand/40">
              ○ Survey / LIFF / AI (จะทำในเฟส M2+)
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/api/health"
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/90"
          >
            ตรวจสอบสถานะระบบ (Health)
          </Link>
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-brand/40">
        Finovas · Multi-tenant SaaS · PDPA-aware
      </p>
    </main>
  );
}
