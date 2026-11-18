/** Paths into JSON columns: `row.settings.owner.name`. */
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Model } from "effect/schema";
import { SqlClient } from "effect/sql/SqlClient";
import { beforeAll, describe, expect, expectTypeOf, test } from "vite-plus/test";
import { DbContext, entity, LinqError } from "../src/index.ts";
import { DATABASE_URL } from "./global-setup.ts";

class Account extends Model.Class<Account>("Account")({
  id: Schema.Number,
  settings: Schema.Struct({
    plan: Schema.String,
    seats: Schema.Number,
    active: Schema.Boolean,
    nick: Schema.optional(Schema.String),
    owner: Schema.Struct({ name: Schema.String, tags: Schema.Array(Schema.String) }),
    limits: Schema.NullOr(Schema.Struct({ max: Schema.Number })),
    items: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Number })),
  }),
  extra: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  legacy: Schema.Struct({ code: Schema.String }),
}) {}

class JsonDb extends DbContext.Service<JsonDb>()("test/JsonDb", {
  accounts: entity(Account, (e) =>
    e
      .toTable("j_accounts")
      .hasKey("id")
      .property("legacy", (p) => p.hasColumnType("json")),
  ),
}) {}

const Live = JsonDb.layer.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(DATABASE_URL) })),
);

const run = <A, E>(effect: Effect.Effect<A, E, JsonDb | SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Live)) as Effect.Effect<A, E>);

const context = Effect.gen(function* () {
  return yield* JsonDb;
});

const use = <A, E>(
  f: (db: Effect.Success<typeof context>) => Effect.Effect<A, E, never>,
): Promise<A> => run(Effect.flatMap(context, f));

const accounts = JsonDb.model.accounts;

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`drop table if exists j_accounts`);
      yield* sql.unsafe(
        `create table j_accounts (id int primary key, settings jsonb not null, extra jsonb, legacy json not null)`,
      );
      const db = yield* JsonDb;
      yield* db.accounts.insert([
        {
          id: 1,
          settings: {
            plan: "pro",
            seats: 10,
            active: true,
            nick: "ada",
            owner: { name: "Ada", tags: ["admin", "it's"] },
            limits: { max: 5 },
            items: [
              { sku: "a", qty: 2 },
              { sku: "b", qty: 7 },
            ],
          },
          extra: { region: "eu", score: 42, beta: true, nested: { deep: "x" }, gone: null },
          legacy: { code: "L1" },
        },
        {
          id: 2,
          settings: {
            plan: "free",
            seats: 1,
            active: false,
            owner: { name: "Grace", tags: [] },
            limits: null,
            items: [],
          },
          extra: null,
          legacy: { code: "L2" },
        },
        {
          id: 3,
          settings: {
            plan: "pro",
            seats: 3,
            active: true,
            owner: { name: "Linus", tags: ["dev"] },
            limits: { max: 50 },
            items: [{ sku: "c", qty: 1 }],
          },
          extra: { region: "us", score: 7 },
          legacy: { code: "L3" },
        },
      ]);
    }),
  );
});

