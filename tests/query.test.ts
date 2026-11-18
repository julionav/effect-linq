import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, test } from "vite-plus/test";
import { LinqError, quote, Sql } from "../src/index.ts";
import { from } from "../src/query.ts";
import * as Table from "../src/table.ts";
import { db, PgLive, Posts, type UserId, Users } from "./schema.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(PgLive)));

const names = (query: { toArray(): Effect.Effect<Array<{ name: string }>, any, SqlClient> }) =>
  run(query.toArray()).then((rows) => rows.map((row) => row.name));

const byId = db.users.orderBy((u) => u.id);
const postsById = db.posts.orderBy((p) => p.id);

describe("filtering", () => {
  test("captured values become bind parameters", async () => {
    const minAge = 18;
    const query = byId.where((u) => u.age !== null && u.age >= minAge);
    expect(await names(query)).toEqual(["Ada", "Grace", "Margaret"]);
    const { sql, params } = query.toSql();
    expect(params).toEqual([18]);
    expect(sql).not.toContain("18");
  });

  test("values are never interpolated into SQL", async () => {
    const name = "O'Brien";
    const hostile = "'; drop table linq_test.users; --";
    expect(await names(byId.where((u) => u.name === name))).toEqual(["O'Brien"]);
    expect(await names(byId.where((u) => u.name === hostile))).toEqual([]);
    expect(await names(byId.where((u) => u.name === "O'Brien"))).toEqual(["O'Brien"]);
    expect(await run(db.users.count())).toBe(5);
  });

  test("comparisons follow JavaScript null semantics", async () => {
    expect(await names(byId.where((u) => u.age! > 30))).toEqual(["Ada", "Grace"]);
    // null !== 36 is true in JS; a plain SQL <> would drop Linus
    expect(await names(byId.where((u) => u.age !== 36))).toEqual([
      "Grace",
      "Linus",
      "Margaret",
      "O'Brien",
    ]);
    expect(await names(byId.where((u) => !(u.age === 36)))).toEqual([
      "Grace",
      "Linus",
      "Margaret",
      "O'Brien",
    ]);
    expect(await names(byId.where((u) => u.age === null))).toEqual(["Linus"]);
    expect(await names(byId.where((u) => u.age == undefined))).toEqual(["Linus"]);
    expect(await names(byId.where((u) => u.age != null))).toHaveLength(4);
    const nothing: number | null = null;
    expect(await names(byId.where((u) => u.age === nothing))).toEqual(["Linus"]);
    // two nullable columns: null === null
    expect(await names(byId.where((u) => u.age === u.managerId))).toEqual([]);
    expect(await names(byId.where((u) => u.managerId === u.manager.managerId))).toEqual(["Ada"]);
  });

  test("string methods", async () => {
    expect(await names(byId.where((u) => u.name.startsWith("A")))).toEqual(["Ada"]);
    expect(await names(byId.where((u) => u.name.endsWith("s")))).toEqual(["Linus"]);
    expect(await names(byId.where((u) => u.name.includes("a")))).toEqual([
      "Ada",
      "Grace",
      "Margaret",
    ]);
    expect(await names(byId.where((u) => u.name.toLowerCase() === "ada"))).toEqual(["Ada"]);
    expect(await names(byId.where((u) => u.name.toUpperCase().includes("RA")))).toEqual(["Grace"]);
    expect(await names(byId.where((u) => u.name.length === 5))).toEqual(["Grace", "Linus"]);
    expect(await names(byId.where((u) => u.email.startsWith(u.name.toLowerCase())))).toEqual([
      "Ada",
      "Grace",
      "Linus",
      "Margaret",
    ]);
    expect(
      await names(byId.where((u) => u.email.endsWith(u.name.toLowerCase() + "@example.com"))),
    ).toHaveLength(4);
    expect(await names(byId.where((u) => "Ada Grace".includes(u.name)))).toEqual(["Ada", "Grace"]);
    expect(
      await run(
        byId
          .select((u) => [
            u.name.substring(1, 3),
            u.name.slice(2),
            u.name.charAt(0),
            u.name.indexOf("a"),
          ])
          .first(),
      ),
    ).toEqual(["da", "a", "A", 2]);
    expect(await run(byId.select((u) => u.name.replaceAll("a", "4").padEnd(6, "*")).first())).toBe(
      "Ad4***",
    );
    expect(await run(byId.select((u) => "  x ".trim() + u.name.trim()).first())).toBe("xAda");
  });

  test("LIKE wildcards in values are escaped", async () => {
    const titles = (query: typeof postsById) =>
      run(query.toArray()).then((rows) => rows.map((row) => row.id));
    expect(await titles(postsById.where((p) => p.title.startsWith("100%")))).toEqual([5]);
    expect(await titles(postsById.where((p) => p.title.includes("_")))).toEqual([5]);
    expect(await titles(postsById.where((p) => p.title.includes("%")))).toEqual([5]);
    expect(await titles(postsById.where((p) => Sql.like(p.title, "%o_e%")))).toEqual([1]);
    expect(await titles(postsById.where((p) => Sql.ilike(p.title, "cobol%")))).toEqual([3]);
  });

  test("conditions on constants are folded away", async () => {
    const search = (filter: { name?: string; minAge?: number }) =>
      byId.where(
        (u) =>
          (filter.name === undefined || u.name === filter.name) &&
          (filter.minAge === undefined || (u.age ?? 0) >= filter.minAge),
      );
    expect(search({}).toSql().sql).not.toContain("WHERE");
    expect(search({}).toSql().params).toEqual([]);
    expect(await names(search({}))).toHaveLength(5);
    expect(await names(search({ name: "Ada" }))).toEqual(["Ada"]);
    expect(search({ name: "Ada" }).toSql().params).toEqual(["Ada"]);
    expect(await names(search({ minAge: 30 }))).toEqual(["Ada", "Grace"]);
    expect(await names(search({ name: "Ada", minAge: 40 }))).toEqual([]);
  });

  test("arrays", async () => {
    const ids = [1, 3, 99] as Array<UserId>;
    const none: Array<UserId> = [];
    expect(await names(byId.where((u) => ids.includes(u.id)))).toEqual(["Ada", "Linus"]);
    expect(byId.where((u) => ids.includes(u.id)).toSql().params).toEqual([[1, 3, 99]]);
    expect(await names(byId.where((u) => !ids.includes(u.id)))).toEqual([
      "Grace",
      "Margaret",
      "O'Brien",
    ]);
    expect(await names(byId.where((u) => none.includes(u.id)))).toEqual([]);
    expect(await names(byId.where((u) => [36, 45].includes(u.age!)))).toEqual(["Ada", "Grace"]);
    expect(await names(byId.where((u) => ids.some((id) => u.id === id)))).toEqual(["Ada", "Linus"]);
    const prefixes = ["A", "G"];
    expect(await names(byId.where((u) => prefixes.some((p) => u.name.startsWith(p))))).toEqual([
      "Ada",
      "Grace",
    ]);
    expect(
      await names(
        byId.where((u) => prefixes.every((p) => !u.name.startsWith(p.toLowerCase().toUpperCase()))),
      ),
    ).toEqual(["Linus", "Margaret", "O'Brien"]);
    expect(await names(byId.where((u) => [u.id, u.managerId].includes(2 as UserId)))).toEqual([
      "Grace",
      "Margaret",
      "O'Brien",
    ]);
    // array columns
    expect(
      await run(
        postsById
          .where((p) => p.tags.includes("math"))
          .select((p) => p.id)
          .toArray(),
      ),
    ).toEqual([1, 2]);
    expect(await run(postsById.select((p) => p.tags.length).toArray())).toEqual([2, 1, 1, 0, 2]);
  });

  test("logical operators and truthiness", async () => {
    expect(await names(byId.where((u) => u.isAdmin || u.age! < 18))).toEqual(["Ada", "O'Brien"]);
    expect(await names(byId.where((u) => !u.isAdmin && !!u.age))).toEqual([
      "Grace",
      "Margaret",
      "O'Brien",
    ]);
    expect(await names(byId.where((u) => Boolean(u.profile.bio)))).toEqual(["Ada"]);
    expect(
      await run(
        postsById
          .where((p) => !p.published)
          .select((p) => p.id)
          .toArray(),
      ),
    ).toEqual([4]);
    expect(await run(byId.select((u) => u.age || -1).toArray())).toEqual([36, 45, -1, 29, 17]);
    expect(await run(byId.select((u) => u.age ?? 0).toArray())).toEqual([36, 45, 0, 29, 17]);
    expect(await run(byId.select((u) => u.profile.bio ?? u.name).toArray())).toEqual([
      "First programmer",
      "Grace",
      "Linus",
      "Margaret",
      "O'Brien",
    ]);
  });

  test("codecs encode parameters and decode results", async () => {
    const since = DateTime.makeUnsafe("2024-03-15T00:00:00Z");
    const query = byId.where((u) => u.createdAt > since);
    expect(query.toSql().params[0]).toBeInstanceOf(Date);
    expect(await names(query)).toEqual(["Margaret", "O'Brien"]);

    const ada = await run(db.users.first((u) => u.id === 1));
    expect(ada.balance).toBe(1000.5);
    expect(DateTime.isDateTime(ada.createdAt)).toBe(true);
    expect(DateTime.formatIso(ada.createdAt)).toBe("2024-01-01T00:00:00.000Z");
    // the numeric column is compared as a number, encoded through its schema
    expect(await names(byId.where((u) => u.balance > 100))).toEqual(["Ada", "Grace"]);

    const when = new Date("2024-06-03T00:00:00Z");
    expect(
      await run(
        postsById
          .where((p) => p.createdAt < when)
          .select((p) => p.id)
          .toArray(),
      ),
    ).toEqual([1, 2]);
    expect(await run(postsById.where((p) => p.createdAt < Sql.now()).count())).toBe(5);
  });

  test("bigint columns keep their precision", async () => {
    expect(
      await run(
        postsById
          .where((p) => p.views > 100n)
          .select((p) => p.views)
          .toArray(),
      ),
    ).toEqual([9007199254740993n, 120n, 5000n]);
    expect(await run(db.posts.where((p) => p.id > 1).sum((p) => Number(p.views)))).toBe(5160);
    expect(await run(db.posts.select((p) => p.views).max())).toBe(9007199254740993n);
  });
});

