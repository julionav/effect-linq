import { Cause, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { LinqError } from "./errors.ts";
import { type Quote, QuoteSymbol } from "./ir.ts";
import {
  compileDelete,
  compileInsert,
  compileUpdate,
  type Conflict,
  insertBatchSize,
  type OnUpdateValues,
  type Returning,
  type Values,
  type WriteOptions,
} from "./mutate.ts";
import type { AnyTable, InsertOf, RowOf, UpdateOf } from "./table.ts";
import {
  type Callable,
  callable,
  compileQuery,
  type Op,
  type Plan,
  type QuerySource,
  QueryTypeId,
  type Relation,
  type Relations,
  type Subquery,
  SubquerySymbol,
  type Terminal,
} from "./translate.ts";

// ------------------------------------------------------------------- types

declare const NavKeys: unique symbol;
declare const OptionalOf: unique symbol;
declare const ManyTypeId: unique symbol;

export type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Uint8Array
  | ((...args: Array<any>) => any);

/** The relation property names of an entity type. */
export type NavKeysOf<T> = typeof NavKeys extends keyof T ? NonNullable<T[typeof NavKeys]> : never;

/**
 * A row that may be absent (the far side of a left join or of an optional
 * relation). Every column reads as `null` when it is; the row itself
 * materializes as `null`.
 */
export type Nullable<T> = T extends Leaf
  ? T | null
  : {
      readonly [K in keyof T as K extends typeof OptionalOf ? never : K]: K extends
        | typeof NavKeys
        | NavKeysOf<T>
        ? T[K]
        : T[K] | null;
    } & { readonly [OptionalOf]?: T };

/**
 * The result type of a query whose lambdas see `T`: relations that were not
 * selected or included are dropped, collections become arrays, and optional
 * rows become `T | null`.
 */
export type Materialize<T> = unknown extends T
  ? T
  : T extends Leaf
    ? T
    : T extends Effect.Effect<infer A, any, any>
      ? // a terminal operator used inside a lambda is a subquery: its value
        A
      : MaterializeObject<T>;

type MaterializeObject<T> =
  T extends Many<infer E>
    ? Array<Materialize<E>>
    : T extends ReadonlyArray<any>
      ? { [K in keyof T]: Materialize<T[K]> }
      : [typeof OptionalOf] extends [keyof T]
        ? T extends { readonly [OptionalOf]?: infer E }
          ? Materialize<E> | null
          : never
        : typeof NavKeys extends keyof T
          ? { [K in Exclude<keyof T, typeof NavKeys | NavKeysOf<T>>]: Materialize<T[K]> }
          : IsOpaque<T> extends true
            ? T
            : { [K in keyof T]: Materialize<T[K]> };

/**
 * Objects with methods (DateTime, Option, BigDecimal, class instances) are
 * values produced by a column's schema, not projections: they are left alone.
 */
export type IsOpaque<T> = true extends {
  [K in keyof T]: T[K] extends (...args: Array<any>) => any ? true : never;
}[keyof T]
  ? true
  : false;

/** `T` with the relation `K` marked as loaded. */
export type Included<T, K> = Omit<T, typeof NavKeys> & {
  readonly [NavKeys]?: Exclude<NavKeysOf<T>, K>;
};

/** The operators shared by queries and by collections inside a lambda. */
interface Operators<T> {
  where(predicate: (item: T) => boolean): this;
  orderBy(key: (item: T) => unknown): this;
  orderByDescending(key: (item: T) => unknown): this;
  thenBy(key: (item: T) => unknown): this;
  thenByDescending(key: (item: T) => unknown): this;
  take(count: number): this;
  skip(count: number): this;
  distinct(): this;
}

/**
 * A collection as seen inside a query lambda: a to-many relation, or a query
 * used as a subquery (see {@link Query.asMany}). Only operators that translate
 * to SQL are available.
 */
export interface Many<T> extends Operators<T> {
  readonly [ManyTypeId]: T;
  readonly length: number;
  filter(predicate: (item: T) => boolean): Many<T>;
  select<R>(selector: (item: T) => R): Many<R>;
  map<R>(selector: (item: T) => R): Many<R>;
  selectMany<R>(selector: (item: T) => Many<R>): Many<R>;
  flatMap<R>(selector: (item: T) => Many<R>): Many<R>;
  any(predicate?: (item: T) => boolean): boolean;
  some(predicate?: (item: T) => boolean): boolean;
  all(predicate: (item: T) => boolean): boolean;
  every(predicate: (item: T) => boolean): boolean;
  count(predicate?: (item: T) => boolean): number;
  sum(this: Many<number>): number;
  sum(selector: (item: T) => number | null): number;
  average(this: Many<number>): number | null;
  average(selector: (item: T) => number | null): number | null;
  min(this: Many<T>): T | null;
  min<R>(selector: (item: T) => R): R | null;
  max(this: Many<T>): T | null;
  max<R>(selector: (item: T) => R): R | null;
  includes(value: T): boolean;
  /** The first row, or an absent row (all columns null) when there is none. */
  first(predicate?: (item: T) => boolean): Nullable<T>;
}

/** The rows that share a `groupBy` key; only aggregates are available. */
export interface Group<K, T> {
  readonly key: K;
  readonly length: number;
  where(predicate: (item: T) => boolean): Group<K, T>;
  filter(predicate: (item: T) => boolean): Group<K, T>;
  select<R>(selector: (item: T) => R): Group<K, R>;
  map<R>(selector: (item: T) => R): Group<K, R>;
  distinct(): Group<K, T>;
  count(predicate?: (item: T) => boolean): number;
  sum(this: Group<K, number>): number;
  sum(selector: (item: T) => number | null): number;
  average(this: Group<K, number>): number | null;
  average(selector: (item: T) => number | null): number | null;
  min(this: Group<K, T>): T | null;
  min<R>(selector: (item: T) => R): R | null;
  max(this: Group<K, T>): T | null;
  max<R>(selector: (item: T) => R): R | null;
  any(predicate?: (item: T) => boolean): boolean;
  some(predicate?: (item: T) => boolean): boolean;
  all(predicate: (item: T) => boolean): boolean;
  every(predicate: (item: T) => boolean): boolean;
}

/**
 * What running a query gives. `Env` is what it still needs: a `SqlClient`,
 * or nothing when the query came from a context service (which holds one).
 */
export type QueryEffect<A, E = never, Env = SqlClient> = Effect.Effect<
  A,
  SqlError | Schema.SchemaError | E,
  Env
>;

type Run<Env, A, E = never> = QueryEffect<A, E, Env>;

/** Runs an effect on the given client rather than the environment's. */
export const onClient = <X>(client: SqlClient | undefined, effect: X): X =>
  client === undefined ? effect : (Effect.provideService(effect as never, SqlClient, client) as X);

// ------------------------------------------------------------------ quotes

const quoteOf = (fn: unknown, operator: string): Quote => {
  const quote =
    typeof fn === "function" ? ((fn as any)[QuoteSymbol] as Quote | undefined) : undefined;
  if (quote === undefined) {
    throw new LinqError(
      typeof fn === "function"
        ? `The function passed to ${operator}() was not compiled to an expression tree. ` +
            "Add the effect-linq plugin to your build (Vite, Vitest, Rolldown or tsdown) or run " +
            "Node with --import effect-linq/register, and pass the lambda inline or wrap it in " +
            "quote(). Function: " +
            String(fn).slice(0, 120)
        : `${operator}() expects a function`,
    );
  }
  return quote;
};

const lambda = (fn: unknown, operator: string): Callable => callable(quoteOf(fn, operator));

/**
 * Marks a lambda as a query expression so that it can be stored in a variable
 * and reused: `const isAdult = quote((u: User) => u.age >= 18)`.
 */
export const quote: {
  <F extends (...args: Array<any>) => unknown>(fn: F): F;
  /** With a query first, the lambda's first parameter is typed as that query's row. */
  <T, F extends (row: T, ...args: Array<any>) => unknown>(source: Query<T, any, any>, fn: F): F;
} = (...args: Array<unknown>): any => {
  const fn = args[args.length - 1];
  quoteOf(fn, "quote");
  return fn;
};

/** The row a query's lambdas receive: `type User = RowIn<typeof db.users>`. */
export type RowIn<Q> = Q extends Query<infer T, any, any> ? T : never;

// ------------------------------------------------------------------- query

const execute = <A>(source: QuerySource, terminal: Terminal): QueryEffect<A> =>
  subquery(source, terminal, run<A>(source, terminal));

/**
 * Tags the effect of a terminal operator with the query it runs, so that it
 * becomes a subquery when it is used inside another query's lambda.
 */
const subquery = <X extends object>(source: QuerySource, terminal: Terminal, effect: X): X => {
  const value: Subquery = { source, terminal };
  Object.defineProperty(effect, SubquerySymbol, { value });
  return effect;
};

const run = <A>(source: QuerySource, terminal: Terminal): QueryEffect<A> =>
  onClient(
    source.client,
    runPlan(() => compileQuery(source, terminal)),
  );

export const runPlan = <A>(compile: () => Plan): QueryEffect<A> =>
  Effect.suspend(() => {
    let plan: Plan;
    try {
      plan = compile();
    } catch (error) {
      // a value that does not match its column's schema is a typed failure
      return Schema.isSchemaError(error) ? Effect.fail(error) : Effect.die(error);
    }
    if (plan.count) {
      // a write that returns nothing: the count is in the driver's command result
      return SqlClient.use((sql) =>
        Effect.map(sql.unsafe(plan.sql, plan.params as Array<unknown>).raw, (result) => {
          const count = (result as { readonly rowCount?: unknown } | null)?.rowCount;
          if (typeof count !== "number") {
            throw new LinqError("the driver did not report how many rows the statement affected");
          }
          return count as A;
        }),
      );
    }
    return SqlClient.use((sql) =>
      Effect.flatMap(
        sql.unsafe(plan.sql, plan.params as Array<unknown>).values,
        (rows): Effect.Effect<A, Schema.SchemaError> => {
          try {
            return Effect.succeed(plan.read(rows) as A);
          } catch (error) {
            return Schema.isSchemaError(error) ? Effect.fail(error) : Effect.die(error);
          }
        },
      ),
    );
  });

// ------------------------------------------------------------------ writes

export type { WriteOptions } from "./mutate.ts";

/** The effect of a write, which can also show the statement it runs. */
export type WriteEffect<A, Env = SqlClient> = QueryEffect<A, never, Env> & {
  /** The SQL this statement runs, for logging and tests. */
  toSql(): { readonly sql: string; readonly params: ReadonlyArray<unknown> };
};

/** Adds `returning` to the effect of a write, which by itself counts rows. */
export interface Returnable<T, W, Env = SqlClient> {
  /** Runs the statement and returns the rows it wrote (deleted rows, for a delete). */
  returning(): WriteEffect<Array<RowOf<W>>, Env>;
  returning<R>(selector: (row: T) => R): WriteEffect<Array<Materialize<R>>, Env>;
}

/** An UPDATE or DELETE: an effect of the number of rows affected. */
export type Mutation<T, W, Env = SqlClient> = WriteEffect<number, Env> & Returnable<T, W, Env>;

export interface Conflictable<T, W, Env = SqlClient> {
  /** Skips rows that violate a unique constraint (on `target`, or any). */
  onConflictDoNothing(target?: ConflictTarget<W>): Mutation<T, W, Env>;
  /**
   * Upsert: when a row with the same `target` exists, updates it instead.
   * Without `values`, the existing row takes every inserted value.
   */
  onConflictDoUpdate(
    target: ConflictTarget<W>,
    values?: UpdateOf<W> | ((existing: RowOf<W>, proposed: RowOf<W>) => UpdateOf<W>),
  ): Mutation<T, W, Env>;
}

type ConflictTarget<W> = (keyof RowOf<W> & string) | ReadonlyArray<keyof RowOf<W> & string>;

/** An INSERT of several rows: an effect of the number of rows inserted. */
export type Insert<T, W, Env = SqlClient> = Mutation<T, W, Env> & Conflictable<T, W, Env>;

/** An INSERT of one row; `returning` yields that row rather than an array. */
export type InsertOne<T, W, Env = SqlClient> = WriteEffect<number, Env> &
  Conflictable<T, W, Env> & {
    returning(): WriteEffect<RowOf<W>, Env>;
    returning<R>(selector: (row: T) => R): WriteEffect<Materialize<R>, Env>;
  };

const mutation = (
  client: SqlClient | undefined,
  compile: (returning: Returning) => Plan,
  run: (returning: Returning) => QueryEffect<unknown> = (returning) =>
    runPlan(() => compile(returning)),
): any => {
  const make = (returning: Returning) =>
    Object.assign(onClient(client, run(returning)), {
      toSql: () => {
        const plan = compile(returning);
        return { sql: plan.sql, params: plan.params };
      },
    });
  return Object.assign(make(undefined), {
    returning: (selector?: unknown) =>
      make({ fn: selector === undefined ? undefined : lambda(selector, "returning") }),
  });
};

const values = (input: unknown, operator: string): Values =>
  typeof input === "function" ? { fn: lambda(input, operator) } : { value: input };

const insertRows = (
  source: QuerySource,
  rows: ReadonlyArray<unknown>,
  conflict: Conflict | undefined,
  single: boolean,
): any => {
  const compile = (returning: Returning, batch = rows, validated = false) =>
    compileInsert(source, batch, conflict, returning, single, validated);
  const model = source.table.model;
  const run = (returning: Returning): QueryEffect<unknown> =>
    model === undefined
      ? insert(returning, rows)
      : // the model fills in what the application generates (ids, timestamps) and validates
        Effect.flatMap(
          Effect.forEach(rows, (row) => model.makeInsert(row)),
          (made) => insert(returning, made, true),
        );
  const insert = (
    returning: Returning,
    rows: ReadonlyArray<unknown>,
    validated = false,
  ): QueryEffect<unknown> => {
    const size = insertBatchSize(source.table);
    const one = (batch: ReadonlyArray<unknown>) =>
      runPlan<any>(() => compile(returning, batch, validated));
    if (rows.length === 0) return Effect.succeed(returning === undefined ? 0 : []);
    if (rows.length <= size) return one(rows);
    // too many bind parameters for one statement: several, atomically
    const batches: Array<ReadonlyArray<unknown>> = [];
    for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size));
    return SqlClient.use((sql) =>
      sql.withTransaction(
        Effect.map(Effect.forEach(batches, one), (results) =>
          returning === undefined
            ? results.reduce((total: number, count: number) => total + count, 0)
            : results.flat(),
        ),
      ),
    );
  };
  return mutation(source.client, compile, run);
};

