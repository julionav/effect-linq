/**
 * Change tracking: a session remembers the rows it loads, and `saveChanges`
 * writes back whatever was changed on them since.
 *
 * - Rows are plain mutable objects; there are no proxies. Changes are found
 *   by comparing each row with a snapshot taken when it was loaded.
 * - Snapshots are stored by column (one array per column, per table), and the
 *   code that takes and compares them is generated for each table, so that
 *   the hot loops are straight-line property reads the JIT can specialize.
 * - A session holds one object per primary key (an identity map).
 * - `saveChanges` runs in one transaction and batches: one INSERT per table,
 *   one UPDATE per table and set of changed columns, one DELETE per table.
 *
 * A session is a unit of work for one fiber; it is not safe to share.
 */
import { Cause, Data, Effect, Equal, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { fail, LinqError } from "./errors.ts";
import { bind, compileInsert, insertBatchSize } from "./mutate.ts";
import {
  type IsOpaque,
  type Leaf,
  type Materialize,
  type Query,
  onClient,
  type QueryEffect,
  runPlan,
} from "./query.ts";
import { compileFrag, type Frag, ident, join } from "./sql.ts";
import type { AnyTable, Column, InsertOf, RowOf } from "./table.ts";
import { callable, compileQuery, type Op, type Plan, tableName } from "./translate.ts";

/** A row was changed or deleted by someone else since this session read it. */
export class ConcurrencyError extends Data.TaggedError("ConcurrencyError")<{
  readonly table: string;
  readonly operation: "update" | "delete";
  readonly expected: number;
  readonly actual: number;
}> {
  override get message(): string {
    return (
      `${this.operation} of ${this.expected} row(s) of "${this.table}" affected ${this.actual}: ` +
      "the data was changed or deleted since it was loaded"
    );
  }
}

/** A loaded row, writable: assign to its columns and call `saveChanges`. */
export type Tracked<A> = A extends Leaf
  ? A
  : A extends ReadonlyArray<infer E>
    ? Array<Tracked<E>>
    : IsOpaque<A> extends true
      ? A
      : { -readonly [K in keyof A]: Tracked<A[K]> };

export type EntityState = "unchanged" | "modified" | "added" | "deleted";

export interface Change {
  readonly table: string;
  readonly state: Exclude<EntityState, "unchanged">;
  readonly entity: object;
  /** the changed properties, for a modified row */
  readonly columns: ReadonlyArray<string>;
}

type Row = Record<string, any>;

// --------------------------------------------------------------- snapshots

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * What is remembered of a column value. Immutable values are kept as they
 * are; values that can be changed in place (dates, bytes, arrays and plain
 * objects) are copied, so that `row.tags.push("x")` is noticed too. Other
 * objects (DateTime, Option, class instances) are taken to be immutable.
 */
const snapshotValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: Array<unknown> = [];
    for (let i = 0; i < value.length; i++) out.push(snapshotValue(value[i]));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  if (isPlain(value)) {
    const out: Row = {};
    for (const key in value) out[key] = snapshotValue((value as Row)[key]);
    return out;
  }
  return value;
};

const unchanged = (before: unknown, now: unknown): boolean => {
  if (now === null || typeof now !== "object") return Object.is(before, now);
  if (before === null || typeof before !== "object") return false;
  if (Array.isArray(now)) {
    if (!Array.isArray(before) || before.length !== now.length) return false;
    for (let i = 0; i < now.length; i++) {
      const a = before[i];
      const b = now[i];
      // the common case, an array of strings or numbers, without a call
      if (a !== b && (typeof b !== "object" || !unchanged(a, b))) {
        if (typeof b === "object" || !Object.is(a, b)) return false;
      }
    }
    return true;
  }
  if (now instanceof Date) return before instanceof Date && before.getTime() === now.getTime();
  if (now instanceof Uint8Array) {
    if (!(before instanceof Uint8Array) || before.length !== now.length) return false;
    for (let i = 0; i < now.length; i++) if (before[i] !== now[i]) return false;
    return true;
  }
  if (isPlain(now)) {
    if (!isPlain(before)) return false;
    for (const key in now) {
      if (!unchanged((before as Row)[key], (now as Row)[key])) return false;
    }
    // a property that is absent is the same as one set to undefined
    for (const key in before) {
      if (!(key in now) && (before as Row)[key] !== undefined) return false;
    }
    return true;
  }
  return before === now || Equal.equals(before, now);
};

