import { Schema } from "effect";
import { fail } from "./errors.ts";

/** How a value behaves in JavaScript; drives operator translation. */
export type JsType =
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "date"
  | "bytes"
  | "array"
  | "json"
  | "unknown";

export const TableTypeId: unique symbol = Symbol.for("effect-linq/Table") as never;

export interface Column {
  /** property name on the row */
  readonly key: string;
  /** column name in the database */
  readonly name: string;
  readonly schema: Schema.Top;
  /** type of the decoded value */
  readonly type: JsType;
  /** type of the value the driver returns */
  readonly wire: JsType;
  /** for an array column, the type of its elements as the driver returns them */
  readonly element: JsType | undefined;
  readonly nullable: boolean;
  /** the database fills it in when an insert leaves it out */
  readonly hasDefault: boolean;
  /** undefined when the schema has no transformation */
  readonly decode: ((value: unknown) => unknown) | undefined;
  readonly encode: ((value: unknown) => unknown) | undefined;
  /** Validates and encodes a value to be written; throws a `SchemaError`. */
  readonly write: (value: unknown) => unknown;
}

export type Fields = { readonly [key: string]: Schema.Top };

export interface Table<
  Name extends string = string,
  F extends Fields = Fields,
  D extends keyof F = never,
> {
  /** phantom: the columns with a database default */
  readonly "~defaults"?: D;
  readonly [TableTypeId]: typeof TableTypeId;
  readonly name: Name;
  readonly schema: string | undefined;
  readonly fields: F;
  readonly columns: { readonly [key: string]: Column };
  readonly columnList: ReadonlyArray<Column>;
  readonly primaryKey: ReadonlyArray<Column>;
  /** optimistic concurrency counter, see {@link TableOptions.version} */
  readonly version: Column | undefined;
}

export type AnyTable = Table<string, any, any>;

/** The decoded row of a table. */
export type RowOf<T> =
  T extends Table<string, infer F, any> ? { readonly [K in keyof F]: F[K]["Type"] } : never;

type OptionalOnInsert<F extends Fields, D> = {
  [K in keyof F]: K extends D ? K : null extends F[K]["Encoded"] ? K : never;
}[keyof F];

/**
 * What `insert` accepts: nullable columns and columns declared in `defaults`
 * may be left out.
 */
export type InsertOf<T> =
  T extends Table<string, infer F, infer D>
    ? { readonly [K in Exclude<keyof F, OptionalOnInsert<F, D>>]: F[K]["Type"] } & {
        readonly [K in OptionalOnInsert<F, D>]?: F[K]["Type"];
      } extends infer O
      ? { readonly [K in keyof O]: O[K] }
      : never
    : never;

/** What `executeUpdate` accepts: any subset of the columns. */
export type UpdateOf<T> =
  T extends Table<string, infer F, any> ? { readonly [K in keyof F]?: F[K]["Type"] } : never;

export interface TableOptions<F, D extends keyof F = never> {
  /**
   * Columns the database fills in when an insert leaves them out (identity
   * and serial columns, `DEFAULT now()`, ...). They become optional in `insert`.
   */
  readonly defaults?: ReadonlyArray<D>;
  /**
   * A number or bigint column used as an optimistic concurrency counter by
   * sessions: saving a changed row checks that it still has the value that
   * was read, and increments it.
   */
  readonly version?: keyof F & string;
  /** Postgres schema; defaults to the search path. */
  readonly schema?: string;
  /**
   * Column names: a function of the property name, or a record of overrides.
   * Defaults to the property name. See {@link snakeCase}.
   */
  readonly columns?: ((key: string) => string) | { readonly [K in keyof F]?: string };
  /** Defaults to `id`. */
  readonly primaryKey?: (keyof F & string) | ReadonlyArray<keyof F & string>;
}

export const snakeCase = (key: string): string =>
  key.replace(/[A-Z]/g, (letter, index: number) => (index === 0 ? "" : "_") + letter.toLowerCase());

