/**
 * Translates queries to SQL by evaluating each lambda's expression tree over
 * symbolic values: a table row is an `EntitySym`, a column a `ScalarSym`, a
 * captured JavaScript value a `ConstSym`, and so on. Anything that only
 * involves constants is computed in JavaScript, so SQL is only produced for
 * the parts that depend on the database.
 */
import { LinqError, fail } from "./errors.ts";
import { type Node, type Pattern, type Quote, QuoteSymbol } from "./ir.ts";
import { and, compileFrag, type Frag, ident, join, Param } from "./sql.ts";
import type { AnyTable, Column, JsType } from "./table.ts";

// ------------------------------------------------------------------- model

export interface Relation {
  readonly kind: "one" | "optional" | "many";
  readonly target: AnyTable;
  readonly on: Quote;
}

export type Relations = Map<AnyTable, { readonly [name: string]: Relation }>;

/** A lambda together with the scope it closes over. */
export interface Callable {
  readonly p: ReadonlyArray<Pattern>;
  readonly b: Node;
  readonly env: Env;
  readonly loc?: string;
}

interface Env {
  readonly vars: ReadonlyMap<string, Sym>;
  readonly captures: ReadonlyArray<() => unknown>;
}

export const callable = (quote: Quote): Callable => ({
  p: quote.ast.p,
  b: quote.ast.b,
  env: { vars: EMPTY_VARS, captures: quote.captures },
  loc: quote.ast.loc,
});

const EMPTY_VARS: ReadonlyMap<string, Sym> = new Map();

export type Op =
  | { readonly k: "where"; readonly fn: Callable }
  | { readonly k: "select"; readonly fn: Callable }
  | {
      readonly k: "orderBy";
      readonly fn: Callable;
      readonly desc: boolean;
      readonly append: boolean;
    }
  | { readonly k: "take"; readonly n: number }
  | { readonly k: "skip"; readonly n: number }
  | { readonly k: "distinct" }
  | { readonly k: "groupBy"; readonly fn: Callable }
  | {
      readonly k: "join";
      readonly left: boolean;
      readonly other: QuerySource;
      readonly on: Callable;
      readonly result: Callable;
    }
  | { readonly k: "selectMany"; readonly fn: Callable; readonly result: Callable | undefined }
  | { readonly k: "include"; readonly key: string };

export const QueryTypeId: unique symbol = Symbol.for("effect-linq/Query") as never;

export interface QuerySource {
  readonly table: AnyTable;
  readonly rels: Relations | undefined;
  readonly ops: ReadonlyArray<Op>;
  /** the client it runs on, when not the environment's (typed in query.ts) */
  readonly client?: any;
}

const isQuerySource = (u: unknown): u is QuerySource =>
  typeof u === "object" && u !== null && QueryTypeId in u;

/**
 * What a SQL marker function (`Sql.like`, `Sql.now`, a `Sql.fn`) returns when
 * it is called with plain values, which happens when none of its arguments
 * depend on the row. The translator applies it when it meets the value.
 */
export class Deferred {
  readonly impl: FnImpl;
  readonly args: ReadonlyArray<unknown>;
  constructor(impl: FnImpl, args: ReadonlyArray<unknown>) {
    this.impl = impl;
    this.args = args;
  }
}

/** Attached to the effect a terminal operator returns, so it can be a subquery. */
export const SubquerySymbol: unique symbol = Symbol.for("effect-linq/subquery") as never;

export interface Subquery {
  readonly source: QuerySource;
  readonly terminal: Terminal;
}

// -------------------------------------------------------------------- syms

export interface ScalarSym {
  readonly k: "scalar";
  readonly sql: Frag;
  readonly type: JsType;
  /** can evaluate to SQL NULL */
  readonly nullable: boolean;
  /** a predicate: NULL means false */
  readonly pred?: boolean;
  /** set when the value is a column, whose schema then decodes it */
  readonly col?: Column;
  /** custom decoder (nested collections) */
  readonly decode?: (value: any) => unknown;
}

interface EntitySym {
  readonly k: "entity";
  readonly table: AnyTable;
  readonly rels: Relations | undefined;
  readonly ref: (column: Column) => Frag;
  /** the select whose FROM clause makes this row visible; joins are added there */
  owner: Select;
  readonly nullable: boolean;
  readonly navs: Map<string, Sym>;
  readonly includes: ReadonlyMap<string, Sym> | undefined;
}

interface ObjectSym {
  readonly k: "object";
  readonly props: ReadonlyMap<string, Sym>;
}

interface TupleSym {
  readonly k: "tuple";
  readonly items: ReadonlyArray<Sym>;
}

interface ConstSym {
  readonly k: "const";
  readonly value: unknown;
  /** written as a literal in the lambda, as opposed to captured */
  readonly literal?: boolean;
}

/** A subquery that has not been rendered yet. */
interface CollSym {
  readonly k: "coll";
  readonly make: () => Select;
  /** the result of `first()`: one row rather than an array */
  readonly single?: boolean;
}

interface GroupSym {
  readonly k: "group";
  readonly key: Sym;
  readonly element: Sym;
  readonly filter: ReadonlyArray<Frag>;
  readonly distinct: boolean;
}

interface LambdaSym {
  readonly k: "lambda";
  readonly fn: Callable;
}

export type { EntitySym };

export type Sym =
  | ScalarSym
  | EntitySym
  | ObjectSym
  | TupleSym
  | ConstSym
  | CollSym
  | GroupSym
  | LambdaSym;

export const constant = (value: unknown): ConstSym => ({ k: "const", value });
const TRUE = constant(true);
const FALSE = constant(false);

const predicate = (sql: Frag, nullable = false): ScalarSym => ({
  k: "scalar",
  sql,
  type: "boolean",
  nullable,
  pred: true,
});

const describe = (sym: Sym): string => {
  switch (sym.k) {
    case "scalar":
      return "a value";
    case "entity":
      return `a row of "${sym.table.name}"`;
    case "object":
      return "an object";
    case "tuple":
      return "an array";
    case "const":
      return sym.value === null ? "null" : `a ${typeof sym.value}`;
    case "coll":
      return "a collection";
    case "group":
      return "a group";
    case "lambda":
      return "a function";
  }
};

// ------------------------------------------------------------------ select

interface Join {
  readonly kind: string;
  readonly sql: Frag;
  readonly on: Frag;
}

export class Select {
  from: Frag = "";
  /** FROM is a subquery (see pushdown), no longer the table itself */
  derived = false;
  joins: Array<Join> = [];
  where: Array<Frag> = [];
  groupBy: Array<Frag> | null = null;
  having: Array<Frag> = [];
  orderBy: Array<{ readonly sql: Frag; readonly desc: boolean }> = [];
  limit: number | null = null;
  offset: number | null = null;
  distinct = false;
  /** GROUP BY has been applied and projected */
  grouped = false;
  shape: Sym = TRUE;
}

type Row = Record<string | number, any>;
type Reader = (row: Row) => unknown;

// ------------------------------------------------------- function registry

export type FnImpl = (t: Translator, args: ReadonlyArray<Sym>) => Sym;

export const SqlFnSymbol: unique symbol = Symbol.for("effect-linq/fn") as never;

const builtins = new Map<unknown, FnImpl>();

const lookupFn = (f: unknown): FnImpl | undefined =>
  typeof f === "function" ? ((f as any)[SqlFnSymbol] ?? builtins.get(f)) : undefined;

const numeric =
  (render: (args: ReadonlyArray<Frag>) => Frag, arity: number, name: string): FnImpl =>
  (t, args) => {
    if (args.length < arity) fail(`${name} expects ${arity} argument(s)`);
    const scalars = args.map((arg) => t.scalar(arg));
    return {
      k: "scalar",
      sql: render(scalars.map((s) => s.sql)),
      type: "number",
      nullable: scalars.some((s) => s.nullable),
    };
  };