describe("projection", () => {
  test("objects, tuples, nesting and constants", async () => {
    const label = "user";
    const rows = await run(
      byId
        .take(2)
        .select((u) => ({
          id: u.id,
          label,
          contact: { name: u.name, email: u.email },
          pair: [u.id, u.name.toUpperCase()],
          missing: null,
        }))
        .toArray(),
    );
    expect(rows).toEqual([
      {
        id: 1,
        label: "user",
        contact: { name: "Ada", email: "ada@example.com" },
        pair: [1, "ADA"],
        missing: null,
      },
      {
        id: 2,
        label: "user",
        contact: { name: "Grace", email: "grace@example.com" },
        pair: [2, "GRACE"],
        missing: null,
      },
    ]);
  });

  test("whole rows, spreads and destructuring", async () => {
    const row = await run(db.posts.where((p) => p.id === 3).first());
    expect(row).toEqual({
      id: 3,
      authorId: 2,
      title: "COBOL tips",
      body: "body three",
      views: 40n,
      published: true,
      tags: ["cobol"],
      meta: { featured: false },
      createdAt: new Date("2024-06-03T10:00:00Z"),
    });
    const spread = await run(
      db.comments
        .where((c) => c.id === 1)
        .select((c) => ({ ...c, shout: c.body.toUpperCase(), ...{ extra: 1 } }))
        .first(),
    );
    expect(spread).toMatchObject({ id: 1, body: "Brilliant", shout: "BRILLIANT", extra: 1 });
    expect(
      await run(
        byId
          .select(({ id, name }) => ({ id, name }))
          .select(({ name }) => name)
          .first(),
      ),
    ).toBe("Ada");
  });

  test("arithmetic, templates and conditionals", async () => {
    expect(await run(byId.select((u) => (u.age ?? 0) * 2 + 1).toArray())).toEqual([
      73, 91, 1, 59, 35,
    ]);
    expect(await run(byId.select((u) => [u.id / 2, u.id % 2, -u.id]).first())).toEqual([
      0.5, 1, -1,
    ]);
    expect(
      await run(byId.select((u) => Math.round(u.balance) + Math.abs(-u.id)).toArray()),
    ).toEqual([1002, 252, 3, 79, 5]);
    expect(await run(byId.select((u) => Math.round(u.id / 2)).toArray())).toEqual([1, 1, 2, 2, 3]);
    expect(
      await run(byId.select((u) => `${u.name} <${u.email}> #${u.id} ${u.age}`).toArray()),
    ).toEqual([
      "Ada <ada@example.com> #1 36",
      "Grace <grace@example.com> #2 45",
      // like JavaScript, null prints as "null"; write `${u.age ?? ""}` to avoid it
      "Linus <linus@example.com> #3 null",
      "Margaret <margaret@example.com> #4 29",
      "O'Brien <obrien@example.com> #5 17",
    ]);
    expect(await run(byId.select((u) => u.name + "!" + u.id).first())).toBe("Ada!1");
    expect(
      await run(
        byId
          .select((u) => (u.age === null ? "unknown" : u.age >= 18 ? "adult" : "minor"))
          .toArray(),
      ),
    ).toEqual(["adult", "adult", "unknown", "adult", "minor"]);
    expect(await run(byId.select((u) => u.age! > 30).toArray())).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(await run(byId.select((u) => u.balance.toFixed(1)).first())).toBe("1000.5");
  });

  test("dates", async () => {
    const row = await run(
      postsById
        .select((p) => ({
          year: p.createdAt.getUTCFullYear(),
          month: p.createdAt.getUTCMonth(),
          day: p.createdAt.getUTCDate(),
          hour: p.createdAt.getUTCHours(),
          time: p.createdAt.getTime(),
          iso: p.createdAt.toISOString(),
        }))
        .first(),
    );
    const date = new Date("2024-06-01T10:00:00Z");
    expect(row).toEqual({
      year: 2024,
      month: 5,
      day: 1,
      hour: 10,
      time: date.getTime(),
      iso: date.toISOString(),
    });
    const start = new Date("2024-06-01T10:00:00Z");
    expect(
      await run(
        postsById
          .select((p) => p.createdAt.getTime() - start.getTime())
          .take(2)
          .toArray(),
      ),
    ).toEqual([0, 86_400_000]);
  });

  test("custom SQL functions", async () => {
    const initcap = Sql.fn<[text: string], string>("initcap", "string");
    const md5 = Sql.fn<[text: string], string>("md5", "string");
    expect(await run(byId.select((u) => initcap(u.email)).first())).toBe("Ada@Example.Com");
    expect(await names(byId.where((u) => md5(u.name) === md5("Ada")))).toEqual(["Ada"]);
    expect(await names(byId.where((u) => Sql.like(u.name, initcap("a%"))))).toEqual(["Ada"]);
  });
});