/**
 * An immutable, composable query. Nothing runs until it is yielded (or one of
 * the terminal operators is).
 *
 * `W` is the table the query can write to; it is lost by operators that change
 * the row shape (`select`, `groupBy`, `join`).
 */
export class Query<T, W = never, Env = SqlClient> implements QuerySource, Operators<T> {
  readonly [QueryTypeId]: typeof QueryTypeId = QueryTypeId;
  readonly table: AnyTable;
  readonly rels: Relations | undefined;
  readonly ops: ReadonlyArray<Op>;

  /** The client the query runs on, when it came from a context service; otherwise the environment's. */
  readonly client: SqlClient | undefined;

  constructor(
    table: AnyTable,
    rels: Relations | undefined,
    ops: ReadonlyArray<Op>,
    client?: SqlClient,
  ) {
    this.table = table;
    this.rels = rels;
    this.ops = ops;
    this.client = client;
  }

  private with<R>(op: Op): Query<R, any, Env> {
    return new Query(this.table, this.rels, [...this.ops, op], this.client);
  }

  // ----- operators

  where(predicate: (item: T) => boolean): this {
    return this.with<T>({ k: "where", fn: lambda(predicate, "where") }) as this;
  }

  select<R>(selector: (item: T) => R): Query<R, never, Env> {
    return this.with({ k: "select", fn: lambda(selector, "select") });
  }