builtins.set(
  Math.abs,
  numeric(([x]) => ["abs(", x!, ")"], 1, "Math.abs"),
);
builtins.set(
  Math.floor,
  numeric(([x]) => ["floor(", x!, ")"], 1, "Math.floor"),
);
builtins.set(
  Math.ceil,
  numeric(([x]) => ["ceil(", x!, ")"], 1, "Math.ceil"),
);
// Math.round rounds half up; Postgres rounds half away from zero (or to even).
builtins.set(
  Math.round,
  numeric(([x]) => ["floor((", x!, ") + 0.5)"], 1, "Math.round"),
);
builtins.set(
  Math.trunc,
  numeric(([x]) => ["trunc(", x!, ")"], 1, "Math.trunc"),
);
builtins.set(
  Math.sign,
  numeric(([x]) => ["sign(", x!, ")"], 1, "Math.sign"),
);
builtins.set(
  Math.sqrt,
  numeric(([x]) => ["sqrt(", x!, ")"], 1, "Math.sqrt"),
);
builtins.set(
  Math.pow,
  numeric(([x, y]) => ["power(", x!, ", ", y!, ")"], 2, "Math.pow"),
);
builtins.set(
  Math.max,
  numeric((xs) => ["GREATEST(", join(xs, ", "), ")"], 1, "Math.max"),
);
builtins.set(
  Math.min,
  numeric((xs) => ["LEAST(", join(xs, ", "), ")"], 1, "Math.min"),
);
builtins.set(Number, (t, args) => {
  const s = t.scalar(args[0] ?? fail("Number() expects an argument"));
  return { k: "scalar", sql: ["(", s.sql, ")::float8"], type: "number", nullable: s.nullable };
});
builtins.set(String, (t, args) => ({
  k: "scalar",
  sql: t.text(args[0] ?? fail("String() expects an argument")),
  type: "string",
  nullable: false,
}));
builtins.set(Boolean, (t, args) =>
  predicate(t.bool(args[0] ?? fail("Boolean() expects an argument"))),
);

// --------------------------------------------------------------- transport

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** Converts what the driver returns for a computed expression. */
const fromDriver = (type: JsType): ((value: any) => unknown) | undefined => {
  switch (type) {
    case "number":
      return (value) => (typeof value === "number" ? value : Number(value));
    case "bigint":
      return (value) => (typeof value === "bigint" ? value : BigInt(value));
    default:
      return undefined;
  }
};

/** Values inside JSON lose their type; these restore what the driver would return. */
const toJson = (s: ScalarSym): Frag => {
  if (s.decode !== undefined) return s.sql;
  if (s.col?.wire === "array") {
    // JSON numbers cannot hold an int8, and JSON has no dates
    if (s.col.element === "bigint") return ["(", s.sql, ")::text[]"];
    if (s.col.element === "date") {
      return [
        "(SELECT COALESCE(array_agg(extract(epoch from x) * 1000 ORDER BY o), '{}') FROM unnest(",
        s.sql,
        ") WITH ORDINALITY AS e(x, o) WHERE ",
        s.sql,
        " IS NOT NULL HAVING ",
        s.sql,
        " IS NOT NULL)",
      ];
    }
    return s.sql;
  }
  switch (s.col?.wire ?? s.type) {
    case "bigint":
      return ["(", s.sql, ")::text"];
    case "string":
      return s.col === undefined ? s.sql : ["(", s.sql, ")::text"];
    case "date":
      return ["(extract(epoch from ", s.sql, ") * 1000)"];
    case "bytes":
      return ["encode(", s.sql, ", 'base64')"];
    default:
      return s.sql;
  }
};

const fromJson = (s: ScalarSym): ((value: any) => unknown) | undefined => {
  if (s.decode !== undefined) return undefined;
  if (s.col?.wire === "array") {
    if (s.col.element === "bigint") return (value: Array<string>) => value.map((x) => BigInt(x));
    if (s.col.element === "date") return (value: Array<number>) => value.map((x) => new Date(x));
    return undefined;
  }
  switch (s.col?.wire ?? s.type) {
    case "bigint":
      return (value) => BigInt(value);
    case "date":
      return (value) => new Date(value);
    case "bytes":
      return fromBase64;
    default:
      return undefined;
  }
};

// -------------------------------------------------------------- translator

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const typeOfValue = (value: unknown): JsType => {
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    default:
      if (value instanceof Date) return "date";
      if (value instanceof Uint8Array) return "bytes";
      if (Array.isArray(value)) return "array";
      return "unknown";
  }
};

const isNullConst = (sym: Sym): boolean => sym.k === "const" && sym.value == null;

export const tableName = (table: AnyTable): string =>
  table.schema === undefined ? ident(table.name) : `${ident(table.schema)}.${ident(table.name)}`;

export const aliased = (columns: ReadonlyArray<Frag>): Frag =>
  columns.length === 0
    ? "1"
    : join(
        columns.map((column, index) => [column, " AS ", ident(`c${index}`)]),
        ", ",
      );

/**
 * For a table, the function called with every row of it that a query
 * materializes, which returns the object to use (or undefined: use the row).
 */
export type Materializer = (table: AnyTable) => ((row: Record<string, any>) => unknown) | undefined;

export class Translator {
  private counter = 0;
  /** set by a session, to track the rows it loads */
  materialize: Materializer | undefined = undefined;