describe("ordering and paging", () => {
  test("orderBy, thenBy, take, skip", async () => {
    expect(await names(db.users.orderByDescending((u) => u.name))).toEqual([
      "O'Brien",
      "Margaret",
      "Linus",
      "Grace",
      "Ada",
    ]);
    expect(
      await names(db.users.orderByDescending((u) => u.managerId ?? 0).thenBy((u) => u.name)),
    ).toEqual(["Margaret", "O'Brien", "Grace", "Linus", "Ada"]);
    expect(
      await names(
        db.users.orderBy((u) => [u.isAdmin, u.name.length]).thenByDescending((u) => u.id),
      ),
    ).toEqual(["Linus", "Grace", "O'Brien", "Margaret", "Ada"]);
    expect(await names(byId.skip(1).take(2))).toEqual(["Grace", "Linus"]);
    const page = (n: number, size: number) => byId.skip(n * size).take(size);
    expect(await names(page(2, 2))).toEqual(["O'Brien"]);
  });

  test("operators after take apply to the limited rows", async () => {
    expect(await names(byId.take(3).where((u) => u.age === null))).toEqual(["Linus"]);
    expect(await names(byId.take(3).orderByDescending((u) => u.id))).toEqual([
      "Linus",
      "Grace",
      "Ada",
    ]);
    expect(await names(byId.take(4).skip(1).take(2))).toEqual(["Grace", "Linus"]);
    expect(await run(byId.take(2).count())).toBe(2);
    expect(
      await run(
        byId
          .skip(1)
          .take(3)
          .sum((u) => u.age ?? 0),
      ),
    ).toBe(74);
    expect(
      await names(
        byId
          .take(3)
          .where((u) => u.posts.any())
          .select((u) => ({ name: u.manager.name ?? "-" })),
      ),
    ).toEqual(["-", "Ada", "Ada"]);
  });

  test("distinct", async () => {
    expect(
      await run(
        db.posts
          .select((p) => p.authorId)
          .distinct()
          .orderBy((id) => id)
          .toArray(),
      ),
    ).toEqual([1, 2, 3]);
    expect(
      await run(
        db.posts
          .select((p) => p.authorId)
          .distinct()
          .count(),
      ),
    ).toBe(3);
    expect(
      await run(
        db.comments
          .select((c) => c.post.author.name)
          .distinct()
          .orderByDescending((n) => n)
          .take(2)
          .toArray(),
      ),
    ).toEqual(["Linus", "Grace"]);
  });

  test("first and firstOption", async () => {
    expect((await run(byId.first())).name).toBe("Ada");
    expect((await run(db.users.first((u) => u.name === "Grace"))).id).toBe(2);
    expect(await run(db.users.where((u) => u.id === 99).firstOption())).toEqual(Option.none());
    expect(Option.isSome(await run(byId.firstOption()))).toBe(true);
    const exit = await run(Effect.exit(db.users.first((u) => u.id === 99)));
    expect(Exit.isFailure(exit) && Cause.isNoSuchElementError(Cause.squash(exit.cause))).toBe(true);
  });
});