  /** Flattens a collection: one result row per element. */
  selectMany<R>(collection: (item: T) => Many<R>): Query<R, never, Env>;
  selectMany<C, R>(
    collection: (item: T) => Many<C>,
    result: (item: T, element: C) => R,
  ): Query<R, never, Env>;
  selectMany(collection: (item: T) => unknown, result?: (item: T, element: any) => unknown): any {
    return this.with({
      k: "selectMany",
      fn: lambda(collection, "selectMany"),
      result: result === undefined ? undefined : lambda(result, "selectMany"),
    });
  }

  /** Sorts by a value, or by several when the key is an array. */
  orderBy(key: (item: T) => unknown): this {
    return this.order(key, "orderBy", false, false);
  }
  orderByDescending(key: (item: T) => unknown): this {
    return this.order(key, "orderByDescending", true, false);
  }
  thenBy(key: (item: T) => unknown): this {
    return this.order(key, "thenBy", false, true);
  }
  thenByDescending(key: (item: T) => unknown): this {
    return this.order(key, "thenByDescending", true, true);
  }
  private order(key: unknown, operator: string, desc: boolean, append: boolean): this {
    return this.with<T>({ k: "orderBy", fn: lambda(key, operator), desc, append }) as this;
  }

  take(count: number): this {
    return this.with<T>({ k: "take", n: count }) as this;
  }