  alias(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  // ---------------------------------------------------------------- selects

  entity(
    table: AnyTable,
    rels: Relations | undefined,
    alias: string,
    owner: Select,
    nullable: boolean,
  ): EntitySym {
    const prefix = `${ident(alias)}.`;
    return {
      k: "entity",
      table,
      rels,
      ref: (column) => prefix + ident(column.name),
      owner,
      nullable,
      navs: new Map(),
      includes: undefined,
    };
  }

  build(source: QuerySource): Select {
    const select = new Select();
    const alias = this.alias("t");
    select.from = [tableName(source.table), " AS ", ident(alias)];
    select.shape = this.entity(source.table, source.rels, alias, select, false);
    for (const op of source.ops) this.applyOp(select, op);
    return select;
  }

  private isWindowed(select: Select): boolean {
    return select.limit !== null || select.offset !== null || select.distinct;
  }

  /** Makes the select safe to filter, join or group further. */
  private plain(select: Select, operator: string): void {
    if (select.shape.k === "group") {
      fail(`${operator} cannot follow groupBy; add a select first`);
    }
    if (this.isWindowed(select) || select.grouped) this.pushdown(select);
  }

  applyOp(select: Select, op: Op): void {
    switch (op.k) {
      case "where": {
        if (select.shape.k !== "group") this.plain(select, "where");
        const test = this.apply(op.fn, [select.shape]);
        if (test.k === "const" && test.value) return;
        (select.shape.k === "group" ? select.having : select.where).push(this.bool(test));
        return;
      }
      case "select": {
        if (select.distinct) this.pushdown(select);
        const group = select.shape.k === "group";
        select.shape = this.apply(op.fn, [select.shape]);
        if (group) {
          if (select.shape.k === "group") fail("a group cannot be selected as is; project it");
          select.grouped = true;
        }
        return;
      }
      case "orderBy": {
        if (this.isWindowed(select)) this.pushdown(select);
        const keys = this.leaves(this.apply(op.fn, [select.shape]), true);
        if (!op.append) select.orderBy = [];
        for (const sql of keys) select.orderBy.push({ sql, desc: op.desc });
        return;
      }
      case "take": {
        if (!Number.isInteger(op.n) || op.n < 0) fail("take expects a non-negative integer");
        if (select.limit !== null) this.pushdown(select);
        select.limit = op.n;
        return;
      }
      case "skip": {
        if (!Number.isInteger(op.n) || op.n < 0) fail("skip expects a non-negative integer");
        if (select.limit !== null || select.offset !== null) this.pushdown(select);
        select.offset = op.n;
        return;
      }
      case "distinct": {
        if (select.shape.k === "group") fail("distinct cannot follow groupBy; add a select first");
        if (select.limit !== null || select.offset !== null) this.pushdown(select);
        select.distinct = true;
        select.orderBy = [];
        return;
      }
      case "groupBy": {
        this.plain(select, "groupBy");
        const key = this.apply(op.fn, [select.shape]);
        select.groupBy = this.leaves(key, false);
        select.orderBy = [];
        select.shape = { k: "group", key, element: select.shape, filter: [], distinct: false };
        return;
      }
      case "join": {
        this.plain(select, "join");
        const right = this.build(op.other);
        if (right.shape.k === "group") fail("a grouped query must be projected before joining");
        const simple =
          right.joins.length === 0 &&
          right.where.length === 0 &&
          right.groupBy === null &&
          !this.isWindowed(right) &&
          right.shape.k === "entity" &&
          right.shape.owner === right;
        if (!simple) this.pushdown(right);
        let shape = right.shape;
        this.reown(shape, select);
        // the ON clause sees the joined row as present; the result may not
        const before = select.joins.length;
        const on = this.bool(this.apply(op.on, [select.shape, shape]));
        if (select.joins.length === before) {
          select.joins.push({ kind: op.left ? "LEFT JOIN" : "INNER JOIN", sql: right.from, on });
        } else if (!op.left) {
          // The condition followed a relation, whose join must come after
          // this one: join first, and apply the condition as a filter.
          select.joins.splice(before, 0, { kind: "INNER JOIN", sql: right.from, on: "TRUE" });
          select.where.push(on);
        } else {
          fail(
            "the condition of a leftJoin cannot follow a relation; " +
              "select the related value in the joined query, or compare the foreign key",
          );
        }
        if (op.left) shape = this.nullable(shape);
        select.shape = this.apply(op.result, [select.shape, shape]);
        return;
      }
      case "selectMany": {
        this.plain(select, "selectMany");
        const collection = this.collection(this.apply(op.fn, [select.shape]), "selectMany");
        const inner = collection.make();
        if (inner.shape.k === "group") fail("a grouped query must be projected first");
        if (inner.groupBy === null && !this.isWindowed(inner)) {
          if (inner.joins.length === 0) {
            select.joins.push({ kind: "INNER JOIN", sql: inner.from, on: and(inner.where) });
          } else {
            select.joins.push({ kind: "INNER JOIN", sql: inner.from, on: "TRUE" }, ...inner.joins);
            select.where.push(...inner.where);
          }
        } else {
          this.pushdown(inner);
          select.joins.push({ kind: "INNER JOIN LATERAL", sql: inner.from, on: "TRUE" });
        }
        this.reown(inner.shape, select);
        select.shape =
          op.result === undefined
            ? inner.shape
            : this.apply(op.result, [select.shape, inner.shape]);
        return;
      }
      case "include": {
        const shape = select.shape;
        if (shape.k !== "entity") return fail("include can only be applied to a table row");
        const includes = new Map(shape.includes);
        includes.set(op.key, this.member(shape, op.key));
        select.shape = { ...shape, includes };
        return;
      }
    }
  }

  private reown(sym: Sym, owner: Select): void {
    switch (sym.k) {
      case "entity":
        if (sym.owner === owner) return;
        sym.owner = owner;
        // relations already navigated were joined in the old select, whose
        // joins moved here with it; later ones must be added here too
        for (const nav of sym.navs.values()) this.reown(nav, owner);
        if (sym.includes !== undefined) {
          for (const included of sym.includes.values()) this.reown(included, owner);
        }
        return;
      case "object":
        for (const value of sym.props.values()) this.reown(value, owner);
        return;
      case "tuple":
        for (const value of sym.items) this.reown(value, owner);
        return;
    }
  }

  private nullable(sym: Sym): Sym {
    switch (sym.k) {
      case "scalar":
        return sym.nullable ? sym : { ...sym, nullable: true };
      case "entity":
        return sym.nullable ? sym : { ...sym, nullable: true, navs: new Map() };
      case "object": {
        const props = new Map<string, Sym>();
        for (const [key, value] of sym.props) props.set(key, this.nullable(value));
        return { k: "object", props };
      }
      case "tuple":
        return { k: "tuple", items: sym.items.map((item) => this.nullable(item)) };
      default:
        return sym;
    }
  }

  /** The scalar expressions a key is made of (for ORDER BY and GROUP BY). */
  private leaves(sym: Sym, ordering: boolean): Array<Frag> {
    switch (sym.k) {
      case "scalar":
        return [sym.sql];
      case "entity": {
        const columns =
          ordering && sym.table.primaryKey.length > 0 ? sym.table.primaryKey : sym.table.columnList;
        return columns.map((column) => sym.ref(column));
      }
      case "object":
        return [...sym.props.values()].flatMap((value) => this.leaves(value, ordering));
      case "tuple":
        return sym.items.flatMap((value) => this.leaves(value, ordering));
      case "const":
        return [];
      default:
        return fail(`${describe(sym)} cannot be used as a key`);
    }
  }

  /**
   * Wraps the select in a subquery: `select` becomes `SELECT ... FROM (old) AS s`.
   * Used whenever the next operator must apply to the result of a LIMIT,
   * DISTINCT or GROUP BY.
   */
  private pushdown(select: Select): void {
    if (select.shape.k === "group") fail("groupBy must be followed by select");
    const alias = this.alias("s");
    const prefix = `${ident(alias)}.`;
    const columns: Array<Frag> = [];
    const column = (sql: Frag): string => `${prefix}${ident(`c${columns.push(sql) - 1}`)}`;

    const remap = (sym: Sym): Sym => {
      switch (sym.k) {
        case "scalar":
          return { ...sym, sql: column(sym.sql) };
        case "entity": {
          const refs = new Map<string, string>();
          for (const col of sym.table.columnList) refs.set(col.key, column(sym.ref(col)));
          let includes: Map<string, Sym> | undefined;
          if (sym.includes !== undefined) {
            includes = new Map();
            for (const [key, value] of sym.includes) includes.set(key, remap(value));
          }
          return {
            k: "entity",
            table: sym.table,
            rels: sym.rels,
            ref: (col) => refs.get(col.key)!,
            owner: select,
            nullable: sym.nullable,
            navs: new Map(),
            includes,
          };
        }
        case "object": {
          const props = new Map<string, Sym>();
          for (const [key, value] of sym.props) props.set(key, remap(value));
          return { k: "object", props };
        }
        case "tuple":
          return { k: "tuple", items: sym.items.map(remap) };
        case "coll":
          return remap(this.jsonCollection(sym));
        case "const":
          return sym;
        default:
          return fail(`${describe(sym)} cannot be carried through a subquery`);
      }
    };

    const shape = remap(select.shape);
    const windowed = select.limit !== null || select.offset !== null;
    const orderBy = select.distinct
      ? []
      : select.orderBy.map((order) => ({ sql: column(order.sql), desc: order.desc }));
    if (!windowed) select.orderBy = [];
    const inner = this.render(select, aliased(columns));

    select.from = ["(", inner, ") AS ", ident(alias)];
    select.derived = true;
    select.joins = [];
    select.where = [];
    select.groupBy = null;
    select.having = [];
    select.orderBy = orderBy;
    select.limit = null;
    select.offset = null;
    select.distinct = false;
    select.grouped = false;
    select.shape = shape;
  }

  render(select: Select, columns: Frag): Frag {
    const out: Array<Frag> = [select.distinct ? "SELECT DISTINCT " : "SELECT ", columns];
    out.push(" FROM ", select.from);
    for (const j of select.joins) out.push(" ", j.kind, " ", j.sql, " ON ", j.on);
    if (select.where.length > 0) out.push(" WHERE ", join(select.where, " AND "));
    if (select.groupBy !== null && select.groupBy.length > 0) {
      out.push(" GROUP BY ", join(select.groupBy, ", "));
    }
    if (select.having.length > 0) out.push(" HAVING ", join(select.having, " AND "));
    if (select.orderBy.length > 0) {
      out.push(
        " ORDER BY ",
        join(
          select.orderBy.map((order) => (order.desc ? [order.sql, " DESC"] : order.sql)),
          ", ",
        ),
      );
    }
    if (select.limit !== null) out.push(` LIMIT ${select.limit}`);
    if (select.offset !== null) out.push(` OFFSET ${select.offset}`);
    return out;
  }

  // ------------------------------------------------------------ projection

  /**
   * Adds the columns `sym` needs to `columns` and returns a function that
   * builds the result value from a row. With `json`, the row is an object
   * produced by `json_agg` rather than the driver's array of values.
   */
  plan(sym: Sym, columns: Array<Frag>, json: boolean): Reader {
    switch (sym.k) {
      case "const": {
        const value = sym.value;
        return () => value;
      }
      case "scalar": {
        const sql: Frag = json
          ? sym.pred && sym.nullable
            ? ["COALESCE(", sym.sql, ", FALSE)"]
            : toJson(sym)
          : sym.pred && sym.nullable
            ? ["COALESCE(", sym.sql, ", FALSE)"]
            : sym.sql;
        const index = columns.push(sql) - 1;
        const key = json ? `c${index}` : index;
        const pre = json ? fromJson(sym) : sym.col === undefined ? fromDriver(sym.type) : undefined;
        const decode = sym.decode ?? sym.col?.decode;
        const guard = sym.col === undefined || !sym.col.nullable;
        if (pre === undefined && decode === undefined) return (row) => row[key];
        return (row) => {
          let value = row[key];
          if (value === null || value === undefined) {
            if (guard) return null;
          } else if (pre !== undefined) value = pre(value);
          return decode === undefined ? value : decode(value);
        };
      }
      case "entity": {
        const table = sym.table;
        const keys: Array<string> = [];
        const readers: Array<Reader> = [];
        let presence: string | number | undefined;
        if (sym.nullable) {
          const pk = table.primaryKey[0];
          if (pk === undefined) {
            return fail(
              `table "${table.name}" needs a primary key to be read through an outer join`,
            );
          }
          presence = columns.length + table.columnList.indexOf(pk);
          if (json) presence = `c${presence}`;
        }
        for (const col of table.columnList) {
          keys.push(col.key);
          readers.push(
            this.plan(
              {
                k: "scalar",
                sql: sym.ref(col),
                type: col.type,
                nullable: col.nullable || sym.nullable,
                col,
              },
              columns,
              json,
            ),
          );
        }
        if (sym.includes !== undefined) {
          for (const [key, value] of sym.includes) {
            keys.push(key);
            readers.push(this.plan(value, columns, json));
          }
        }
        const size = keys.length;
        const track = this.materialize?.(table);
        // a table declared from a Model.Class: rows are instances of the class
        const proto = table.model?.proto;
        if (track !== undefined) {
          return (row) => {
            if (presence !== undefined && row[presence] === null) return null;
            const out: Record<string, unknown> = proto === undefined ? {} : Object.create(proto);
            for (let i = 0; i < size; i++) out[keys[i]!] = readers[i]!(row);
            return track(out);
          };
        }
        if (proto !== undefined) {
          return (row) => {
            if (presence !== undefined && row[presence] === null) return null;
            const out: Record<string, unknown> = Object.create(proto);
            for (let i = 0; i < size; i++) out[keys[i]!] = readers[i]!(row);
            return out;
          };
        }
        return (row) => {
          if (presence !== undefined && row[presence] === null) return null;
          const out: Record<string, unknown> = {};
          for (let i = 0; i < size; i++) out[keys[i]!] = readers[i]!(row);
          return out;
        };
      }
      case "object": {
        const keys: Array<string> = [];
        const readers: Array<Reader> = [];
        for (const [key, value] of sym.props) {
          keys.push(key);
          readers.push(this.plan(value, columns, json));
        }
        const size = keys.length;
        return (row) => {
          const out: Record<string, unknown> = {};
          for (let i = 0; i < size; i++) out[keys[i]!] = readers[i]!(row);
          return out;
        };
      }
      case "tuple": {
        const readers = sym.items.map((item) => this.plan(item, columns, json));
        return (row) => readers.map((reader) => reader(row));
      }
      case "coll":
        return this.plan(this.jsonCollection(sym), columns, json);
      case "group":
        return fail("groupBy must be followed by select");
      case "lambda":
        return fail("a function cannot be selected");
    }
  }

  /** Renders a collection as a single JSON column, decoded on the client. */
  private jsonCollection(collection: CollSym): ScalarSym {
    const select = collection.make();
    if (select.shape.k === "group") fail("groupBy must be followed by select");
    const columns: Array<Frag> = [];
    const reader = this.plan(select.shape, columns, true);
    const alias = this.alias("s");
    const parse = (value: any): any => (typeof value === "string" ? JSON.parse(value) : value);
    if (collection.single) {
      select.limit = 1;
      const inner = this.render(select, aliased(columns));
      return {
        k: "scalar",
        sql: ["(SELECT row_to_json(", ident(alias), ") FROM (", inner, ") AS ", ident(alias), ")"],
        type: "json",
        nullable: true,
        decode: (value) => reader(parse(value)),
      };
    }
    const inner = this.render(select, aliased(columns));
    return {
      k: "scalar",
      sql: [
        "COALESCE((SELECT json_agg(",
        ident(alias),
        ") FROM (",
        inner,
        ") AS ",
        ident(alias),
        "), '[]'::json)",
      ],
      type: "json",
      nullable: false,
      decode: (value) => {
        const rows: Array<Row> = parse(value);
        const out: Array<unknown> = [];
        for (let i = 0; i < rows.length; i++) out.push(reader(rows[i]!));
        return out;
      },
    };
  }

  // ------------------------------------------------------------ evaluation

  apply(fn: Callable, args: ReadonlyArray<Sym>): Sym {
    const vars = new Map(fn.env.vars);
    for (let i = 0; i < fn.p.length; i++) {
      const arg = args[i];
      if (arg !== undefined) this.bind(fn.p[i]!, arg, vars);
    }
    if (fn.loc === undefined) return this.eval(fn.b, { vars, captures: fn.env.captures });
    try {
      return this.eval(fn.b, { vars, captures: fn.env.captures });
    } catch (error) {
      if (error instanceof LinqError && error.location === undefined) {
        error.location = fn.loc;
        error.message += `\n    in the lambda at ${fn.loc}`;
      }
      throw error;
    }
  }

  private bind(pattern: Pattern, sym: Sym, vars: Map<string, Sym>): void {
    if (typeof pattern === "string") {
      vars.set(pattern, sym);
    } else if ("o" in pattern) {
      for (const [key, inner] of pattern.o) this.bind(inner, this.member(sym, key), vars);
    } else {
      pattern.a.forEach((inner, index) => {
        if (inner !== null) this.bind(inner, this.member(sym, String(index)), vars);
      });
    }
  }

  eval(node: Node, env: Env): Sym {
    switch (node.t) {
      case "p":
        return env.vars.get(node.n) ?? fail(`unbound name "${node.n}"`);
      case "c":
        return this.captured(env.captures[node.i]!());
      case "l":
        return node.u ? constant(undefined) : { k: "const", value: node.v, literal: true };
      case "big":
        return constant(BigInt(node.v));
      case "m":
        return this.member(this.eval(node.o, env), node.n);
      case "call":
        return this.call(
          this.eval(node.o, env),
          node.n,
          node.a.map((arg) => this.eval(arg, env)),
        );
      case "fn": {
        const f = this.eval(node.f, env);
        const args = node.a.map((arg) => this.eval(arg, env));
        const impl = f.k === "const" ? lookupFn(f.value) : undefined;
        if (impl !== undefined) return impl(this, args);
        if (f.k === "const" && typeof f.value === "function" && args.every(isPlainConst)) {
          return constant(f.value(...args.map((arg) => (arg as ConstSym).value)));
        }
        if (f.k === "const" && typeof f.value === "function") {
          // a shared query expression (see quote) applied to a row
          const quoted = (f.value as any)[QuoteSymbol] as Quote | undefined;
          if (quoted !== undefined) return this.apply(callable(quoted), args);
          return fail(
            `${node.n}(...) is not a query expression. Declare it with quote(), or as a ` +
              "module-level `const` arrow function in the file that uses it",
          );
        }
        return fail(`${node.n}(...) cannot be translated to SQL`);
      }
      case "b":
        return this.binary(node.op, this.eval(node.l, env), () => this.eval(node.r, env));
      case "u":
        return this.unary(node.op, this.eval(node.a, env));
      case "?": {
        const test = this.eval(node.c, env);
        if (test.k === "const") return this.eval(test.value ? node.a : node.b, env);
        const a = this.eval(node.a, env);
        const b = this.eval(node.b, env);
        const whenTrue = this.scalar(a, b);
        const whenFalse = this.scalar(b, a);
        return {
          k: "scalar",
          sql: [
            "CASE WHEN ",
            this.bool(test),
            " THEN ",
            whenTrue.sql,
            " ELSE ",
            whenFalse.sql,
            " END",
          ],
          type: whenTrue.type === "unknown" ? whenFalse.type : whenTrue.type,
          nullable: whenTrue.nullable || whenFalse.nullable,
          ...(whenTrue.pred && whenFalse.pred ? { pred: true } : {}),
          ...this.sharedColumn(whenTrue, whenFalse),
        };
      }
      case "tpl": {
        const parts = node.e.map((expression) => this.eval(expression, env));
        if (parts.every(isPlainConst)) {
          let text = node.q[0]!;
          parts.forEach((part, index) => {
            text += String((part as ConstSym).value) + node.q[index + 1]!;
          });
          return constant(text);
        }
        const pieces: Array<Frag> = [];
        node.q.forEach((quasi, index) => {
          if (quasi !== "") pieces.push(new Param(quasi, "text"));
          const part = parts[index];
          if (part !== undefined) pieces.push(this.text(part));
        });
        return {
          k: "scalar",
          sql: ["(", join(pieces, " || "), ")"],
          type: "string",
          nullable: false,
        };
      }
      case "o": {
        const props = new Map<string, Sym>();
        for (const [key, valueNode] of node.p) {
          const value = this.eval(valueNode, env);
          if (key !== "...") {
            props.set(key, value);
            continue;
          }
          switch (value.k) {
            case "entity":
              for (const col of value.table.columnList)
                props.set(col.key, this.member(value, col.key));
              if (value.includes !== undefined) {
                for (const [name, included] of value.includes) props.set(name, included);
              }
              break;
            case "object":
              for (const [name, inner] of value.props) props.set(name, inner);
              break;
            case "const":
              if (typeof value.value === "object" && value.value !== null) {
                for (const [name, inner] of Object.entries(value.value)) {
                  props.set(name, constant(inner));
                }
              }
              break;
            default:
              fail(`${describe(value)} cannot be spread into an object`);
          }
        }
        return { k: "object", props };
      }
      case "a":
        return { k: "tuple", items: node.e.map((element) => this.eval(element, env)) };
      case "fnx":
        return { k: "lambda", fn: { p: node.p, b: node.b, env } };
      case "err":
        return fail(`${node.m} (${node.at})`);
    }
  }

  /** A value captured from the enclosing scope. */
  captured(value: unknown): Sym {
    if (typeof value === "object" && value !== null) {
      if (value instanceof Deferred) {
        return value.impl(
          this,
          value.args.map((arg) => this.captured(arg)),
        );
      }
      const subquery = (value as any)[SubquerySymbol] as Subquery | undefined;
      if (subquery !== undefined) return this.subquery(subquery);
    }
    return constant(value);
  }

  /** A query that was run to completion inside a lambda: `other.count()`. */
  private subquery({ source, terminal }: Subquery): Sym {
    const collection: CollSym = { k: "coll", make: () => this.build(source) };
    switch (terminal.k) {
      case "all":
        return collection;
      case "first":
        return this.collCall(collection, "first", []);
      case "scalar":
        return this.collCall(collection, terminal.name, terminal.args.map(terminalArg));
    }
  }

  private sharedColumn(a: ScalarSym, b: ScalarSym): { col?: Column } {
    const col = a.col ?? b.col;
    if (col === undefined) return {};
    if ((a.col === undefined || a.col === col) && (b.col === undefined || b.col === col)) {
      return { col };
    }
    return a.col?.schema === b.col?.schema ? { col } : {};
  }

  member(sym: Sym, name: string): Sym {
    switch (sym.k) {
      case "const": {
        const value: any = sym.value;
        if (value == null) return constant(undefined);
        if (isQuerySource(value) && name === "length") return this.call(sym, "count", []);
        return constant(value[name]);
      }
      case "entity": {
        const col = sym.table.columns[name];
        if (col !== undefined) {
          return {
            k: "scalar",
            sql: sym.ref(col),
            type: col.type,
            nullable: col.nullable || sym.nullable,
            col,
          };
        }
        const included = sym.includes?.get(name);
        if (included !== undefined) return included;
        const cached = sym.navs.get(name);
        if (cached !== undefined) return cached;
        const relation = sym.rels?.get(sym.table)?.[name];
        if (relation === undefined) {
          return fail(`"${name}" is not a column or relation of "${sym.table.name}"`);
        }
        const nav = this.navigate(sym, relation);
        sym.navs.set(name, nav);
        return nav;
      }
      case "object":
        return (
          sym.props.get(name) ?? fail(`property "${name}" does not exist on the selected object`)
        );
      case "tuple":
        if (name === "length") return constant(sym.items.length);
        return sym.items[Number(name)] ?? fail(`index ${name} is out of range`);
      case "scalar":
        if (name === "length") {
          return {
            k: "scalar",
            sql: [sym.type === "array" ? "cardinality(" : "char_length(", sym.sql, ")"],
            type: "number",
            nullable: sym.nullable,
          };
        }
        return fail(`property "${name}" of ${describe(sym)} cannot be translated to SQL`);
      case "coll": {
        if (name === "length") return this.call(sym, "count", []);
        if (!sym.single) {
          return fail(`property "${name}" does not exist on a collection; use select or first`);
        }
        const select = sym.make();
        const inner = this.member(select.shape, name);
        if (inner.k === "scalar") {
          select.shape = inner;
          return this.firstScalar(select);
        }
        return {
          k: "coll",
          single: true,
          make: () => {
            const again = sym.make();
            again.shape = this.member(again.shape, name);
            return again;
          },
        };
      }
      case "group":
        if (name === "key") return sym.key;
        if (name === "length") return this.groupCall(sym, "count", []);
        return fail(`property "${name}" does not exist on a group`);
      case "lambda":
        return fail("a function has no translatable properties");
    }
  }

  private navigate(source: EntitySym, relation: Relation): Sym {
    const on = callable(relation.on);
    if (relation.kind === "many") {
      return {
        k: "coll",
        make: () => {
          const select = this.build({ table: relation.target, rels: source.rels, ops: [] });
          select.where.push(this.bool(this.apply(on, [source, select.shape])));
          return select;
        },
      };
    }
    const alias = this.alias("t");
    const nullable = relation.kind === "optional" || source.nullable;
    // Inside the ON clause the joined row exists, so its columns are compared
    // with plain `=` (which can use an index), not as possibly-absent values.
    const present = this.entity(relation.target, source.rels, alias, source.owner, false);
    source.owner.joins.push({
      kind: "LEFT JOIN",
      sql: [tableName(relation.target), " AS ", ident(alias)],
      on: this.bool(this.apply(on, [source, present])),
    });
    return nullable ? { ...present, nullable: true, navs: new Map() } : present;
  }

  // ---------------------------------------------------------------- scalars

  /**
   * Converts a symbolic value to a SQL expression. Constants become bind
   * parameters; `hint` is the value it is combined with, whose column schema
   * encodes the parameter.
   */
  scalar(sym: Sym, hint?: Sym): ScalarSym {
    switch (sym.k) {
      case "scalar":
        // used as a value, a condition that is NULL is false
        return sym.pred && sym.nullable
          ? { ...sym, sql: ["COALESCE(", sym.sql, ", FALSE)"], nullable: false }
          : sym;
      case "const": {
        let value = sym.value;
        if (value === null || value === undefined) {
          return { k: "scalar", sql: "NULL", type: "unknown", nullable: true };
        }
        if (typeof value === "boolean") {
          return { k: "scalar", sql: value ? "TRUE" : "FALSE", type: "boolean", nullable: false };
        }
        if (sym.literal && typeof value === "number" && Number.isFinite(value)) {
          // a number written in the source is part of the query, not an input
          const sql = value < 0 || Object.is(value, -0) ? `(${value})` : String(value);
          return { k: "scalar", sql, type: "number", nullable: false };
        }
        const col = hint?.k === "scalar" ? hint.col : undefined;
        if (col?.encode !== undefined) {
          try {
            value = Array.isArray(value) ? value.map(col.encode) : col.encode(value);
          } catch (cause) {
            return fail(
              `a value compared with column "${col.name}" does not match its schema: ${String(cause)}`,
            );
          }
        }
        const type = typeOfValue(sym.value);
        return {
          k: "scalar",
          sql: new Param(value, type === "string" && hint === undefined ? "text" : undefined),
          type,
          nullable: false,
        };
      }
      case "coll":
        if (sym.single) return this.firstScalar(sym.make());
        return fail("a collection cannot be used as a value; aggregate it or use it in select");
      default:
        return fail(`expected a value but found ${describe(sym)}`);
    }
  }

  private firstScalar(select: Select): ScalarSym {
    const value = this.scalar(select.shape);
    select.limit = 1;
    return { ...value, sql: ["(", this.render(select, value.sql), ")"], nullable: true };
  }

  /** `String(value)` as JavaScript would print it: null prints as "null". */
  text(sym: Sym): Frag {
    if (sym.k === "const") return new Param(String(sym.value), "text");
    const value = this.scalar(sym);
    const sql: Frag =
      value.type === "string"
        ? value.sql
        : value.type === "number"
          ? ["(", value.sql, ")::float8::text"]
          : ["(", value.sql, ")::text"];
    return value.nullable ? ["COALESCE(", sql, ", 'null')"] : sql;
  }

  /** Converts a symbolic value to a SQL condition, following JS truthiness. */
  bool(sym: Sym): Frag {
    switch (sym.k) {
      case "const":
        return sym.value ? "TRUE" : "FALSE";
      case "scalar":
        switch (sym.type) {
          case "boolean":
          case "unknown":
            return sym.sql;
          case "string":
            return ["(", sym.sql, " IS NOT NULL AND ", sym.sql, " <> '')"];
          case "number":
          case "bigint":
            return ["(", sym.sql, " IS NOT NULL AND ", sym.sql, " <> 0)"];
          default:
            return sym.nullable ? ["(", sym.sql, " IS NOT NULL)"] : "TRUE";
        }
      case "entity":
        return sym.nullable ? this.entityIsNull(sym, true) : "TRUE";
      case "object":
      case "tuple":
        return "TRUE";
      default:
        return fail(`${describe(sym)} cannot be used as a condition`);
    }
  }

  private entityIsNull(sym: EntitySym, negate: boolean): Frag {
    const pk = sym.table.primaryKey[0];
    if (pk === undefined) {
      return fail(`table "${sym.table.name}" needs a primary key to be compared with null`);
    }
    return ["(", sym.ref(pk), negate ? " IS NOT NULL)" : " IS NULL)"];
  }

  private unary(op: "!" | "-" | "+", sym: Sym): Sym {
    if (sym.k === "const") {
      const value: any = sym.value;
      return constant(op === "!" ? !value : op === "-" ? -value : +value);
    }
    if (op === "!") {
      const nullable = sym.k === "scalar" && sym.nullable && sym.type === "boolean";
      const test = this.bool(sym);
      return predicate(nullable ? ["NOT COALESCE(", test, ", FALSE)"] : ["NOT ", test]);
    }
    const value = this.scalar(sym);
    return {
      k: "scalar",
      sql: op === "-" ? ["(-", value.sql, ")"] : ["(", value.sql, ")::float8"],
      type: value.type === "bigint" ? "bigint" : "number",
      nullable: value.nullable,
    };
  }

  private binary(op: string, left: Sym, evalRight: () => Sym): Sym {
    switch (op) {
      case "&&": {
        if (left.k === "const") return left.value ? evalRight() : left;
        const right = evalRight();
        if (right.k === "const") {
          if (!right.value) return FALSE;
          // `flag && true` is `flag` itself, null included
          return left.k === "scalar" && left.type === "boolean" ? left : this.condition(left);
        }
        return this.logical(" AND ", left, right);
      }
      case "||": {
        if (left.k === "const") return left.value ? left : evalRight();
        const right = evalRight();
        const booleanLeft =
          left.k !== "scalar" || left.type === "boolean" || left.type === "unknown";
        if (booleanLeft) {
          if (right.k === "const") return right.value ? TRUE : this.condition(left);
          return this.logical(" OR ", left, right);
        }
        // `value || fallback`: falsy values (null, '', 0) fall through
        const value = left as ScalarSym;
        const fallback = this.scalar(right, value);
        const empty =
          value.type === "string"
            ? "''"
            : value.type === "number" || value.type === "bigint"
              ? "0"
              : undefined;
        return {
          k: "scalar",
          sql: [
            "COALESCE(",
            empty === undefined ? value.sql : ["NULLIF(", value.sql, ", ", empty, ")"],
            ", ",
            fallback.sql,
            ")",
          ],
          type: value.type,
          nullable: fallback.nullable,
          ...this.sharedColumn(value, fallback),
        };
      }
      case "??": {
        if (left.k === "const") return left.value == null ? evalRight() : left;
        const right = evalRight();
        const value = this.scalar(left, right);
        if (isNullConst(right)) return value;
        const fallback = this.scalar(right, value);
        return {
          k: "scalar",
          sql: ["COALESCE(", value.sql, ", ", fallback.sql, ")"],
          type: value.type === "unknown" ? fallback.type : value.type,
          nullable: fallback.nullable,
          ...(value.pred ? { pred: true } : {}),
          ...this.sharedColumn(value, fallback),
        };
      }
    }

    const right = evalRight();
    if (left.k === "const" && right.k === "const") {
      return constant(jsBinary(op, left.value, right.value));
    }
    switch (op) {
      case "===":
      case "==":
        return this.equals(left, right, false);
      case "!==":
      case "!=":
        return this.equals(left, right, true);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const l = this.scalar(left, right);
        const r = this.scalar(right, left);
        return predicate(["(", l.sql, ` ${op} `, r.sql, ")"], l.nullable || r.nullable);
      }
    }

    const l = this.scalar(left, right);
    const r = this.scalar(right, left);
    const nullable = l.nullable || r.nullable;
    if (op === "+" && (l.type === "string" || r.type === "string")) {
      return {
        k: "scalar",
        sql: ["(", this.text(l), " || ", this.text(r), ")"],
        type: "string",
        nullable: false,
      };
    }
    if (op === "-" && l.type === "date" && r.type === "date") {
      return {
        k: "scalar",
        sql: ["(extract(epoch from (", l.sql, " - ", r.sql, ")) * 1000)"],
        type: "number",
        nullable,
      };
    }
    const type: JsType = l.type === "bigint" || r.type === "bigint" ? "bigint" : "number";
    // JS division is floating point; Postgres would truncate integers.
    const sql: Frag =
      op === "/" && type === "number"
        ? ["((", l.sql, ")::float8 / ", r.sql, ")"]
        : ["(", l.sql, ` ${op} `, r.sql, ")"];
    return { k: "scalar", sql, type, nullable };
  }