describe("aggregates", () => {
  test("count, any, all, sum, min, max, average", async () => {
    expect(await run(db.users.count())).toBe(5);
    expect(await run(db.users.count((u) => u.age !== null && u.age >= 18))).toBe(3);
    expect(await run(db.users.any())).toBe(true);
    expect(await run(db.users.any((u) => u.name === "Nobody"))).toBe(false);
    expect(await run(db.users.all((u) => u.email.endsWith("@example.com")))).toBe(true);
    // all() over a nullable column: null >= 18 counts as false
    expect(await run(db.users.all((u) => u.age! >= 17))).toBe(false);
    expect(await run(db.users.where((u) => u.age !== null).all((u) => u.age! >= 17))).toBe(true);
    expect(await run(db.users.sum((u) => u.age))).toBe(127);
    expect(await run(db.users.where((u) => u.id > 99).sum((u) => u.age))).toBe(0);
    expect(await run(db.users.select((u) => u.age).min())).toBe(17);
    expect(await run(db.users.max((u) => u.balance))).toBe(1000.5);
    expect(await run(db.users.average((u) => u.age))).toBe(31.75);
    expect(await run(db.users.where((u) => u.id > 99).average((u) => u.age))).toBe(null);
    const newest = await run(db.users.max((u) => u.createdAt));
    expect(DateTime.formatIso(newest!)).toBe("2024-05-01T00:00:00.000Z");
  });
});

