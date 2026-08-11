import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fake Supabase client "แบบ in-memory จริง" (มี state + filter/insert/update/delete จริง) — ใช้กับเทสต์
 *   data layer ของเฟส 9 (Payroll) ที่ต้องจำลอง query หลายจุดต่อเนื่องกัน (เช่น recalcRunLines/
 *   createDraftRun ที่ query หลายตารางในลำดับที่ผลลัพธ์ของ query ก่อนหน้าต้องสอดคล้องกับ query ถัดไปจริง ๆ)
 *   — ต่างจาก `fake-supabase.ts` (generic resolver คืนค่า canned ตาม table/op/terminal เฉย ๆ ไม่มี state จริง
 *   เหมาะกับเทสต์ actions.ts ที่ guard/สโคปเป็นหลัก) — mirror แนวคิดเดียวกับ mock DB inline ของ
 *   tests/accounting/fixed-assets.test.ts แต่แยกเป็น helper กลางใช้ซ้ำได้หลายไฟล์ (payroll-employees/
 *   payroll-settings/payroll-config/payroll.test.ts)
 */

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type FilterOp = "eq" | "is" | "in" | "lte" | "gte" | "lt" | "gt";
type Filter = { col: string; op: FilterOp; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    switch (f.op) {
      case "eq":
        return v === f.val;
      case "is":
        return f.val === null ? v === null || v === undefined : v === f.val;
      case "in":
        return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
      case "lte":
        return (v as string | number) <= (f.val as string | number);
      case "gte":
        return (v as string | number) >= (f.val as string | number);
      case "lt":
        return (v as string | number) < (f.val as string | number);
      case "gt":
        return (v as string | number) > (f.val as string | number);
      default:
        return true;
    }
  });
}

export type UniqueIndex = {
  table: string;
  columns: string[];
  /** เงื่อนไขเพิ่มเติม (เช่น "เฉพาะแถวที่ deleted_at is null" — partial unique index) */
  where?: (row: Row) => boolean;
};

/** ★ ใช้จำลอง DB error ชั่วคราวที่ precheck ตรวจไม่พบ (เช่น insert/update chunk ใดชิ้นหนึ่งล้มเหลว) — consume
 *   ครั้งเดียวแล้วลบทิ้ง (ครั้งต่อไป table+mode เดียวกันทำงานปกติ) mirror pattern เดียวกับ
 *   tests/accounting/fixed-assets.test.ts::ForceError */
export type ForceError = { table: string; mode: "insert" | "update" | "delete" | "select"; message: string };

/** สร้าง fake DB in-memory — `tables` เป็น object อ้างอิง (mutate ได้ตรง ๆ จากเทสต์เพื่อ setup ข้อมูลล่วงหน้า) */
export function makeInMemoryDb(
  tables: Tables,
  opts: { uniqueIndexes?: UniqueIndex[]; idPrefix?: string; forceErrors?: ForceError[] } = {}
): { db: SupabaseClient; tables: Tables; forceErrors: ForceError[] } {
  let seq = 1;
  const nextId = (table: string) => `${opts.idPrefix ?? table}-${seq++}`;
  const forceErrors: ForceError[] = opts.forceErrors ?? [];
  function consumeForceError(table: string, mode: string): string | null {
    const idx = forceErrors.findIndex((f) => f.table === table && f.mode === mode);
    if (idx === -1) return null;
    const [f] = forceErrors.splice(idx, 1);
    return f.message;
  }

  function checkUniqueViolation(table: string, row: Row, excludeId?: string): boolean {
    const indexes = (opts.uniqueIndexes ?? []).filter((u) => u.table === table);
    if (indexes.length === 0) return false;
    const existing = tables[table] ?? [];
    for (const idx of indexes) {
      const clash = existing.some((r) => {
        if (excludeId && r.id === excludeId) return false;
        if (idx.where && !idx.where(r)) return false;
        return idx.columns.every((c) => r[c] === row[c]);
      });
      if (clash) return true;
    }
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function qb(table: string): any {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown;
    const orderSpecs: { col: string; asc: boolean }[] = [];
    let limitN: number | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "is", val: v });
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.lte = (c: string, v: unknown) => {
      filters.push({ col: c, op: "lte", val: v });
      return api;
    };
    api.gte = (c: string, v: unknown) => {
      filters.push({ col: c, op: "gte", val: v });
      return api;
    };
    api.lt = (c: string, v: unknown) => {
      filters.push({ col: c, op: "lt", val: v });
      return api;
    };
    api.order = (c: string, o?: { ascending?: boolean }) => {
      orderSpecs.push({ col: c, asc: o?.ascending !== false });
      return api;
    };
    api.limit = (n: number) => {
      limitN = n;
      return api;
    };
    api.insert = (p: unknown) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.update = (p: unknown) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };

    function selectRows(): Row[] {
      tables[table] ??= [];
      let out = tables[table].filter((r) => matchRow(r, filters));
      for (const spec of [...orderSpecs].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[spec.col] as string | number;
          const bv = b[spec.col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (spec.asc ? 1 : -1);
        });
      }
      if (limitN !== undefined) out = out.slice(0, limitN);
      return out;
    }

    function commit(): { rows: Row[]; error: { code?: string; message: string } | null } {
      tables[table] ??= [];
      const forced = consumeForceError(table, mode);
      if (forced) return { rows: [], error: { message: forced } };
      if (mode === "insert") {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const now = new Date().toISOString();
        const toInsert = arr.map((p) => ({ id: nextId(table), created_at: now, updated_at: now, ...p }));
        for (const row of toInsert) {
          if (checkUniqueViolation(table, row)) {
            return { rows: [], error: { code: "23505", message: `duplicate key value violates unique constraint on ${table}` } };
          }
        }
        tables[table].push(...toInsert);
        return { rows: toInsert, error: null };
      }
      if (mode === "update") {
        const matched = tables[table].filter((r) => matchRow(r, filters));
        for (const r of matched) {
          const merged = { ...r, ...(payload as Row) };
          if (checkUniqueViolation(table, merged, r.id as string)) {
            return { rows: [], error: { code: "23505", message: `duplicate key value violates unique constraint on ${table}` } };
          }
        }
        for (const r of matched) Object.assign(r, payload as Row);
        return { rows: matched, error: null };
      }
      if (mode === "delete") {
        const matched = tables[table].filter((r) => matchRow(r, filters));
        tables[table] = tables[table].filter((r) => !matched.includes(r));
        return { rows: matched, error: null };
      }
      return { rows: selectRows(), error: null };
    }

    api.maybeSingle = async () => {
      const { rows, error } = commit();
      if (error) return { data: null, error };
      return { data: rows[0] ?? null, error: null };
    };
    api.single = async () => {
      const { rows, error } = commit();
      if (error) return { data: null, error };
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      const { rows, error } = commit();
      return Promise.resolve({ data: error ? null : rows, error }).then(onF, onR);
    };
    return api;
  }

  const db = { from: (t: string) => qb(t) } as unknown as SupabaseClient;
  return { db, tables, forceErrors };
}
