/**
 * SQL features with no JavaScript equivalent, for use inside query lambdas:
 * `db.users.where(u => Sql.ilike(u.name, "a%"))`.
 */
import { LinqError } from "./errors.ts";
import { join } from "./sql.ts";
import type { JsType } from "./table.ts";
import { Deferred, type FnImpl, SqlFnSymbol } from "./translate.ts";

const define = <F extends (...args: Array<any>) => unknown>(impl: FnImpl): F => {
  // Called directly (all arguments are plain values), the function defers to
  // the translator; called with row-dependent arguments, the translator finds
  // the implementation on the function itself.
  const f = (...args: Array<unknown>): Deferred => new Deferred(impl, args);
  (f as any)[SqlFnSymbol] = impl;
  return f as never;
};

const pattern = (operator: string) =>
  define<(value: string | null, pattern: string) => boolean>((t, args) => {
    const value = t.scalar(args[0]!);
    const other = t.scalar(args[1]!, value);
    return {
      k: "scalar",
      sql: ["(", value.sql, operator, other.sql, ")"],
      type: "boolean",
      nullable: value.nullable || other.nullable,
      pred: true,
    };
  });

/** `value LIKE pattern` */
export const like = pattern(" LIKE ");

/** `value ILIKE pattern` (case-insensitive) */
export const ilike = pattern(" ILIKE ");

/** The database's `now()`. */
export const now = define<() => Date>(() => ({
  k: "scalar",
  sql: "now()",
  type: "date",
  nullable: false,
}));

/**
 * Declares a SQL function so it can be called inside query lambdas.
 *
 * ```ts
 * const unaccent = Sql.fn<[text: string], string>("unaccent", "string")
 * db.users.where(u => unaccent(u.name) === "jose")
 * ```
 */
export const fn = <Args extends ReadonlyArray<unknown>, R>(
  name: string,
  returns: JsType = "unknown",
): ((...args: Args) => R) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) {
    throw new LinqError(`Sql.fn: "${name}" is not a valid function name`);
  }
  return define((t, args) => {
    const scalars = args.map((arg) => t.scalar(arg));
    return {
      k: "scalar",
      sql: [
        name,
        "(",
        join(
          scalars.map((scalar) => scalar.sql),
          ", ",
        ),
        ")",
      ],
      type: returns,
      nullable: true,
    };
  });
};
