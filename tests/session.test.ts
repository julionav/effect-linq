import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { ConcurrencyError, LinqError } from "../src/index.ts";
import { session } from "../src/session.ts";
import { type AuthorId, PgLive, writeDb } from "./schema.ts";

const s = writeDb("s");
const db = s.db;

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient> | { toArray(): Effect.Effect<A, E, SqlClient> },
): Promise<A> =>
  Effect.runPromise(("toArray" in effect ? effect.toArray() : effect).pipe(Effect.provide(PgLive)));

const exit = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(PgLive)));

/** The statements an effect sends, in order. */
const statements = async <A, E>(effect: Effect.Effect<A, E, SqlClient>): Promise<Array<string>> => {
  const log: Array<string> = [];
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const spy: SqlClient = Object.assign(Object.create(sql), {
        unsafe: (text: string, params?: ReadonlyArray<unknown>) => {
          log.push(text);
          return sql.unsafe(text, params);
        },
      });
      return yield* Effect.provideService(effect, SqlClient, spy);
    }),
  );
  return log;
};

const authors = db.authors.orderBy((a) => a.id);
const books = db.books.orderBy((b) => b.id);

beforeEach(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(s.truncate);
      yield* db.authors.insert([
        { name: "Ada", email: "ada@example.com", age: 36, balance: 100 },
        { name: "Grace", email: "grace@example.com", age: 45, managerId: 1 as AuthorId },
        { name: "Linus", email: "linus@example.com", active: false },
      ]);
      yield* db.books.insert([
        { authorId: 1 as AuthorId, title: "Engine", views: 10n, tags: ["math"] },
        { authorId: 1 as AuthorId, title: "Numbers", views: 20n, meta: { featured: true } },
        { authorId: 3 as AuthorId, title: "Kernel", views: 30n },
      ]);
      yield* db.accounts.insert([{ owner: "ada" }, { owner: "grace", balance: 50 }]);
    }),
  ),
);

