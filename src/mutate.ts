/**
 * INSERT, UPDATE and DELETE. Each call is one explicit, set-based statement:
 * there is no change tracking and no unit of work. The rows to change are
 * described by the same queries (and the same lambdas) that read them.
 */
import { fail } from "./errors.ts";
import { compileFrag, type Frag, ident, join, Param } from "./sql.ts";
import type { AnyTable, Column } from "./table.ts";
import {
  aliased,
  type Callable,
  Deferred,
  type EntitySym,
  type Plan,
  type QuerySource,
  Select,
  type Sym,
  tableName,
  Translator,
} from "./translate.ts";

/** Column values: a lambda over the row, or a plain object. */
export type Values = { readonly fn: Callable } | { readonly value: unknown };

/** `undefined`: return the number of affected rows. `fn: undefined`: the whole row. */
export type Returning =
  | { readonly fn: Callable | undefined }
  /** only these columns: what a session needs back from an insert */
  | { readonly columns: ReadonlyArray<Column> }
  | undefined;

export interface Conflict {
  /** property names of the columns of the unique constraint */
  readonly target: ReadonlyArray<string> | undefined;
  /** `undefined`: DO NOTHING. `values: undefined`: overwrite with the inserted values. */
  readonly update: { readonly values: Values | undefined } | undefined;
}

export interface WriteOptions {
  /** Allow the statement to run without any condition, on every row. */
  readonly unfiltered?: boolean;
}

/** A plain value as a bind parameter of the column's type. */
export const bind = (col: Column, value: unknown, typed = true, validated = false): Frag => {
  // SchemaError propagates: the caller turns it into a typed failure.
  // A value its model already validated only needs encoding, if anything.
  const encoded = validated
    ? col.encode === undefined || value === null
      ? value
      : col.encode(value)
    : col.write(value);
  if (encoded === null || encoded === undefined) return "NULL";
  // `typed: false` where the context gives the parameter the column's own type
  if (col.wire === "json") return new Param(JSON.stringify(encoded), typed ? "jsonb" : undefined);
  return new Param(encoded);
};

const column = (table: AnyTable, key: string, operator: string): Column =>
  table.columns[key] ?? fail(`${operator}: "${key}" is not a column of "${table.name}"`);

interface Assignment {
  readonly col: Column;
  readonly sql: Frag;
  /** does not depend on any row */
  readonly constant: boolean;
}

const assignments = (
  t: Translator,
  values: Values,
  args: ReadonlyArray<Sym>,
  target: EntitySym,
  operator: string,
  extra?: OnUpdateValues,
): Array<Assignment> => {
  let entries: Array<readonly [string, Sym]>;
  if ("fn" in values) {
    const sym = t.apply(values.fn, args);
    if (sym.k === "object") entries = [...sym.props];
    else if (sym.k === "const" && typeof sym.value === "object" && sym.value !== null) {
      entries = Object.entries(sym.value).map(([key, value]) => [key, t.captured(value)] as const);
    } else return fail(`${operator}: the lambda must return an object of column values`);
  } else {
    if (typeof values.value !== "object" || values.value === null) {
      return fail(`${operator} expects an object of column values, or a lambda returning one`);
    }
    entries = Object.entries(values.value).map(([key, value]) => [key, t.captured(value)] as const);
  }
  const out: Array<Assignment> = [];
  const model = target.table.model;
  for (const [key, sym] of entries) {
    const col = column(target.table, key, operator);
    if (model?.notUpdatable.has(key) && !(sym.k === "const" && sym.value === undefined)) {
      fail(`${operator}: "${key}" cannot be updated (it is not in the model's update variant)`);
    }
    if (sym.k === "const") {
      if (sym.value === undefined) continue;
      out.push({ col, sql: bind(col, sym.value), constant: true });
    } else {
      out.push({ col, sql: t.scalar(sym, t.member(target, key)).sql, constant: false });
    }
  }
  if (out.length === 0) fail(`${operator}: no column values were given`);
  // columns the model refreshes on every update, unless they were given
  if (extra !== undefined) {
    for (const [col, value] of extra) {
      if (!out.some((item) => item.col === col)) {
        out.push({ col, sql: bind(col, value), constant: true });
      }
    }
  }
  return out;
};

/** Values for the columns a model refreshes on update (`Model.DateTimeUpdate`). */
export type OnUpdateValues = ReadonlyArray<readonly [Column, unknown]>;

const setClause = (items: ReadonlyArray<Assignment>): Frag =>
  join(
    items.map((item) => [ident(item.col.name), " = ", item.sql]),
    ", ",
  );

/**
 * Appends RETURNING (or wraps the statement to count the rows it changed) and
 * builds the plan. `target` is the row as it is after the statement.
 */