describe("JSON paths", () => {
  test("a property is read as what its schema says it is", async () => {
    const query = accounts
      .where((a) => a.settings.plan === "pro" && a.settings.seats > 5)
      .select((a) => ({ id: a.id, plan: a.settings.plan, seats: a.settings.seats }));
    expect(query.toSql()).toEqual({
      sql:
        `SELECT "t0"."id" AS "c0", ("t0"."settings" ->> 'plan') AS "c1", ` +
        `("t0"."settings" ->> 'seats')::float8 AS "c2" FROM "j_accounts" AS "t0" ` +
        `WHERE ((("t0"."settings" ->> 'plan') = $1) AND (("t0"."settings" ->> 'seats')::float8 > 5))`,
      params: ["pro"],
    });
    const rows = await run(query.toArray());
    expect(rows).toEqual([{ id: 1, plan: "pro", seats: 10 }]);
    expectTypeOf(rows).toEqualTypeOf<Array<{ id: number; plan: string; seats: number }>>();
  });

  test("nested objects, booleans and ordering", async () => {
    const rows = await use((db) =>
      db.accounts
        .where((a) => a.settings.active)
        .orderByDescending((a) => a.settings.seats)
        .select((a) => ({ owner: a.settings.owner.name, active: a.settings.active }))
        .toArray(),
    );
    expect(rows).toEqual([
      { owner: "Ada", active: true },
      { owner: "Linus", active: true },
    ]);
    expectTypeOf(rows).toEqualTypeOf<Array<{ owner: string; active: boolean }>>();
  });

  test("string methods and arithmetic work on what a path yields", async () => {
    const rows = await use((db) =>
      db.accounts
        .where((a) => a.settings.owner.name.toLowerCase().startsWith("a"))
        .select((a) => ({ double: a.settings.seats * 2, label: a.settings.plan + "!" }))
        .toArray(),
    );
    expect(rows).toEqual([{ double: 20, label: "pro!" }]);
  });

  test("a missing key, an optional property and a JSON null are all null", async () => {
    const rows = await use((db) =>
      db.accounts
        .orderBy((a) => a.id)
        .select((a) => ({
          nick: a.settings.nick ?? "none",
          max: a.settings.limits?.max ?? -1,
          unlimited: a.settings.limits === null,
        }))
        .toArray(),
    );
    expect(rows).toEqual([
      { nick: "ada", max: 5, unlimited: false },
      { nick: "none", max: -1, unlimited: true },
      { nick: "none", max: 50, unlimited: false },
    ]);
    const limited = await use((db) =>
      db.accounts
        .where((a) => a.settings.limits !== null)
        .select((a) => a.id)
        .toArray(),
    );
    expect(limited.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  test("an object or array inside the JSON comes back as it is stored", async () => {
    const rows = await use((db) =>
      db.accounts
        .where((a) => a.id === 1)
        .select((a) => ({
          owner: a.settings.owner,
          tags: a.settings.owner.tags,
          items: a.settings.items,
        }))
        .toArray(),
    );
    expect(rows).toEqual([
      {
        owner: { name: "Ada", tags: ["admin", "it's"] },
        tags: ["admin", "it's"],
        items: [
          { sku: "a", qty: 2 },
          { sku: "b", qty: 7 },
        ],
      },
    ]);
  });

  test("array elements and length", async () => {
    const rows = await use((db) =>
      db.accounts
        .orderBy((a) => a.id)
        .select((a) => ({
          first: a.settings.items[0]?.sku ?? null,
          tag: a.settings.owner.tags[1] ?? null,
          count: a.settings.items.length,
        }))
        .toArray(),
    );
    expect(rows).toEqual([
      { first: "a", tag: "it's", count: 2 },
      { first: null, tag: null, count: 0 },
      { first: "c", tag: null, count: 1 },
    ]);
    const busy = await use((db) =>
      db.accounts
        .where((a) => a.settings.items.length > 1)
        .select((a) => a.id)
        .toArray(),
    );
    expect(busy).toEqual([1]);
  });

  test("a value without a schema is compared as what it is compared with", async () => {
    const query = accounts
      .where((a) => a.extra!.region === "eu" && (a.extra!.score as number) > 40)
      .select((a) => a.id);
    expect(query.toSql().sql).toContain(
      `((("t0"."extra" ->> 'region') = $1) AND (("t0"."extra" ->> 'score')::float8 > 40))`,
    );
    expect(await run(query.toArray())).toEqual([1]);

    const rows = await use((db) =>
      db.accounts
        .orderBy((a) => a.id)
        .select((a) => ({
          beta: a.extra!.beta === true,
          deep: (a.extra!.nested as { deep: string }).deep === "x",
          raw: a.extra!.nested,
          gone: a.extra!.gone === null,
        }))
        .toArray(),
    );
    expect(rows).toEqual([
      { beta: true, deep: true, raw: { deep: "x" }, gone: true },
      { beta: false, deep: false, raw: null, gone: true },
      { beta: false, deep: false, raw: null, gone: true },
    ]);
  });

  test("grouping and aggregating by a path", async () => {
    const rows = await use((db) =>
      db.accounts
        .groupBy((a) => a.settings.plan)
        .select((g) => ({ plan: g.key, seats: g.sum((a) => a.settings.seats), n: g.count() }))
        .orderBy((r) => r.plan)
        .toArray(),
    );
    expect(rows).toEqual([
      { plan: "free", seats: 1, n: 1 },
      { plan: "pro", seats: 13, n: 2 },
    ]);
  });

  test("a json (not jsonb) column and a key that needs quoting", async () => {
    const rows = await use((db) =>
      db.accounts
        .where((a) => a.legacy.code === "L2")
        .select((a) => a.id)
        .toArray(),
    );
    expect(rows).toEqual([2]);
    expect(accounts.select((a) => a.extra!["it's"]).toSql().sql).toContain(`-> 'it''s'`);
  });

  test("updating by a path, and a path the schema does not have", async () => {
    const count = await use((db) =>
      db.accounts
        .where((a) => a.settings.plan === "free")
        .executeUpdate({ extra: { region: "none" } }),
    );
    expect(count).toBe(1);
    const moved = await use((db) =>
      db.accounts
        .where((a) => a.extra!.region === "none")
        .select((a) => a.settings.owner.name)
        .toArray(),
    );
    expect(moved).toEqual(["Grace"]);
    expect(() =>
      accounts.select((a) => (a.settings as unknown as { nope: string }).nope).toSql(),
    ).toThrow(LinqError);
    expect(() => accounts.select((a) => (a.id as unknown as { x: number }).x).toSql()).toThrow(
      /cannot be translated/,
    );
  });
});
