import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, test } from "vite-plus/test";
import { compile } from "../src/compiler.ts";
import { LinqError } from "../src/index.ts";
import { db, PgLive } from "./schema.ts";
import {
  displayName,
  isActiveAuthor,
  isAdult,
  newest,
  olderThan,
  page,
  type Post,
  postsByAuthor,
  postSummary,
  published,
  publishedPosts,
  titleContains,
  type User,
} from "./shared/queries.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient> | { toArray(): Effect.Effect<A, E, SqlClient> },
): Promise<A> =>
  Effect.runPromise(("toArray" in effect ? effect.toArray() : effect).pipe(Effect.provide(PgLive)));

const byId = db.users.orderBy((u) => u.id);

// Module-level helpers in the file that uses them need no quote(): the build
// step finds them by name.
const isMinor = (u: User) => u.age !== null && u.age < 18;
const initial = (u: User) => u.name.charAt(0);
const popular = (p: Post, threshold: bigint) => p.views >= threshold;
const popularPosts = (u: User, threshold: bigint) => u.posts.where((p) => popular(p, threshold));
// not a query expression: only ever called with plain values
const double = (n: number) => {
  const twice = n * 2;
  return twice;
};

describe("sharing expressions", () => {
  test("imported expressions, passed to operators", async () => {
    expect(await run(byId.where(isAdult).select((u) => u.name))).toEqual([
      "Ada",
      "Grace",
      "Margaret",
    ]);
    expect(await run(db.users.count(isAdult))).toBe(3);
    expect(await run(byId.select(displayName).take(1))).toEqual(["Ada <ada@example.com>"]);
    expect(await run(db.posts.where(titleContains("NUMBERS")).select((p) => p.id))).toEqual([2]);
  });

  test("imported expressions, called inside a lambda", async () => {
    const min = 30;
    expect(
      await run(byId.where((u) => olderThan(u, min) && !u.isAdmin).select((u) => u.name)),
    ).toEqual(["Grace"]);
    expect(
      await run(byId.where((u) => isActiveAuthor(u, 100n)).select((u) => displayName(u))),
    ).toEqual(["Ada <ada@example.com>"]);
    // on a related row, and returning a collection
    const rows = await run(
      db.posts
        .where((p) => isAdult(p.author) && p.id <= 3)
        .orderBy((p) => p.id)
        .select((p) => ({ ...postSummary(p), others: publishedPosts(p.author).count() - 1 })),
    );
    expect(rows).toEqual([
      { id: 1, title: "Notes on the Engine", by: "Ada <ada@example.com>", comments: 2, others: 1 },
      { id: 2, title: "Bernoulli numbers", by: "Ada <ada@example.com>", comments: 1, others: 1 },
      { id: 3, title: "COBOL tips", by: "Grace <grace@example.com>", comments: 1, others: 0 },
    ]);
  });

  test("a shared expression is still one SQL statement, with its arguments as parameters", () => {
    const { sql, params } = db.users.where((u) => isActiveAuthor(u, 100n)).toSql();
    expect(sql.match(/SELECT/g)!.length).toBe(2);
    expect(sql).toContain("EXISTS");
    expect(params).toEqual([100n]);
  });

  test("same-file helpers need no quote()", async () => {
    expect(await run(byId.where(isMinor).select((u) => u.name))).toEqual(["O'Brien"]);
    expect(
      await run(
        byId
          .where((u) => !isMinor(u) && popularPosts(u, 1000n).some())
          .select((u) => [initial(u), popularPosts(u, BigInt(double(60))).count()]),
      ),
    ).toEqual([
      ["A", 2],
      ["L", 1],
    ]);
  });

  test("shared expressions are also the original functions", () => {
    expect(isAdult({ age: 20 } as User)).toBe(true);
    expect(olderThan({ age: 20 } as User, 30)).toBe(false);
    expect(isMinor({ age: 3 } as User)).toBe(true);
  });

  test("a helper from another file that was not quoted is reported when used", () => {
    const plain = new Function("return (u) => u.age > 1")() as (u: User) => boolean;
    expect(() => db.users.where((u) => plain(u)).toSql()).toThrow(/not a query expression/);
    expect(() => db.users.where(plain)).toThrow(LinqError);
  });
});

describe("sharing queries", () => {
  test("query -> query functions compose with pipe", async () => {
    const rows = await run(db.posts.pipe(published, newest(2)).select((p) => postSummary(p).title));
    expect(rows).toEqual(["100% kernel_stuff", "COBOL tips"]);
    expect(await run(db.users.pipe(page(1, 2)).select((u) => u.id))).toEqual([3, 4]);
    expect(await run(db.posts.pipe(published, page(0, 3)).select((p) => p.id))).toEqual([1, 2, 3]);
  });

  test("parameterized queries are functions; the result stays composable", async () => {
    expect(await run(postsByAuthor(2 as User["id"]).select((p) => p.title))).toEqual([
      "COBOL tips",
    ]);
    expect(
      await run(
        postsByAuthor(1 as User["id"])
          .pipe(newest(1))
          .count(),
      ),
    ).toBe(1);
  });

  test("shared functions keep the query writable", () => {
    const { sql } = db.posts
      .pipe(published)
      .where((p) => p.id === -1)
      .executeUpdate({ title: "x" })
      .toSql();
    expect(sql).toContain('UPDATE "linq_test"."posts"');
  });
});

describe("the build step and helpers", () => {
  const sitesOf = (source: string) => compile(source, "/app/f.ts", { sourceMap: false });

  test("helpers referenced by name are compiled; unrelated functions are left alone", () => {
    const result = sitesOf(`
      const isAdult = (u) => u.age >= 18;
      const unrelated = (x) => x + 1;
      export const q = db.users.where(isAdult);
    `)!;
    expect(result.sites).toBe(1);
    expect(result.code).toContain("const isAdult = __linq_q((u) => u.age >= 18");
    expect(result.code).toContain("const unrelated = (x) => x + 1;");
  });

  test("helpers called inside lambdas are compiled, transitively", () => {
    const result = sitesOf(`
      const inner = (p) => p.published;
      export const outer = (u) => u.posts.where((p) => inner(p));
      export const q = db.users.where((u) => outer(u).some());
    `)!;
    expect(result.sites).toBe(4);
    expect(result.diagnostics).toEqual([]);
  });

  test("a shadowed or rebound name is not treated as the helper", () => {
    const result = sitesOf(`
      const check = (u) => u.age >= 18;
      export const f = (check) => db.users.where(check);
    `);
    expect(result).toBeNull();
  });

  test("helpers that cannot be SQL are not reported at build time", () => {
    const result = sitesOf(`
      const compute = (n) => { let x = n; x += 1; return x; };
      export const q = db.users.where((u) => u.id === compute(3));
    `)!;
    expect(result.diagnostics).toEqual([]);
    expect(result.sites).toBe(2);
  });
});
