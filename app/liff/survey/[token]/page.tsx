import { getLiffId, isLineDevMode } from "@/lib/env";
import SurveyClient from "./SurveyClient";

export const dynamic = "force-dynamic";

/**
 * หน้า LIFF แบบประเมินลูกค้า /liff/survey/[token]
 * - server อ่าน LIFF ID จาก env แล้วส่งให้ client (init LINE Login/LIFF SDK)
 * - ไม่มี env → dev mode (ไม่ init LIFF, ไม่ crash) ตามข้อกำหนด
 * - render จริงต่อ API /api/liff/survey/[token] + submit ไป /api/survey/submit
 */
export default async function SurveyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <SurveyClient
      token={token}
      liffCareId={getLiffId("care") ?? null}
      liffSaleId={getLiffId("sale") ?? null}
      devMode={isLineDevMode()}
    />
  );
}
