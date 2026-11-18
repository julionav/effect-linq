/**
 * Differential tests: a compiled lambda is still an ordinary function, so
 * every expression here runs twice, once in Postgres and once in JavaScript
 * over the same rows, and the two results must agree.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { quote } from "../src/index.ts";
import { from } from "../src/query.ts";
import * as Table from "../src/table.ts";
import { PgLive } from "./schema.ts";

const Samples = Table.make(
  "samples",
  {
    id: Schema.Number,
    a: Schema.NullOr(Schema.Number),
    b: Schema.NullOr(Schema.Number),
    s: Schema.NullOr(Schema.String),
    t: Schema.String,
    flag: Schema.NullOr(Schema.Boolean),
    f: Schema.Number,
    d: Schema.Date,
  },
  { schema: "linq_test" },
);

interface Row {
  readonly id: number;
  readonly a: number | null;
  readonly b: number | null;
  readonly s: string | null;
  readonly t: string;
  readonly flag: boolean | null;
  readonly f: number;
  readonly d: Date;
}

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(PgLive)));

// deterministic pseudo-random data, dense in edge cases
const random = (() => {
  let state = 0x9e3779b9;
  return (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = <A>(values: ReadonlyArray<A>): A => values[Math.floor(random() * values.length)]!;

const ints = [null, null, -3, -2, -1, 0, 1, 2, 3];
const strings = ["", "a", "A", "ab", "a%", "a_b", "b", " x ", "ba"];
const rows: Array<Row> = Array.from({ length: 300 }, (_, index) => ({
  id: index + 1,
  a: pick(ints),
  b: pick(ints),
  s: pick([null, null, ...strings]),
  t: pick(strings),
  flag: pick([null, true, false]),
  f: Math.floor(random() * 21) / 4,
  d: new Date(Date.UTC(2023, 11, 30) + Math.floor(random() * 20) * 6 * 3600 * 1000),
}));

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`drop table if exists linq_test.samples`);
      yield* sql.unsafe(
        `create table linq_test.samples (id int primary key, a int, b int, s text, t text not null, flag boolean, f float8 not null, d timestamptz not null)`,
      );
      yield* sql`insert into linq_test.samples ${sql.insert(rows as any)}`;
    }),
  );
});

const one = 1;
const nothing: number | null = null;
const list = [1, 2, -3];
const words = ["a", "A"];
const cutoff = new Date("2024-01-01T00:00:00Z");

const predicates: ReadonlyArray<(r: Row) => boolean> = [
  // ----- equality and null
  quote((r: Row) => r.a === r.b),
  quote((r: Row) => r.a !== r.b),
  quote((r: Row) => !(r.a === r.b)),
  quote((r: Row) => !(r.a !== r.b)),
  // oxlint-disable-next-line eqeqeq
  quote((r: Row) => r.a == r.b),
  // oxlint-disable-next-line eqeqeq
  quote((r: Row) => r.a != r.b),
  quote((r: Row) => r.a === null),
  quote((r: Row) => r.a !== null),
  quote((r: Row) => r.a == undefined),
  quote((r: Row) => r.a === nothing),
  quote((r: Row) => r.a !== nothing),
  quote((r: Row) => r.a === one),
  quote((r: Row) => r.a !== one),
  quote((r: Row) => !(r.a !== one)),
  quote((r: Row) => !(r.a === one)),
  quote((r: Row) => r.a === 1 || r.b === 1),
  quote((r: Row) => !(r.a === 1 || r.b === 1)),
  quote((r: Row) => !(r.a === 1 && r.b === 1)),
  quote((r: Row) => (r.a === 1) === (r.b === 1)),
  quote((r: Row) => (r.a === 1) !== (r.b === 2)),
  quote((r: Row) => (r.flag === null) === (r.a === null)),
  // ----- ordering (guarded: JS coerces null to 0, SQL does not)
  quote((r: Row) => r.a !== null && r.a > 0),
  quote((r: Row) => r.a !== null && r.b !== null && r.a <= r.b),
  quote((r: Row) => !(r.a !== null && r.b !== null && r.a < r.b)),
  quote((r: Row) => r.f >= 2.5 && r.f < 4),
  // ----- arithmetic
  quote((r: Row) => (r.a ?? 0) + (r.b ?? 0) > 1),
  quote((r: Row) => (r.a ?? 1) * 2 - (r.b ?? 0) === 3),
  quote((r: Row) => (r.a ?? 0) / 2 === 0.5),
  quote((r: Row) => (r.a ?? 0) % 2 === -1),
  quote((r: Row) => r.f / 2 > 0.6),
  quote((r: Row) => -r.f < -2),
  quote((r: Row) => Math.abs(r.a ?? 0) === 2),
  quote((r: Row) => Math.round(r.f) === 1),
  quote((r: Row) => Math.round(r.f - 3) === -1),
  quote((r: Row) => Math.floor(r.f) + Math.ceil(r.f) === 3),
  quote((r: Row) => Math.trunc(r.f - 2.5) === 0),
  quote((r: Row) => Math.max(r.a ?? 0, r.b ?? 0) === 2),
  quote((r: Row) => Math.min(r.f, 1) === 1),
  quote((r: Row) => Math.sign(r.a ?? 0) === -1),
  quote((r: Row) => Math.sqrt(r.f) === 1.5),
  quote((r: Row) => Math.pow(r.f, 2) === 6.25),
  // ----- fallbacks and truthiness
  quote((r: Row) => (r.a || 5) === 5),
  quote((r: Row) => (r.a ?? r.b ?? -9) === -9),
  quote((r: Row) => (r.s || "z") === "z"),
  quote((r: Row) => (r.s ?? "z") === "z"),
  quote((r: Row) => !r.s),
  quote((r: Row) => !!r.s),
  quote((r: Row) => !r.a),
  quote((r: Row) => Boolean(r.a)),
  quote((r: Row) => !r.t),
  quote((r: Row) => !!r.f),
  // ----- booleans
  quote((r: Row) => r.flag === true),
  quote((r: Row) => r.flag === false),
  quote((r: Row) => r.flag !== true),
  quote((r: Row) => r.flag === null),
  quote((r: Row) => !r.flag),
  quote((r: Row) => !!r.flag),
  quote((r: Row) => !!(r.flag || r.a === 1)),
  quote((r: Row) => !!(r.flag && r.a === 1)),
  quote((r: Row) => !(r.flag && r.a === 1)),
  quote((r: Row) => !(r.flag || r.s === "a")),
  quote((r: Row) => (r.flag ? r.a === 1 : r.b === 1)),
  quote((r: Row) => (r.a === null ? r.b : r.a) === 1),
  quote((r: Row) => (r.a === 1 ? "x" : r.b === 1 ? "y" : "z") !== "z"),
  // ----- strings
  quote((r: Row) => r.s === ""),
  quote((r: Row) => r.s === r.t),
  quote((r: Row) => r.s !== r.t),
  quote((r: Row) => !(r.s === r.t)),
  quote((r: Row) => r.t.startsWith("a")),
  quote((r: Row) => r.t.endsWith("b")),
  quote((r: Row) => r.t.includes("%")),
  quote((r: Row) => r.t.includes("_")),
  quote((r: Row) => !r.t.includes("a")),
  quote((r: Row) => r.t.startsWith(r.s ?? "")),
  quote((r: Row) => r.t.endsWith(r.s ?? "zz")),
  quote((r: Row) => r.t.includes(r.s ?? "q")),
  quote((r: Row) => r.s !== null && r.s.startsWith("a")),
  quote((r: Row) => !r.s?.startsWith("a")),
  quote((r: Row) => r.t.toLowerCase() === r.t),
  quote((r: Row) => r.t.toUpperCase() === "A"),
  quote((r: Row) => r.t.length > 2),
  quote((r: Row) => (r.s?.length ?? -1) === 0),
  quote((r: Row) => r.t.trim() === "x"),
  quote((r: Row) => r.t.trimStart().length + r.t.trimEnd().length === 4),
  quote((r: Row) => r.t.substring(1) === "b"),
  quote((r: Row) => r.t.substring(1, 2) === "_"),
  quote((r: Row) => r.t.slice(0, 1) === "a"),
  quote((r: Row) => r.t.charAt(1) === "%"),
  quote((r: Row) => r.t.charAt(2) === ""),
  quote((r: Row) => r.t.indexOf("b") === 1),
  quote((r: Row) => r.t.indexOf("_") === -1),
  quote((r: Row) => r.t.replaceAll("a", "") === ""),
  quote((r: Row) => r.t.padStart(3, "*") === "**a"),
  quote((r: Row) => r.t.padEnd(2, "-") === "a_b"),
  quote((r: Row) => r.t.concat("!", r.s ?? "?") === "a!?"),
  quote((r: Row) => (r.s ?? "z") + r.t === "za"),
  quote((r: Row) => r.t + r.a === "a1"),
  quote((r: Row) => r.t + r.a === "anull"),
  quote((r: Row) => `${r.t}-${r.a ?? 0}` === "a-1"),
  quote((r: Row) => `${r.s}|${r.a}|${r.flag}` === "null|null|null"),
  quote((r: Row) => String(r.a) === "null"),
  quote((r: Row) => String(r.f) === "1.5"),
  quote((r: Row) => r.f.toString() === "2"),
  quote((r: Row) => r.f.toFixed(1) === "0.3"),
  quote((r: Row) => r.f.toFixed(2) === "1.00"),
  quote((r: Row) => "a%b".includes(r.t)),
  // ----- lists
  quote((r: Row) => list.includes(r.a!)),
  quote((r: Row) => !list.includes(r.a!)),
  quote((r: Row) => words.includes(r.t)),
  quote((r: Row) => words.some((w) => r.s === w)),
  quote((r: Row) => words.every((w) => r.s !== w)),
  quote((r: Row) => words.some((w) => r.t.startsWith(w.toLowerCase()) && r.t.length > w.length)),
  quote((r: Row) => [r.a, r.b].includes(2)),
  quote((r: Row) => ![r.a, r.b].includes(2)),
  quote((r: Row) => [1, 2].includes(r.a ?? 1)),
  // ----- dates
  quote((r: Row) => r.d > cutoff),
  quote((r: Row) => r.d <= cutoff),
  quote((r: Row) => !(r.d > cutoff)),
  quote((r: Row) => r.d.getUTCFullYear() === 2024),
  quote((r: Row) => r.d.getUTCMonth() === 11),
  quote((r: Row) => r.d.getUTCDate() === 31),
  quote((r: Row) => r.d.getUTCHours() === 6),
  quote((r: Row) => r.d.getUTCDay() === 0),
  quote((r: Row) => r.d.getTime() === cutoff.getTime()),
  quote((r: Row) => r.d.getTime() - cutoff.getTime() > 3_600_000),
  quote((r: Row) => r.d.toISOString() === "2024-01-01T06:00:00.000Z"),
];

const projections: ReadonlyArray<(r: Row) => unknown> = [
  quote((r: Row) => r.a ?? -1),
  quote((r: Row) => (r.a ?? 0) + r.f),
  quote((r: Row) => r.t.toUpperCase() + r.t.length),
  quote((r: Row) => `${r.t}:${r.a}:${r.f}:${r.flag}:${r.s}`),
  quote((r: Row) => (r.a === null ? "none" : r.a > 0 ? "positive" : "other")),
  quote((r: Row) => ({
    id: r.id,
    sum: (r.a ?? 0) + (r.b ?? 0),
    both: r.a !== null && r.b !== null,
    equal: r.a === r.b,
    differs: r.s !== r.t,
    one: r.a === 1,
    notOne: r.a !== 1,
    s: r.s,
    flag: r.flag,
    not: !r.flag,
    nested: { either: r.s || r.t, length: r.s?.length ?? -1 },
  })),
  quote((r: Row) => [r.f / 4, r.f * 2, r.f - 10, r.f.toFixed(1), Math.round(r.f), r.id % 7]),
  quote((r: Row) => r.d.getTime()),
  quote((r: Row) => r.t.trim().padEnd(4, ".") + "|"),
  quote((r: Row) => r.a !== null && r.a > 1),
  quote((r: Row) => r.flag || false),
  quote((r: Row) => r.flag && true),
  quote((r: Row) => (r.flag ? r.a : r.b)),
  quote((r: Row) => r.d),
];

const samples = from(Samples).orderBy((r) => r.id);

describe("SQL agrees with JavaScript", () => {
  test("the table round-trips", async () => {
    expect(await run(samples.toArray())).toEqual(rows);
  });

  test.each(predicates.map((predicate) => [String(predicate), predicate] as const))(
    "where %s",
    async (_, predicate) => {
      const expected = rows.filter(predicate).map((row) => row.id);
      const actual = await run(
        samples
          .where(predicate)
          .select((r) => r.id)
          .toArray(),
      );
      expect(actual).toEqual(expected);
      // every predicate should select something and reject something, or it tests little
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(rows.length);
      // the same expression as an aggregate
      expect(await run(samples.count(predicate))).toBe(expected.length);
    },
  );

  test.each(projections.map((projection) => [String(projection), projection] as const))(
    "select %s",
    async (_, projection) => {
      expect(await run(samples.select(projection).toArray())).toEqual(rows.map(projection));
    },
  );
});
