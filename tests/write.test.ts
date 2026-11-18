import { Cause, DateTime, Effect, Exit, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { LinqError, Sql } from "../src/index.ts";
import { type AuthorId, db, PgLive, truncateW, wdb } from "./schema.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient> | { toArray(): Effect.Effect<A, E, SqlClient> },
): Promise<A> =>
  Effect.runPromise(("toArray" in effect ? effect.toArray() : effect).pipe(Effect.provide(PgLive)));

const exit = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(PgLive)));

const defect = async <A, E>(effect: Effect.Effect<A, E, SqlClient>): Promise<string> => {
  const result = await exit(effect);
  if (!Exit.isFailure(result)) throw new Error("expected a failure");
  const error = Cause.squash(result.cause);
  expect(error).toBeInstanceOf(LinqError);
  return (error as LinqError).message;
};

const authors = wdb.authors.orderBy((a) => a.id);
const books = wdb.books.orderBy((b) => b.id);

/** Ada (1), Grace (2, reports to Ada), Linus (3, inactive); three books. */
const seed = Effect.gen(function* () {
  yield* wdb.authors.insert([
    { name: "Ada", email: "ada@example.com", age: 36, balance: 100 },
    { name: "Grace", email: "grace@example.com", age: 45, managerId: 1 as AuthorId },
    { name: "Linus", email: "linus@example.com", active: false },
  ]);
  yield* wdb.books.insert([
    { authorId: 1 as AuthorId, title: "Engine", views: 10n },
    { authorId: 1 as AuthorId, title: "Numbers", views: 20n },
    { authorId: 3 as AuthorId, title: "Kernel", views: 30n },
  ]);
});

beforeEach(() => run(SqlClient.use((sql) => sql.unsafe(truncateW))));