describe("tracking", () => {
  test("change a loaded row and save: only the changed columns are written", async () => {
    const uow = session();
    const sent = await statements(
      Effect.gen(function* () {
        const ada = yield* uow.first(db.authors.where((a) => a.name === "Ada"));
        expect(uow.state(ada)).toBe("unchanged");
        ada.name = "Ada Lovelace";
        ada.age = 37;
        expect(uow.state(ada)).toBe("modified");
        expect(uow.changes()).toMatchObject([
          { table: "s_authors", state: "modified", columns: ["name", "age"] },
        ]);
        expect(yield* uow.saveChanges()).toBe(1);
        expect(uow.state(ada)).toBe("unchanged");
        // nothing changed since: no statement at all
        expect(yield* uow.saveChanges()).toBe(0);
      }),
    );
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(
      'UPDATE "linq_test"."s_authors" AS t SET "name" = v."n0", "age" = v."n1" FROM (VALUES ' +
        '((NULL::"linq_test"."s_authors")."id", (NULL::"linq_test"."s_authors")."name", (NULL::"linq_test"."s_authors")."age"), ' +
        '($1, $2, $3)) AS v ("k0", "n0", "n1") WHERE t."id" = v."k0"',
    );
    expect(await run(authors.select((a) => [a.name, a.age, a.balance]))).toEqual([
      ["Ada Lovelace", 37, 100],
      ["Grace", 45, 0],
      ["Linus", null, 0],
    ]);
  });

  test("many rows changed the same way are one statement", async () => {
    const uow = session();
    const sent = await statements(
      Effect.gen(function* () {
        const rows = yield* uow.load(authors);
        for (const row of rows) row.balance += 1.5;
        rows[0]!.active = false;
        expect(yield* uow.saveChanges()).toBe(3);
      }),
    );
    // load, begin, [balance] x2, [balance, active] x1, commit
    expect(sent.filter((text) => text.includes("UPDATE")).length).toBe(2);
    expect(await run(authors.select((a) => [a.balance, a.active]))).toEqual([
      [101.5, false],
      [1.5, true],
      [1.5, false],
    ]);
  });

  test("every column type round-trips, and in-place changes are noticed", async () => {
    const uow = session();
    const publishedAt = new Date("2025-01-02T03:04:05.000Z");
    await run(
      Effect.gen(function* () {
        const [engine, numbers, kernel] = yield* uow.load(books);
        engine!.tags.push('it\'s {a} "b"');
        numbers!.meta!.rank = 3;
        numbers!.cover = new Uint8Array([1, 2, 3]);
        kernel!.views += 9007199254740993n;
        kernel!.publishedAt = publishedAt;
        kernel!.raw = { note: "n" };
        expect(uow.changes().map((change) => change.columns)).toEqual([
          ["tags"],
          ["meta", "cover"],
          ["raw", "views", "publishedAt"],
        ]);
        expect(yield* uow.saveChanges()).toBe(3);

        // mutating a date or bytes in place
        kernel!.publishedAt!.setUTCFullYear(2030);
        numbers!.cover![0] = 9;
        expect(uow.changes().map((change) => change.columns)).toEqual([["cover"], ["publishedAt"]]);
        yield* uow.saveChanges();
        expect(uow.hasChanges()).toBe(false);
      }),
    );
    const rows = await run(books);
    expect(rows[0]!.tags).toEqual(["math", 'it\'s {a} "b"']);
    expect(rows[1]).toMatchObject({
      meta: { featured: true, rank: 3 },
      cover: new Uint8Array([9, 2, 3]),
    });
    expect(rows[2]).toMatchObject({
      views: 9007199254740993n + 30n,
      raw: { note: "n" },
      publishedAt: new Date("2030-01-02T03:04:05.000Z"),
    });
  });

  test("setting a value to an equal one is not a change", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const ada = yield* uow.first(authors);
        const [engine] = yield* uow.load(books);
        ada.name = "Ada";
        ada.createdAt = DateTime.makeUnsafe(DateTime.toEpochMillis(ada.createdAt));
        engine!.tags = ["math"];
        engine!.publishedAt = null;
        expect(uow.hasChanges()).toBe(false);
        ada.age = null;
        expect(uow.changes()[0]!.columns).toEqual(["age"]);
      }),
    );
  });

  test("identity map: one object per row, and local changes survive a reload", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const ada = yield* uow.first(db.authors.where((a) => a.id === 1));
        ada.name = "Changed locally";
        const again = yield* uow.load(authors);
        expect(again[0]).toBe(ada);
        expect(again[0]!.name).toBe("Changed locally");
        expect(uow.size).toBe(3);
        // find() answers from the map without a query
        const found = yield* uow.find(db.authors, 1);
        expect(Option.getOrThrow(found)).toBe(ada);
      }),
    );
    const sent = await statements(
      Effect.gen(function* () {
        expect(Option.isSome(yield* uow.find(db.authors, 2))).toBe(true);
        expect(Option.isNone(yield* uow.find(db.authors, 99))).toBe(true);
        expect(Option.isSome(yield* uow.find(db.stock, ["a", "1"]))).toBe(false);
      }),
    );
    expect(sent.length).toBe(2);
  });

  test("rows reached through relations and projections are tracked too", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const [ada] = yield* uow.load(authors.include("books").take(1));
        const pairs = yield* uow.load(
          books.where((b) => b.id === 1).select((b) => ({ book: b, author: b.author, n: b.views })),
        );
        expect(pairs[0]!.author).toBe(ada);
        expect(pairs[0]!.book).toBe(ada!.books[0]);
        ada!.books[1]!.title = "Bernoulli";
        pairs[0]!.book.title = "The Engine";
        pairs[0]!.author.age = 40;
        expect(yield* uow.saveChanges()).toBe(3);
      }),
    );
    expect(await run(books.select((b) => b.title))).toEqual(["The Engine", "Bernoulli", "Kernel"]);
    expect(await run(authors.select((a) => a.age).take(1))).toEqual([40]);
  });

  test("queries run outside the session are not tracked", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const [plain] = yield* authors;
        expect(uow.state(plain!)).toBe("detached");
        expect(uow.size).toBe(0);
      }),
    );
  });
});

