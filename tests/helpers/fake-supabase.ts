import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fake Supabase client (chainable) สำหรับ unit test ชั้น service
 *   - รองรับ select/insert/update + eq/is/in/gte/lt/order/limit
 *   - terminal: single / maybeSingle / await (then)
 *   - resolver ตัดสินผลจาก { table, op, terminal, payload } — เก็บ inserts/updates ไว้ตรวจ
 */
export type ResolverArg = {
  table: string;
  op: string;
  terminal: "single" | "maybeSingle" | "await";
  payload: unknown;
};
export type Resolver = (q: ResolverArg) => { data?: unknown; error?: unknown };

export type FilterCall = { table: string; kind: "eq" | "in" | "gte" | "lt"; column: string; value: unknown };
export type Capture = {
  inserts: { table: string; payload: unknown }[];
  updates: { table: string; payload: unknown }[];
  filters: FilterCall[];
};

export function makeCapture(): Capture {
  return { inserts: [], updates: [], filters: [] };
}

export function makeFakeDb(resolver: Resolver, capture: Capture = makeCapture()): {
  db: SupabaseClient;
  capture: Capture;
} {
  class Query {
    op: string | undefined;
    payload: unknown;
    constructor(public table: string) {}
    select() {
      if (!this.op) this.op = "select";
      return this;
    }
    insert(p: unknown) {
      this.op = "insert";
      this.payload = p;
      capture.inserts.push({ table: this.table, payload: p });
      return this;
    }
    update(p: unknown) {
      this.op = "update";
      this.payload = p;
      capture.updates.push({ table: this.table, payload: p });
      return this;
    }
    eq(column?: string, value?: unknown) {
      if (column) capture.filters.push({ table: this.table, kind: "eq", column, value });
      return this;
    }
    is() { return this; }
    in(column?: string, value?: unknown) {
      if (column) capture.filters.push({ table: this.table, kind: "in", column, value });
      return this;
    }
    gte(column?: string, value?: unknown) {
      if (column) capture.filters.push({ table: this.table, kind: "gte", column, value });
      return this;
    }
    lt(column?: string, value?: unknown) {
      if (column) capture.filters.push({ table: this.table, kind: "lt", column, value });
      return this;
    }
    order() { return this; }
    limit() { return this; }
    single() {
      return Promise.resolve(resolver({ table: this.table, op: this.op ?? "select", terminal: "single", payload: this.payload }));
    }
    maybeSingle() {
      return Promise.resolve(resolver({ table: this.table, op: this.op ?? "select", terminal: "maybeSingle", payload: this.payload }));
    }
    then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(
        resolver({ table: this.table, op: this.op ?? "select", terminal: "await", payload: this.payload })
      ).then(onF, onR);
    }
  }
  const db = {
    from(table: string) {
      return new Query(table);
    },
  } as unknown as SupabaseClient;
  return { db, capture };
}