describe("relations", () => {
  test("to-one in filters and projections", async () => {
    expect(
      await run(
        postsById
          .where((p) => p.author.name === "Ada")
          .select((p) => p.id)
          .toArray(),
      ),
    ).toEqual([1, 2]);
    const query = postsById
      .where((p) => p.author.isAdmin)
      .select((p) => ({ title: p.title, by: p.author.name, email: p.author.email }));
    expect(await run(query.toArray())).toEqual([
      { title: "Notes on the Engine", by: "Ada", email: "ada@example.com" },
      { title: "Bernoulli numbers", by: "Ada", email: "ada@example.com" },
    ]);
    // one join, however often the relation is used
    expect(query.toSql().sql.match(/JOIN/g)).toHaveLength(1);
    expect(
      await run(
        db.comments
          .orderBy((c) => c.id)
          .where((c) => c.post.author.name === "Linus")
          .select((c) => `${c.author.name} on ${c.post.title}`)
          .toArray(),
      ),
    ).toEqual(["Ada on 100% kernel_stuff", "Margaret on 100% kernel_stuff"]);
    const withAuthor = await run(
      db.posts
        .where((p) => p.id === 5)
        .select((p) => ({ id: p.id, author: p.author }))
        .first(),
    );
    expect(withAuthor.author.name).toBe("Linus");
    expect(withAuthor.author.age).toBe(null);
    expect(DateTime.isDateTime(withAuthor.author.createdAt)).toBe(true);
  });

  test("optional relations read as null", async () => {
    expect(
      await run(
        byId
          .select((u) => ({
            name: u.name,
            bio: u.profile.bio,
            boss: u.manager.name,
            grandBoss: u.manager.manager.name,
          }))
          .toArray(),
      ),
    ).toEqual([
      { name: "Ada", bio: "First programmer", boss: null, grandBoss: null },
      { name: "Grace", bio: null, boss: "Ada", grandBoss: null },
      { name: "Linus", bio: null, boss: "Ada", grandBoss: null },
      { name: "Margaret", bio: null, boss: "Grace", grandBoss: "Ada" },
      { name: "O'Brien", bio: null, boss: "Grace", grandBoss: "Ada" },
    ]);
    expect(await names(byId.where((u) => u.manager === null))).toEqual(["Ada"]);
    expect(await names(byId.where((u) => u.profile !== null))).toEqual(["Ada", "Grace"]);
    // absent rows compare equal to each other, like null === null
    expect(await names(byId.where((u) => u.manager.manager === u.manager.manager.manager))).toEqual(
      ["Ada", "Grace", "Linus"],
    );
    expect(await names(byId.where((u) => u.manager !== u.manager.manager))).toEqual([
      "Grace",
      "Linus",
      "Margaret",
      "O'Brien",
    ]);
    const rows = await run(
      byId
        .take(3)
        .select((u) => ({ name: u.name, manager: u.manager, profile: u.profile }))
        .toArray(),
    );
    expect(rows[0]!.manager).toBe(null);
    expect(rows[0]!.profile).toEqual({
      userId: 1,
      bio: "First programmer",
      avatar: new Uint8Array([1, 2, 255]),
    });
    expect(rows[1]!.manager!.name).toBe("Ada");
    expect(rows[1]!.profile).toEqual({ userId: 2, bio: null, avatar: null });
    expect(rows[2]!.profile).toBe(null);
  });

  test("to-many in filters", async () => {
    expect(await names(byId.where((u) => u.posts.some((p) => p.published)))).toEqual([
      "Ada",
      "Grace",
      "Linus",
    ]);
    expect(await names(byId.where((u) => u.posts.any()))).toEqual(["Ada", "Grace", "Linus"]);
    expect(await names(byId.where((u) => u.posts.length === 0))).toEqual(["Margaret", "O'Brien"]);
    expect(await names(byId.where((u) => !u.posts.any()))).toEqual(["Margaret", "O'Brien"]);
    expect(await names(byId.where((u) => u.posts.every((p) => p.published)))).toEqual([
      "Ada",
      "Linus",
      "Margaret",
      "O'Brien",
    ]);
    expect(await names(byId.where((u) => u.posts.count((p) => p.published) >= 2))).toEqual(["Ada"]);
    expect(
      await names(
        byId.where((u) =>
          u.posts.some((p) => p.comments.some((c) => c.author.name === "Margaret")),
        ),
      ),
    ).toEqual(["Linus"]);
    expect(
      await names(
        byId.where((u) => u.posts.some((p) => p.comments.some((c) => c.authorId === u.managerId))),
      ),
    ).toEqual(["Grace", "Linus"]);
    expect(await names(byId.where((u) => u.comments.select((c) => c.postId).includes(5)))).toEqual([
      "Ada",
      "Margaret",
    ]);
    expect(await names(byId.where((u) => u.reports.count() > 1))).toEqual(["Ada", "Grace"]);
  });

  test("aggregates over relations", async () => {
    expect(
      await run(
        byId
          .select((u) => ({
            name: u.name,
            posts: u.posts.length,
            published: u.posts.where((p) => p.published).count(),
            views: u.posts.sum((p) => Number(p.views)),
            topScore: u.posts.selectMany((p) => p.comments).max((c) => c.score),
            lastPost: u.posts.max((p) => p.createdAt),
            avgScore: u.comments.average((c) => c.score),
          }))
          .skip(1)
          .toArray(),
      ),
    ).toEqual([
      {
        name: "Grace",
        posts: 2,
        published: 1,
        views: 40,
        topScore: 2,
        lastPost: new Date("2024-06-04T10:00:00Z"),
        avgScore: 4,
      },
      {
        name: "Linus",
        posts: 1,
        published: 1,
        views: 5000,
        topScore: 7,
        lastPost: new Date("2024-06-05T10:00:00Z"),
        avgScore: -1,
      },
      {
        name: "Margaret",
        posts: 0,
        published: 0,
        views: 0,
        topScore: null,
        lastPost: null,
        avgScore: 1,
      },
      {
        name: "O'Brien",
        posts: 0,
        published: 0,
        views: 0,
        topScore: null,
        lastPost: null,
        avgScore: null,
      },
    ]);
    expect(
      await names(
        db.users
          .orderByDescending((u) => u.posts.count())
          .thenBy((u) => u.id)
          .take(2),
      ),
    ).toEqual(["Ada", "Grace"]);
  });

  test("nested collections are loaded in one query", async () => {
    const query = byId
      .where((u) => u.id <= 2)
      .select((u) => ({
        name: u.name,
        posts: u.posts
          .where((p) => p.published)
          .orderByDescending((p) => p.id)
          .select((p) => ({
            title: p.title,
            views: p.views,
            at: p.createdAt,
            comments: p.comments
              .orderBy((c) => c.id)
              .select((c) => ({ body: c.body, by: c.author.name })),
          })),
      }));
    expect(query.toSql().sql.match(/^SELECT/g)).toHaveLength(1);
    expect(await run(query.toArray())).toEqual([
      {
        name: "Ada",
        posts: [
          {
            title: "Bernoulli numbers",
            views: 120n,
            at: new Date("2024-06-02T10:00:00Z"),
            comments: [{ body: "Checked the math", by: "Grace" }],
          },
          {
            title: "Notes on the Engine",
            views: 9007199254740993n,
            at: new Date("2024-06-01T10:00:00Z"),
            comments: [
              { body: "Brilliant", by: "Grace" },
              { body: "Needs a kernel", by: "Linus" },
            ],
          },
        ],
      },
      {
        name: "Grace",
        posts: [
          {
            title: "COBOL tips",
            views: 40n,
            at: new Date("2024-06-03T10:00:00Z"),
            comments: [{ body: "Nice", by: "Ada" }],
          },
        ],
      },
    ]);
  });

  test("nested collections of scalars, rows and optional rows", async () => {
    const rows = await run(
      byId
        .where((u) => u.id === 1 || u.id === 5)
        .select((u) => ({
          titles: u.posts.orderBy((p) => p.id).select((p) => p.title),
          posts: u.posts.orderBy((p) => p.id).take(1),
          reports: u.reports
            .orderBy((r) => r.id)
            .select((r) => ({ who: r, profile: r.profile, joined: r.createdAt })),
        }))
        .toArray(),
    );
    expect(rows[1]).toEqual({ titles: [], posts: [], reports: [] });
    expect(rows[0]!.titles).toEqual(["Notes on the Engine", "Bernoulli numbers"]);
    expect(rows[0]!.posts).toEqual([
      {
        id: 1,
        authorId: 1,
        title: "Notes on the Engine",
        body: "body one",
        views: 9007199254740993n,
        published: true,
        tags: ["math", "engine"],
        meta: { featured: true, rank: 1 },
        createdAt: new Date("2024-06-01T10:00:00Z"),
      },
    ]);
    const [grace, linus] = rows[0]!.reports;
    expect(grace!.who.balance).toBe(250);
    expect(DateTime.formatIso(grace!.who.createdAt)).toBe("2024-02-01T00:00:00.000Z");
    expect(DateTime.formatIso(grace!.joined)).toBe("2024-02-01T00:00:00.000Z");
    expect(grace!.profile).toEqual({ userId: 2, bio: null, avatar: null });
    expect(linus!.profile).toBe(null);
  });

  test("include", async () => {
    const ada = await run(
      db.users
        .include("posts")
        .include("profile")
        .include("manager")
        .first((u) => u.id === 1),
    );
    expect(ada.posts.map((p) => p.title).sort()).toEqual([
      "Bernoulli numbers",
      "Notes on the Engine",
    ]);
    expect(ada.profile!.avatar).toEqual(new Uint8Array([1, 2, 255]));
    expect(ada.manager).toBe(null);
    const post = await run(
      db.posts
        .include("author")
        .include("comments")
        .where((p) => p.id === 5)
        .first(),
    );
    expect(post.author.name).toBe("Linus");
    expect(post.comments).toHaveLength(2);
    // without include, relations are not part of the row
    expect(Object.keys(await run(db.posts.first()))).not.toContain("author");
    // include survives paging
    const paged = await run(
      byId
        .include("posts")
        .skip(1)
        .take(1)
        .where((u) => u.id > 0)
        .toArray(),
    );
    expect(paged[0]!.posts).toHaveLength(2);
  });

  test("first inside a lambda", async () => {
    expect(
      await run(
        byId
          .select((u) => ({
            name: u.name,
            latest: u.posts.orderByDescending((p) => p.createdAt).first().title,
            firstTitle: u.posts
              .orderBy((p) => p.id)
              .select((p) => p.title)
              .first(),
            latestPost: u.posts
              .orderByDescending((p) => p.createdAt)
              .select((p) => ({ id: p.id, views: p.views }))
              .first(),
          }))
          .where((x) => x.name !== "Grace")
          .take(3)
          .toArray(),
      ),
    ).toEqual([
      {
        name: "Ada",
        latest: "Bernoulli numbers",
        firstTitle: "Notes on the Engine",
        latestPost: { id: 2, views: 120n },
      },
      {
        name: "Linus",
        latest: "100% kernel_stuff",
        firstTitle: "100% kernel_stuff",
        latestPost: { id: 5, views: 5000n },
      },
      { name: "Margaret", latest: null, firstTitle: null, latestPost: null },
    ]);
  });

  test("selectMany", async () => {
    expect(
      await run(
        db.users
          .where((u) => u.id === 1)
          .selectMany((u) => u.posts)
          .orderBy((p) => p.id)
          .select((p) => p.title)
          .toArray(),
      ),
    ).toEqual(["Notes on the Engine", "Bernoulli numbers"]);
    expect(
      await run(
        db.users
          .selectMany(
            (u) => u.posts.where((p) => p.published && p.author.age !== null),
            (u, p) => ({ user: u.name, title: p.title, comments: p.comments.count() }),
          )
          .orderBy((x) => x.title)
          .toArray(),
      ),
    ).toEqual([
      { user: "Ada", title: "Bernoulli numbers", comments: 1 },
      { user: "Grace", title: "COBOL tips", comments: 1 },
      { user: "Ada", title: "Notes on the Engine", comments: 2 },
    ]);
    // a limited inner collection needs a lateral join
    expect(
      await run(
        byId
          .selectMany(
            (u) => u.posts.orderByDescending((p) => p.id).take(1),
            (u, p) => `${u.name}: ${p.title}`,
          )
          .toArray(),
      ),
    ).toEqual(["Ada: Bernoulli numbers", "Grace: Draft: bugs", "Linus: 100% kernel_stuff"]);
    expect(
      await run(
        db.users
          .selectMany((u) => u.posts)
          .selectMany((p) => p.comments)
          .count(),
      ),
    ).toBe(6);
  });
});