describe("generated change detection", () => {
  test("NaN and values of an unexpected shape are handled by the exact comparison", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const [ada] = yield* uow.load(authors);
        const [engine, numbers] = yield* uow.load(books);
        ada!.balance = Number.NaN;
        expect(uow.changes()[0]!.columns).toEqual(["balance"]);
        yield* uow.saveChanges();
        // NaN !== NaN, but it is not a change
        expect(uow.hasChanges()).toBe(false);
        expect(yield* uow.saveChanges()).toBe(0);

        // replaced by an equal value, a reordered object, and a new array
        numbers!.meta = { rank: undefined, featured: true };
        engine!.tags = [...engine!.tags];
        expect(uow.hasChanges()).toBe(false);
        // values that do not match the schema are caught when saving
        (engine as any).tags = "not an array";
        expect(uow.changes()[0]!.columns).toEqual(["tags"]);
        const failed = yield* Effect.exit(uow.saveChanges());
        expect(Exit.isFailure(failed) && Schema.isSchemaError(Cause.squash(failed.cause))).toBe(
          true,
        );
      }),
    );
    expect(await run(authors.select((a) => a.balance).take(1))).toEqual([Number.NaN]);
  });

  test("without code generation (a CSP, some edge runtimes) the generic path does the same", async () => {
    const original = globalThis.Function;
    let blocked = 0;
    (globalThis as any).Function = function () {
      blocked++;
      throw new EvalError("code generation is disabled");
    };
    try {
      const uow = session();
      await run(
        Effect.gen(function* () {
          const rows = yield* uow.load(books.include("author"));
          expect(blocked).toBe(2);
          expect(rows[0]!.author).toBe(rows[1]!.author);
          rows[0]!.tags.push("x");
          rows[1]!.meta!.rank = 9;
          rows[2]!.title = "Renamed";
          rows[0]!.author.age = 50;
          expect(uow.changes().map((change) => change.columns)).toEqual([
            ["age"],
            ["tags"],
            ["meta"],
            ["title"],
          ]);
          expect(yield* uow.saveChanges()).toBe(4);
          expect(uow.hasChanges()).toBe(false);
          uow.remove(rows[2]!);
          expect(yield* uow.saveChanges()).toBe(1);
          expect(uow.size).toBe(4);
        }),
      );
    } finally {
      globalThis.Function = original;
    }
    expect((await run(books)).map((b) => [b.title, b.tags, b.meta?.rank ?? null])).toEqual([
      ["Engine", ["math", "x"], null],
      ["Numbers", [], 9],
    ]);
  });
});

describe("add and remove", () => {
  test("added rows are inserted in one statement and get their generated values", async () => {
    const uow = session();
    const sent = await statements(
      Effect.gen(function* () {
        const a = uow.add(db.authors, { name: "Barbara", email: "b@example.com" });
        const b = uow.add(db.authors, { name: "Dennis", email: "d@example.com", age: 70 });
        expect(uow.state(a)).toBe("added");
        expect(yield* uow.saveChanges()).toBe(2);
        expect([a.id, b.id]).toEqual([4, 5]);
        expect(a).toMatchObject({ balance: 0, active: true, age: null, managerId: null });
        expect(DateTime.isDateTime(a.createdAt)).toBe(true);
        expect(uow.state(a)).toBe("unchanged");
        // now tracked like a loaded row
        expect(Option.getOrThrow(yield* uow.find(db.authors, 5))).toBe(b);
        b.managerId = a.id;
        expect(yield* uow.saveChanges()).toBe(1);
      }),
    );
    expect(sent.filter((text) => text.includes("INSERT")).length).toBe(1);
    expect(await run(authors.select((a) => [a.name, a.managerId]).skip(3))).toEqual([
      ["Barbara", null],
      ["Dennis", 4],
    ]);
  });

  test("a parent and its children: save the parent first to get its key", async () => {
    const uow = session();
    await run(
      SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const author = uow.add(db.authors, { name: "Barbara", email: "b@example.com" });
            yield* uow.saveChanges();
            uow.add(db.books, { authorId: author.id, title: "CLU" });
            uow.add(db.books, { authorId: author.id, title: "Abstraction", tags: ["types"] });
            yield* uow.saveChanges();
          }),
        ),
      ),
    );
    expect(
      await run(db.authors.where((a) => a.name === "Barbara").select((a) => a.books.count())),
    ).toEqual([2]);
  });

  test("removed rows are deleted, in the order they were removed", async () => {
    const uow = session();
    const sent = await statements(
      Effect.gen(function* () {
        const [ada] = yield* uow.load(authors.include("books").take(1));
        yield* uow.load(db.stock);
        // children first, as the foreign key demands
        for (const book of ada!.books) uow.remove(book);
        expect(uow.state(ada!.books[0]!)).toBe("deleted");
        expect(Option.isNone(yield* uow.find(db.books, ada!.books[0]!.id))).toBe(true);
        const grace = Option.getOrThrow(yield* uow.find(db.authors, 2));
        grace.managerId = null;
        uow.remove(ada!);
        expect(yield* uow.saveChanges()).toBe(4);
        expect(uow.state(ada!)).toBe("detached");
        expect(uow.size).toBe(1);
      }),
    );
    const writes = sent.filter((text) => /UPDATE|DELETE/.test(text));
    expect(
      writes.map((text) => text.match(/(UPDATE|DELETE FROM) "linq_test"."(\w+)"/)![2]),
    ).toEqual(["s_authors", "s_books", "s_authors"]);
    expect(writes[1]).toContain('($1), ($2)) AS v ("k0") WHERE t."id" = v."k0"');
    expect(await run(authors.select((a) => a.name))).toEqual(["Grace", "Linus"]);
  });

  test("composite keys", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        uow.add(db.stock, { warehouse: "a", sku: "1", qty: 1 });
        uow.add(db.stock, { warehouse: "a", sku: "2", qty: 2 });
        uow.add(db.stock, { warehouse: "b", sku: "1", qty: 3 });
        yield* uow.saveChanges();
        const rows = yield* uow.load(db.stock.orderBy((x) => [x.warehouse, x.sku]));
        rows[0]!.qty = 10;
        rows[2]!.qty = 30;
        uow.remove(rows[1]!);
        expect(yield* uow.saveChanges()).toBe(3);
        expect(Option.getOrThrow(yield* uow.find(db.stock, ["b", "1"]))).toBe(rows[2]);
      }),
    );
    expect(
      await run(db.stock.orderBy((x) => x.qty).select((x) => [x.warehouse, x.sku, x.qty])),
    ).toEqual([
      ["a", "1", 10],
      ["b", "1", 30],
    ]);
  });

  test("add then remove before saving does nothing; detach and clear forget", async () => {
    const uow = session();
    await run(
      Effect.gen(function* () {
        const added = uow.add(db.authors, { name: "X", email: "x@example.com" });
        uow.remove(added);
        const [ada, grace] = yield* uow.load(authors);
        ada!.name = "Changed";
        uow.detach(ada!);
        expect(yield* uow.saveChanges()).toBe(0);
        grace!.name = "Changed";
        uow.clear();
        expect(yield* uow.saveChanges()).toBe(0);
        expect(uow.size).toBe(0);
      }),
    );
    expect(await run(authors.select((a) => a.name))).toEqual(["Ada", "Grace", "Linus"]);
  });
});