  /** `sym` as a condition, keeping track of whether it can be NULL. */
  private condition(sym: Sym): ScalarSym {
    return predicate(this.bool(sym), sym.k === "scalar" && sym.nullable && sym.type === "boolean");
  }

  private logical(operator: " AND " | " OR ", left: Sym, right: Sym): ScalarSym {
    const nullable =
      (left.k === "scalar" && left.nullable) || (right.k === "scalar" && right.nullable);
    return predicate(["(", this.bool(left), operator, this.bool(right), ")"], nullable);
  }

  private equals(left: Sym, right: Sym, negate: boolean): Sym {
    if (isNullConst(left)) [left, right] = [right, left];
    if (isNullConst(right)) {
      switch (left.k) {
        case "entity":
          return left.nullable ? predicate(this.entityIsNull(left, negate)) : constant(negate);
        case "object":
        case "tuple":
          return constant(negate);
        default: {
          const value = this.scalar(left);
          return predicate(["(", value.sql, negate ? " IS NOT NULL)" : " IS NULL)"]);
        }
      }
    }
    if (left.k === "entity" || right.k === "entity") {
      if (left.k !== "entity" || right.k !== "entity" || left.table !== right.table) {
        return fail("a table row can only be compared with a row of the same table or null");
      }
      const keys = left.table.primaryKey;
      if (keys.length === 0) fail(`table "${left.table.name}" needs a primary key to be compared`);
      const other = right;
      const both = left.nullable && other.nullable;
      const same = and(
        keys.map((key) => [left.ref(key), both ? " IS NOT DISTINCT FROM " : " = ", other.ref(key)]),
      );
      if (both) return predicate(negate ? ["NOT ", same] : same);
      const nullable = left.nullable || other.nullable;
      return predicate(
        negate ? (nullable ? ["NOT COALESCE(", same, ", FALSE)"] : ["NOT ", same]) : same,
        !negate && nullable,
      );
    }
    const l = this.scalar(left, right);
    const r = this.scalar(right, left);
    // JS has no three-valued logic: null === null, and null !== 1 is true.
    if (l.nullable && r.nullable) {
      return predicate([
        "(",
        l.sql,
        negate ? " IS DISTINCT FROM " : " IS NOT DISTINCT FROM ",
        r.sql,
        ")",
      ]);
    }
    if (negate && (l.nullable || r.nullable)) {
      return predicate(["(", l.sql, " IS DISTINCT FROM ", r.sql, ")"]);
    }
    return predicate(["(", l.sql, negate ? " <> " : " = ", r.sql, ")"], l.nullable || r.nullable);
  }