  skip(count: number): this {
    return this.with<T>({ k: "skip", n: count }) as this;
  }

  distinct(): this {
    return this.with<T>({ k: "distinct" }) as this;
  }

  /** Groups rows; follow with `select` (and optionally `where`, which becomes HAVING). */
  groupBy<K>(key: (item: T) => K): Query<Group<K, T>, never, Env> {
    return this.with({ k: "groupBy", fn: lambda(key, "groupBy") });
  }

  join<U, R>(
    other: Query<U, any, any>,
    on: (left: T, right: U) => boolean,
    result: (left: T, right: U) => R,
  ): Query<R, never, Env> {
    return this.with({
      k: "join",
      left: false,
      other,
      on: lambda(on, "join"),
      result: lambda(result, "join"),
    });
  }

  leftJoin<U, R>(
    other: Query<U, any, any>,
    on: (left: T, right: U) => boolean,
    result: (left: T, right: Nullable<U>) => R,
  ): Query<R, never, Env> {
    return this.with({
      k: "join",
      left: true,
      other,
      on: lambda(on, "leftJoin"),
      result: lambda(result, "leftJoin"),
    });
  }

  /** Loads a relation along with each row. */
  include<K extends NavKeysOf<T> & string>(relation: K): Query<Included<T, K>, W, Env> {
    return this.with({ k: "include", key: relation });
  }