describe("failures", () => {
  test("a failed save writes nothing and keeps the changes for a retry", async () => {
    const uow = session();
    const [ada, grace] = await run(uow.load(authors));
    const added = uow.add(db.authors, { name: "New", email: "new@example.com" });
    ada!.name = "Renamed";
    grace!.email = "ada@example.com"; // violates the unique constraint
    const failed = await exit(uow.saveChanges());
    expect(Exit.isFailure(failed) && (Cause.squash(failed.cause) as any)._tag).toBe("SqlError");
    expect(await run(db.authors.count())).toBe(3);
    expect(await run(authors.select((a) => a.name).take(1))).toEqual(["Ada"]);
    expect(uow.state(added)).toBe("added");
    expect(uow.state(ada!)).toBe("modified");

    grace!.email = "grace@example.com";
    expect(await run(uow.saveChanges())).toBe(2);
    expect(added.id).toBe(5); // the sequence moved on during the failed attempt
    expect(await run(authors.select((a) => a.name))).toEqual(["Renamed", "Grace", "Linus", "New"]);
  });

  test("a row deleted by someone else is a ConcurrencyError", async () => {
    const uow = session();
    const [, , linus] = await run(uow.load(authors));
    const [, , kernel] = await run(uow.load(books));
    await run(db.books.where((b) => b.id === 3).executeDelete());
    kernel!.title = "Renamed";
    linus!.name = "Renamed";
    const failed = await exit(uow.saveChanges());
    const error = Exit.isFailure(failed) ? Cause.squash(failed.cause) : undefined;
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject({ table: "s_books", operation: "update", expected: 1, actual: 0 });
    // the transaction was rolled back
    expect(await run(authors.select((a) => a.name).skip(2))).toEqual(["Linus"]);
  });

  test("a version column detects concurrent updates, and is incremented on save", async () => {
    const mine = session();
    const theirs = session();
    await run(
      Effect.gen(function* () {
        const a = yield* mine.first(db.accounts.where((x) => x.owner === "ada"));
        const b = yield* theirs.first(db.accounts.where((x) => x.owner === "ada"));
        a.balance += 10;
        b.balance += 5;
        expect(yield* mine.saveChanges()).toBe(1);
        expect(a.version).toBe(2);

        const stale = yield* Effect.flip(theirs.saveChanges());
        expect(stale).toBeInstanceOf(ConcurrencyError);
        expect(stale).toMatchObject({ table: "s_accounts", operation: "update" });
        expect(
          yield* Effect.flip(
            Effect.sync(() => theirs.remove(b)).pipe(Effect.andThen(theirs.saveChanges())),
          ),
        ).toBeInstanceOf(ConcurrencyError);

        // the winner keeps working with the row it holds
        a.balance += 1;
        yield* mine.saveChanges();
        expect(a.version).toBe(3);
        mine.remove(a);
        expect(yield* mine.saveChanges()).toBe(1);
      }),
    );
    expect(await run(db.accounts.select((x) => [x.owner, x.balance, x.version]))).toEqual([
      ["grace", 50, 1],
    ]);
  });

  test("retrying after a conflict: reload in a new session", async () => {
    const deposit = (amount: number) =>
      Effect.gen(function* () {
        const uow = session();
        const account = yield* uow.first(db.accounts.where((x) => x.owner === "grace"));
        yield* Effect.yieldNow;
        account.balance += amount;
        yield* uow.saveChanges();
      }).pipe(Effect.retry({ while: (error) => error instanceof ConcurrencyError }));
    await run(
      Effect.all(
        Array.from({ length: 12 }, (_, i) => deposit(i + 1)),
        { concurrency: 6 },
      ),
    );
    expect(
      await run(
        db.accounts.where((x) => x.owner === "grace").select((x) => [x.balance, x.version]),
      ),
    ).toEqual([[50 + 78, 13]]);
  });

  test("values are validated by the column schema before anything is written", async () => {
    const uow = session();
    const [ada, grace] = await run(uow.load(authors));
    grace!.name = "Renamed";
    ada!.age = 1.5;
    const failed = await exit(uow.saveChanges());
    expect(Exit.isFailure(failed) && Schema.isSchemaError(Cause.squash(failed.cause))).toBe(true);
    expect(
      await run(
        authors
          .select((a) => a.name)
          .skip(1)
          .take(1),
      ),
    ).toEqual(["Grace"]);
  });

  test("misuse is rejected with a clear message", async () => {
    const uow = session();
    const [ada] = await run(uow.load(authors));
    ada!.id = 99 as AuthorId;
    const failed = await exit(uow.saveChanges());
    const error = Exit.isFailure(failed) ? Cause.squash(failed.cause) : undefined;
    expect(error).toBeInstanceOf(LinqError);
    expect((error as Error).message).toContain("primary key");
    expect(() => uow.remove({})).toThrow(/not tracked/);
    expect(() =>
      uow.add(
        db.authors.where((a) => a.id === 1),
        { name: "x", email: "y" },
      ),
    ).toThrow(/expects a table/);
  });

  test("saves take part in an outer transaction", async () => {
    const uow = session();
    const failed = await exit(
      SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const ada = yield* uow.first(authors);
            ada.name = "Renamed";
            uow.add(db.authors, { name: "New", email: "n@example.com" });
            yield* uow.saveChanges();
            expect(yield* db.authors.count((a) => a.name === "Renamed")).toBe(1);
            return yield* Effect.fail("rollback");
          }),
        ),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(await run(authors.select((a) => a.name))).toEqual(["Ada", "Grace", "Linus"]);
  });

  test("large change sets are split to fit the parameter limit", async () => {
    const uow = session();
    for (let i = 0; i < 25_000; i++)
      uow.add(db.stock, { warehouse: `w${i % 5}`, sku: `s${i}`, qty: i });
    expect(await run(uow.saveChanges())).toBe(25_000);
    const rows = await run(uow.load(db.stock));
    expect(uow.size).toBe(25_000);
    for (const row of rows) row.qty += 1;
    expect(await run(uow.saveChanges())).toBe(25_000);
    expect(await run(db.stock.sum((x) => x.qty))).toBe((24_999 * 25_000) / 2 + 25_000);
    for (const row of rows) if (row.qty % 2 === 0) uow.remove(row);
    expect(await run(uow.saveChanges())).toBe(12_500);
    expect(await run(db.stock.count())).toBe(12_500);
  });
});