/**
 * How a value of a known shape is copied and compared, as generated code:
 * `true` for a JavaScript primitive (kept as it is, compared with `===`),
 * the name of a pair of generated functions `<name>_same` / `<name>_copy` for
 * arrays and structs of such values, or undefined when the shape is not known
 * (dates, class instances, records, unions) and the generic code is used.
 *
 * A generated `_same` may answer false for values that are equal (NaN, a
 * value of an unexpected shape), never true for values that differ.
 */
type Shape = true | string | undefined;

const PRIMITIVES = new Set(["String", "Number", "Boolean", "BigInt", "Null", "Undefined"]);

const shapeOf = (ast: any, helpers: Array<string>): Shape => {
  if (PRIMITIVES.has(ast._tag)) return true;
  if (ast._tag === "Literal") return typeof ast.literal !== "object" ? true : undefined;
  if (ast._tag === "Union") {
    // `T | null | undefined` has the shape of T: the generated functions accept both
    const rest = (ast.types as Array<any>).filter(
      (type) => type._tag !== "Null" && type._tag !== "Undefined",
    );
    if (rest.length === 1) return shapeOf(rest[0], helpers);
    return rest.every((type) => shapeOf(type, []) === true) ? true : undefined;
  }
  const name = `f${helpers.length}`;
  if (ast._tag === "Declaration") {
    const id: unknown = ast.annotations?.representation?.id;
    if (typeof id !== "string" || !id.endsWith("/Date")) return undefined;
    helpers.push(`
      function ${name}_same(a, b) {
        return a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());
      }
      function ${name}_copy(v) {
        return v instanceof Date ? new Date(v.getTime()) : snapshot(v);
      }`);
    return name;
  }
  if (ast._tag === "Arrays" && ast.elements.length === 0 && ast.rest.length === 1) {
    helpers.push(""); // reserve the name before descending
    const slot = helpers.length - 1;
    const item = shapeOf(ast.rest[0], helpers);
    if (item === undefined) return undefined;
    helpers[slot] = `
      function ${name}_same(a, b) {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < b.length; i++) {
          if (${item === true ? "a[i] !== b[i]" : `!${item}_same(a[i], b[i])`}) return false;
        }
        return true;
      }
      function ${name}_copy(v) {
        if (!Array.isArray(v)) return snapshot(v);
        ${
          item === true
            ? "return v.slice();"
            : `const out = []; for (let i = 0; i < v.length; i++) out.push(${item}_copy(v[i])); return out;`
        }
      }`;
    return name;
  }
  if (ast._tag === "Objects" && ast.indexSignatures.length === 0) {
    helpers.push("");
    const slot = helpers.length - 1;
    const tests: Array<string> = [];
    const copies: Array<string> = [];
    for (const property of ast.propertySignatures) {
      if (typeof property.name !== "string") return undefined;
      const key = `[${JSON.stringify(property.name)}]`;
      const shape = shapeOf(property.type, helpers);
      if (shape === undefined) return undefined;
      tests.push(shape === true ? `a${key} === b${key}` : `${shape}_same(a${key}, b${key})`);
      copies.push(
        `${JSON.stringify(property.name)}: ${shape === true ? `v${key}` : `${shape}_copy(v${key})`}`,
      );
    }
    helpers[slot] = `
      function ${name}_same(a, b) {
        if (a === b) return true;
        if (!plain(a) || !plain(b)) return false;
        return ${tests.length === 0 ? "true" : tests.join(" && ")};
      }
      function ${name}_copy(v) {
        return plain(v) ? { ${copies.join(", ")} } : snapshot(v);
      }`;
    return name;
  }
  return undefined;
};

const isPlainObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && isPlain(value);