  /** Applies functions from query to query: `db.posts.pipe(published, newest(10))`. */
  pipe<A>(f: (query: this) => A): A;
  pipe<A, B>(f: (query: this) => A, g: (a: A) => B): B;
  pipe<A, B, C>(f: (query: this) => A, g: (a: A) => B, h: (b: B) => C): C;
  pipe<A, B, C, D>(f: (query: this) => A, g: (a: A) => B, h: (b: B) => C, i: (c: C) => D): D;
  pipe<A, B, C, D, E>(
    f: (query: this) => A,
    g: (a: A) => B,
    h: (b: B) => C,
    i: (c: C) => D,
    j: (d: D) => E,
  ): E;
  pipe<A, B, C, D, E, F>(
    f: (query: this) => A,
    g: (a: A) => B,
    h: (b: B) => C,
    i: (c: C) => D,
    j: (d: D) => E,
    k: (e: E) => F,
  ): F;
  pipe(...fns: Array<(value: any) => unknown>): unknown {
    return fns.reduce<unknown>((value, fn) => fn(value), this);
  }

  /** This query as a collection, for use as a subquery inside another lambda. */
  asMany(): Many<T> {
    return this as never;
  }

  // ----- execution

  toArray(): Run<Env, Array<Materialize<T>>> {
    return execute(this, { k: "all" }) as never;
  }