const classify = (ast: any): JsType => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "BigInt":
      return "bigint";
    case "Literal":
      return typeof ast.literal === "string"
        ? "string"
        : typeof ast.literal === "number"
          ? "number"
          : typeof ast.literal === "boolean"
            ? "boolean"
            : typeof ast.literal === "bigint"
              ? "bigint"
              : "unknown";
    case "Arrays": {
      // an array of objects (or of arrays) can only be a JSON column
      const element = ast.rest?.[0] ?? ast.elements?.[0];
      const inner = element === undefined ? "unknown" : classify(element);
      return inner === "json" || inner === "array" ? "json" : "array";
    }
    case "Objects":
      return "json";
    case "Declaration": {
      const id: unknown = ast.annotations?.representation?.id;
      if (typeof id !== "string") return "unknown";
      if (id.endsWith("/Date") || id.includes("DateTime")) return "date";
      if (id.endsWith("/Uint8Array")) return "bytes";
      return "unknown";
    }
    case "Union": {
      let found: JsType | undefined;
      for (const member of ast.types) {
        if (member._tag === "Null" || member._tag === "Undefined") continue;
        const type = classify(member);
        if (found === undefined) found = type;
        else if (found !== type) return "unknown";
      }
      return found ?? "unknown";
    }
    default:
      return "unknown";
  }
};

const elementOf = (ast: any): JsType | undefined => {
  if (ast._tag === "Union") {
    const rest = ast.types.filter((t: any) => t._tag !== "Null" && t._tag !== "Undefined");
    return rest.length === 1 ? elementOf(rest[0]) : undefined;
  }
  if (ast._tag !== "Arrays" || ast.rest.length !== 1) return undefined;
  return classify(ast.rest[0]);
};

const makeColumn = (key: string, name: string, schema: Schema.Top, hasDefault: boolean): Column => {
  const encoded = Schema.toEncoded(schema as any) as Schema.Top;
  const transforms = encoded.ast !== schema.ast;
  return {
    key,
    name,
    schema,
    type: classify((Schema.toType(schema as any) as Schema.Top).ast),
    wire: classify(encoded.ast),
    element: elementOf(encoded.ast),
    nullable: Schema.is(encoded as any)(null),
    hasDefault,
    decode: transforms ? (Schema.decodeUnknownSync(schema as any) as any) : undefined,
    encode: transforms ? (Schema.encodeUnknownSync(schema as any) as any) : undefined,
    write: Schema.encodeUnknownSync(schema as any) as any,
  };
};

/**
 * Describes a table. `fields` is a record of schemas, or anything with a
 * `fields` property (a `Schema.Struct`, a `Schema.Class`, a `Model.Class`).
 *
 * Each schema decodes from what the Postgres driver returns for the column:
 * `number` for int4/float8, `bigint` for int8, `string` for numeric/uuid/date,
 * `Date` for timestamps, `Uint8Array` for bytea.
 */
export const make = <const Name extends string, F extends Fields, const D extends keyof F = never>(
  name: Name,
  fields: F | { readonly fields: F },
  options: TableOptions<F, D> = {},
): Table<Name, F, D> => {
  const resolved: F =
    "fields" in fields && !Schema.isSchema((fields as any).fields)
      ? ((fields as any).fields as F)
      : (fields as F);
  const naming = options.columns;
  const defaults = new Set<PropertyKey>(options.defaults ?? []);
  for (const key of defaults) {
    if (!(key in resolved)) return fail(`Table "${name}": default "${String(key)}" is not a field`);
  }
  // without a prototype: `constructor` or `toString` are not columns
  const columns: Record<string, Column> = Object.create(null);
  for (const key of Object.keys(resolved)) {
    const schema = resolved[key]!;
    if (!Schema.isSchema(schema)) {
      return fail(`Table "${name}": field "${key}" is not a Schema`);
    }
    const columnName = typeof naming === "function" ? naming(key) : ((naming as any)?.[key] ?? key);
    columns[key] = makeColumn(key, columnName, schema, defaults.has(key));
  }
  const keys =
    options.primaryKey === undefined
      ? "id" in columns
        ? ["id"]
        : []
      : typeof options.primaryKey === "string"
        ? [options.primaryKey]
        : [...options.primaryKey];
  const primaryKey = keys.map(
    (key) => columns[key] ?? fail(`Table "${name}": primary key "${key}" is not a field`),
  );
  let version: Column | undefined;
  if (options.version !== undefined) {
    version =
      columns[options.version] ??
      fail(`Table "${name}": version column "${options.version}" is not a field`);
    if (version.type !== "number" && version.type !== "bigint") {
      return fail(`Table "${name}": the version column must be a number or a bigint`);
    }
  }
  return {
    version,
    [TableTypeId]: TableTypeId,
    name,
    schema: options.schema,
    fields: resolved,
    columns,
    columnList: Object.values(columns),
    primaryKey,
  };
};

export const isTable = (u: unknown): u is AnyTable =>
  typeof u === "object" && u !== null && TableTypeId in u;