const keyPart = (col: Column, value: unknown): string => {
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  try {
    return JSON.stringify(col.write(value), (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  } catch {
    return "?";
  }
};

/** The identity-map key of a row: the primary key value, or a string for a composite one. */
const keyOf = (pk: ReadonlyArray<Column>, row: Row): unknown => {
  if (pk.length === 1) {
    const value = row[pk[0]!.key];
    return typeof value === "object" && value !== null ? keyPart(pk[0]!, value) : value;
  }
  // each part is quoted, so no value can imitate the separator
  let key = "";
  for (let i = 0; i < pk.length; i++) key += `${JSON.stringify(keyPart(pk[i]!, row[pk[i]!.key]))},`;
  return key;
};

// ------------------------------------------------------------------- stores

const UNCHANGED = 0;
const DELETED = 1;
const FREE = 2;

/**
 * The tracked rows of one table, stored by column: slot `i` is the row
 * `entities[i]`, whose value for column `c` when it was read is `snaps[c][i]`.
 * There is no object per tracked row; the engine keeps arrays of numbers
 * unboxed, so a snapshot of numeric columns costs 8 bytes per value.
 */
class Store {
  readonly table: AnyTable;
  readonly columns: ReadonlyArray<Column>;
  readonly entities: Array<Row | undefined> = [];
  readonly states: Array<number> = [];
  readonly snaps: Array<Array<unknown>>;
  readonly index = new Map<unknown, number>();
  readonly counter = { live: 0 };
  /** Tracks a row that was read: returns it, or the object already tracked for its key. */
  readonly track: (row: Row) => Row;
  /** Appends to `out` the slots whose row may differ from its snapshot. */
  readonly scan: (out: Array<number>) => void;

  constructor(table: AnyTable) {
    this.table = table;
    this.columns = table.columnList;
    this.snaps = this.columns.map(() => []);
    const generated = generate(this);
    this.track = generated?.track ?? this.trackSlow;
    this.scan = generated?.scan ?? this.scanSlow;
  }

  /** A row with the same key is tracked already: it wins, relations loaded now are attached. */
  readonly merge = (slot: number, row: Row): Row => {
    const entity = this.entities[slot]!;
    for (const name in row) if (!(name in this.table.columns)) entity[name] = row[name];
    return entity;
  };

  readonly key = (row: Row): unknown => keyOf(this.table.primaryKey, row);

  // The generic versions of the generated functions (see `generate`), used
  // where code generation is not allowed.
  private readonly trackSlow = (row: Row): Row => {
    const key = this.key(row);
    const at = this.index.get(key);
    if (at !== undefined) return this.merge(at, row);
    const slot = this.entities.length;
    this.entities.push(row);
    this.states.push(UNCHANGED);
    for (let c = 0; c < this.columns.length; c++) {
      this.snaps[c]!.push(snapshotValue(row[this.columns[c]!.key]));
    }
    this.index.set(key, slot);
    this.counter.live++;
    return row;
  };

  private readonly scanSlow = (out: Array<number>): void => {
    for (let slot = 0; slot < this.entities.length; slot++) {
      if (this.states[slot] !== UNCHANGED) continue;
      const entity = this.entities[slot]!;
      for (let c = 0; c < this.columns.length; c++) {
        if (!unchanged(this.snaps[c]![slot], entity[this.columns[c]!.key])) {
          out.push(slot);
          break;
        }
      }
    }
  };

  /** The slot of a tracked object, or -1. */
  slotOf(entity: Row): number {
    const slot = this.index.get(this.key(entity));
    if (slot !== undefined && this.entities[slot] === entity) return slot;
    // its key may have been changed (an error when saving, but it must still
    // be possible to find the row, to detach it)
    return this.entities.indexOf(entity);
  }

  original(slot: number, col: Column): unknown {
    return this.snaps[this.columns.indexOf(col)]![slot];
  }

  /** The columns of a row that differ from its snapshot, compared exactly. */
  changed(slot: number): Array<Column> {
    const entity = this.entities[slot]!;
    let out: Array<Column> | undefined;
    for (let c = 0; c < this.columns.length; c++) {
      const col = this.columns[c]!;
      if (!unchanged(this.snaps[c]![slot], entity[col.key])) (out ??= []).push(col);
    }
    if (out === undefined) return NONE;
    for (const col of out) {
      if (this.table.primaryKey.includes(col)) {
        fail(
          `the primary key of a tracked row of "${this.table.name}" was changed ("${col.key}"); ` +
            "remove the row and add a new one instead",
        );
      }
    }
    return out;
  }

  /** Takes the row's current values as its new snapshot. */
  refresh(slot: number): void {
    const entity = this.entities[slot]!;
    for (let c = 0; c < this.columns.length; c++) {
      this.snaps[c]![slot] = snapshotValue(entity[this.columns[c]!.key]);
    }
  }

  drop(slot: number): void {
    const original: Row = {};
    for (const col of this.table.primaryKey) original[col.key] = this.original(slot, col);
    this.index.delete(this.key(original));
    this.entities[slot] = undefined;
    this.states[slot] = FREE;
    for (const snap of this.snaps) snap[slot] = undefined;
    this.counter.live--;
  }
}

/**
 * Generates `track` and `scan` for a table. Written out for a table with
 * columns `id`, `name` and `tags`, they are:
 *
 *     function track(row) {
 *       const key = row.id;
 *       const at = index.get(key);
 *       if (at !== undefined) return merge(at, row);
 *       entities.push(row); states.push(0);
 *       s0.push(row.id); s1.push(row.name); s2.push(snapshot(row.tags));
 *       index.set(key, entities.length - 1); counter.live++;
 *       return row;
 *     }
 *     function scan(out) {
 *       for (let i = 0; i < entities.length; i++) {
 *         if (states[i] !== 0) continue;
 *         const e = entities[i];
 *         if (e.id !== s0[i] || e.name !== s1[i] || !same(s2[i], e.tags)) out.push(i);
 *       }
 *     }
 *
 * `scan` may report a row that turns out to be unchanged (NaN, or an equal
 * object); `Store.changed` then compares exactly. It never misses one.
 */
const generate = (store: Store): { track: Store["track"]; scan: Store["scan"] } | undefined => {
  const { columns, table } = store;
  const prop = (col: Column): string => `[${JSON.stringify(col.key)}]`;
  const pk = table.primaryKey;
  const helpers: Array<string> = [];
  const shapes = columns.map((col) => {
    const known = helpers.length;
    const shape = shapeOf((Schema.toType(col.schema as any) as Schema.Top).ast, helpers);
    if (shape === undefined) helpers.length = known;
    return shape;
  });
  const keyExpr =
    pk.length === 1 && shapes[columns.indexOf(pk[0]!)] === true ? `row${prop(pk[0]!)}` : "key(row)";
  const pushes = columns
    .map((col, c) => {
      const shape = shapes[c];
      const value = `row${prop(col)}`;
      return `s${c}.push(${shape === true ? value : shape === undefined ? `snapshot(${value})` : `${shape}_copy(${value})`});`;
    })
    .join(" ");
  const tests = columns
    .map((col, c) => {
      const shape = shapes[c];
      const value = `e${prop(col)}`;
      if (shape === true) return `${value} !== s${c}[i]`;
      // an immutable object (DateTime, ...) is usually the very same one
      if (shape === undefined) return `(${value} !== s${c}[i] && !same(s${c}[i], ${value}))`;
      return `!${shape}_same(s${c}[i], ${value})`;
    })
    .join(" || ");
  const source = `
    ${helpers.join("\n")}
    ${columns.map((_, c) => `const s${c} = snaps[${c}];`).join(" ")}
    return {
      track(row) {
        const k = ${keyExpr};
        const at = index.get(k);
        if (at !== undefined) return merge(at, row);
        entities.push(row); states.push(0);
        ${pushes}
        index.set(k, entities.length - 1); counter.live++;
        return row;
      },
      scan(out) {
        const n = entities.length;
        for (let i = 0; i < n; i++) {
          if (states[i] !== 0) continue;
          const e = entities[i];
          if (${tests}) out.push(i);
        }
      },
    };`;
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- see the comment above
    return new Function(
      "entities",
      "states",
      "snaps",
      "index",
      "counter",
      "merge",
      "key",
      "snapshot",
      "same",
      "plain",
      source,
    )(
      store.entities,
      store.states,
      store.snaps,
      store.index,
      store.counter,
      store.merge,
      store.key,
      snapshotValue,
      unchanged,
      isPlainObject,
    );
  } catch {
    // code generation is disabled (a Content Security Policy, some edge runtimes)
    return undefined;
  }
};

/** A tracked row: a slot of a store. */
interface Ref {
  readonly store: Store;
  readonly slot: number;
}

/** A row that was added and not saved yet. */
interface Pending {
  readonly store: Store;
  readonly entity: Row;
}

const entityOf = (ref: Ref): Row => ref.store.entities[ref.slot]!;

// ---------------------------------------------------------------- statements

interface Statement {
  readonly plan: Plan;
  /** fails the save, or records what to do once everything succeeded */
  readonly done: (result: any) => ConcurrencyError | undefined;
}

const MAX_PARAMS = 60_000;

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  if (items.length <= size) return [items];
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const counted = (statement: Frag): Plan => {
  const compiled = compileFrag([
    "WITH m AS (",
    statement,
    " RETURNING 1) SELECT count(*)::int FROM m",
  ]);
  return { ...compiled, read: (rows) => rows[0]![0] };
};

const one = (table: AnyTable): bigint | number => (table.version?.type === "bigint" ? 1n : 1);

/** The columns that identify the row as it was read: the key, and the version if any. */
const identity = (table: AnyTable): ReadonlyArray<Column> =>
  table.version === undefined ? table.primaryKey : [...table.primaryKey, table.version];

/**
 * A VALUES list whose first row is typed NULLs taken from the table's row
 * type, which gives every parameter its column's type without naming it.
 */
const valuesList = (
  table: AnyTable,
  columns: ReadonlyArray<Column>,
  rows: ReadonlyArray<Frag>,
): Frag => {
  const name = tableName(table);
  return [
    "(VALUES (",
    columns.map((col) => `(NULL::${name}).${ident(col.name)}`).join(", "),
    "), ",
    join(rows, ", "),
    ")",
  ];
};

/** One UPDATE for many rows: the new values are joined on the primary key. */
const updateStatement = (
  table: AnyTable,
  changed: ReadonlyArray<Column>,
  refs: ReadonlyArray<Ref>,
): Plan => {
  const version = table.version;
  const keys = identity(table);
  const rows = refs.map((ref): Frag => {
    const entity = entityOf(ref);
    const values: Array<Frag> = [];
    // keys are compared with what was read: the snapshot, not the row
    for (const col of keys) values.push(bind(col, ref.store.original(ref.slot, col), false));
    for (const col of changed) values.push(bind(col, entity[col.key], false));
    return ["(", join(values, ", "), ")"];
  });
  const sets = changed.map((col, i) => `${ident(col.name)} = v.${ident(`n${i}`)}`);
  if (version !== undefined && !changed.includes(version)) {
    sets.push(`${ident(version.name)} = t.${ident(version.name)} + 1`);
  }
  return counted([
    "UPDATE ",
    tableName(table),
    " AS t SET ",
    sets.join(", "),
    " FROM ",
    valuesList(table, [...keys, ...changed], rows),
    " AS v (",
    [...keys.map((_, i) => ident(`k${i}`)), ...changed.map((_, i) => ident(`n${i}`))].join(", "),
    ") WHERE ",
    keys.map((col, i) => `t.${ident(col.name)} = v.${ident(`k${i}`)}`).join(" AND "),
  ]);
};

const deleteStatement = (table: AnyTable, refs: ReadonlyArray<Ref>): Plan => {
  const keys = identity(table);
  const rows = refs.map((ref): Frag => [
    "(",
    join(
      keys.map((col) => bind(col, ref.store.original(ref.slot, col), false)),
      ", ",
    ),
    ")",
  ]);
  return counted([
    "DELETE FROM ",
    tableName(table),
    " AS t USING ",
    valuesList(table, keys, rows),
    " AS v (",
    keys.map((_, i) => ident(`k${i}`)).join(", "),
    ") WHERE ",
    keys.map((col, i) => `t.${ident(col.name)} = v.${ident(`k${i}`)}`).join(" AND "),
  ]);
};

const grouped = <K, V>(items: Iterable<V>, key: (item: V) => K): Map<K, Array<V>> => {
  const out = new Map<K, Array<V>>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) out.set(k, [item]);
    else list.push(item);
  }
  return out;
};

