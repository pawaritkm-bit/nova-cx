import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server action `deleteChatGroupAction` (ลบกลุ่มทดสอบ — soft-delete)
 *   - ยืนยัน guard (requireAdminContext) + inject tenant/actor จาก session (ไม่เชื่อ client)
 *   - validate chatGroupId เป็น uuid ก่อนแตะ DB
 *   - guard throw → คืน error สุภาพ ไม่แตะ service
 * mock ชั้นล่าง (supabase/guard/service/next-cache) เพื่อทดสอบเฉพาะ logic ของ action
 */
const { deleteChatGroupMock, requireAdminContextMock } = vi.hoisted(() => ({
  deleteChatGroupMock: vi.fn(),
  requireAdminContextMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/admin/guard", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/admin/guard")>();
  return {
    ...actual,
    requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
  };
});

vi.mock("@/lib/chat-admin/group", () => ({
  deleteChatGroup: (...args: unknown[]) => deleteChatGroupMock(...args),
}));

import { deleteChatGroupAction } from "@/lib/chat-admin/actions";
import { AdminAuthError } from "@/lib/admin/guard";

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminContextMock.mockResolvedValue({ tenantId: "tenant-9", role: "admin", userId: "user-7" });
  deleteChatGroupMock.mockResolvedValue(undefined);
});

describe("deleteChatGroupAction", () => {
  it("สำเร็จ: เรียก deleteChatGroup ด้วย tenant/actor จาก session (ไม่ใช่ client)", async () => {
    const res = await deleteChatGroupAction(null, fd({ chat_group_id: GROUP }));
    expect(res.ok).toBe(true);
    expect(deleteChatGroupMock).toHaveBeenCalledTimes(1);
    const [, tenantId, groupId, actor] = deleteChatGroupMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9"); // ★ จาก session
    expect(groupId).toBe(GROUP);
    expect(actor).toBe("user-7"); // ★ actor จาก session
  });

  it("ล้มเหลว: chat_group_id ไม่ใช่ uuid → ไม่แตะ service", async () => {
    const res = await deleteChatGroupAction(null, fd({ chat_group_id: "nope" }));
    expect(res.ok).toBe(false);
    expect(deleteChatGroupMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ service", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await deleteChatGroupAction(null, fd({ chat_group_id: GROUP }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(deleteChatGroupMock).not.toHaveBeenCalled();
  });
});
