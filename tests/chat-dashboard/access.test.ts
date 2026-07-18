import { describe, it, expect } from "vitest";
import {
  canSeeExecDashboard,
  canSeeTeamDashboard,
  canSeeMeDashboard,
  canSeeRiskDashboard,
  canAccessChatViewer,
  canDecryptChat,
  caseScopeForViewer,
  isChatPrivileged,
} from "@/lib/chat-dashboard/access";
import type { Viewer } from "@/lib/evaluation/access";

const accountant = (id: string): Viewer => ({ role: "accountant", employeeId: id, tenantId: "t1" });
const lead = (id: string, team: string[]): Viewer => ({
  role: "acc_lead",
  employeeId: id,
  tenantId: "t1",
  teamMemberIds: new Set(team),
});
const admin: Viewer = { role: "admin", employeeId: "adm", tenantId: "t1" };
const executive: Viewer = { role: "executive", employeeId: "ex", tenantId: "t1" };
const auditor: Viewer = { role: "auditor_qa", employeeId: "au", tenantId: "t1" };
const hr: Viewer = { role: "hr", employeeId: "hr1", tenantId: "t1" };
const cs: Viewer = { role: "cs", employeeId: "cs1", tenantId: "t1" };
const noRole: Viewer = { role: null, employeeId: null, tenantId: "t1" };

describe("สิทธิ์เข้าถึงหน้า (allow-list / default-deny)", () => {
  it("Exec Dashboard — เฉพาะ admin/executive/auditor_qa", () => {
    expect(canSeeExecDashboard("admin")).toBe(true);
    expect(canSeeExecDashboard("executive")).toBe(true);
    expect(canSeeExecDashboard("auditor_qa")).toBe(true);
    expect(canSeeExecDashboard("acc_lead")).toBe(false);
    expect(canSeeExecDashboard("accountant")).toBe(false);
    expect(canSeeExecDashboard("hr")).toBe(false);
    expect(canSeeExecDashboard(null)).toBe(false);
  });
  it("Team Dashboard — เฉพาะ acc_lead", () => {
    expect(canSeeTeamDashboard("acc_lead")).toBe(true);
    expect(canSeeTeamDashboard("accountant")).toBe(false);
    expect(canSeeTeamDashboard("admin")).toBe(false);
    expect(canSeeTeamDashboard(null)).toBe(false);
  });
  it("Me Dashboard — เฉพาะ accountant", () => {
    expect(canSeeMeDashboard("accountant")).toBe(true);
    expect(canSeeMeDashboard("acc_lead")).toBe(false);
    expect(canSeeMeDashboard(null)).toBe(false);
  });
  it("Risk Dashboard — privileged + cs + acc_lead", () => {
    for (const r of ["admin", "executive", "auditor_qa", "cs", "acc_lead"]) {
      expect(canSeeRiskDashboard(r)).toBe(true);
    }
    expect(canSeeRiskDashboard("accountant")).toBe(false);
    expect(canSeeRiskDashboard("hr")).toBe(false);
    expect(canSeeRiskDashboard(null)).toBe(false);
  });
  it("Chat viewer — privileged/acc_lead/accountant (ไม่ใช่ hr/cs)", () => {
    expect(canAccessChatViewer("admin")).toBe(true);
    expect(canAccessChatViewer("acc_lead")).toBe(true);
    expect(canAccessChatViewer("accountant")).toBe(true);
    expect(canAccessChatViewer("hr")).toBe(false);
    expect(canAccessChatViewer("cs")).toBe(false);
    expect(canAccessChatViewer(null)).toBe(false);
  });
});

describe("canDecryptChat — ★ hr/cs ไม่เห็นเนื้อหาแชตดิบ", () => {
  it("privileged ถอดได้เสมอ", () => {
    expect(canDecryptChat(admin, "any")).toBe(true);
    expect(canDecryptChat(executive, "any")).toBe(true);
    expect(canDecryptChat(auditor, "any")).toBe(true);
  });
  it("★ hr ถอดไม่ได้เด็ดขาด", () => {
    expect(canDecryptChat(hr, "any")).toBe(false);
  });
  it("★ cs ถอดไม่ได้ (เห็นแค่หน้าเสี่ยง ไม่เห็นแชตดิบ)", () => {
    expect(canDecryptChat(cs, "any")).toBe(false);
  });
  it("accountant ถอดได้เฉพาะเคสของตัวเอง", () => {
    expect(canDecryptChat(accountant("e1"), "e1")).toBe(true);
    expect(canDecryptChat(accountant("e1"), "e2")).toBe(false);
  });
  it("acc_lead ถอดได้เฉพาะลูกทีม", () => {
    expect(canDecryptChat(lead("L", ["e1"]), "e1")).toBe(true);
    expect(canDecryptChat(lead("L", ["e1"]), "e9")).toBe(false);
  });
  it("role null → default deny", () => {
    expect(canDecryptChat(noRole, "e1")).toBe(false);
  });
  it("owner null → accountant/lead ถอดไม่ได้", () => {
    expect(canDecryptChat(accountant("e1"), null)).toBe(false);
    expect(canDecryptChat(lead("L", ["e1"]), null)).toBe(false);
  });
});

describe("caseScopeForViewer — scope เคส/ความเสี่ยง (default-deny)", () => {
  it("privileged/cs → all", () => {
    expect(caseScopeForViewer(admin)).toEqual({ kind: "all" });
    expect(caseScopeForViewer(executive)).toEqual({ kind: "all" });
    expect(caseScopeForViewer(auditor)).toEqual({ kind: "all" });
    expect(caseScopeForViewer(cs)).toEqual({ kind: "all" });
  });
  it("★ accountant → owner (เฉพาะตัวเอง)", () => {
    expect(caseScopeForViewer(accountant("e1"))).toEqual({ kind: "owner", employeeId: "e1" });
  });
  it("acc_lead → team (ลูกทีม + ตัวเอง)", () => {
    const s = caseScopeForViewer(lead("L", ["e1", "e2"]));
    expect(s.kind).toBe("team");
    if (s.kind === "team") {
      expect(s.employeeIds).toEqual(expect.arrayContaining(["e1", "e2", "L"]));
    }
  });
  it("acc_lead ไม่มีลูกทีม → deny (กันหลุดทั้ง tenant)", () => {
    expect(caseScopeForViewer({ role: "acc_lead", employeeId: "L", tenantId: "t1", teamMemberIds: new Set() }))
      .toEqual({ kind: "team", employeeIds: ["L"] });
    // ไม่มีทั้งลูกทีมและ employeeId → deny
    expect(caseScopeForViewer({ role: "acc_lead", employeeId: null, tenantId: "t1", teamMemberIds: new Set() }))
      .toEqual({ kind: "deny" });
  });
  it("★ hr → deny (ไม่เห็นเคส/แชต)", () => {
    expect(caseScopeForViewer(hr)).toEqual({ kind: "deny" });
  });
  it("role null → deny", () => {
    expect(caseScopeForViewer(noRole)).toEqual({ kind: "deny" });
  });
});

describe("isChatPrivileged", () => {
  it("เฉพาะ admin/executive/auditor_qa", () => {
    expect(isChatPrivileged("admin")).toBe(true);
    expect(isChatPrivileged("cs")).toBe(false);
    expect(isChatPrivileged("acc_lead")).toBe(false);
    expect(isChatPrivileged(null)).toBe(false);
  });
});