  [Symbol.iterator](): Effect.EffectIterator<Run<Env, Array<Materialize<T>>>> {
    return this.toArray()[Symbol.iterator]();
  }

  /** The first row; fails with `NoSuchElementError` when there is none. */
  first(predicate?: (item: T) => boolean): Run<Env, Materialize<T>, Cause.NoSuchElementError> {
    const source = predicate === undefined ? this : this.where(predicate);
    const terminal: Terminal = { k: "first" };
    return subquery(
      source,
      terminal,
      Effect.flatMap(run<Array<Materialize<T>>>(source, terminal), (rows) =>
        rows.length === 0 ? Effect.fail(new Cause.NoSuchElementError()) : Effect.succeed(rows[0]!),
      ),
    ) as never;
  }

  firstOption(predicate?: (item: T) => boolean): Run<Env, Option.Option<Materialize<T>>> {
    const source = predicate === undefined ? this : this.where(predicate);
    return Effect.map(run<Array<Materialize<T>>>(source, { k: "first" }), (rows) =>
      rows.length === 0 ? Option.none() : Option.some(rows[0]!),
    ) as never;
  }

  count(predicate?: (item: T) => boolean): Run<Env, number> {
    return this.scalar("count", predicate);
  }

  any(predicate?: (item: T) => boolean): Run<Env, boolean> {
    return this.scalar("any", predicate);
  }

  all(predicate: (item: T) => boolean): Run<Env, boolean> {
    return this.scalar("all", predicate);
  }

  sum(this: Query<number, any, Env>): Run<Env, number>;
  sum(selector: (item: T) => number | null): Run<Env, number>;
  sum(selector?: unknown): Run<Env, number> {
    return this.scalar("sum", selector);
  }

  average(this: Query<number, any, Env>): Run<Env, number | null>;
  average(selector: (item: T) => number | null): Run<Env, number | null>;
  average(selector?: unknown): Run<Env, number | null> {
    return this.scalar("average", selector);
  }

  min(this: Query<T, any, Env>): Run<Env, Materialize<T> | null>;
  min<R>(selector: (item: T) => R): Run<Env, Materialize<R> | null>;
  min(selector?: unknown): Run<Env, any> {
    return this.scalar("min", selector);
  }

  max(this: Query<T, any, Env>): Run<Env, Materialize<T> | null>;
  max<R>(selector: (item: T) => R): Run<Env, Materialize<R> | null>;
  max(selector?: unknown): Run<Env, any> {
    return this.scalar("max", selector);
  }

  private scalar<A>(name: string, fn: unknown): Run<Env, A> {
    return execute(this, {
      k: "scalar",
      name,
      args: fn === undefined ? [] : [lambda(fn, name)],
    }) as never;
  }

  // ----- writes

