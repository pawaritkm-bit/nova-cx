import { getLiffId, isLineDevMode } from "@/lib/env";
import { extractLiffToken, firstQueryValue } from "@/lib/line/liff";
import SurveyClient from "./[token]/SurveyClient";

export const dynamic = "force-dynamic";

/**
 * หน้า LIFF endpoint แบบ base /liff/survey (ไม่มี token param บน path)
 *
 * ทำไมต้องมี: LINE เปิด LIFF endpoint URL (= /liff/survey) ก่อนเสมอ แล้วส่ง extra path
 * มาทาง query `liff.state` ให้ liff.init() redirect เอง — ถ้าไม่มีหน้านี้จะ 404
 * ก่อน SDK ทำงาน (บั๊กที่เจอตอนต่อ LINE จริง)
 *
 * resolve token ได้ 2 ทาง (ดู extractLiffToken):
 *   - ?token={token}            (รูปแบบใหม่ที่ buildLiffSurveyUrl ส่ง)
 *   - liff.state=%2F{token}     (รูปแบบที่ LINE แนบมาให้ SDK / ข้อความ path-style เดิม)
 * ได้ token → reuse SurveyClient เดิม (ไม่ duplicate logic) เหมือนหน้า [token] เป๊ะ
 */
export default async function SurveyEndpointPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // ⚠️ "liff.state" มีจุดในชื่อ key → ต้องอ่านด้วย bracket notation
  const token = extractLiffToken({
    token: firstQueryValue(sp["token"]),
    liffState: firstQueryValue(sp["liff.state"]),
  });

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <div className="text-lg font-semibold text-brand">
            ไม่พบลิงก์แบบประเมิน
          </div>
          <p className="text-sm text-brand/70 mt-2">
            กรุณาเปิดแบบประเมินจากลิงก์ที่ได้รับใน LINE อีกครั้งค่ะ
          </p>
        </div>
      </div>
    );
  }

  return (
    <SurveyClient
      token={token}
      liffCareId={getLiffId("care") ?? null}
      liffSaleId={getLiffId("sale") ?? null}
      devMode={isLineDevMode()}
    />
  );
}
