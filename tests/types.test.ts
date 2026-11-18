import type { DateTime, Effect, Option } from "effect";
import { describe, expectTypeOf, test } from "vite-plus/test";
import type { InsertOf } from "../src/index.ts";
import { type AuthorId, db, type UserId } from "./schema.ts";

type Result<Q> = Q extends { toArray(): Effect.Effect<Array<infer A>, any, any> } ? A : never;

type UserRow = Result<typeof db.users>;

describe("types", () => {
  test("rows are the decoded schema types, without relations", () => {
    expectTypeOf<Result<typeof db.users>>().toEqualTypeOf<{
      id: UserId;
      name: string;
      email: string;
      age: number | null;
      isAdmin: boolean;
      balance: number;
      managerId: UserId | null;
      createdAt: DateTime.Utc;
    }>();
    expectTypeOf<Result<typeof db.posts>["views"]>().toEqualTypeOf<bigint>();
    // Effect data types are kept as they are, not expanded structurally
    expectTypeOf<Result<typeof db.users>["createdAt"]>().toEqualTypeOf<DateTime.Utc>();
    expectTypeOf<Result<typeof db.posts>>().not.toHaveProperty("author");
    expectTypeOf<Result<typeof db.posts>["tags"]>().toEqualTypeOf<ReadonlyArray<string>>();
  });

  test("lambda parameters see columns and relations", () => {
    db.posts.where((p) => {
      expectTypeOf(p.title).toEqualTypeOf<string>();
      expectTypeOf(p.author.name).toEqualTypeOf<string>();
      expectTypeOf(p.author.manager.name).toEqualTypeOf<string | null>();
      expectTypeOf(p.author.profile.bio).toEqualTypeOf<string | null>();
      expectTypeOf(p.comments.count()).toEqualTypeOf<number>();
      expectTypeOf(p.comments.first().score).toEqualTypeOf<number | null>();
      expectTypeOf(p.author.posts.select((x) => x.views).max()).toEqualTypeOf<bigint | null>();
      return true;
    });
    // @ts-expect-error relations of other tables are not visible
    db.posts.where((p) => p.profile !== null);
    // @ts-expect-error a predicate must return a boolean
    db.posts.where((p) => p.title);
    // @ts-expect-error unknown column
    db.users.select((u) => u.nope);
    // @ts-expect-error collections only expose translatable operators
    db.users.select((u) => u.posts.reduce((a: number) => a, 0));
  });

  test("projections", () => {
    const query = db.posts.select((p) => ({
      title: p.title,
      author: p.author,
      boss: p.author.manager,
      bossName: p.author.manager.name,
      comments: p.comments.select((c) => ({ body: c.body, by: c.author })),
      scores: p.comments.select((c) => c.score),
      latest: p.comments.first(),
      pair: [p.id, p.title] as const,
      n: p.comments.count(),
    }));
    type Row = Result<typeof query>;
    expectTypeOf<Row["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["author"]>().toEqualTypeOf<UserRow>();
    expectTypeOf<Row["boss"]>().toEqualTypeOf<UserRow | null>();
    expectTypeOf<Row["bossName"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Row["comments"][number]["by"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["comments"][number]>().toHaveProperty("body");
    expectTypeOf<Row["scores"]>().toEqualTypeOf<Array<number>>();
    expectTypeOf<NonNullable<Row["latest"]>["score"]>().toEqualTypeOf<number>();
    expectTypeOf<null>().toExtend<Row["latest"]>();
    expectTypeOf<Row["pair"]>().toEqualTypeOf<readonly [number, string]>();
    expectTypeOf<Row["n"]>().toEqualTypeOf<number>();
  });

  test("include adds the relation to the row", () => {
    const query = db.users.include("posts").include("manager");
    type Row = Result<typeof query>;
    expectTypeOf<Row["posts"][number]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["posts"][number]>().not.toHaveProperty("author");
    expectTypeOf<null>().toExtend<Row["manager"]>();
    expectTypeOf<NonNullable<Row["manager"]>["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Row>().not.toHaveProperty("profile");
    // @ts-expect-error not a relation
    db.users.include("name");
  });

  test("joins, groups and terminals", () => {
    const joined = db.users.leftJoin(
      db.posts,
      (u, p) => p.authorId === u.id,
      (u, p) => ({ name: u.name, title: p.title, post: p }),
    );
    expectTypeOf<Result<typeof joined>["title"]>().toEqualTypeOf<string | null>();
    expectTypeOf<null>().toExtend<Result<typeof joined>["post"]>();

    const grouped = db.posts
      .groupBy((p) => ({ author: p.authorId, published: p.published }))
      .select((g) => ({ ...g.key, n: g.count(), last: g.max((p) => p.createdAt) }));
    expectTypeOf<Result<typeof grouped>>().toEqualTypeOf<{
      author: UserId;
      published: boolean;
      n: number;
      last: Date | null;
    }>();

    type Success<E> = E extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<Success<ReturnType<typeof db.users.count>>>().toEqualTypeOf<number>();
    expectTypeOf<Success<ReturnType<typeof db.users.any>>>().toEqualTypeOf<boolean>();
    const maxBalance = db.users.max((u) => u.balance);
    expectTypeOf<Success<typeof maxBalance>>().toEqualTypeOf<number | null>();
    const first = db.users.select((u) => u.name).firstOption();
    expectTypeOf<Success<typeof first>>().toEqualTypeOf<Option.Option<string>>();
  });
});

describe("write types", () => {
  test("insert: nullable and defaulted columns are optional, the rest required", async () => {
    const { wdb } = await import("./schema.ts");
    const { Authors } = await import("./schema.ts");
    type AuthorInsert = InsertOf<typeof Authors>;
    expectTypeOf<{ name: string; email: string }>().toExtend<AuthorInsert>();
    expectTypeOf<AuthorInsert["age"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<AuthorInsert["id"]>().toEqualTypeOf<AuthorId | undefined>();
    // @ts-expect-error email is required
    wdb.authors.insert({ name: "a" });
    // @ts-expect-error wrong type
    wdb.authors.insert({ name: "a", email: 1 });
    // @ts-expect-error unknown column
    wdb.authors.insert({ name: "a", email: "e", nope: 1 });
    const one = wdb.authors.insert({ name: "a", email: "e" });
    const many = wdb.authors.insert([{ name: "a", email: "e" }]);
    type Success<E> = E extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<Success<typeof one>>().toEqualTypeOf<number>();
    const row = one.returning();
    const rows = many.returning();
    const ids = many.returning((a) => ({ id: a.id, books: a.books.count() }));
    expectTypeOf<Success<typeof row>["createdAt"]>().toEqualTypeOf<DateTime.Utc>();
    expectTypeOf<Success<typeof rows>[number]>().toEqualTypeOf<Success<typeof row>>();
    expectTypeOf<Success<typeof ids>>().toEqualTypeOf<Array<{ id: AuthorId; books: number }>>();
  });

  test("update: any subset of the columns; projected queries cannot be written to", async () => {
    const { wdb } = await import("./schema.ts");
    const one = wdb.authors.where((a) => a.id === 1);
    one.executeUpdate({ name: "a" });
    one.executeUpdate((a) => ({ age: a.books.count(), name: a.manager.name ?? a.name }));
    // @ts-expect-error wrong type
    one.executeUpdate({ name: 1 });
    // @ts-expect-error wrong type from a lambda
    one.executeUpdate((a) => ({ name: a.id }));
    // @ts-expect-error a projection has no table to write to
    one.select((a) => a.name).executeUpdate({ name: "a" });
    // @ts-expect-error a projection cannot be inserted into
    one.select((a) => a.name).insert({ name: "a", email: "e" });
  });
});

describe("review findings", () => {
  test("a terminal used inside a projection is its value, and unknown stays unknown", () => {
    const counts = db.users.select((u) => ({
      n: db.posts.where((p) => p.authorId === u.id).count(),
      raw: null as unknown,
    }));
    expectTypeOf<Result<typeof counts>>().toEqualTypeOf<{ n: number; raw: unknown }>();
  });

  test("projected and grouped queries cannot be updated or deleted; included ones can", async () => {
    const { wdb } = await import("./schema.ts");
    const one = wdb.authors.where((a) => a.id === 1);
    // @ts-expect-error no table to delete from
    one.select((a) => a.name).executeDelete();
    // @ts-expect-error no table to delete from
    one.groupBy((a) => a.active).executeDelete();
    // @ts-expect-error no table to update
    one.select((a) => a.name).executeUpdate(() => ({}));
    one.include("books").executeUpdate({ name: "x" });
    one.executeDelete();
  });
});