// ------------------------------------------------------------------ session

export class Session<Env = SqlClient> {
  /** The client the session runs on, when it came from a context service. */
  private readonly client: SqlClient | undefined;

  constructor(client?: SqlClient) {
    this.client = client;
  }

  private readonly stores = new Map<AnyTable, Store>();
  private readonly added: Array<Pending> = [];
  private readonly removed: Array<Ref> = [];

  private store(table: AnyTable): Store {
    let store = this.stores.get(table);
    if (store === undefined) this.stores.set(table, (store = new Store(table)));
    return store;
  }

  /** Resolved once per query and table, not per row. */
  private readonly materialize = (table: AnyTable): ((row: Row) => unknown) | undefined =>
    table.primaryKey.length === 0 ? undefined : this.store(table).track;

  /** Where a tracked object lives. */
  private locate(entity: object): Ref | undefined {
    for (const store of this.stores.values()) {
      const slot = store.slotOf(entity);
      if (slot >= 0) return { store, slot };
    }
    return undefined;
  }

  // ----- reading

  /** Runs the query and tracks every table row in its result. */
  load<T>(query: Query<T, any, any>): QueryEffect<Array<Tracked<Materialize<T>>>, never, Env> {
    return this.run(runPlan(() => compileQuery(query, { k: "all" }, this.materialize)));
  }

