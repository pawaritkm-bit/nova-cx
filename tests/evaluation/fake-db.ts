import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fake Supabase client (chainable + thenable) สำหรับ unit test ชั้น evaluation
 *   - รองรับ eq/in/is/gte/lte/not/order/limit/select/insert/update/delete/maybeSingle
 *   - eq รองรับ json path 'payload->>key' (ดึงจาก row.payload[key])
 *   - rpc: บันทึก call + คืนผลตาม rpcResults[name] (default success)
 */

export type Store = {
  data: Record<string, Record<string, unknown>[]>;
  rpcCalls: { name: string; params: Record<string, unknown> }[];
  rpcResults: Record<string, { data: unknown; error: unknown }>;
  inserts: Record<string, Record<string, unknown>[]>;
  insertError?: Record<string, { code?: string } | undefined>;
};

class QB {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private eqFilters: [string, unknown][] = [];
  private inFilters: [string, unknown[]][] = [];
  private wantSingle = false;
  private payload: Record<string, unknown> = {};

  constructor(private table: string, private store: Store) {}

  select() {
    return this;
  }
  insert(payload: Record<string, unknown>) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Record<string, unknown>) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqFilters.push([col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.inFilters.push([col, vals]);
    return this;
  }
  is() {
    return this;
  }
  gte() {
    return this;
  }
  lte() {
    return this;
  }
  not() {
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

  private getCol(row: Record<string, unknown>, col: string): unknown {
    if (col.includes("->>")) {
      const [base, key] = col.split("->>");
      const obj = row[base];
      return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
    }
    return row[col];
  }

  private rows(): Record<string, unknown>[] {
    const all = this.store.data[this.table] ?? [];
    return all.filter((r) => {
      for (const [col, val] of this.eqFilters) {
        if (this.getCol(r, col) !== val) return false;
      }
      for (const [col, vals] of this.inFilters) {
        if (!vals.includes(this.getCol(r, col))) return false;
      }
      return true;
    });
  }

  private terminal(): { data: unknown; error: unknown } {
    if (this.op === "insert") {
      const list = this.store.inserts[this.table] ?? [];
      list.push(this.payload);
      this.store.inserts[this.table] = list;
      const err = this.store.insertError?.[this.table];
      return { data: null, error: err ?? null };
    }
    if (this.op === "update" || this.op === "delete") {
      return { data: this.wantSingle ? { id: "x" } : null, error: null };
    }
    const rows = this.rows();
    if (this.wantSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.terminal()).then(onF);
  }
}

export function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    data: {},
    rpcCalls: [],
    rpcResults: {},
    inserts: {},
    ...overrides,
  };
}

export function makeDb(store: Store): SupabaseClient {
  return {
    from(table: string) {
      return new QB(table, store);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      store.rpcCalls.push({ name, params });
      return (
        store.rpcResults[name] ?? {
          data: { evaluation_id: "eval-1", created: true, appeal_id: "ap-1", to_status: "manager_confirmed", from_status: "ai_draft", decision: "accepted" },
          error: null,
        }
      );
    },
    auth: {
      async getUser() {
        return { data: { user: null }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}
