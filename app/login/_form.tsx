"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { validateLoginInput, loginErrorMessage } from "@/lib/auth/login";

/**
 * ฟอร์มเข้าสู่ระบบ (client) — signInWithPassword ผ่าน browser client
 * สำเร็จ → refresh (ให้ middleware/Server Component เห็น cookie ใหม่) แล้วไป redirectTo
 */
export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const check = validateLoginInput(email, password);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError(loginErrorMessage(authError.message));
        setLoading(false);
        return;
      }
      // สำเร็จ → รีเฟรชให้ server เห็น session cookie ใหม่ แล้วเข้าปลายทาง
      router.replace(redirectTo);
      router.refresh();
    } catch {
      setError("เชื่อมต่อระบบยืนยันตัวตนไม่ได้ กรุณาลองใหม่");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-sm font-medium text-brand/80"
        >
          อีเมล
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-brand outline-none ring-brand-light/40 focus:ring-2 disabled:opacity-60"
          placeholder="you@finovas.demo"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-sm font-medium text-brand/80"
        >
          รหัสผ่าน
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-brand outline-none ring-brand-light/40 focus:ring-2 disabled:opacity-60"
          placeholder="••••••••"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand/90 disabled:opacity-60"
      >
        {loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}