  /** The first row, tracked; fails with `NoSuchElementError` when there is none. */
  first<T>(
    query: Query<T, any, any>,
  ): QueryEffect<Tracked<Materialize<T>>, Cause.NoSuchElementError, Env> {
    return Effect.flatMap(this.firstOption(query), (row) =>
      Option.isNone(row) ? Effect.fail(new Cause.NoSuchElementError()) : Effect.succeed(row.value),
    );
  }

  firstOption<T>(
    query: Query<T, any, any>,
  ): QueryEffect<Option.Option<Tracked<Materialize<T>>>, never, Env> {
    return this.run(
      Effect.map(
        runPlan<Array<any>>(() => compileQuery(query, { k: "first" }, this.materialize)),
        (rows) => (rows.length === 0 ? Option.none() : Option.some(rows[0])),
      ),
    );
  }

  /**
   * The row with this primary key. A row the session already tracks is
   * returned without a query. For a composite key, pass the values in order.
   */
  find<T, W extends AnyTable>(
    table: Query<T, W, any>,
    key: unknown,
  ): QueryEffect<Option.Option<Tracked<RowOf<W>>>, never, Env> {
    return this.run(
      Effect.suspend(() => {
        const target = table.table;
        const pk = target.primaryKey;
        if (pk.length === 0)
          return Effect.die(new LinqError(`"${target.name}" has no primary key`));
        const values = pk.length === 1 ? [key] : (key as ReadonlyArray<unknown>);
        const probe: Row = {};
        pk.forEach((col, i) => (probe[col.key] = values[i]));
        const store = this.store(target);
        const slot = store.index.get(store.key(probe));
        if (slot !== undefined) {
          return Effect.succeed(
            store.states[slot] === DELETED ? Option.none() : Option.some(store.entities[slot]),
          );
        }
        // row => row.k0 === key0 && row.k1 === key1
        const condition = pk
          .map((col, i) => ({
            t: "b" as const,
            op: "===" as const,
            l: { t: "m" as const, o: { t: "p" as const, n: "row" }, n: col.key },
            r: { t: "c" as const, i },
          }))
          .reduce((l, r) => ({ t: "b", op: "&&", l, r }) as never);
        const where: Op = {
          k: "where",
          fn: callable({
            ast: { v: 1, p: ["row"], b: condition, loc: "Session.find" },
            captures: values.map((value) => () => value),
          }),
        };
        const source = { table: target, rels: table.rels, ops: [where] };
        return Effect.map(
          runPlan<Array<any>>(() => compileQuery(source, { k: "first" }, this.materialize)),
          (rows) => (rows.length === 0 ? Option.none() : Option.some(rows[0])),
        );
      }) as never,
    );
  }

