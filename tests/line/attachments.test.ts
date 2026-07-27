import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * processPendingAttachments (เฟส 1 — ดึงรูปบิล LINE → storage abstraction)
 *   ครอบเส้นทางหลักตามผลรีวิว (rev รอบ 2):
 *     - inert: storage backend ยังไม่พร้อม → disabled ไม่แตะ DB
 *     - claim atomic: คว้าไม่ได้ (worker อื่นชิง) → ข้าม ไม่อัป/ไม่นับ
 *     - เขียนแบบ 2 สเต็ป (link → stored) กัน orphan
 *     - dedup ข้ามรอบ (sha256 ซ้ำ มี drive_url) → reuse ไม่อัปซ้ำ
 *     - in-batch dedup (sha256 ซ้ำในรอบเดียว) → อัปครั้งเดียว
 *     - upload สำเร็จแต่ write DB พลาด → mark failed (retry จะ reuse ผ่าน dedup)
 *     - store คืน null (upload ล้ม) → mark failed 'storage_upload_failed'
 */

// --- mock ชั้น storage/bill-storage + line/client (คุมพฤติกรรมภายนอกทั้งหมด) ---
const isBillStorageEnabledMock = vi.fn<() => boolean>();
const storeBillFileMock = vi.fn();

vi.mock("@/lib/storage/bill-storage", () => ({
  isBillStorageEnabled: () => isBillStorageEnabledMock(),
  storeBillFile: (params: unknown) => storeBillFileMock(params),
}));

const getMessageContentMock = vi.fn();
const getLineClientMock = vi.fn();
vi.mock("@/lib/line/client", () => ({
  getLineClient: (oa: string) => getLineClientMock(oa),
}));

import { processPendingAttachments } from "@/lib/line/attachments";

// ---------------------------------------------------------------------
// Fake DB เฉพาะ message_attachments — จำลอง semantics ของ query แต่ละแบบ
//   - select แบบ list (candidate queue)   → คืน candidates[]
//   - update + maybeSingle (claim)         → คืนตาม claimResult ต่อ id
//   - select + maybeSingle (dedup)         → คืนตาม dedupResult ต่อ sha256
//   - update ธรรมดา (link/stored/failed)   → บันทึกลง updates[]
// ---------------------------------------------------------------------
type UpdateRec = { payload: Record<string, unknown>; filters: Record<string, unknown> };

type FakeConfig = {
  candidates: Record<string, unknown>[];
  /** claim ต่อ id: true = คว้าได้, false = คว้าไม่ได้ (worker อื่นชิง) */
  claim?: (id: string) => boolean;
  /** dedup ต่อ sha256: คืน row หรือ null */
  dedup?: (sha256: string) => { drive_file_id: string | null; drive_url: string | null } | null;
  /** ให้ update ธรรมดา (link/stored/failed) คืน error สำหรับ id ที่ระบุ */
  updateError?: (payload: Record<string, unknown>, id: string) => { code?: string } | null;
};

function makeFakeDb(cfg: FakeConfig) {
  const updates: UpdateRec[] = [];
  const claims: string[] = [];

  class QB {
    private mode: "select" | "update" = "select";
    private wantSingle = false;
    private payload: Record<string, unknown> = {};
    private filters: Record<string, unknown> = {};
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters[col] = val;
      return this;
    }
    in() {
      return this;
    }
    lt() {
      return this;
    }
    or() {
      return this;
    }
    not() {
      return this;
    }
    is() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    update(payload: Record<string, unknown>) {
      this.mode = "update";
      this.payload = payload;
      return this;
    }
    private result(): { data: unknown; error: unknown } {
      if (this.mode === "update") {
        const id = String(this.filters.id);
        // claim = update({fetch_status:'processing'}) + maybeSingle
        if (this.wantSingle && this.payload.fetch_status === "processing") {
          claims.push(id);
          const ok = cfg.claim ? cfg.claim(id) : true;
          return { data: ok ? { id } : null, error: null };
        }
        // update ธรรมดา (link / stored / failed)
        const err = cfg.updateError ? cfg.updateError(this.payload, id) : null;
        updates.push({ payload: this.payload, filters: { ...this.filters } });
        return { data: null, error: err };
      }
      // select
      if (this.wantSingle) {
        // dedup query (มี filter sha256)
        const sha = this.filters.sha256 as string | undefined;
        const row = sha && cfg.dedup ? cfg.dedup(sha) : null;
        return { data: row, error: null };
      }
      // candidate list
      return { data: cfg.candidates, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
      return Promise.resolve(this.result()).then(onF);
    }
  }

  const db = { from: (t: string) => new QB(t) } as unknown as SupabaseClient;
  return { db, updates, claims };
}