  /**
   * Inserts one row or many, in one statement. Nullable columns and columns
   * listed in the table's `defaults` may be left out.
   *
   * ```ts
   * const user = yield* db.users.insert({ name: "Ada" }).returning()
   * const count = yield* db.users.insert([a, b, c])
   * ```
   */
  insert(row: InsertOf<W>): InsertOne<T, W, Env>;
  insert(rows: ReadonlyArray<InsertOf<W>>): Insert<T, W, Env>;
  insert(input: unknown): any {
    const single = !Array.isArray(input);
    const rows: ReadonlyArray<unknown> = single ? [input] : (input as ReadonlyArray<unknown>);
    const conflicting = (conflict: Conflict) => insertRows(this, rows, conflict, false);
    const target = (keys: string | ReadonlyArray<string> | undefined) =>
      keys === undefined ? undefined : typeof keys === "string" ? [keys] : keys;
    return Object.assign(insertRows(this, rows, undefined, single), {
      onConflictDoNothing: (keys?: string | ReadonlyArray<string>) =>
        conflicting({ target: target(keys), update: undefined }),
      onConflictDoUpdate: (keys: string | ReadonlyArray<string>, set?: unknown) =>
        conflicting({
          target: target(keys),
          update: { values: set === undefined ? undefined : values(set, "onConflictDoUpdate") },
        }),
    });
  }

  /**
   * Updates every row of this query in one statement, without loading them.
   * Values are a plain object, or a lambda over the row for values computed
   * in the database.
   *
   * ```ts
   * yield* db.users.where((u) => u.id === id).executeUpdate({ name: "Ada" })
   * yield* db.posts.where((p) => p.author.isAdmin).executeUpdate((p) => ({ views: p.views + 1n }))
   * ```
   */
  executeUpdate(
    this: Writable<this, W>,
    set: UpdateOf<W> | ((row: T) => UpdateOf<W>),
    options?: WriteOptions,
  ): Mutation<T, W, Env> {
    const assigned = values(set, "executeUpdate");
    const onUpdate = this.table.model?.onUpdate ?? [];
    if (onUpdate.length === 0) {
      return mutation(this.client, (returning) =>
        compileUpdate(this, assigned, returning, options),
      );
    }
    // the model refreshes some columns on every update (Model.DateTimeUpdate)
    const fresh = Effect.forEach(onUpdate, ({ col, make }) =>
      Effect.map(make, (value) => [col, value] as const),
    );
    return mutation(
      this.client,
      (returning) =>
        compileUpdate(this, assigned, returning, options, Effect.runSync(fresh) as OnUpdateValues),
      (returning) =>
        Effect.flatMap(fresh, (extra) =>
          runPlan(() => compileUpdate(this, assigned, returning, options, extra)),
        ),
    );
  }

  /** Deletes every row of this query in one statement, without loading them. */
  executeDelete(this: Writable<this, W>, options?: WriteOptions): Mutation<T, W, Env> {
    return mutation(this.client, (returning) => compileDelete(this, returning, options));
  }

  /** The SQL this query runs, for logging and tests. Throws if it cannot be translated. */
  toSql(): { readonly sql: string; readonly params: ReadonlyArray<unknown> } {
    const plan = compileQuery(this, { k: "all" });
    return { sql: plan.sql, params: plan.params };
  }
}

/** A query that still has a table to write to: `never` once it was projected, grouped or joined. */
type Writable<Q, W> = [W] extends [never] ? never : Q;

/** A query over a single table, without relations. See {@link database}. */
export const from = <T extends AnyTable>(table: T): Query<RowOf<T>, T> =>
  new Query(table, undefined, []);

// --------------------------------------------------------------- relations

export interface RelationDef<S, T extends AnyTable, Kind extends Relation["kind"]> {
  readonly kind: Kind;
  readonly target: T;
  readonly on: (source: S, target: RowOf<T>) => boolean;
}

export interface RelationBuilder {
  /** A reference that is always present (a NOT NULL foreign key). */
  readonly one: <S, T extends AnyTable>(
    target: T,
    on: (source: S, target: RowOf<T>) => boolean,
  ) => RelationDef<S, T, "one">;
  /** A reference that may be absent (a nullable foreign key, or the far side of a 1:1). */
  readonly optional: <S, T extends AnyTable>(
    target: T,
    on: (source: S, target: RowOf<T>) => boolean,
  ) => RelationDef<S, T, "optional">;
  /** A collection of related rows. */
  readonly many: <S, T extends AnyTable>(
    target: T,
    on: (source: S, target: RowOf<T>) => boolean,
  ) => RelationDef<S, T, "many">;
}