  // ----- changing

  /**
   * Schedules a row to be inserted by `saveChanges`, and returns the object
   * that will be tracked. Columns the database fills in are set on it then.
   */
  add<T, W extends AnyTable>(table: Query<T, W, any>, row: InsertOf<W>): Tracked<RowOf<W>> {
    if (table.ops.length > 0) fail("add() expects a table, not a query");
    if (typeof row !== "object" || row === null) return fail("add() expects an object");
    this.added.push({ store: this.store(table.table), entity: row });
    return row as never;
  }

  /** Schedules a tracked row to be deleted by `saveChanges`. */
  remove(entity: object): void {
    const pending = this.added.findIndex((item) => item.entity === entity);
    if (pending >= 0) {
      // never saved: forget it
      this.added.splice(pending, 1);
      return;
    }
    const ref = this.locate(entity) ?? fail("remove(): this object is not tracked");
    if (ref.store.states[ref.slot] === UNCHANGED) {
      ref.store.states[ref.slot] = DELETED;
      this.removed.push(ref);
    }
  }

  /** Stops tracking a row, without saving it. */
  detach(entity: object): void {
    const pending = this.added.findIndex((item) => item.entity === entity);
    if (pending >= 0) {
      this.added.splice(pending, 1);
      return;
    }
    const ref = this.locate(entity);
    if (ref !== undefined) this.forget(ref);
  }

  private forget(ref: Ref): void {
    const at = this.removed.findIndex((r) => r.store === ref.store && r.slot === ref.slot);
    if (at >= 0) this.removed.splice(at, 1);
    ref.store.drop(ref.slot);
  }

  /** Stops tracking everything. */
  clear(): void {
    this.stores.clear();
    this.added.length = 0;
    this.removed.length = 0;
  }

  /** The number of tracked rows. */
  get size(): number {
    let size = this.added.length;
    for (const store of this.stores.values()) size += store.counter.live;
    return size;
  }

  // ----- inspecting

