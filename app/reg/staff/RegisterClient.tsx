"use client";

import { useEffect, useState } from "react";

/**
 * RegisterClient — ฟอร์มลงทะเบียนนักบัญชีผ่าน LIFF
 *   1) โหลด LIFF SDK → liff.init → ถ้ายังไม่ login → liff.login() (redirect กลับมาหน้าเดิม)
 *   2) login แล้ว → getIDToken() (ส่งให้ server verify) + getProfile() (prefill ชื่อ)
 *   3) กรอกฟอร์ม (ชื่อ/ชื่อเล่น/ทีม/รหัสลงทะเบียน) → POST /api/register-staff
 *   4) แสดงผลสำเร็จ ("เชื่อม LINE แล้ว: <ชื่อ> · <ทีม>") + userId ย่อ (ให้เทียบ chat_members)
 *
 * ⚠️ ต่างจากหน้า survey: ที่นี่ "ต้อง" login เพราะไม่มี token — ใช้ LINE login ยืนยันตัวตน
 */

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";

/** subset ของ liff ที่หน้านี้ใช้ (มี login/getIDToken ต่างจาก survey ที่ห้าม login) */
type RegLiff = {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: (config?: { redirectUri?: string }) => void;
  getIDToken: () => string | null;
  getProfile: () => Promise<{ userId: string; displayName?: string }>;
};

/**
 * อ่าน window.liff แบบ cast เฉพาะที่ (ไม่ augment global Window เพราะหน้า survey
 * ประกาศ liff เป็น type อื่นไว้แล้ว — การ redeclare จะชนกัน)
 */
function getRegLiff(): RegLiff | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { liff?: RegLiff }).liff;
}

function loadLiffSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (getRegLiff()) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${LIFF_SDK_URL}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("liff sdk load error")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = LIFF_SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("liff sdk load error"));
    document.body.appendChild(script);
  });
}

type SuccessInfo = {
  employeeName: string;
  userIdShort: string;
  teamLinked: boolean;
  teamName: string | null;
  propagatedGroups: number;
  created: boolean;
};