type Tables = { readonly [key: string]: AnyTable };

type RelationsFor<Ts extends Tables> = {
  readonly [K in keyof Ts]?: {
    readonly [name: string]: RelationDef<RowOf<Ts[K]>, any, any>;
  };
};

interface Shape {
  readonly tables: Tables;
  readonly rels: { readonly [key: string]: unknown };
}

type RelsOf<DB extends Shape, K> = K extends keyof DB["rels"] ? NonNullable<DB["rels"][K]> : {};

type KeyOfTable<DB extends Shape, T extends AnyTable> = {
  [K in keyof DB["tables"]]: [DB["tables"][K]["name"], T["name"]] extends [
    T["name"],
    DB["tables"][K]["name"],
  ]
    ? K
    : never;
}[keyof DB["tables"]];

type EntityFor<DB extends Shape, T extends AnyTable> = [KeyOfTable<DB, T>] extends [never]
  ? RowOf<T>
  : Entity<DB, KeyOfTable<DB, T>>;

/** A table row as seen inside a query lambda: its columns plus its relations. */
export type Entity<DB extends Shape, K extends keyof DB["tables"]> = RowOf<DB["tables"][K]> & {
  readonly [N in keyof RelsOf<DB, K>]: RelsOf<DB, K>[N] extends RelationDef<
    any,
    infer T,
    infer Kind
  >
    ? Kind extends "many"
      ? Many<EntityFor<DB, T>>
      : Kind extends "optional"
        ? Nullable<EntityFor<DB, T>>
        : EntityFor<DB, T>
    : never;
} & { readonly [NavKeys]?: keyof RelsOf<DB, K> };

export type Database<Ts extends Tables, Rels, Env = SqlClient> = {
  readonly [K in keyof Ts]: Query<Entity<{ tables: Ts; rels: Rels & {} }, K>, Ts[K], Env>;
};

const relationBuilder: RelationBuilder = {
  one: (target, on) => ({ kind: "one", target, on }),
  optional: (target, on) => ({ kind: "optional", target, on }),
  many: (target, on) => ({ kind: "many", target, on }),
};

/**
 * Declares a set of tables and the relations between them, and returns one
 * query per table.
 *
 * ```ts
 * const db = database({ users: Users, posts: Posts }, (r) => ({
 *   users: { posts: r.many(Posts, (user, post) => post.authorId === user.id) },
 *   posts: { author: r.one(Users, (post, user) => post.authorId === user.id) },
 * }))
 * ```
 */
export const database = <const Ts extends Tables, Rels extends RelationsFor<Ts> = {}>(
  tables: Ts,
  relations?: (r: RelationBuilder) => Rels,
): Database<Ts, Rels> => {
  const rels: Relations = new Map();
  const declared = (relations?.(relationBuilder) ?? {}) as {
    readonly [key: string]:
      | { readonly [name: string]: RelationDef<any, AnyTable, any> }
      | undefined;
  };
  for (const key of Object.keys(declared)) {
    const table = tables[key];
    if (table === undefined) {
      throw new LinqError(`database(): relations were declared for unknown table "${key}"`);
    }
    const entries: Record<string, Relation> = {};
    for (const [name, def] of Object.entries(declared[key] ?? {})) {
      if (name in table.columns) {
        throw new LinqError(`database(): relation "${key}.${name}" collides with a column`);
      }
      entries[name] = { kind: def.kind, target: def.target, on: quoteOf(def.on, def.kind) };
    }
    rels.set(table, entries);
  }
  const out: Record<string, Query<unknown>> = {};
  for (const key of Object.keys(tables)) out[key] = new Query(tables[key]!, rels, []);
  return out as never;
};