describe("insert", () => {
  test("one row: returns the count, or the row with what the database filled in", async () => {
    expect(await run(wdb.authors.insert({ name: "Ada", email: "ada@example.com" }))).toBe(1);
    const row = await run(
      wdb.authors.insert({ name: "Grace", email: "grace@example.com", age: 45 }).returning(),
    );
    expect(row).toMatchObject({
      id: 2,
      name: "Grace",
      age: 45,
      balance: 0,
      active: true,
      managerId: null,
    });
    expect(DateTime.isDateTime(row.createdAt)).toBe(true);
    const id = await run(
      wdb.authors.insert({ name: "Linus", email: "linus@example.com" }).returning((a) => a.id),
    );
    expect(id).toBe(3);
  });

  test("many rows in one statement; a column left out of some rows takes its default", async () => {
    const insert = wdb.authors.insert([
      { name: "Ada", email: "ada@example.com", balance: 12.5 },
      { name: "Grace", email: "grace@example.com", active: false },
    ]);
    expect(insert.toSql()).toEqual({
      sql:
        'WITH m AS (INSERT INTO "linq_test"."w_authors" AS "t0" ("name", "email", "balance", "active") ' +
        "VALUES ($1, $2, $3, DEFAULT), ($4, $5, DEFAULT, $6) RETURNING 1) SELECT count(*)::int FROM m",
      params: ["Ada", "ada@example.com", "12.5", "Grace", "grace@example.com", false],
    });
    expect(await run(insert)).toBe(2);
    expect(await run(authors.select((a) => [a.name, a.balance, a.active]))).toEqual([
      ["Ada", 12.5, true],
      ["Grace", 0, false],
    ]);
  });

  test("values go through the column schemas, both ways", async () => {
    const publishedAt = new Date("2025-03-04T05:06:07.000Z");
    await run(wdb.authors.insert({ name: "Ada", email: "a@example.com" }));
    const inserted = await run(
      wdb.books
        .insert({
          authorId: 1 as AuthorId,
          title: "O'Reilly \"quoted\" \\ $1 'x'); drop table linq_test.w_books; --",
          tags: ["a,b", 'c"d', "{e}"],
          meta: { featured: true, rank: 2 },
          raw: { note: "it's" },
          cover: new Uint8Array([0, 1, 255]),
          views: 9007199254740993n,
          publishedAt,
        })
        .returning(),
    );
    const [read] = await run(books);
    expect(read).toEqual(inserted);
    expect(read).toEqual({
      id: 1,
      authorId: 1,
      title: "O'Reilly \"quoted\" \\ $1 'x'); drop table linq_test.w_books; --",
      tags: ["a,b", 'c"d', "{e}"],
      meta: { featured: true, rank: 2 },
      raw: { note: "it's" },
      cover: new Uint8Array([0, 1, 255]),
      views: 9007199254740993n,
      publishedAt,
    });
  });

  test("null and undefined: NULL and the default", async () => {
    await run(wdb.authors.insert({ name: "Ada", email: "a@example.com", age: null }));
    const row = await run(
      wdb.books
        .insert({ authorId: 1 as AuthorId, title: "t", meta: null, tags: undefined })
        .returning(),
    );
    expect(row).toMatchObject({ meta: null, raw: null, tags: [], views: 0n, publishedAt: null });
  });

  test("a value that does not match its schema is a typed failure, before any SQL", async () => {
    const result = await exit(
      wdb.authors.insert({ name: "Ada", email: "a@example.com", age: 1.5 }),
    );
    expect(Exit.isFailure(result) && Schema.isSchemaError(Cause.squash(result.cause))).toBe(true);
    expect(await run(wdb.authors.count())).toBe(0);
  });

  test("database errors are SqlErrors", async () => {
    await run(wdb.authors.insert({ name: "Ada", email: "a@example.com" }));
    const result = await exit(wdb.authors.insert({ name: "Ada 2", email: "a@example.com" }));
    expect(Exit.isFailure(result) && (Cause.squash(result.cause) as any)._tag).toBe("SqlError");
  });

  test("misuse is rejected with a clear message", async () => {
    expect(await defect(wdb.authors.insert({ name: "Ada" } as never))).toContain(
      '"email" is required',
    );
    expect(await defect(wdb.authors.insert({ name: "A", email: "e", nope: 1 } as never))).toContain(
      '"nope" is not a column',
    );
    expect(
      await defect(
        (wdb.authors.where((a) => a.id === 1) as typeof wdb.authors).insert({
          name: "A",
          email: "e",
        }),
      ),
    ).toContain("must be called on a table");
  });

  test("an empty array does nothing", async () => {
    expect(await run(wdb.authors.insert([]))).toBe(0);
    expect(await run(wdb.authors.insert([]).returning())).toEqual([]);
  });

  test("large inserts are split to fit the parameter limit, atomically", async () => {
    const rows = Array.from({ length: 23_000 }, (_, i) => ({
      warehouse: `w${i % 7}`,
      sku: `sku-${i}`,
      qty: i,
    }));
    expect(await run(wdb.stock.insert(rows))).toBe(23_000);
    expect(await run(wdb.stock.sum((s) => s.qty))).toBe((22_999 * 23_000) / 2);
    const returned = await run(
      wdb.stock.insert(rows.map((r) => ({ ...r, warehouse: "x" }))).returning((s) => s.qty),
    );
    expect(returned.length).toBe(23_000);
    expect(returned[22_999]).toBe(22_999);

    // a duplicate in the last batch undoes the earlier ones
    await run(wdb.stock.executeDelete({ unfiltered: true }));
    const bad = [...rows.slice(0, 22_999), rows[0]!];
    expect(Exit.isFailure(await exit(wdb.stock.insert(bad)))).toBe(true);
    expect(await run(wdb.stock.count())).toBe(0);
  });

  test("Sql.now() as a value", async () => {
    await run(wdb.authors.insert({ name: "Ada", email: "a@example.com" }));
    const row = await run(
      wdb.books.insert({ authorId: 1 as AuthorId, title: "t", publishedAt: Sql.now() }).returning(),
    );
    expect(Math.abs(row.publishedAt!.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

describe("upsert", () => {
  test("onConflictDoNothing skips existing rows", async () => {
    await run(wdb.stock.insert({ warehouse: "a", sku: "1", qty: 5 }));
    const count = await run(
      wdb.stock
        .insert([
          { warehouse: "a", sku: "1", qty: 99 },
          { warehouse: "a", sku: "2", qty: 7 },
        ])
        .onConflictDoNothing(),
    );
    expect(count).toBe(1);
    const inserted = await run(
      wdb.stock
        .insert({ warehouse: "a", sku: "1", qty: 99 })
        .onConflictDoNothing(["warehouse", "sku"])
        .returning(),
    );
    expect(inserted).toEqual([]);
    expect(await run(wdb.stock.orderBy((s) => s.sku).select((s) => s.qty))).toEqual([5, 7]);
  });

  test("onConflictDoUpdate overwrites with the inserted values by default", async () => {
    await run(wdb.authors.insert({ name: "Ada", email: "ada@example.com", age: 36 }));
    const upsert = wdb.authors
      .insert({ name: "Ada L.", email: "ada@example.com", age: 37 })
      .onConflictDoUpdate("email");
    expect(upsert.returning((a) => a.id).toSql().sql).toBe(
      'INSERT INTO "linq_test"."w_authors" AS "t0" ("name", "email", "age") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("email") DO UPDATE SET "name" = "excluded"."name", "age" = "excluded"."age" ' +
        'RETURNING "t0"."id" AS "c0"',
    );
    expect(await run(upsert)).toBe(1);
    expect(await run(authors.select((a) => [a.id, a.name, a.age]))).toEqual([[1, "Ada L.", 37]]);
  });

  test("onConflictDoUpdate with a lambda over the existing and the proposed row", async () => {
    const add = (qty: number) =>
      wdb.stock
        .insert({ warehouse: "a", sku: "1", qty })
        .onConflictDoUpdate(["warehouse", "sku"], (existing, proposed) => ({
          qty: existing.qty + proposed.qty,
        }))
        .returning((s) => s.qty);
    expect(await run(add(5))).toEqual([5]);
    expect(await run(add(3))).toEqual([8]);
    // a plain object works too
    await run(
      wdb.stock
        .insert({ warehouse: "a", sku: "1", qty: 1 })
        .onConflictDoUpdate(["warehouse", "sku"], { qty: 0 }),
    );
    expect(await run(wdb.stock.select((s) => s.qty))).toEqual([0]);
  });
});

describe("executeUpdate", () => {
  beforeEach(() => run(seed));

  test("a plain object: values are bind parameters, encoded by the column schema", async () => {
    const id = 2;
    const update = wdb.authors
      .where((a) => a.id === id)
      .executeUpdate({ name: "Grace H.", balance: 7.25, age: null, email: undefined });
    expect(update.toSql()).toEqual({
      sql:
        'WITH m AS (UPDATE "linq_test"."w_authors" AS "t0" SET "name" = $1, "balance" = $2, "age" = NULL ' +
        'WHERE ("t0"."id" = $3) RETURNING 1) SELECT count(*)::int FROM m',
      params: ["Grace H.", "7.25", 2],
    });
    expect(await run(update)).toBe(1);
    expect(await run(authors.select((a) => [a.name, a.balance, a.age, a.email]))).toEqual([
      ["Ada", 100, 36, "ada@example.com"],
      ["Grace H.", 7.25, null, "grace@example.com"],
      ["Linus", 0, null, "linus@example.com"],
    ]);
  });

  test("a lambda: values computed in the database, row by row", async () => {
    const bonus = 10;
    const count = await run(
      wdb.authors
        .where((a) => a.active)
        .executeUpdate((a) => ({
          name: a.name.toUpperCase(),
          balance: a.balance + bonus,
          age: a.age === null ? 0 : a.age + 1,
        })),
    );
    expect(count).toBe(2);
    expect(await run(authors.select((a) => [a.name, a.balance, a.age]))).toEqual([
      ["ADA", 110, 37],
      ["GRACE", 10, 46],
      ["Linus", 0, null],
    ]);
  });

  test("the update is a single statement: concurrent increments are not lost", async () => {
    const bump = wdb.books.where((b) => b.id === 1).executeUpdate((b) => ({ views: b.views + 1n }));
    await run(
      Effect.all(
        Array.from({ length: 40 }, () => bump),
        { concurrency: 8 },
      ),
    );
    expect(await run(wdb.books.where((b) => b.id === 1).select((b) => b.views))).toEqual([50n]);
  });

  test("returning: the rows as they are after the update", async () => {
    const rows = await run(
      wdb.authors
        .where((a) => a.age !== null)
        .executeUpdate((a) => ({ age: a.age! * 2 }))
        .returning((a) => ({ id: a.id, age: a.age, books: a.books.count() })),
    );
    expect(rows.sort((x, y) => x.id - y.id)).toEqual([
      { id: 1, age: 72, books: 2 },
      { id: 2, age: 90, books: 0 },
    ]);
    const [full] = await run(
      wdb.authors
        .where((a) => a.id === 3)
        .executeUpdate({ active: true })
        .returning(),
    );
    expect(full).toMatchObject({ id: 3, name: "Linus", active: true, balance: 0 });
    expect(DateTime.isDateTime(full!.createdAt)).toBe(true);
  });

  test("conditions and values can follow relations", async () => {
    const update = wdb.books
      .where((b) => b.author.active && b.author.name.startsWith("A"))
      .executeUpdate((b) => ({ title: `${b.author.name}: ${b.title}`, views: 0n }));
    expect(update.toSql().sql).toBe(
      'WITH m AS (UPDATE "linq_test"."w_books" AS "u2" SET "title" = "s3"."c1", "views" = $1 FROM (' +
        'SELECT "t0"."id" AS "c0", ("t1"."name" || $2::text || "t0"."title") AS "c1" FROM "linq_test"."w_books" AS "t0" ' +
        'LEFT JOIN "linq_test"."w_authors" AS "t1" ON ("t0"."author_id" = "t1"."id") ' +
        'WHERE ("t1"."active" AND ("t1"."name" LIKE $3))) AS "s3" ' +
        'WHERE "u2"."id" = "s3"."c0" RETURNING 1) SELECT count(*)::int FROM m',
    );
    expect(await run(update)).toBe(2);
    expect(await run(books.select((b) => [b.title, b.views]))).toEqual([
      ["Ada: Engine", 0n],
      ["Ada: Numbers", 0n],
      ["Kernel", 30n],
    ]);
  });

  test("values can be subqueries over a collection", async () => {
    await run(
      wdb.authors.executeUpdate(
        (a) => ({ age: a.books.count(), balance: a.books.sum((b) => Number(b.views)) }),
        { unfiltered: true },
      ),
    );
    expect(await run(authors.select((a) => [a.age, a.balance]))).toEqual([
      [2, 30],
      [0, 0],
      [1, 30],
    ]);
  });

  test("conditions on collections stay in the WHERE clause", async () => {
    const update = wdb.authors
      .where((a) => a.books.some((b) => b.views > 15n))
      .executeUpdate({ active: false });
    expect(update.toSql().sql).toContain(
      'UPDATE "linq_test"."w_authors" AS "t0" SET "active" = $1 WHERE EXISTS',
    );
    expect(await run(update)).toBe(2);
  });

  test("paging: update the top N rows", async () => {
    const rows = await run(
      wdb.books
        .orderByDescending((b) => b.views)
        .take(2)
        .executeUpdate({ tags: ["popular"] })
        .returning((b) => b.title),
    );
    expect(rows.sort()).toEqual(["Kernel", "Numbers"]);
    expect(await run(books.select((b) => b.tags))).toEqual([[], ["popular"], ["popular"]]);
  });

  test("json, array, bytes and Sql.now() as values", async () => {
    await run(
      wdb.books
        .where((b) => b.id === 1)
        .executeUpdate({
          meta: { featured: false },
          raw: { note: "n" },
          tags: ["x", "y"],
          cover: new Uint8Array([9]),
          publishedAt: Sql.now(),
        }),
    );
    const [book] = await run(books.take(1));
    expect(book).toMatchObject({
      meta: { featured: false },
      raw: { note: "n" },
      tags: ["x", "y"],
      cover: new Uint8Array([9]),
    });
    expect(Math.abs(book!.publishedAt!.getTime() - Date.now())).toBeLessThan(60_000);
  });

  test("an update without a condition must be asked for", async () => {
    expect(await defect(wdb.authors.executeUpdate({ active: false }))).toContain("every row");
    // the dangerous case: an optional filter that folds away
    const filter: { name?: string } = {};
    expect(
      await defect(
        wdb.authors
          .where((a) => filter.name === undefined || a.name === filter.name)
          .executeUpdate({ active: false }),
      ),
    ).toContain("every row");
    expect(await run(authors.select((a) => a.active))).toEqual([true, true, false]);
    expect(await run(wdb.authors.executeUpdate({ active: false }, { unfiltered: true }))).toBe(3);
  });

  test("misuse is rejected with a clear message", async () => {
    const one = wdb.authors.where((a) => a.id === 1);
    expect(await defect(one.executeUpdate({}))).toContain("no column values");
    expect(await defect(one.executeUpdate({ nope: 1 } as never))).toContain("is not a column");
    expect(
      await defect((one.select((a) => a.id) as never as typeof one).executeUpdate({ age: 1 })),
    ).toContain("remove select");
    expect(await defect(one.executeUpdate({ age: 1 }).returning((a) => a.manager.name))).toContain(
      "to-one relation",
    );
    const result = await exit(one.executeUpdate({ age: 1.5 }));
    expect(Exit.isFailure(result) && Schema.isSchemaError(Cause.squash(result.cause))).toBe(true);
  });

  test("values are never interpolated into SQL", async () => {
    const hostile = "'; drop table linq_test.w_authors; --";
    await run(wdb.authors.where((a) => a.id === 1).executeUpdate({ name: hostile }));
    await run(
      wdb.authors.where((a) => a.id === 2).executeUpdate((a) => ({ name: a.name + hostile })),
    );
    expect(await run(authors.select((a) => a.name))).toEqual([hostile, `Grace${hostile}`, "Linus"]);
  });
});

describe("executeDelete", () => {
  beforeEach(() => run(seed));

  test("deletes the rows of the query and returns the count", async () => {
    const remove = wdb.books.where((b) => b.views >= 20n).executeDelete();
    expect(remove.toSql()).toEqual({
      sql:
        'WITH m AS (DELETE FROM "linq_test"."w_books" AS "t0" WHERE ("t0"."views" >= $1) RETURNING 1) ' +
        "SELECT count(*)::int FROM m",
      params: [20n],
    });
    expect(await run(remove)).toBe(2);
    expect(await run(remove)).toBe(0);
    expect(await run(books.select((b) => b.title))).toEqual(["Engine"]);
  });

  test("returning: the deleted rows", async () => {
    const rows = await run(
      wdb.books
        .where((b) => b.authorId === 1)
        .executeDelete()
        .returning((b) => ({ title: b.title, views: b.views })),
    );
    expect(rows.sort((x, y) => x.title.localeCompare(y.title))).toEqual([
      { title: "Engine", views: 10n },
      { title: "Numbers", views: 20n },
    ]);
    const full = await run(
      wdb.books
        .where((b) => b.id === 3)
        .executeDelete()
        .returning(),
    );
    expect(full).toMatchObject([{ id: 3, title: "Kernel", tags: [] }]);
  });

  test("conditions can follow relations and collections", async () => {
    expect(await run(wdb.books.where((b) => !b.author.active).executeDelete())).toBe(1);
    expect(
      await run(
        wdb.authors.where((a) => a.manager.name === "Ada" && !a.books.some()).executeDelete(),
      ),
    ).toBe(1);
    expect(await run(authors.select((a) => a.name))).toEqual(["Ada", "Linus"]);
  });

  test("paging, with a composite primary key", async () => {
    await run(
      wdb.stock.insert([
        { warehouse: "a", sku: "1", qty: 5 },
        { warehouse: "a", sku: "2", qty: 1 },
        { warehouse: "b", sku: "1", qty: 3 },
      ]),
    );
    const remove = wdb.stock
      .orderBy((s) => s.qty)
      .take(2)
      .executeDelete();
    expect(remove.toSql().sql).toBe(
      'WITH m AS (DELETE FROM "linq_test"."w_stock" AS "d1" WHERE ("d1"."warehouse", "d1"."sku") IN (' +
        'SELECT "t0"."warehouse" AS "c0", "t0"."sku" AS "c1" FROM "linq_test"."w_stock" AS "t0" ' +
        'ORDER BY "t0"."qty" LIMIT 2) RETURNING 1) SELECT count(*)::int FROM m',
    );
    expect(await run(remove)).toBe(2);
    expect(await run(wdb.stock.select((s) => s.qty))).toEqual([5]);
  });

  test("a delete without a condition must be asked for", async () => {
    expect(await defect(wdb.books.executeDelete())).toContain("every row");
    const filter: { title?: string } = {};
    expect(
      await defect(
        wdb.books
          .where((b) => filter.title === undefined || b.title === filter.title)
          .executeDelete(),
      ),
    ).toContain("every row");
    expect(await run(wdb.books.count())).toBe(3);
    expect(await run(wdb.books.executeDelete({ unfiltered: true }))).toBe(3);
  });

  test("a table without a primary key: plain deletes work, paged ones say why not", async () => {
    await run(wdb.log.insert([{ message: "a" }, { message: "b" }]));
    expect(await defect(wdb.log.take(1).executeDelete())).toContain("primary key");
    expect(await run(wdb.log.where((l) => l.message === "a").executeDelete())).toBe(1);
  });
});

describe("writes and Effect SQL", () => {
  test("writes take part in transactions", async () => {
    const result = await exit(
      SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const author = yield* wdb.authors
              .insert({ name: "Ada", email: "a@example.com" })
              .returning();
            yield* wdb.books.insert({ authorId: author.id, title: "Engine" });
            expect(yield* wdb.books.count()).toBe(1);
            return yield* Effect.fail("rollback");
          }),
        ),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(await run(wdb.authors.count())).toBe(0);
    expect(await run(wdb.books.count())).toBe(0);
  });

  test("the statements are index-friendly", async () => {
    await run(seed);
    const { sql, params } = wdb.books
      .where((b) => b.id === 2)
      .executeUpdate((b) => ({ views: b.views + 1n }))
      .returning((b) => b.views)
      .toSql();
    const plan = await run(
      SqlClient.use((client) =>
        Effect.gen(function* () {
          yield* client.unsafe("set local enable_seqscan = off");
          return yield* client.unsafe(`explain ${sql}`, params as Array<unknown>);
        }).pipe(client.withTransaction),
      ),
    );
    expect(JSON.stringify(plan)).toContain("w_books_pkey");
  });

  test("nothing is tracked: read rows are plain values, and the seed data is untouched", async () => {
    const [user] = await run(db.users.where((u) => u.id === 1));
    (user as { name: string }).name = "Changed locally";
    expect(await run(db.users.where((u) => u.id === 1).select((u) => u.name))).toEqual(["Ada"]);
  });
});