/** candidate row มาตรฐาน (มี context กลุ่ม/ลูกค้า/OA) */
function candRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "att-1",
    tenant_id: "t1",
    line_content_id: "msg-1",
    created_at: "2026-07-18T09:00:00Z",
    fetch_attempts: 0,
    chat_messages: {
      sent_at: "2026-07-18T09:00:00Z",
      chat_groups: {
        customer_id: "c1",
        display_name_enc: null,
        customers: { name: "ลูกค้า A", customer_code: "C001" },
        chat_channels: { oa_type: "care" },
      },
    },
    ...over,
  };
}

function lineClientReturning(data: Buffer | null, mime = "image/jpeg") {
  getMessageContentMock.mockResolvedValue(data ? { data, mime } : null);
  return {
    oa: "care",
    getMessageContent: getMessageContentMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isBillStorageEnabledMock.mockReturnValue(true);
  storeBillFileMock.mockResolvedValue({ objectPath: "t1/cust/2026-07/x.jpg", url: "https://signed/x" });
  getLineClientMock.mockImplementation(() => lineClientReturning(Buffer.from("IMG")));
});

describe("processPendingAttachments — inert-by-default", () => {
  it("storage backend ยังไม่พร้อม → disabled และไม่แตะ DB เลย", async () => {
    isBillStorageEnabledMock.mockReturnValue(false);
    // db ที่ throw ถ้าถูกเรียก — พิสูจน์ว่าไม่แตะ DB
    const throwingDb = {
      from() {
        throw new Error("DB must not be touched when disabled");
      },
    } as unknown as SupabaseClient;

    const res = await processPendingAttachments(throwingDb);
    expect(res.disabled).toBe(true);
    expect(res.processed).toBe(0);
    expect(storeBillFileMock).not.toHaveBeenCalled();
  });
});

describe("processPendingAttachments — happy path (2-step write)", () => {
  it("อัปแล้วเขียน link ก่อน แล้วค่อย set stored (แยก 2 สเต็ป)", async () => {
    const { db, updates, claims } = makeFakeDb({ candidates: [candRow()] });

    const res = await processPendingAttachments(db);

    expect(res.stored).toBe(1);
    expect(res.processed).toBe(1);
    expect(storeBillFileMock).toHaveBeenCalledTimes(1);
    expect(claims).toEqual(["att-1"]); // claim ก่อนทำงาน

    // สเต็ป A: เขียน storage ref (drive_url) แต่ยังไม่ set stored
    const linkStep = updates.find((u) => "drive_url" in u.payload);
    expect(linkStep?.payload.drive_url).toBe("https://signed/x");
    expect(linkStep?.payload.drive_file_id).toBe("t1/cust/2026-07/x.jpg");
    expect(linkStep?.payload.fetch_status).toBeUndefined();
    // สเต็ป B: set stored แยกต่างหาก
    const storedStep = updates.find((u) => u.payload.fetch_status === "stored");
    expect(storedStep).toBeTruthy();
  });
});

