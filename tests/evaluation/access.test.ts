import { describe, it, expect } from "vitest";
import {
  canViewEvaluation,
  canViewEvidence,
  canReviewEvaluation,
  canAppeal,
  canResolveAppeal,
  isTeamLeadOf,
  type Viewer,
} from "@/lib/evaluation/access";

const accountant = (empId: string): Viewer => ({ role: "accountant", employeeId: empId });
const lead = (empId: string, team: string[]): Viewer => ({
  role: "acc_lead",
  employeeId: empId,
  teamMemberIds: new Set(team),
});
const admin: Viewer = { role: "admin", employeeId: "adm" };
const executive: Viewer = { role: "executive", employeeId: "exec" };
const auditor: Viewer = { role: "auditor_qa", employeeId: "aud" };
const hr: Viewer = { role: "hr", employeeId: "hr1" };

describe("canViewEvaluation — tier (★ accountant เห็นเฉพาะตัวเอง)", () => {
  it("★ accountant เห็น eval ของตัวเอง", () => {
    expect(canViewEvaluation(accountant("e1"), "e1", "ai_draft")).toBe(true);
  });
  it("★ accountant เห็น eval คนอื่น 'ไม่ได้' เด็ดขาด", () => {
    expect(canViewEvaluation(accountant("e1"), "e2", "ai_draft")).toBe(false);
    expect(canViewEvaluation(accountant("e1"), "e2", "manager_confirmed")).toBe(false);
  });
  it("acc_lead เห็นของลูกทีม แต่ไม่เห็นนอกทีม", () => {
    const l = lead("L", ["e1", "e2"]);
    expect(canViewEvaluation(l, "e1", "ai_draft")).toBe(true);
    expect(canViewEvaluation(l, "e9", "ai_draft")).toBe(false);
  });
  it("admin/executive/auditor_qa เห็นทั้งหมด", () => {
    expect(canViewEvaluation(admin, "any", "ai_draft")).toBe(true);
    expect(canViewEvaluation(executive, "any", "rejected")).toBe(true);
    expect(canViewEvaluation(auditor, "any", "ai_draft")).toBe(true);
  });
  it("★ hr เห็นเฉพาะ confirmed (draft ไม่เห็น)", () => {
    expect(canViewEvaluation(hr, "e1", "ai_draft")).toBe(false);
    expect(canViewEvaluation(hr, "e1", "manager_confirmed")).toBe(true);
    expect(canViewEvaluation(hr, "e1", "manager_edited")).toBe(true);
    expect(canViewEvaluation(hr, "e1", "appeal_resolved")).toBe(true);
  });
  it("role null → default deny", () => {
    expect(canViewEvaluation({ role: null, employeeId: "x" }, "x", "ai_draft")).toBe(false);
  });
});

describe("canViewEvidence — ★ hr ไม่เห็น evidence แชตดิบ", () => {
  it("hr เห็น evidence ไม่ได้ แม้ confirmed", () => {
    expect(canViewEvidence(hr, "e1")).toBe(false);
  });
  it("accountant เห็น evidence ของตัวเอง / lead เห็นของทีม / privileged เห็นหมด", () => {
    expect(canViewEvidence(accountant("e1"), "e1")).toBe(true);
    expect(canViewEvidence(accountant("e1"), "e2")).toBe(false);
    expect(canViewEvidence(lead("L", ["e1"]), "e1")).toBe(true);
    expect(canViewEvidence(admin, "any")).toBe(true);
    expect(canViewEvidence(auditor, "any")).toBe(true);
  });
});

describe("canReviewEvaluation — confirm/edit/reject", () => {
  it("★ accountant review 'ไม่ได้'", () => {
    expect(canReviewEvaluation(accountant("e1"), "e1")).toBe(false);
  });
  it("acc_lead review ลูกทีมได้ แต่ไม่ใช่นอกทีม", () => {
    expect(canReviewEvaluation(lead("L", ["e1"]), "e1")).toBe(true);
    expect(canReviewEvaluation(lead("L", ["e1"]), "e9")).toBe(false);
  });
  it("admin/executive review ได้ ; ★ auditor_qa review ไม่ได้ (อ่านอย่างเดียว)", () => {
    expect(canReviewEvaluation(admin, "any")).toBe(true);
    expect(canReviewEvaluation(executive, "any")).toBe(true);
    expect(canReviewEvaluation(auditor, "any")).toBe(false);
    expect(canReviewEvaluation(hr, "any")).toBe(false);
  });
});

describe("canAppeal — ★ เฉพาะเจ้าของ eval + สถานะอุทธรณ์ได้", () => {
  it("เจ้าของอุทธรณ์ได้เมื่อ confirmed/edited", () => {
    expect(canAppeal(accountant("e1"), "e1", "manager_confirmed")).toBe(true);
    expect(canAppeal(accountant("e1"), "e1", "manager_edited")).toBe(true);
  });
  it("ยังเป็น draft → อุทธรณ์ไม่ได้ (ยังไม่มีผล)", () => {
    expect(canAppeal(accountant("e1"), "e1", "ai_draft")).toBe(false);
  });
  it("ไม่ใช่เจ้าของ → อุทธรณ์ไม่ได้ (แม้เป็นหัวหน้า)", () => {
    expect(canAppeal(lead("L", ["e1"]), "e1", "manager_confirmed")).toBe(false);
    expect(canAppeal(admin, "e1", "manager_confirmed")).toBe(false);
  });
});

describe("helpers", () => {
  it("isTeamLeadOf: เฉพาะ acc_lead + อยู่ในทีม", () => {
    expect(isTeamLeadOf(lead("L", ["e1"]), "e1")).toBe(true);
    expect(isTeamLeadOf(lead("L", ["e1"]), "e2")).toBe(false);
    expect(isTeamLeadOf(accountant("e1"), "e1")).toBe(false);
  });
  it("canResolveAppeal = canReviewEvaluation", () => {
    expect(canResolveAppeal(lead("L", ["e1"]), "e1")).toBe(true);
    expect(canResolveAppeal(accountant("e1"), "e1")).toBe(false);
  });
});