describe("grouping and joins", () => {
  test("groupBy with aggregates", async () => {
    expect(
      await run(
        db.posts
          .groupBy((p) => p.authorId)
          .select((g) => ({
            author: g.key,
            posts: g.count(),
            published: g.count((p) => p.published),
            drafts: g.where((p) => !p.published).count(),
            views: g.sum((p) => Number(p.views)),
            maxViews: g.max((p) => p.views),
            last: g.max((p) => p.createdAt),
            titles: g.select((p) => p.title.length).average(),
            anyDraft: g.some((p) => !p.published),
            allPublished: g.every((p) => p.published),
          }))
          .orderBy((x) => x.author)
          .skip(1)
          .toArray(),
      ),
    ).toEqual([
      {
        author: 2,
        posts: 2,
        published: 1,
        drafts: 1,
        views: 40,
        maxViews: 40n,
        last: new Date("2024-06-04T10:00:00Z"),
        titles: 10.5,
        anyDraft: true,
        allPublished: false,
      },
      {
        author: 3,
        posts: 1,
        published: 1,
        drafts: 0,
        views: 5000,
        maxViews: 5000n,
        last: new Date("2024-06-05T10:00:00Z"),
        titles: 17,
        anyDraft: false,
        allPublished: true,
      },
    ]);
  });

  test("having, ordering by aggregates, composite and relation keys", async () => {
    expect(
      await run(
        db.comments
          .groupBy((c) => c.post.author.name)
          .where((g) => g.count() > 1)
          .orderByDescending((g) => g.sum((c) => c.score))
          .select((g) => ({ author: g.key, comments: g.count(), score: g.sum((c) => c.score) }))
          .toArray(),
      ),
    ).toEqual([
      { author: "Linus", comments: 2, score: 8 },
      { author: "Ada", comments: 3, score: 7 },
    ]);
    expect(
      await run(
        db.posts
          .groupBy((p) => ({ author: p.author.name, published: p.published }))
          .select((g) => ({ ...g.key, n: g.count() }))
          .where((x) => x.n > 1)
          .toArray(),
      ),
    ).toEqual([{ author: "Ada", published: true, n: 2 }]);
    expect(
      await run(
        db.users
          .groupBy((u) => u.managerId)
          .select((g) => ({
            manager: g.key,
            ages: g
              .select((u) => u.age)
              .distinct()
              .count(),
            n: g.length,
          }))
          .orderBy((x) => x.manager ?? 0)
          .toArray(),
      ),
    ).toEqual([
      { manager: null, ages: 1, n: 1 },
      { manager: 1, ages: 1, n: 2 },
      { manager: 2, ages: 2, n: 2 },
    ]);
    expect(
      await run(
        db.posts
          .groupBy((p) => p.authorId)
          .select((g) => g.count())
          .max(),
      ),
    ).toBe(2);
    expect(
      await run(
        db.posts
          .take(4)
          .groupBy((p) => p.published)
          .select((g) => g.key)
          .count(),
      ),
    ).toBe(2);
  });

  test("join and leftJoin", async () => {
    expect(
      await run(
        db.users
          .join(
            db.posts,
            (u, p) => p.authorId === u.id,
            (u, p) => ({ user: u.name, post: p.title, boss: u.manager.name }),
          )
          .where((x) => x.post.includes("o"))
          .orderBy((x) => x.post)
          .toArray(),
      ),
    ).toEqual([
      { user: "Ada", post: "Bernoulli numbers", boss: null },
      { user: "Ada", post: "Notes on the Engine", boss: null },
    ]);
    const left = await run(
      byId
        .leftJoin(
          db.posts.where((p) => !p.published),
          (u, p) => p.authorId === u.id,
          (u, p) => ({ name: u.name, draft: p.title, post: p, hasDraft: p !== null }),
        )
        .where((x) => x.name.length === 5)
        .toArray(),
    );
    expect(left.map((x) => [x.name, x.draft, x.hasDraft])).toEqual([
      ["Grace", "Draft: bugs", true],
      ["Linus", null, false],
    ]);
    expect(left[0]!.post!.views).toBe(0n);
    expect(left[1]!.post).toBe(null);
    // joining an aggregated query
    const counts = db.comments
      .groupBy((c) => c.authorId)
      .select((g) => ({ authorId: g.key, n: g.count() }));
    expect(
      await run(
        byId
          .join(
            counts,
            (u, c) => c.authorId === u.id,
            (u, c) => [u.name, c.n],
          )
          .toArray(),
      ),
    ).toEqual([
      ["Ada", 2],
      ["Grace", 2],
      ["Linus", 1],
      ["Margaret", 1],
    ]);
  });

  test("subqueries", async () => {
    const authors = db.posts.where((p) => p.published).select((p) => p.authorId);
    expect(await names(byId.where((u) => authors.asMany().includes(u.id)))).toEqual([
      "Ada",
      "Grace",
      "Linus",
    ]);
    expect(
      await names(
        byId.where(
          (u) =>
            db.comments
              .asMany()
              .where((c) => c.authorId === u.id)
              .count() >= 2,
        ),
      ),
    ).toEqual(["Ada", "Grace"]);
    expect(
      await names(
        byId.where((u) => db.comments.asMany().any((c) => c.authorId === u.id && c.score < 0)),
      ),
    ).toEqual(["Linus"]);
    const maxAge = db.users.select((u) => u.age);
    expect(await names(byId.where((u) => u.age === maxAge.asMany().max()))).toEqual(["Grace"]);
    // the result of a terminal operator on another query is a scalar subquery
    const total = await run(
      db.users
        .where((u) => u.id === 1)
        .select((u) => ({ name: u.name, users: db.users.asMany().count() }))
        .first(),
    );
    expect(total).toEqual({ name: "Ada", users: 5 });
  });
});