const finish = (
  t: Translator,
  statement: Frag,
  target: EntitySym,
  returning: Returning,
  single: boolean,
): Plan => {
  if (returning === undefined) {
    return { ...compileFrag(statement), count: true, read: () => 0 };
  }
  const joins = target.owner.joins.length;
  const columns: Array<Frag> = [];
  const shape: Sym =
    "columns" in returning
      ? {
          k: "object",
          props: new Map(returning.columns.map((col) => [col.key, t.member(target, col.key)])),
        }
      : returning.fn === undefined
        ? target
        : t.apply(returning.fn, [target]);
  const reader = t.plan(shape, columns, false);
  if (target.owner.joins.length !== joins) {
    fail(
      "returning() cannot follow a to-one relation (RETURNING has no joins); " +
        "return the key and query the relation separately",
    );
  }
  const compiled = compileFrag([statement, " RETURNING ", aliased(columns)]);
  return {
    ...compiled,
    read: (rows) => {
      if (single) return rows.length === 0 ? undefined : reader(rows[0] as never);
      const out: Array<unknown> = [];
      for (let i = 0; i < rows.length; i++) out.push(reader(rows[i] as never));
      return out;
    },
  };
};

// ------------------------------------------------------------------ insert

/** Rows per INSERT statement so that Postgres' 65535 parameter limit holds. */
export const insertBatchSize = (table: AnyTable): number =>
  Math.max(1, Math.min(5000, Math.floor(65535 / Math.max(1, table.columnList.length))));

export const compileInsert = (
  source: QuerySource,
  rows: ReadonlyArray<unknown>,
  conflict: Conflict | undefined,
  returning: Returning,
  single: boolean,
  /** the rows went through the model's insert variant already */
  validated = false,
): Plan => {
  const table = source.table;
  if (source.ops.length > 0) fail("insert() must be called on a table, not on a query");
  const used = new Set<Column>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return fail("insert() expects objects");
    for (const key of Object.keys(row)) {
      const col = column(table, key, "insert()");
      if ((row as any)[key] !== undefined) used.add(col);
    }
    for (const col of table.columnList) {
      if ((row as any)[col.key] === undefined && !col.nullable && !col.hasDefault) {
        fail(
          `insert(): "${col.key}" is required by "${table.name}". ` +
            `If the database fills it in, list it in the table's "defaults".`,
        );
      }
    }
  }
  // every statement needs a column list; DEFAULT fills in what is left out
  const cols =
    used.size === 0 ? [table.columnList[0]!] : table.columnList.filter((c) => used.has(c));
  const t = new Translator();
  const alias = t.alias("t");
  const target = t.entity(table, source.rels, alias, new Select(), false);
  const statement: Array<Frag> = [
    "INSERT INTO ",
    tableName(table),
    " AS ",
    ident(alias),
    " (",
    cols.map((col) => ident(col.name)).join(", "),
    ") VALUES ",
    join(
      rows.map((row) => [
        "(",
        join(
          cols.map((col) => {
            const value = (row as any)[col.key];
            if (value === undefined) return "DEFAULT";
            // a SQL expression such as Sql.now()
            if (value instanceof Deferred) return t.scalar(t.captured(value)).sql;
            return bind(col, value, true, validated);
          }),
          ", ",
        ),
        ")",
      ]),
      ", ",
    ),
  ];
  if (conflict !== undefined) {
    statement.push(" ON CONFLICT");
    if (conflict.target !== undefined) {
      const keys = conflict.target.map((key) => column(table, key, "onConflict"));
      statement.push(" (", keys.map((col) => ident(col.name)).join(", "), ")");
    }
    if (conflict.update === undefined) {
      statement.push(" DO NOTHING");
    } else {
      if (conflict.target === undefined) fail("onConflictDoUpdate needs the conflicting columns");
      const proposed = t.entity(table, source.rels, "excluded", target.owner, false);
      let items: Array<Assignment>;
      if (conflict.update.values === undefined) {
        const keys = new Set(conflict.target);
        items = cols
          .filter((col) => !keys.has(col.key))
          .map((col) => ({ col, sql: proposed.ref(col), constant: false }));
        if (items.length === 0) fail("onConflictDoUpdate: there is no column left to update");
      } else {
        items = assignments(
          t,
          conflict.update.values,
          [target, proposed],
          target,
          "onConflictDoUpdate",
        );
      }
      if (target.owner.joins.length > 0) fail("onConflictDoUpdate cannot follow a to-one relation");
      statement.push(" DO UPDATE SET ", setClause(items));
    }
  }
  return finish(t, statement, target, returning, single);
};

// ------------------------------------------------------- update and delete

