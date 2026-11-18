/** Regression tests for the defects found in review. */
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { ConcurrencyError, LinqError } from "../src/index.ts";
import { session } from "../src/session.ts";
import { from } from "../src/query.ts";
import * as Table from "../src/table.ts";
import { type AuthorId, db as readDb, PgLive, writeDb } from "./schema.ts";

const r = writeDb("r");
const db = r.db;

const Things = Table.make(
  "r_things",
  {
    id: Schema.Number,
    owner: Schema.Number,
    big: Schema.Array(Schema.BigInt),
    dates: Schema.NullOr(Schema.Array(Schema.Date)),
    items: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Number })),
  },
  { schema: "linq_test" },
);
const things = from(Things);

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient> | { toArray(): Effect.Effect<A, E, SqlClient> },
): Promise<A> =>
  Effect.runPromise(("toArray" in effect ? effect.toArray() : effect).pipe(Effect.provide(PgLive)));

const exit = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(PgLive)));

const failure = async <A, E>(effect: Effect.Effect<A, E, SqlClient>): Promise<unknown> => {
  const result = await exit(effect);
  if (!Exit.isFailure(result)) throw new Error("expected a failure");
  return Cause.squash(result.cause);
};

const authors = db.authors.orderBy((a) => a.id);
const books = db.books.orderBy((b) => b.id);

beforeEach(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(r.truncate);
      yield* sql.unsafe("truncate linq_test.r_things");
      yield* db.authors.insert([
        { name: "Ada", email: "ada@example.com", age: 36 },
        { name: "Grace", email: "grace@example.com", age: 45, managerId: 1 as AuthorId },
        { name: "Linus", email: "linus@example.com", active: false },
      ]);
      yield* db.books.insert([
        { authorId: 1 as AuthorId, title: "Engine", views: 0n },
        { authorId: 1 as AuthorId, title: "Numbers", views: 20n },
        { authorId: 3 as AuthorId, title: "Kernel", views: 30n },
      ]);
      yield* db.accounts.insert([{ owner: "a" }, { owner: "b" }, { owner: "c" }]);
    }),
  ),
);

describe("sessions", () => {
  test("a one-statement save that fails its row count writes nothing", async () => {
    const uow = session();
    const rows = await run(uow.load(authors));
    await run(db.books.where((b) => b.authorId === 3).executeDelete());
    await run(db.authors.where((a) => a.id === 3).executeDelete());
    for (const row of rows) row.name += "!";
    expect(await failure(uow.saveChanges())).toBeInstanceOf(ConcurrencyError);
    expect(await run(authors.select((a) => a.name))).toEqual(["Ada", "Grace"]);

    // with a version column, the rows that would have succeeded can still be saved
    const accounts = session();
    const [a, b, c] = await run(accounts.load(db.accounts.orderBy((x) => x.id)));
    await run(db.accounts.where((x) => x.id === 3).executeDelete());
    for (const row of [a!, b!, c!]) row.balance += 1;
    expect(await failure(accounts.saveChanges())).toBeInstanceOf(ConcurrencyError);
    accounts.detach(c!);
    expect(await run(accounts.saveChanges())).toBe(2);
    expect(
      await run(db.accounts.orderBy((x) => x.id).select((x) => [x.balance, x.version])),
    ).toEqual([
      [1, 2],
      [1, 2],
    ]);

    // deletes too
    const removing = session();
    const [x, y] = await run(removing.load(db.accounts.orderBy((row) => row.id)));
    await run(db.accounts.where((row) => row.id === 2).executeDelete());
    removing.remove(x!);
    removing.remove(y!);
    expect(await failure(removing.saveChanges())).toBeInstanceOf(ConcurrencyError);
    expect(await run(db.accounts.count())).toBe(1);
  });

  test("composite keys that contain the separator do not collide", async () => {
    await run(
      db.stock.insert([
        { warehouse: "a\u0001string:b", sku: "c", qty: 1 },
        { warehouse: "a", sku: "b\u0001string:c", qty: 2 },
        { warehouse: 'a","b', sku: "c", qty: 3 },
        { warehouse: "a", sku: 'b","c', qty: 4 },
      ]),
    );
    const uow = session();
    const rows = await run(uow.load(db.stock.orderBy((s) => s.qty)));
    expect(uow.size).toBe(4);
    expect(new Set(rows).size).toBe(4);
    const found = await run(uow.find(db.stock, ["a", "b\u0001string:c"]));
    expect(Option.getOrThrow(found)).toBe(rows[1]);
  });

  test("an added row whose key the session already held replaces the stale one", async () => {
    await run(db.stock.insert({ warehouse: "a", sku: "x", qty: 1 }));
    const uow = session();
    const [old] = await run(uow.load(db.stock));
    await run(db.stock.executeDelete({ unfiltered: true }));
    const fresh = uow.add(db.stock, { warehouse: "a", sku: "x", qty: 7 });
    expect(await run(uow.saveChanges())).toBe(1);
    expect(uow.state(fresh)).toBe("unchanged");
    expect(uow.state(old!)).toBe("detached");
    fresh.qty = 8;
    expect(await run(uow.saveChanges())).toBe(1);
    expect(await run(db.stock.select((s) => s.qty))).toEqual([8]);
  });

  test("a row whose primary key was changed can still be found and detached", async () => {
    const uow = session();
    const [ada] = await run(uow.load(authors));
    ada!.id = 99 as AuthorId;
    expect(((await failure(uow.saveChanges())) as Error).message).toContain("primary key");
    uow.detach(ada!);
    expect(uow.state(ada!)).toBe("detached");
    expect(await run(uow.saveChanges())).toBe(0);
    expect(uow.size).toBe(2);
  });
});