describe("composition", () => {
  test("queries are immutable values", async () => {
    const adults = db.users.where((u) => (u.age ?? 0) >= 18);
    const admins = adults.where((u) => u.isAdmin);
    expect(await run(adults.count())).toBe(3);
    expect(await run(admins.count())).toBe(1);
    expect(await run(adults.count())).toBe(3);
  });

  test("quote() makes reusable expressions", async () => {
    const isAdult = quote((u: { readonly age: number | null }) => u.age !== null && u.age >= 18);
    expect(await names(byId.where(isAdult))).toEqual(["Ada", "Grace", "Margaret"]);
    expect(await run(db.users.count(isAdult))).toBe(3);
    const byNewest = quote((p: { readonly createdAt: Date }) => p.createdAt);
    expect((await run(db.posts.orderByDescending(byNewest).first())).id).toBe(5);
  });

  test("captured values are read when the query runs", async () => {
    let wanted = "Ada";
    const query = byId.where((u) => u.name === wanted);
    wanted = "Grace";
    expect(await names(query)).toEqual(["Grace"]);
  });

  test("from() queries a table without relations", async () => {
    expect(
      await run(
        from(Users)
          .where((u) => u.isAdmin)
          .select((u) => u.name)
          .toArray(),
      ),
    ).toEqual(["Ada"]);
    expect(await run(from(Posts).count((p) => p.published))).toBe(4);
  });

  test("yield* runs a query, inside transactions too", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`update linq_test.users set name = 'Changed' where id = 1`;
            const inside = yield* db.users.where((u) => u.id === 1).select((u) => u.name);
            yield* sql`update linq_test.users set name = 'Ada' where id = 1`;
            return inside;
          }),
        );
      }),
    );
    expect(result).toEqual(["Changed"]);
  });
});

