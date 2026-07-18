import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fake Supabase client (chainable + thenable) สำหรับ unit test worker/ingest LINE
 * รองรับ: select/eq/in/not/is/lte/order/limit/maybeSingle/update/insert/upsert
 * บันทึก insert/update/upsert ให้ assert ได้
 *
 * insert/upsert เป็น chainable → รองรับ `.insert(row).select("id").maybeSingle()`
 *   (คืน row พร้อม id สังเคราะห์; upsert single จะ merge กับ canned data ของ table นั้น
 *    เพื่อจำลอง ON CONFLICT DO UPDATE ที่คืนค่าคอลัมน์เดิม เช่น customer_id)
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

type Mode = "select" | "insert" | "update" | "upsert";

class QB {
  private wantSingle = false;
  private mode: Mode = "select";
  private updatePayload: Record<string, unknown> = {};
  private insertRows: Record<string, unknown>[] = [];
  private upsertRow: Record<string, unknown> = {};
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
    this.mode = "update";
    this.updatePayload = payload;
    return this;
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    const arr = Array.isArray(rows) ? rows : [rows];
    this.mode = "insert";
    this.insertRows = arr;
    this.store.inserts.push({ table: this.table, rows: arr });
    return this;
  }
  upsert(row: Record<string, unknown>) {
    this.mode = "upsert";
    this.upsertRow = row;
    this.store.upserts.push({ table: this.table, row });
    return this;
  }

  /** canned single ของ table (object หรือ array[0]) */
  private cannedSingle(): Record<string, unknown> | null {
    const canned = this.store.data[this.table];
    if (Array.isArray(canned)) return (canned[0] as Record<string, unknown>) ?? null;
    return (canned as Record<string, unknown>) ?? null;
  }

  private withId(row: Record<string, unknown>): Record<string, unknown> {
    return { id: row.id ?? `${this.table}-id`, ...row };
  }

  private result(): { data: unknown; error: unknown } {
    const err = this.store.errors?.[this.table] ?? null;

    if (this.mode === "update") {
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

    if (this.mode === "insert") {
      if (this.wantSingle) {
        const first = this.insertRows[0] ?? {};
        return { data: this.withId(first), error: null };
      }
      return { data: null, error: null };
    }

    if (this.mode === "upsert") {
      if (this.wantSingle) {
        // จำลอง ON CONFLICT DO UPDATE ... RETURNING: merge canned เดิม + ค่าที่ส่ง
        const canned = this.cannedSingle() ?? {};
        const merged = { ...canned, ...this.upsertRow };
        return { data: this.withId(merged), error: null };
      }
      return { data: null, error: null };
    }

    // select
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
