import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fake Supabase client (chainable + thenable) สำหรับ unit test worker LINE
 * รองรับ: select/eq/in/not/is/lte/order/limit/maybeSingle/update/insert/upsert
 * บันทึก insert/update/upsert ให้ assert ได้
 */

export type Store = {
  /** ข้อมูลตั้งต้นต่อ table (array = list, object = single) */
  data: Record<string, unknown>;
  inserts: { table: string; rows: Record<string, unknown>[] }[];
  updates: { table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }[];
  upserts: { table: string; row: Record<string, unknown> }[];
  /** guarded update (claim / reminder mark) คืน null เพื่อจำลอง contention */
  guardedUpdateReturnsNull?: boolean;
  errors?: Record<string, { message: string }>;
};

export function makeStore(data: Record<string, unknown> = {}): Store {
  return { data, inserts: [], updates: [], upserts: [] };
}

class QB {
  private wantSingle = false;
  private isUpdate = false;
  private updatePayload: Record<string, unknown> = {};
  private filters: Record<string, unknown> = {};
  constructor(private table: string, private store: Store) {}

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
  not() {
    return this;
  }
  is() {
    return this;
  }
  lte() {
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
    this.isUpdate = true;
    this.updatePayload = payload;
    return this;
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    const arr = Array.isArray(rows) ? rows : [rows];
    this.store.inserts.push({ table: this.table, rows: arr });
    return Promise.resolve({ data: null, error: null });
  }
  upsert(row: Record<string, unknown>) {
    this.store.upserts.push({ table: this.table, row });
    return Promise.resolve({ data: null, error: null });
  }

  private result(): { data: unknown; error: unknown } {
    const err = this.store.errors?.[this.table] ?? null;

    if (this.isUpdate) {
      this.store.updates.push({
        table: this.table,
        payload: this.updatePayload,
        filters: { ...this.filters },
      });
      if (this.wantSingle) {
        // guarded update (claim / reminder mark)
        if (this.store.guardedUpdateReturnsNull) return { data: null, error: null };
        return { data: { id: this.filters.id ?? "row" }, error: null };
      }
      return { data: null, error: null };
    }

    if (err) return { data: null, error: err };

    const canned = this.store.data[this.table];
    if (this.wantSingle) {
      const single = Array.isArray(canned) ? canned[0] ?? null : canned ?? null;
      return { data: single, error: null };
    }
    const arr = Array.isArray(canned) ? canned : canned ? [canned] : [];
    return { data: arr, error: null };
  }

  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.result()).then(onF);
  }
}

export function makeDb(store: Store): SupabaseClient {
  const db = {
    from(table: string) {
      return new QB(table, store);
    },
  };
  return db as unknown as SupabaseClient;
}