interface Scope {
  readonly t: Translator;
  readonly select: Select;
  readonly row: EntitySym;
}

const scope = (source: QuerySource, operator: string): Scope => {
  const t = new Translator();
  const select = t.build(source);
  const row = select.shape;
  if (row.k !== "entity" || row.table !== source.table || row.nullable) {
    return fail(
      `${operator} applies to rows of "${source.table.name}"; ` +
        "the query must not project or group them (remove select/groupBy)",
    );
  }
  return { t, select, row };
};

/** Can the query be the statement's own WHERE clause? */
const isDirect = ({ select, row }: Scope): boolean =>
  !select.derived &&
  row.owner === select &&
  select.joins.length === 0 &&
  select.groupBy === null &&
  select.limit === null &&
  select.offset === null &&
  !select.distinct;

const guard = (select: Select, options: WriteOptions | undefined, operator: string): void => {
  // A LEFT JOIN (a to-one relation that was navigated) removes no rows, and
  // neither does DISTINCT or an ORDER BY: only these narrow the statement.
  const narrowed =
    select.where.length > 0 ||
    select.having.length > 0 ||
    select.limit !== null ||
    select.offset !== null ||
    select.derived ||
    select.joins.some((j) => j.kind !== "LEFT JOIN");
  if (!narrowed && !options?.unfiltered) {
    fail(
      `${operator} would affect every row of the table (there is no condition, or it folded ` +
        "away). Pass { unfiltered: true } if that is intended.",
    );
  }
};

const primaryKey = (table: AnyTable, operator: string): ReadonlyArray<Column> =>
  table.primaryKey.length > 0
    ? table.primaryKey
    : fail(
        `${operator} on a query with joins or paging needs "${table.name}" to have a primary key`,
      );

export const compileUpdate = (
  source: QuerySource,
  values: Values,
  returning: Returning,
  options?: WriteOptions,
  onUpdate?: OnUpdateValues,
): Plan => {
  const s = scope(source, "executeUpdate()");
  const { t, select, row } = s;
  const table = source.table;
  const items = assignments(t, values, [row], row, "executeUpdate()", onUpdate);
  if (isDirect(s)) {
    guard(select, options, "executeUpdate()");
    const statement: Array<Frag> = ["UPDATE ", select.from, " SET ", setClause(items)];
    if (select.where.length > 0) statement.push(" WHERE ", join(select.where, " AND "));
    return finish(t, statement, row, returning, false);
  }
  // The query has joins, paging or grouping of its own: compute the keys and
  // the new values in a subquery, and join the table to it.
  guard(select, options, "executeUpdate()");
  const pk = primaryKey(table, "executeUpdate()");
  const alias = t.alias("u");
  const from = t.alias("s");
  const target = t.entity(table, source.rels, alias, new Select(), false);
  const columns: Array<Frag> = pk.map((col) => row.ref(col));
  const projected = items.map((item) =>
    item.constant
      ? item
      : { ...item, sql: `${ident(from)}.${ident(`c${columns.push(item.sql) - 1}`)}` },
  );
  const statement: Array<Frag> = [
    "UPDATE ",
    tableName(table),
    " AS ",
    ident(alias),
    " SET ",
    setClause(projected),
    " FROM (",
    t.render(select, aliased(columns)),
    ") AS ",
    ident(from),
    " WHERE ",
    join(
      pk.map((col, index) => [target.ref(col), " = ", `${ident(from)}.${ident(`c${index}`)}`]),
      " AND ",
    ),
  ];
  return finish(t, statement, target, returning, false);
};

export const compileDelete = (
  source: QuerySource,
  returning: Returning,
  options?: WriteOptions,
): Plan => {
  const s = scope(source, "executeDelete()");
  const { t, select, row } = s;
  const table = source.table;
  if (isDirect(s)) {
    guard(select, options, "executeDelete()");
    const statement: Array<Frag> = ["DELETE FROM ", select.from];
    if (select.where.length > 0) statement.push(" WHERE ", join(select.where, " AND "));
    return finish(t, statement, row, returning, false);
  }
  guard(select, options, "executeDelete()");
  const pk = primaryKey(table, "executeDelete()");
  const alias = t.alias("d");
  const target = t.entity(table, source.rels, alias, new Select(), false);
  const keys = join(
    pk.map((col) => target.ref(col)),
    ", ",
  );
  const statement: Array<Frag> = [
    "DELETE FROM ",
    tableName(table),
    " AS ",
    ident(alias),
    " WHERE (",
    keys,
    ") IN (",
    t.render(select, aliased(pk.map((col) => row.ref(col)))),
    ")",
  ];
  return finish(t, statement, target, returning, false);
};