  /** The modified rows, with their changed columns. */
  private modified(): Array<{ ref: Ref; cols: Array<Column> }> {
    const out: Array<{ ref: Ref; cols: Array<Column> }> = [];
    const candidates: Array<number> = [];
    for (const store of this.stores.values()) {
      candidates.length = 0;
      store.scan(candidates);
      for (const slot of candidates) {
        const cols = store.changed(slot);
        if (cols.length > 0) out.push({ ref: { store, slot }, cols });
      }
    }
    return out;
  }

  state(entity: object): EntityState | "detached" {
    if (this.added.some((item) => item.entity === entity)) return "added";
    const ref = this.locate(entity);
    if (ref === undefined) return "detached";
    if (ref.store.states[ref.slot] === DELETED) return "deleted";
    return ref.store.changed(ref.slot).length === 0 ? "unchanged" : "modified";
  }

  /** Everything `saveChanges` would write. Compares every tracked row. */
  changes(): Array<Change> {
    const out: Array<Change> = [];
    for (const { store, entity } of this.added) {
      out.push({ table: store.table.name, state: "added", entity, columns: [] });
    }
    for (const { ref, cols } of this.modified()) {
      out.push({
        table: ref.store.table.name,
        state: "modified",
        entity: entityOf(ref),
        columns: cols.map((col) => col.key),
      });
    }
    for (const ref of this.removed) {
      out.push({
        table: ref.store.table.name,
        state: "deleted",
        entity: entityOf(ref),
        columns: [],
      });
    }
    return out;
  }

  hasChanges(): boolean {
    return this.added.length > 0 || this.removed.length > 0 || this.modified().length > 0;
  }

  // ----- saving

  /**
   * Writes every pending change in one transaction, and returns the number of
   * rows written. Inserts run first (tables in the order rows were added),
   * then updates, then deletes (in the order rows were removed).
   *
   * Fails with `ConcurrencyError`, and writes nothing, when a row to update
   * or delete is no longer there (or, with a `version` column, was changed).
   */
  saveChanges(): Effect.Effect<number, SqlError | Schema.SchemaError | ConcurrencyError, Env> {
    return this.run(Effect.flatMap(this.prepare(), () => this.write()));
  }

  /** On the session's own client when it has one; `Env` is then nothing. */
  private run<A, E>(effect: Effect.Effect<A, E, SqlClient>): Effect.Effect<A, E, Env> {
    return onClient(this.client, effect) as never;
  }

  /**
   * What models do before a write: fill in what the application generates on
   * insert (ids, timestamps), and refresh the columns that change with every
   * update (`Model.DateTimeUpdate`).
   */
  private prepare(): Effect.Effect<void, Schema.SchemaError> {
    return Effect.suspend(() => {
      const steps: Array<Effect.Effect<void, Schema.SchemaError>> = [];
      for (const item of this.added) {
        const model = item.store.table.model;
        if (model === undefined) continue;
        steps.push(
          Effect.map(model.makeInsert(item.entity), (made) => {
            Object.assign(item.entity, made);
          }),
        );
      }
      let modified: ReturnType<Session["modified"]>;
      try {
        modified = this.modified();
      } catch (error) {
        return Schema.isSchemaError(error) ? Effect.fail(error) : Effect.die(error);
      }
      // one value per column and save, shared by every row
      const makers = new Map<Column, Effect.Effect<unknown, Schema.SchemaError>>();
      const stale: Array<{ entity: Row; col: Column }> = [];
      for (const { ref, cols } of modified) {
        for (const { col, make } of ref.store.table.model?.onUpdate ?? []) {
          if (cols.includes(col)) continue;
          makers.set(col, make);
          stale.push({ entity: entityOf(ref), col });
        }
      }
      if (stale.length > 0) {
        steps.push(
          Effect.map(
            Effect.forEach([...makers], ([col, make]) =>
              Effect.map(make, (value) => [col, value] as const),
            ),
            (values) => {
              const fresh = new Map(values);
              for (const { entity, col } of stale) entity[col.key] = fresh.get(col);
            },
          ),
        );
      }
      return Effect.all(steps, { discard: true });
    });
  }

  private write(): Effect.Effect<
    number,
    SqlError | Schema.SchemaError | ConcurrencyError,
    SqlClient
  > {
    return Effect.suspend(() => {
      let statements: Array<Statement>;
      const commit: Array<() => void> = [];
      try {
        statements = this.plan(commit);
      } catch (error) {
        return Schema.isSchemaError(error) ? Effect.fail(error) : Effect.die(error);
      }
      if (statements.length === 0) return Effect.succeed(0);
      let total = 0;
      const run = Effect.forEach(
        statements,
        (statement) =>
          Effect.flatMap(
            runPlan<any>(() => statement.plan),
            (result): Effect.Effect<void, ConcurrencyError> => {
              const error = statement.done(result);
              if (error !== undefined) return Effect.fail(error);
              total += typeof result === "number" ? result : result.length;
              return Effect.void;
            },
          ),
        { discard: true },
      );
      return SqlClient.use((sql) =>
        // always a transaction: a row-count check that fails must undo its own statement
        Effect.map(sql.withTransaction(run), () => {
          // only now is the session's view of the database moved forward
          for (const apply of commit) apply();
          return total;
        }),
      );
    });
  }