export default function RegisterClient({
  liffId,
  featureOn,
}: {
  liffId: string | null;
  featureOn: boolean;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [initError, setInitError] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);

  // ฟอร์ม
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [teamName, setTeamName] = useState("");
  const [code, setCode] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessInfo | null>(null);

  // ---- init LIFF + login + ดึง idToken/profile ----
  useEffect(() => {
    if (!featureOn) {
      setPhase("error");
      setInitError("ระบบลงทะเบียนยังไม่เปิดใช้งาน กรุณาติดต่อผู้ดูแล");
      return;
    }
    if (!liffId) {
      setPhase("error");
      setInitError("ยังไม่ได้ตั้งค่า LIFF (LINE_STAFF_REG_LIFF_ID) — ติดต่อผู้ดูแล");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await loadLiffSdk();
        const liff = getRegLiff();
        if (!liff) throw new Error("no liff");
        await liff.init({ liffId });

        if (!liff.isLoggedIn()) {
          // redirect ไป LINE login แล้วกลับมาหน้าเดิม (มี idToken หลังกลับมา)
          liff.login({ redirectUri: window.location.href });
          return; // หน้าจะ reload หลัง login
        }

        const token = liff.getIDToken();
        if (!token) throw new Error("no id token");
        if (cancelled) return;
        setIdToken(token);

        // prefill ชื่อจาก LINE (best-effort)
        try {
          const profile = await liff.getProfile();
          if (!cancelled && profile.displayName) setNickname((n) => n || profile.displayName!);
        } catch {
          // ignore — ไม่มี profile ก็กรอกเองได้
        }

        if (!cancelled) setPhase("ready");
      } catch {
        if (!cancelled) {
          setPhase("error");
          setInitError("เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดจากลิงก์/QR ในแอป LINE อีกครั้ง");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [liffId, featureOn]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!idToken) {
      setSubmitError("ยังยืนยันตัวตน LINE ไม่สำเร็จ กรุณาลองใหม่");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/register-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          name: name.trim(),
          nickname: nickname.trim() || undefined,
          teamName: teamName.trim() || undefined,
          code,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setSuccess({
          employeeName: data.employeeName,
          userIdShort: data.userIdShort,
          teamLinked: !!data.teamLinked,
          teamName: data.teamName ?? null,
          propagatedGroups: data.propagatedGroups ?? 0,
          created: !!data.created,
        });
      } else {
        setSubmitError(data?.message ?? "ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่");
      }
    } catch {
      setSubmitError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setSubmitting(false);
    }
  }

  // ================= UI =================
  const wrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0f1b3d",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    fontFamily: "system-ui, -apple-system, 'Noto Sans Thai', sans-serif",
  };
  const card: React.CSSProperties = {
    width: "100%",
    maxWidth: 420,
    background: "#fff",
    color: "#0f1b3d",
    borderRadius: 16,
    padding: 24,
    boxShadow: "0 8px 40px rgba(0,0,0,.3)",
  };

  if (phase === "loading") {
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <p style={{ fontWeight: 700, fontSize: 18 }}>กำลังเชื่อมต่อ LINE…</p>
          <p style={{ color: "#5b6b88", marginTop: 8, fontSize: 14 }}>ขอเวลาสักครู่นะคะ</p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <p style={{ fontWeight: 700, fontSize: 18, color: "#b91c1c" }}>เปิดหน้าลงทะเบียนไม่ได้</p>
          <p style={{ color: "#334", marginTop: 10, fontSize: 14 }}>{initError}</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <div style={{ fontSize: 44 }}>✅</div>
          <p style={{ fontWeight: 800, fontSize: 20, marginTop: 8 }}>ลงทะเบียนสำเร็จ</p>
          <p style={{ marginTop: 12, fontSize: 15 }}>
            เชื่อม LINE แล้ว: <strong>{success.employeeName}</strong>
            {success.teamLinked && success.teamName ? (
              <>
                {" · "}
                <strong>{success.teamName}</strong>
              </>
            ) : null}
          </p>
          {!success.teamLinked && (
            <p style={{ marginTop: 8, fontSize: 13, color: "#92600a" }}>
              (ยังไม่ได้ผูกทีม — แจ้งชื่อทีมให้แอดมินตรวจสอบได้ภายหลัง)
            </p>
          )}
          <p style={{ marginTop: 14, fontSize: 13, color: "#5b6b88" }}>
            ระบบจะเริ่มจับ+ประเมินแชตของคุณในทุกกลุ่มโดยอัตโนมัติ
            {success.propagatedGroups > 0
              ? ` (อัปเดตย้อนหลัง ${success.propagatedGroups} กลุ่ม)`
              : ""}
          </p>
          <p style={{ marginTop: 14, fontSize: 12, color: "#8a97b3" }}>
            LINE userId (ย่อ): <code>{success.userIdShort}</code>
          </p>
        </div>
      </div>
    );
  }

  // phase === "ready" → ฟอร์ม
  return (
    <div style={wrap}>
      <form style={card} onSubmit={handleSubmit}>
        <p style={{ fontWeight: 800, fontSize: 20 }}>ลงทะเบียนนักบัญชี</p>
        <p style={{ color: "#5b6b88", marginTop: 6, fontSize: 13, marginBottom: 16 }}>
          ยืนยัน LINE แล้ว — กรอกข้อมูลเพื่อผูกบัญชีของคุณกับระบบ NOVA-CX
        </p>

        <Field label="ชื่อ-นามสกุล *">
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="เช่น สมชาย ใจดี"
            style={inputStyle}
          />
        </Field>
        <Field label="ชื่อเล่น">
          <input
            maxLength={200}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="เช่น ชาย"
            style={inputStyle}
          />
        </Field>
        <Field label="ทีมบัญชี (พิมพ์ชื่อทีม ถ้ามี)">
          <input
            maxLength={200}
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="เช่น ทีมบัญชี A"
            style={inputStyle}
          />
        </Field>
        <Field label="รหัสลงทะเบียน *">
          <input
            required
            maxLength={200}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="รหัสลับที่ได้รับจากแอดมิน"
            style={inputStyle}
            autoComplete="off"
          />
        </Field>

        {submitError && (
          <p style={{ color: "#b91c1c", fontSize: 13, marginTop: 4 }}>{submitError}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: "100%",
            marginTop: 16,
            padding: "12px 16px",
            borderRadius: 10,
            border: "none",
            background: submitting ? "#7a86a8" : "#0f1b3d",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: submitting ? "default" : "pointer",
          }}
        >
          {submitting ? "กำลังลงทะเบียน…" : "ลงทะเบียน"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #cdd5e5",
  fontSize: 15,
  boxSizing: "border-box",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {label}
      </span>
      {children}
    </label>
  );
}