  // ------------------------------------------------------------------ calls

  private collection(sym: Sym, operator: string): CollSym {
    if (sym.k === "coll") return sym;
    if (sym.k === "const" && isQuerySource(sym.value)) {
      const source = sym.value;
      return { k: "coll", make: () => this.build(source) };
    }
    return fail(`${operator} expects a collection but found ${describe(sym)}`);
  }

  call(receiver: Sym, name: string, args: ReadonlyArray<Sym>): Sym {
    switch (receiver.k) {
      case "const": {
        const value: any = receiver.value;
        if (isQuerySource(value)) return this.collCall(this.collection(receiver, name), name, args);
        const f = value == null ? undefined : value[name];
        const impl = lookupFn(f);
        if (impl !== undefined) return impl(this, args);
        if (Array.isArray(value)) {
          const result = this.arrayCall(value, name, args);
          if (result !== undefined) return result;
        }
        if (typeof f === "function" && args.every(isPlainConst)) {
          return constant(
            f.apply(
              value,
              args.map((arg) => (arg as ConstSym).value),
            ),
          );
        }
        if (value == null) return fail(`cannot call .${name}() on ${value}`);
        return this.scalarCall(this.scalar(receiver), name, args);
      }
      case "scalar":
        return this.scalarCall(receiver, name, args);
      case "coll":
        return this.collCall(receiver, name, args);
      case "group":
        return this.groupCall(receiver, name, args);
      case "tuple":
        if (name === "includes") {
          const value = this.scalar(args[0] ?? fail("includes expects an argument"));
          const present = receiver.items.filter((item) => !isNullConst(item));
          const hasNull = present.length !== receiver.items.length && value.nullable;
          if (present.length === 0) {
            return hasNull ? predicate(["(", value.sql, " IS NULL)"]) : FALSE;
          }
          const items = present.map((item) => this.scalar(item, value));
          if (hasNull) {
            return predicate([
              "(",
              value.sql,
              " IS NULL OR ",
              value.sql,
              " IN (",
              join(
                items.map((item) => item.sql),
                ", ",
              ),
              "))",
            ]);
          }
          return predicate(
            [
              "(",
              value.sql,
              " IN (",
              join(
                items.map((item) => item.sql),
                ", ",
              ),
              "))",
            ],
            value.nullable || items.some((item) => item.nullable),
          );
        }
        return fail(`.${name}() on an array literal cannot be translated to SQL`);
      default:
        return fail(`.${name}() cannot be called on ${describe(receiver)}`);
    }
  }

