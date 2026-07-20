/**
 * กรองรายชื่อพนักงานที่เป็น "หัวหน้าทีม" ได้ ตามประเภททีมที่เลือก
 *
 * mapping ประเภททีม (teams.type) → ประเภทพนักงาน (employees.employee_type):
 *   accounting → accountant   (ทีมบัญชี = นักบัญชี)
 *   sales      → sales        (ทีมขาย = เซล)
 *   cs         → cs           (ทีมบริการลูกค้า = CS)
 * ประเภทอื่น/ไม่มี mapping ชัด → null = ไม่จำกัด (แสดงพนักงานทั้งหมด กันตัน)
 *
 * แยกเป็น pure function เพื่อ reuse ใน UI + เขียนเทสต์ได้ตรง ๆ
 */
export const TEAM_TYPE_TO_EMPLOYEE_TYPE: Record<string, string | undefined> = {
  accounting: "accountant",
  sales: "sales",
  cs: "cs",
};

/** ประเภทพนักงานที่เป็นหัวหน้าทีมประเภทนี้ได้ (undefined = ไม่จำกัด) */
export function leadEmployeeTypeForTeam(teamType: string): string | undefined {
  return TEAM_TYPE_TO_EMPLOYEE_TYPE[teamType];
}

/**
 * คัดพนักงานที่เป็นหัวหน้าทีมประเภท teamType ได้
 * - ถ้ามี mapping → กรองตาม employee_type ที่ตรง
 * - ถ้าไม่มี mapping (เช่น other/ค่าแปลก) → คืนทั้งหมด (กันตัน เลือกหัวหน้าไม่ได้)
 */
export function filterLeadCandidates<T extends { employee_type: string }>(
  employees: T[],
  teamType: string
): T[] {
  const want = leadEmployeeTypeForTeam(teamType);
  if (!want) return employees;
  return employees.filter((e) => e.employee_type === want);
}