describe("writes", () => {
  test("the full-table guard also covers queries that only follow relations", async () => {
    const message = async (effect: Effect.Effect<unknown, unknown, SqlClient>) =>
      ((await failure(effect)) as Error).message;
    expect(await message(db.books.include("author").executeDelete())).toContain("every row");
    const flag = true;
    expect(
      await message(db.books.where((b) => b.author.active || flag).executeUpdate({ title: "X" })),
    ).toContain("every row");
    expect(await message(db.authors.distinct().executeDelete())).toContain("every row");
    expect(await message(db.books.orderBy((b) => b.author.name).executeDelete())).toContain(
      "every row",
    );
    expect(await run(db.books.count())).toBe(3);
    expect(await run(books.select((b) => b.title))).toEqual(["Engine", "Numbers", "Kernel"]);
    // a real condition through a relation still works, and so does asking for it
    expect(await run(db.books.where((b) => !b.author.active).executeDelete())).toBe(1);
    expect(await run(db.books.include("author").executeDelete({ unfiltered: true }))).toBe(2);
  });

  test("undefined in an update lambda leaves the column alone", async () => {
    const update = db.authors
      .where((a) => a.id === 1)
      .executeUpdate((a) => ({ name: a.name + "!", age: undefined }));
    expect(update.toSql().sql).not.toContain('"age"');
    await run(update);
    expect(await run(authors.select((a) => [a.name, a.age]).take(1))).toEqual([["Ada!", 36]]);
    await run(db.authors.where((a) => a.id === 1).executeUpdate(() => ({ age: null })));
    expect(await run(authors.select((a) => a.age).take(1))).toEqual([null]);
  });

  test("names inherited from Object are not columns", async () => {
    const hostile = JSON.parse('{"warehouse":"a","sku":"b","qty":1,"constructor":5}');
    expect(await failure(db.stock.insert(hostile))).toBeInstanceOf(LinqError);
    expect(
      await failure(
        db.stock.where((s) => s.qty === 1).executeUpdate({ qty: 2, toString: 5 } as never),
      ),
    ).toBeInstanceOf(LinqError);
    expect(() => db.stock.where((s) => (s as any).hasOwnProperty === 1).toSql()).toThrow(LinqError);
  });

  test("a JSON column that holds an array, and arrays of bigint and dates", async () => {
    const when = new Date("2025-02-03T04:05:06.000Z");
    const row = {
      id: 1,
      owner: 7,
      big: [9007199254740993n, 2n],
      dates: [when, new Date(0)],
      items: [
        { sku: "a", qty: 1 },
        { sku: 'b,"c"', qty: 2 },
      ],
    };
    await run(things.insert([row, { ...row, id: 2, dates: null, big: [], items: [] }]));
    expect(await run(things.orderBy((t) => t.id).take(1))).toEqual([row]);
    await run(things.where((t) => t.id === 2).executeUpdate({ items: [{ sku: "z", qty: 9 }] }));

    // the same values read inside a nested collection (through JSON)
    const nested = await run(
      things
        .where((t) => t.id === 1)
        .select((t) => ({
          siblings: things
            .where((o) => o.owner === t.owner)
            .orderBy((o) => o.id)
            .asMany(),
        })),
    );
    expect(nested[0]!.siblings).toEqual([
      row,
      { id: 2, owner: 7, big: [], dates: null, items: [{ sku: "z", qty: 9 }] },
    ]);

    // and tracked
    const uow = session();
    const [first] = await run(uow.load(things.orderBy((t) => t.id)));
    first!.items.push({ sku: "new", qty: 3 });
    first!.big[1] = 3n;
    expect(uow.changes()[0]!.columns).toEqual(["big", "items"]);
    expect(await run(uow.saveChanges())).toBe(1);
    const [saved] = await run(things.orderBy((t) => t.id).take(1));
    expect(saved!.items.length).toBe(3);
    expect(saved!.big).toEqual([9007199254740993n, 3n]);
  });
});