  /** Methods of a captured JavaScript array whose arguments depend on the row. */
  private arrayCall(
    values: ReadonlyArray<unknown>,
    name: string,
    args: ReadonlyArray<Sym>,
  ): Sym | undefined {
    const first = args[0];
    if (first === undefined) return undefined;
    if (name === "includes" && first.k !== "const" && first.k !== "lambda") {
      const present = values.filter((value) => value !== null && value !== undefined);
      // as in JavaScript, a list that holds null includes a null value
      const hasNull = present.length !== values.length;
      const value = this.scalar(first);
      if (present.length === 0) {
        return hasNull && value.nullable ? predicate(["(", value.sql, " IS NULL)"]) : FALSE;
      }
      const list = this.scalar(constant(present), value);
      if (hasNull && value.nullable) {
        return predicate(["(", value.sql, " IS NULL OR ", value.sql, " = ANY(", list.sql, "))"]);
      }
      return predicate(["(", value.sql, " = ANY(", list.sql, "))"], value.nullable);
    }
    if ((name === "some" || name === "every") && first.k === "lambda") {
      const every = name === "every";
      const tests: Array<Frag> = [];
      for (const value of values) {
        const test = this.apply(first.fn, [constant(value)]);
        if (test.k === "const") {
          if (Boolean(test.value) !== every) return constant(!every);
          continue;
        }
        tests.push(this.bool(test));
      }
      if (tests.length === 0) return constant(every);
      return predicate(["(", join(tests, every ? " AND " : " OR "), ")"], true);
    }
    return undefined;
  }

