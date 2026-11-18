/**
 * The generated SQL, pinned. These snapshots are the place to review what the
 * translator emits; the plans below check that it stays index-friendly.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, test } from "vite-plus/test";
import { db, PgLive, type UserId } from "./schema.ts";

const sqlOf = (query: { toSql(): { sql: string } }): string => query.toSql().sql;

describe("generated SQL", () => {
  test("filter, order, page", () => {
    const minAge = 18;
    expect(
      sqlOf(
        db.users
          .where((u) => u.age !== null && u.age >= minAge && u.name.startsWith("A"))
          .orderByDescending((u) => u.createdAt)
          .skip(20)
          .take(10)
          .select((u) => ({ id: u.id, name: u.name })),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."id" AS "c0", "t0"."name" AS "c1" FROM "linq_test"."users" AS "t0" WHERE ((("t0"."age" IS NOT NULL) AND ("t0"."age" >= $1)) AND ("t0"."name" LIKE $2)) ORDER BY "t0"."created_at" DESC LIMIT 10 OFFSET 20"`,
    );
  });

  test("to-one relations become joins, once each", () => {
    expect(
      sqlOf(
        db.comments
          .where((c) => c.post.author.name === "Ada" && c.post.published)
          .select((c) => ({ body: c.body, title: c.post.title, by: c.author.name })),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."body" AS "c0", "t1"."title" AS "c1", "t3"."name" AS "c2" FROM "linq_test"."comments" AS "t0" LEFT JOIN "linq_test"."posts" AS "t1" ON ("t0"."post_id" = "t1"."id") LEFT JOIN "linq_test"."users" AS "t2" ON ("t1"."author_id" = "t2"."id") LEFT JOIN "linq_test"."users" AS "t3" ON ("t0"."author_id" = "t3"."id") WHERE (("t2"."name" = $1) AND "t1"."published")"`,
    );
  });

  test("to-many relations become correlated subqueries", () => {
    expect(
      sqlOf(
        db.users
          .where((u) => u.posts.some((p) => p.published) && u.comments.count() > 1)
          .select((u) => ({ name: u.name, views: u.posts.sum((p) => Number(p.views)) })),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."name" AS "c0", (SELECT COALESCE(sum(("t3"."views")::float8), 0) FROM "linq_test"."posts" AS "t3" WHERE ("t3"."author_id" = "t0"."id")) AS "c1" FROM "linq_test"."users" AS "t0" WHERE (EXISTS (SELECT 1 FROM "linq_test"."posts" AS "t1" WHERE ("t1"."author_id" = "t0"."id") AND "t1"."published") AND ((SELECT count(*)::int FROM "linq_test"."comments" AS "t2" WHERE ("t2"."author_id" = "t0"."id")) > 1))"`,
    );
  });

  test("nested collections are aggregated to JSON", () => {
    expect(
      sqlOf(
        db.users.select((u) => ({
          name: u.name,
          posts: u.posts
            .orderByDescending((p) => p.createdAt)
            .take(3)
            .select((p) => ({ title: p.title, views: p.views, at: p.createdAt })),
        })),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."name" AS "c0", COALESCE((SELECT json_agg("s2") FROM (SELECT ("t1"."title")::text AS "c0", ("t1"."views")::text AS "c1", (extract(epoch from "t1"."created_at") * 1000) AS "c2" FROM "linq_test"."posts" AS "t1" WHERE ("t1"."author_id" = "t0"."id") ORDER BY "t1"."created_at" DESC LIMIT 3) AS "s2"), '[]'::json) AS "c1" FROM "linq_test"."users" AS "t0""`,
    );
  });

  test("groupBy with having", () => {
    expect(
      sqlOf(
        db.posts
          .groupBy((p) => p.authorId)
          .where((g) => g.count() > 1)
          .select((g) => ({
            author: g.key,
            posts: g.count(),
            drafts: g.count((p) => !p.published),
          }))
          .orderByDescending((x) => x.posts),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."author_id" AS "c0", count(*)::int AS "c1", count(*) FILTER (WHERE NOT "t0"."published")::int AS "c2" FROM "linq_test"."posts" AS "t0" GROUP BY "t0"."author_id" HAVING (count(*)::int > 1) ORDER BY count(*)::int DESC"`,
    );
  });

  test("operators after take wrap the query", () => {
    expect(
      sqlOf(
        db.users
          .orderBy((u) => u.id)
          .take(10)
          .where((u) => u.isAdmin),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "s1"."c0" AS "c0", "s1"."c1" AS "c1", "s1"."c2" AS "c2", "s1"."c3" AS "c3", "s1"."c4" AS "c4", "s1"."c5" AS "c5", "s1"."c6" AS "c6", "s1"."c7" AS "c7" FROM (SELECT "t0"."id" AS "c0", "t0"."name" AS "c1", "t0"."email" AS "c2", "t0"."age" AS "c3", "t0"."is_admin" AS "c4", "t0"."balance" AS "c5", "t0"."manager_id" AS "c6", "t0"."created_at" AS "c7", "t0"."id" AS "c8" FROM "linq_test"."users" AS "t0" ORDER BY "t0"."id" LIMIT 10) AS "s1" WHERE "s1"."c4" ORDER BY "s1"."c8""`,
    );
  });

  test("joins", () => {
    expect(
      sqlOf(
        db.users.leftJoin(
          db.posts.where((p) => p.published),
          (u, p) => p.authorId === u.id,
          (u, p) => ({ name: u.name, title: p.title }),
        ),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."name" AS "c0", "s2"."c2" AS "c1" FROM "linq_test"."users" AS "t0" LEFT JOIN (SELECT "t1"."id" AS "c0", "t1"."author_id" AS "c1", "t1"."title" AS "c2", "t1"."body" AS "c3", "t1"."views" AS "c4", "t1"."published" AS "c5", "t1"."tags" AS "c6", "t1"."meta" AS "c7", "t1"."created_at" AS "c8" FROM "linq_test"."posts" AS "t1" WHERE "t1"."published") AS "s2" ON ("s2"."c1" = "t0"."id")"`,
    );
    expect(
      sqlOf(
        db.users.selectMany(
          (u) => u.posts.where((p) => p.published),
          (u, p) => [u.name, p.title],
        ),
      ),
    ).toMatchInlineSnapshot(
      `"SELECT "t0"."name" AS "c0", "t1"."title" AS "c1" FROM "linq_test"."users" AS "t0" INNER JOIN "linq_test"."posts" AS "t1" ON (("t1"."author_id" = "t0"."id") AND "t1"."published")"`,
    );
  });
});

describe("query plans", () => {
  /** The plan Postgres picks when it may not fall back to a sequential scan. */
  const plan = (query: {
    toSql(): { sql: string; params: ReadonlyArray<unknown> };
  }): Promise<string> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const { sql: text, params } = query.toSql();
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(`set local enable_seqscan = off`);
            const lines = yield* sql.unsafe(`explain (costs off) ${text}`, params as Array<unknown>)
              .values;
            return lines.map((line) => line[0]).join("\n");
          }),
        );
      }).pipe(Effect.provide(PgLive)),
    );

  test("parameters keep the column's type, so indexes apply", async () => {
    const id = 3 as UserId;
    expect(await plan(db.users.where((u) => u.id === id))).toMatch(
      /Index Scan using users_pkey[\s\S]*Index Cond: \(id = 3\)/,
    );
    const email = "ada@example.com";
    expect(await plan(db.users.where((u) => u.email === email))).toMatch(
      /Index Scan using users_email_key/,
    );
    const ids = [1, 2, 3] as Array<UserId>;
    expect(await plan(db.users.where((u) => ids.includes(u.id)))).toMatch(/Index Cond: \(id = ANY/);
    expect(await plan(db.posts.where((p) => p.authorId === id))).toMatch(/posts_author_id_idx/);
  });

  test("relations use the foreign key indexes", async () => {
    const id = 1 as UserId;
    // EXISTS over a to-many relation
    expect(
      await plan(db.users.where((u) => u.id === id && u.posts.some((p) => p.published))),
    ).toMatch(/posts_author_id_idx/);
    // a to-one join
    expect(await plan(db.comments.where((c) => c.post.authorId === id))).toMatch(
      /posts_author_id_idx|posts_pkey/,
    );
    // an optional relation over a nullable foreign key still joins with `=`
    const optional = db.users.where((u) => u.id === id).select((u) => u.manager.manager.name);
    expect(optional.toSql().sql).not.toContain("DISTINCT FROM");
    expect(await plan(optional)).toMatch(/Index Scan using users_pkey on users t2/);
    // nested collection
    expect(
      await plan(
        db.posts
          .where((p) => p.id === 1)
          .select((p) => ({ id: p.id, comments: p.comments.select((c) => c.body) })),
      ),
    ).toMatch(/comments_post_id_idx/);
  });
});
