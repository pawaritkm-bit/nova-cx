/**
 * ตัวช่วยกรอง/จัดเรียง "เคสร้องเรียน" สำหรับหน้า /cases — ★ ฟังก์ชันบริสุทธิ์ (unit test ได้)
 *   - แยกตรรกะ filter/sort ออกจาก UI เพื่อทดสอบแน่นอน
 *   - รับ nowMs เป็นพารามิเตอร์ (ไม่เรียก Date.now เอง) เหมือน lib/dashboard/sla.ts
 *   - เรียงตามความเร่งด่วน (reuse compareUrgency): เกิน SLA ก่อน → critical/high → sla ใกล้สุด
 */
import { compareUrgency } from "./sla";
import type { CaseFactRow } from "./types";

/** สถานะที่ถือว่า "ปิดแล้ว" (ตรงกับ dashboard queries) */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "resolved",
  "closed",
]);

/** true = เคสนี้ปิดแล้ว (resolved/closed) */
export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status);
}

/** ตัวเลือกกรองระดับความรุนแรง ("all" = ทุกระดับ) */
export type CaseLevelFilter = "all" | "critical" | "high" | "medium" | "low";
/** ตัวเลือกกรองสถานะ ("all" = ทั้งเปิดและปิด) */
export type CaseStatusFilter = "all" | "open" | "closed";

export const CASE_LEVEL_FILTERS: readonly CaseLevelFilter[] = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
] as const;
export const CASE_STATUS_FILTERS: readonly CaseStatusFilter[] = [
  "all",
  "open",
  "closed",
] as const;

/** normalize ค่าจาก query param → ตัวเลือก filter ที่ถูกต้อง (ไม่รู้จัก → "all") */
export function normalizeLevelFilter(v: string | null | undefined): CaseLevelFilter {
  return (CASE_LEVEL_FILTERS as readonly string[]).includes(v ?? "")
    ? (v as CaseLevelFilter)
    : "all";
}
export function normalizeStatusFilter(
  v: string | null | undefined
): CaseStatusFilter {
  return (CASE_STATUS_FILTERS as readonly string[]).includes(v ?? "")
    ? (v as CaseStatusFilter)
    : "all";
}

export type CaseFilter = {
  level: CaseLevelFilter;
  status: CaseStatusFilter;
};

/** กรองเคสตามระดับ + สถานะ (เปิด/ปิด) — ฟังก์ชันบริสุทธิ์ */
export function filterCases(
  rows: CaseFactRow[],
  filter: CaseFilter
): CaseFactRow[] {
  return rows.filter((r) => {
    if (filter.level !== "all" && r.level.toLowerCase() !== filter.level) {
      return false;
    }
    if (filter.status === "open" && isClosedStatus(r.status)) return false;
    if (filter.status === "closed" && !isClosedStatus(r.status)) return false;
    return true;
  });
}

/** เรียงเคสตามความเร่งด่วน (ไม่แก้ต้นฉบับ) */
export function sortCasesByUrgency(
  rows: CaseFactRow[],
  nowMs: number
): CaseFactRow[] {
  return [...rows].sort((a, b) => compareUrgency(a, b, nowMs));
}

/** กรองแล้วเรียงในขั้นตอนเดียว (ใช้ในหน้า /cases) */
export function filterAndSortCases(
  rows: CaseFactRow[],
  filter: CaseFilter,
  nowMs: number
): CaseFactRow[] {
  return sortCasesByUrgency(filterCases(rows, filter), nowMs);
}