  private lambda(sym: Sym | undefined, operator: string): Callable {
    if (sym?.k === "lambda") return sym.fn;
    if (sym?.k === "const" && typeof sym.value === "function") {
      // a quote()d expression captured from the enclosing scope
      const quoted = (sym.value as any)[QuoteSymbol] as Quote | undefined;
      if (quoted !== undefined) return callable(quoted);
      return fail(
        `${operator} was given a function that is not a query expression; wrap it in quote()`,
      );
    }
    return fail(`${operator} expects a function`);
  }

  private count(sym: Sym | undefined, operator: string): number {
    if (sym?.k !== "const" || typeof sym.value !== "number") {
      return fail(`${operator} expects a number that does not depend on the row`);
    }
    return sym.value;
  }

  private chain(collection: CollSym, op: Op): CollSym {
    return {
      k: "coll",
      make: () => {
        const select = collection.make();
        this.applyOp(select, op);
        return select;
      },
    };
  }

  /** Query operators, usable both on a query and on a collection inside a lambda. */
  collCall(collection: CollSym, name: string, args: ReadonlyArray<Sym>): Sym {
    // a query built inside the lambda already is a collection here
    if (name === "asMany" || name === "toArray") return collection;
    const first = args[0];
    const ordering = (desc: boolean, append: boolean): Sym =>
      this.chain(collection, { k: "orderBy", fn: this.lambda(first, name), desc, append });
    const filtered = (): CollSym =>
      first === undefined
        ? collection
        : this.chain(collection, { k: "where", fn: this.lambda(first, name) });
    const projected = (): Select => {
      const select = (
        first === undefined
          ? collection
          : this.chain(collection, { k: "select", fn: this.lambda(first, name) })
      ).make();
      if (select.shape.k === "group") fail("groupBy must be followed by select");
      if (this.isWindowed(select) || select.grouped) this.pushdown(select);
      select.orderBy = [];
      return select;
    };

    switch (name) {
      case "where":
      case "filter":
        return this.chain(collection, { k: "where", fn: this.lambda(first, name) });
      case "select":
      case "map":
        return this.chain(collection, { k: "select", fn: this.lambda(first, name) });
      case "selectMany":
      case "flatMap":
        return this.chain(collection, {
          k: "selectMany",
          fn: this.lambda(first, name),
          result: args[1] === undefined ? undefined : this.lambda(args[1], name),
        });
      case "orderBy":
        return ordering(false, false);
      case "orderByDescending":
        return ordering(true, false);
      case "thenBy":
        return ordering(false, true);
      case "thenByDescending":
        return ordering(true, true);
      case "take":
        return this.chain(collection, { k: "take", n: this.count(first, name) });
      case "skip":
        return this.chain(collection, { k: "skip", n: this.count(first, name) });
      case "distinct":
        return this.chain(collection, { k: "distinct" });
      case "groupBy":
        return this.chain(collection, { k: "groupBy", fn: this.lambda(first, name) });
      case "toArray":
        return collection;

      case "any":
      case "some": {
        const select = filtered().make();
        if (select.shape.k === "group") fail("groupBy must be followed by select");
        if (select.limit === null) select.orderBy = [];
        return predicate(["EXISTS (", this.render(select, "1"), ")"]);
      }
      case "all":
      case "every": {
        const test = this.lambda(first, name);
        const select = collection.make();
        this.plain(select, name);
        select.where.push(this.bool(this.unary("!", this.apply(test, [select.shape]))));
        select.orderBy = [];
        return predicate(["NOT EXISTS (", this.render(select, "1"), ")"]);
      }
      case "count": {
        const select = filtered().make();
        if (select.shape.k === "group") fail("groupBy must be followed by select");
        if (this.isWindowed(select) || select.grouped) this.pushdown(select);
        select.orderBy = [];
        return {
          k: "scalar",
          sql: ["(", this.render(select, "count(*)::int"), ")"],
          type: "number",
          nullable: false,
        };
      }
      case "sum": {
        const select = projected();
        const value = this.scalar(select.shape);
        return {
          k: "scalar",
          sql: ["(", this.render(select, ["COALESCE(sum(", value.sql, "), 0)"]), ")"],
          type: value.type === "bigint" ? "bigint" : "number",
          nullable: false,
        };
      }
      case "average": {
        const select = projected();
        const value = this.scalar(select.shape);
        return {
          k: "scalar",
          sql: ["(", this.render(select, ["avg(", value.sql, ")::float8"]), ")"],
          type: "number",
          nullable: true,
        };
      }
      case "min":
      case "max": {
        const select = projected();
        const value = this.scalar(select.shape);
        return {
          ...value,
          sql: ["(", this.render(select, [name, "(", value.sql, ")"]), ")"],
          nullable: true,
        };
      }
      case "includes":
      case "contains": {
        const value = this.scalar(first ?? fail(`${name} expects an argument`));
        const select = collection.make();
        const item = this.scalar(select.shape);
        if (select.limit === null) select.orderBy = [];
        return predicate(
          ["(", value.sql, " IN (", this.render(select, item.sql), "))"],
          value.nullable || item.nullable,
        );
      }
      case "first":
      case "firstOrNull": {
        const source = filtered();
        const select = source.make();
        if (select.shape.k === "scalar") return this.firstScalar(select);
        return { k: "coll", single: true, make: source.make };
      }
      default:
        return fail(`.${name}() is not a supported collection operator`);
    }
  }

  /** Aggregates over the rows of a group. */
  private groupCall(group: GroupSym, name: string, args: ReadonlyArray<Sym>): Sym {
    const first = args[0];
    const filter = (extra?: Frag): Frag =>
      group.filter.length === 0 && extra === undefined
        ? ""
        : [
            " FILTER (WHERE ",
            and(extra === undefined ? group.filter : [...group.filter, extra]),
            ")",
          ];
    const value = (): ScalarSym =>
      this.scalar(
        first === undefined ? group.element : this.apply(this.lambda(first, name), [group.element]),
      );
    const distinct = group.distinct ? "DISTINCT " : "";

    switch (name) {
      case "where":
      case "filter":
        return {
          ...group,
          filter: [
            ...group.filter,
            this.bool(this.apply(this.lambda(first, name), [group.element])),
          ],
        };
      case "select":
      case "map":
        return { ...group, element: this.apply(this.lambda(first, name), [group.element]) };
      case "distinct":
        return { ...group, distinct: true };
      case "count": {
        const extra =
          first === undefined
            ? undefined
            : this.bool(this.apply(this.lambda(first, name), [group.element]));
        const what: Frag = group.distinct ? ["DISTINCT ", this.scalar(group.element).sql] : "*";
        return {
          k: "scalar",
          sql: ["count(", what, ")", filter(extra), "::int"],
          type: "number",
          nullable: false,
        };
      }
      case "sum": {
        const v = value();
        return {
          k: "scalar",
          sql: ["COALESCE(sum(", distinct, v.sql, ")", filter(), ", 0)"],
          type: v.type === "bigint" ? "bigint" : "number",
          nullable: false,
        };
      }
      case "average": {
        const v = value();
        return {
          k: "scalar",
          sql: ["(avg(", distinct, v.sql, ")", filter(), ")::float8"],
          type: "number",
          nullable: true,
        };
      }
      case "min":
      case "max": {
        const v = value();
        return { ...v, sql: [name, "(", v.sql, ")", filter()], nullable: true };
      }
      case "any":
      case "some":
      case "all":
      case "every": {
        const some = name === "any" || name === "some";
        if (first === undefined) {
          if (!some) fail(`${name} expects a function`);
          return predicate(["(count(*)", filter(), " > 0)"]);
        }
        const test = this.bool(this.apply(this.lambda(first, name), [group.element]));
        return predicate([
          "COALESCE(",
          some ? "bool_or(" : "bool_and(",
          test,
          ")",
          filter(),
          some ? ", FALSE)" : ", TRUE)",
        ]);
      }
      default:
        return fail(`.${name}() is not supported on a group; use an aggregate`);
    }
  }