describe("processPendingAttachments — claim atomic (race)", () => {
  it("คว้าไม่ได้ (worker อื่นชิง) → ข้าม ไม่อัป ไม่นับ processed", async () => {
    const { db, updates } = makeFakeDb({
      candidates: [candRow()],
      claim: () => false, // จำลอง contention: claim คืน null
    });

    const res = await processPendingAttachments(db);

    expect(res.processed).toBe(0);
    expect(res.stored).toBe(0);
    expect(storeBillFileMock).not.toHaveBeenCalled();
    expect(getMessageContentMock).not.toHaveBeenCalled();
    // ไม่มี update อื่นนอกจาก claim
    expect(updates).toHaveLength(0);
  });
});

describe("processPendingAttachments — dedup ข้ามรอบ", () => {
  it("sha256 ซ้ำ (มี drive_url) → reuse ลิงก์เดิม ไม่อัปซ้ำ นับเป็น skipped", async () => {
    const { db, updates } = makeFakeDb({
      candidates: [candRow()],
      dedup: () => ({ drive_file_id: "old-file", drive_url: "https://drive/old" }),
    });

    const res = await processPendingAttachments(db);

    expect(res.skipped).toBe(1);
    expect(res.stored).toBe(0);
    expect(storeBillFileMock).not.toHaveBeenCalled(); // ไม่อัปซ้ำ
    const reuse = updates.find((u) => u.payload.drive_url === "https://drive/old");
    expect(reuse?.payload.fetch_status).toBe("stored"); // reuse ปิดงานเป็น stored ในสเต็ปเดียว
  });
});

describe("processPendingAttachments — in-batch dedup", () => {
  it("sha256 ซ้ำในรอบเดียว → อัปครั้งเดียว แถวที่เหลือ reuse", async () => {
    // สองแถว content เดียวกัน → sha256 เท่ากัน; dedup DB คืน null (ยังไม่มีใน DB)
    const { db } = makeFakeDb({
      candidates: [candRow({ id: "att-1" }), candRow({ id: "att-2", line_content_id: "msg-2" })],
      dedup: () => null,
    });

    const res = await processPendingAttachments(db);

    expect(res.processed).toBe(2);
    expect(res.stored).toBe(1); // แถวแรกอัปจริง
    expect(res.skipped).toBe(1); // แถวสอง reuse ใน batch
    expect(storeBillFileMock).toHaveBeenCalledTimes(1); // อัปครั้งเดียว
  });
});

describe("processPendingAttachments — upload สำเร็จแต่ write DB พลาด", () => {
  it("เขียน link พลาด → mark failed (retry รอบหน้าจะ reuse ผ่าน dedup)", async () => {
    const { db, updates } = makeFakeDb({
      candidates: [candRow()],
      updateError: (payload) => ("drive_url" in payload ? { code: "XX" } : null),
    });

    const res = await processPendingAttachments(db);

    expect(res.stored).toBe(0);
    expect(res.failed).toBe(1);
    const failedStep = updates.find((u) => u.payload.fetch_status === "failed");
    expect(failedStep?.payload.fetch_error).toBe("db_link_write_failed");
    expect(failedStep?.payload.fetch_attempts).toBe(1); // attempts +1
  });
});

describe("processPendingAttachments — storeBillFile ล้ม (คืน null)", () => {
  it("อัป storage ไม่สำเร็จ → mark failed 'storage_upload_failed' + attempts +1", async () => {
    storeBillFileMock.mockResolvedValue(null); // จำลอง upload ล้ม (จับ error ภายในแล้วคืน null)
    const { db, updates } = makeFakeDb({ candidates: [candRow()], dedup: () => null });

    const res = await processPendingAttachments(db);

    expect(res.stored).toBe(0);
    expect(res.failed).toBe(1);
    const failedStep = updates.find((u) => u.payload.fetch_status === "failed");
    expect(failedStep?.payload.fetch_error).toBe("storage_upload_failed");
    expect(failedStep?.payload.fetch_attempts).toBe(1);
    // ไม่มีการเขียน storage ref เพราะ store ล้มก่อน
    expect(updates.some((u) => "drive_url" in u.payload)).toBe(false);
  });
});