  private plan(commit: Array<() => void>): Array<Statement> {
    const statements: Array<Statement> = [];
    const stale = (
      table: AnyTable,
      operation: "update" | "delete",
      expected: number,
      actual: number,
    ) => new ConcurrencyError({ table: table.name, operation, expected, actual });

    // inserts: one statement per table, returning what the database filled in
    for (const [store, pending] of grouped(this.added, (item) => item.store)) {
      const table = store.table;
      const source = { table, rels: undefined, ops: [] };
      for (const batch of chunks(pending, insertBatchSize(table))) {
        const plan = compileInsert(
          source,
          batch.map((item) => item.entity),
          undefined,
          { fn: undefined },
          false,
        );
        statements.push({
          plan,
          done: (rows: Array<Row>) => {
            commit.push(() => {
              batch.forEach((item, i) => {
                Object.assign(item.entity, rows[i]!);
                // a row of a model is an instance of its class, as loaded rows are
                if (table.model !== undefined)
                  Object.setPrototypeOf(item.entity, table.model.proto);
                this.added.splice(this.added.indexOf(item), 1);
                // without a key it cannot be found again: inserted, not tracked
                if (table.primaryKey.length === 0) return;
                // A row with this key that the session still holds is gone from
                // the database (the insert succeeded): the new object replaces it.
                const stale = store.index.get(store.key(item.entity));
                if (stale !== undefined && store.entities[stale] !== item.entity) {
                  this.forget({ store, slot: stale });
                }
                store.track(item.entity);
              });
            });
            return undefined;
          },
        });
      }
    }

    // updates: one statement per table and set of changed columns
    const signature = (cols: ReadonlyArray<Column>): string =>
      cols.length === 1 ? cols[0]!.key : cols.map((col) => col.key).join("\u0000");
    for (const [store, items] of grouped(this.modified(), (item) => item.ref.store)) {
      const table = store.table;
      const version = table.version;
      for (const group of grouped(items, (item) => signature(item.cols)).values()) {
        const cols = group[0]!.cols;
        const locked = cols.find((col) => table.model?.notUpdatable.has(col.key));
        if (locked !== undefined) {
          fail(
            `"${locked.key}" of a tracked row of "${table.name}" was changed, but it cannot be ` +
              "updated (it is not in the model's update variant)",
          );
        }
        const width = identity(table).length + cols.length;
        for (const batch of chunks(group, Math.max(1, Math.floor(MAX_PARAMS / width)))) {
          const refs = batch.map((item) => item.ref);
          statements.push({
            plan: updateStatement(table, cols, refs),
            done: (count: number) => {
              if (count !== refs.length) return stale(table, "update", refs.length, count);
              commit.push(() => {
                for (const ref of refs) {
                  if (version !== undefined && !cols.includes(version)) {
                    entityOf(ref)[version.key] += one(table);
                  }
                  store.refresh(ref.slot);
                }
              });
              return undefined;
            },
          });
        }
      }
    }

    // deletes: one statement per table
    for (const [store, refs] of grouped(this.removed, (ref) => ref.store)) {
      const table = store.table;
      for (const batch of chunks(refs, Math.floor(MAX_PARAMS / identity(table).length))) {
        statements.push({
          plan: deleteStatement(table, batch),
          done: (count: number) => {
            if (count !== batch.length) return stale(table, "delete", batch.length, count);
            commit.push(() => {
              const gone = new Set(batch);
              for (const ref of batch) store.drop(ref.slot);
              for (let i = this.removed.length - 1; i >= 0; i--) {
                if (gone.has(this.removed[i]!)) this.removed.splice(i, 1);
              }
            });
            return undefined;
          },
        });
      }
    }
    return statements;
  }
}

const NONE: Array<Column> = [];

/** Starts a unit of work. See {@link Session}. */
export const session = (): Session => new Session();

/** A unit of work on a given client: what a context service's `session()` returns. */
export const sessionOn = (client: SqlClient): Session<never> => new Session<never>(client);