  private scalarCall(self: ScalarSym, name: string, args: ReadonlyArray<Sym>): Sym {
    const arg = (index: number): Sym =>
      args[index] ?? fail(`.${name}() expects at least ${index + 1} argument(s)`);
    const text = (sql: Frag, nullable = self.nullable): ScalarSym => ({
      k: "scalar",
      sql,
      type: "string",
      nullable,
    });
    const number = (sql: Frag, nullable = self.nullable): ScalarSym => ({
      k: "scalar",
      sql,
      type: "number",
      nullable,
    });
    const like = (pattern: (escaped: string) => string, fallback: (other: Frag) => Frag): Sym => {
      const other = arg(0);
      if (other.k === "const" && typeof other.value === "string") {
        return predicate(
          ["(", self.sql, " LIKE ", new Param(pattern(escapeLike(other.value))), ")"],
          self.nullable,
        );
      }
      const value = this.scalar(other, self);
      return predicate(fallback(value.sql), self.nullable || value.nullable);
    };
    const part = (field: string, utc: boolean, offset = ""): ScalarSym =>
      number([
        "(extract(",
        field,
        " from ",
        utc ? ["(", self.sql, " AT TIME ZONE 'UTC')"] : self.sql,
        ")::int",
        offset,
        ")",
      ]);

    switch (name) {
      // ----- strings
      case "startsWith":
        return like(
          (escaped) => `${escaped}%`,
          (other) => ["starts_with(", self.sql, ", ", other, ")"],
        );
      case "endsWith":
        return like(
          (escaped) => `%${escaped}`,
          (other) => ["(right(", self.sql, ", char_length(", other, ")) = ", other, ")"],
        );
      case "includes": {
        if (self.type === "array") {
          const value = this.scalar(arg(0));
          return predicate(
            ["(", value.sql, " = ANY(", self.sql, "))"],
            self.nullable || value.nullable,
          );
        }
        return like(
          (escaped) => `%${escaped}%`,
          (other) => ["(strpos(", self.sql, ", ", other, ") > 0)"],
        );
      }
      case "toLowerCase":
      case "toLocaleLowerCase":
        return text(["lower(", self.sql, ")"]);
      case "toUpperCase":
      case "toLocaleUpperCase":
        return text(["upper(", self.sql, ")"]);
      case "trim":
        return text(["btrim(", self.sql, ", E' \\t\\n\\r')"]);
      case "trimStart":
        return text(["ltrim(", self.sql, ", E' \\t\\n\\r')"]);
      case "trimEnd":
        return text(["rtrim(", self.sql, ", E' \\t\\n\\r')"]);
      case "substring":
      case "slice": {
        const start = arg(0);
        const end = args[1];
        for (const bound of [start, end]) {
          if (bound?.k === "const" && typeof bound.value === "number" && bound.value < 0) {
            fail(`.${name}() with a negative index cannot be translated to SQL`);
          }
        }
        const from = this.scalar(start).sql;
        if (end === undefined) return text(["substr(", self.sql, ", (", from, ") + 1)"]);
        const to = this.scalar(end).sql;
        return text([
          "substr(",
          self.sql,
          ", (",
          from,
          ") + 1, GREATEST((",
          to,
          ") - (",
          from,
          "), 0))",
        ]);
      }
      case "charAt":
        return text(["substr(", self.sql, ", (", this.scalar(arg(0)).sql, ") + 1, 1)"]);
      case "indexOf":
        return number(["(strpos(", self.sql, ", ", this.scalar(arg(0), self).sql, ") - 1)"]);
      case "replaceAll":
        return text([
          "replace(",
          self.sql,
          ", ",
          this.scalar(arg(0), self).sql,
          ", ",
          this.scalar(arg(1), self).sql,
          ")",
        ]);
      case "concat":
        return text(["(", join([self.sql, ...args.map((other) => this.text(other))], " || "), ")"]);
      case "padStart":
      case "padEnd": {
        // unlike lpad/rpad, JS never truncates a string that is already long enough
        const length = this.scalar(arg(0)).sql;
        return text([
          "CASE WHEN char_length(",
          self.sql,
          ") >= ",
          length,
          " THEN ",
          self.sql,
          name === "padStart" ? " ELSE lpad(" : " ELSE rpad(",
          self.sql,
          ", ",
          length,
          args[1] === undefined ? "" : [", ", this.scalar(args[1], self).sql],
          ") END",
        ]);
      }
      case "toString":
        return text(
          self.type === "number" ? ["(", self.sql, ")::float8::text"] : ["(", self.sql, ")::text"],
        );

      // ----- numbers
      case "toFixed":
        return text([
          "round((",
          self.sql,
          ")::numeric, ",
          args[0] === undefined ? "0" : this.scalar(args[0]).sql,
          ")::text",
        ]);

      // ----- dates
      case "getTime":
      case "valueOf":
        if (self.type !== "date") break;
        return number(["(extract(epoch from ", self.sql, ") * 1000)"]);
      case "toISOString":
        return text([
          "to_char(",
          self.sql,
          ` AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        ]);
      case "getFullYear":
        return part("year", false);
      case "getUTCFullYear":
        return part("year", true);
      case "getMonth":
        return part("month", false, " - 1");
      case "getUTCMonth":
        return part("month", true, " - 1");
      case "getDate":
        return part("day", false);
      case "getUTCDate":
        return part("day", true);
      case "getDay":
        return part("dow", false);
      case "getUTCDay":
        return part("dow", true);
      case "getHours":
        return part("hour", false);
      case "getUTCHours":
        return part("hour", true);
      case "getMinutes":
        return part("minute", false);
      case "getUTCMinutes":
        return part("minute", true);
      case "getSeconds":
        return part("second", false);
      case "getUTCSeconds":
        return part("second", true);
    }
    return fail(`.${name}() cannot be translated to SQL`);
  }
}

const isPlainConst = (sym: Sym): boolean => sym.k === "const";

const jsBinary = (op: string, l: any, r: any): unknown => {
  switch (op) {
    case "===":
      return l === r;
    case "!==":
      return l !== r;
    case "==":
      // oxlint-disable-next-line eqeqeq
      return l == r;
    case "!=":
      // oxlint-disable-next-line eqeqeq
      return l != r;
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      return l / r;
    case "%":
      return l % r;
    default:
      return fail(`unsupported operator ${op}`);
  }
};

// ---------------------------------------------------------------- compile

export type Terminal =
  | { readonly k: "all" }
  | { readonly k: "first" }
  | {
      readonly k: "scalar";
      readonly name: string;
      readonly args: ReadonlyArray<Callable | { readonly value: unknown }>;
    };

export interface Plan {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  /** Builds the result from the rows returned by the driver (as arrays). */
  readonly read: (rows: ReadonlyArray<ReadonlyArray<unknown>>) => unknown;
  /** The result is the number of rows the statement affected, which the driver reports. */
  readonly count?: boolean;
}

const terminalArg = (arg: Callable | { readonly value: unknown }): Sym =>
  "value" in arg ? constant(arg.value) : { k: "lambda", fn: arg };

export const compileQuery = (
  source: QuerySource,
  terminal: Terminal,
  materialize?: Materializer,
): Plan => {
  const t = new Translator();
  t.materialize = materialize;
  const columns: Array<Frag> = [];
  if (terminal.k === "scalar") {
    const args = terminal.args.map(terminalArg);
    const result = t.collCall({ k: "coll", make: () => t.build(source) }, terminal.name, args);
    const reader = t.plan(result, columns, false);
    const compiled = compileFrag(["SELECT ", aliased(columns)]);
    return { ...compiled, read: (rows) => reader(rows[0] as Row) };
  }
  const select = t.build(
    terminal.k === "first" ? { ...source, ops: [...source.ops, { k: "take", n: 1 }] } : source,
  );
  const reader = t.plan(select.shape, columns, false);
  const compiled = compileFrag(t.render(select, aliased(columns)));
  return {
    ...compiled,
    read: (rows) => {
      const out: Array<unknown> = [];
      for (let i = 0; i < rows.length; i++) out.push(reader(rows[i] as Row));
      return out;
    },
  };
};