describe("queries", () => {
  const users = readDb.users.orderBy((u) => u.id);

  test("a condition inside a nested collection is false, not null, for a missing value", async () => {
    const rows = await run(
      users
        .where((u) => u.id === 1)
        .select((u) => u.reports.orderBy((x) => x.id).select((x) => ({ adult: x.age! >= 18 }))),
    );
    expect(rows).toEqual([[{ adult: true }, { adult: false }]]);
  });

  test("a join condition can follow a relation", async () => {
    const rows = await run(
      users
        .join(
          readDb.posts,
          (u, p) => p.author.id === u.id && p.published,
          (u, p) => ({ user: u.name, title: p.title }),
        )
        .where((x) => x.user === "Grace"),
    );
    expect(rows).toEqual([{ user: "Grace", title: "COBOL tips" }]);
    expect(() =>
      users
        .leftJoin(
          readDb.posts,
          (u, p) => p.author.id === u.id,
          (u, p) => ({ user: u.name, title: p.title }),
        )
        .toSql(),
    ).toThrow(/leftJoin cannot follow a relation/);
  });

  test("a relation navigated before and after selectMany", async () => {
    const rows = await run(
      users.selectMany(
        (u) => u.posts.where((p) => p.author.isAdmin),
        (u, p) => ({ title: p.title, boss: p.author.manager.name, email: p.author.email }),
      ),
    );
    expect(rows.map((row) => row.title).sort()).toEqual([
      "Bernoulli numbers",
      "Notes on the Engine",
    ]);
    expect(rows[0]).toMatchObject({ boss: null, email: "ada@example.com" });
  });

  test("bigint || fallback, and includes with null", async () => {
    expect(
      await run(
        readDb.posts
          .orderBy((p) => p.id)
          .select((p) => p.views || 5n)
          .skip(3)
          .take(1),
      ),
    ).toEqual([5n]);
    const ids: Array<number | null> = [1, null];
    expect(await run(users.where((u) => ids.includes(u.managerId)).select((u) => u.name))).toEqual([
      "Ada",
      "Grace",
      "Linus",
    ]);
    expect(
      await run(users.where((u) => [2, null].includes(u.managerId)).select((u) => u.id)),
    ).toEqual([1, 4, 5]);
    const none: Array<number | null> = [null];
    expect(await run(users.where((u) => none.includes(u.managerId)).select((u) => u.id))).toEqual([
      1,
    ]);
  });
});