describe("errors", () => {
  test("untranslatable constructs die with a located LinqError", async () => {
    const query = db.users.where((u) => u.name.normalize() === "x");
    expect(() => query.toSql()).toThrow(
      /\.normalize\(\) cannot be translated to SQL[\s\S]*tests\/query\.test\.ts:\d+:\d+/,
    );
    const exit = await run(Effect.exit(query.toArray()));
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(LinqError);
    expect(() => db.users.select((u) => u.posts.select((p) => (p as any).nope)).toSql()).toThrow(
      /"nope" is not a column or relation of "posts"/,
    );
    expect(() => db.users.groupBy((u) => u.age).toSql()).toThrow(
      /groupBy must be followed by select/,
    );
    expect(() => db.users.where((u) => (u.posts as any) === 1).toSql()).toThrow(LinqError);
  });

  test("functions that were not compiled are rejected immediately", () => {
    const predicate = (u: { readonly id: number }) => u.id === 1;
    expect(() => db.users.where(predicate)).toThrow(/was not compiled to an expression tree/);
  });

  test("statements in a lambda are reported when it is used", () => {
    expect(() =>
      db.users.where((u) => {
        const limit = 3;
        return u.id < limit;
      }),
    ).not.toThrow();
    expect(() =>
      db.users
        .where((u) => {
          const limit = 3;
          return u.id < limit;
        })
        .toSql(),
    ).toThrow(/must be a single expression/);
  });

  test("schema mismatches fail with a typed SchemaError", async () => {
    // `name` is text, so decoding it as a number must fail
    const Wrong = Table.make(
      "users",
      { id: Schema.Number, name: Schema.FiniteFromString },
      { schema: "linq_test" },
    );
    const exit = await run(Effect.exit(from(Wrong).toArray()));
    expect(Exit.isFailure(exit) && Schema.isSchemaError(Cause.squash(exit.cause))).toBe(true);
    const caught = await run(
      from(Wrong)
        .toArray()
        .pipe(Effect.catchTag("SchemaError", () => Effect.succeed("recovered"))),
    );
    expect(caught).toBe("recovered");
  });
});
