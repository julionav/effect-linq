/**
 * A small program that exercises the library the way an application would.
 * It is built with `vp pack` (minified) and also run directly by Node with
 * `--import effect-linq/register`; both must print the same thing.
 */
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { quote } from "effect-linq";
import { BlogDb } from "./schema.ts";

const url = process.env.LINQ_TEST_DATABASE_URL ?? "postgres://postgres:linq@localhost:54871/linq";

interface Filter {
  readonly search?: string;
  readonly minViews?: bigint;
  readonly page: number;
}

const isPublished = quote((post: { readonly published: boolean }) => post.published);

/** A typical list endpoint: optional filters, paging, a nested projection. */
const listPosts = (db: BlogDb["Service"], filter: Filter) =>
  db.posts
    .where(isPublished)
    .where(
      (post) =>
        (filter.search === undefined ||
          post.title.toLowerCase().includes(filter.search.toLowerCase())) &&
        (filter.minViews === undefined || post.views >= filter.minViews),
    )
    .orderByDescending((post) => post.createdAt)
    .skip(filter.page * 2)
    .take(2)
    .select((post) => ({
      id: post.id,
      title: post.title,
      author: post.author.name,
      boss: post.author.manager.name,
      comments: post.comments
        .orderByDescending((comment) => comment.score)
        .select((comment) => ({ body: comment.body, by: comment.author.name })),
    }));

const program = Effect.gen(function* () {
  const db = yield* BlogDb;
  const firstPage = yield* listPosts(db, { page: 0 });
  const searched = yield* listPosts(db, { page: 0, search: "NUMBERS", minViews: 100n });
  const leaderboard = yield* db.users
    .where((user) => user.posts.any())
    .select((user) => ({
      name: user.name,
      posts: user.posts.count(isPublished),
      bestComment: user.posts.selectMany((post) => post.comments).max((comment) => comment.score),
    }))
    .orderByDescending((row) => row.posts)
    .thenBy((row) => row.name);
  const adults = yield* db.users.count((user) => (user.age ?? 0) >= 18);
  // writes are statements too; printed rather than run, to leave the data alone
  const suffix = " (archived)";
  const write = db.posts
    .where((post) => !post.published && post.author.isAdmin)
    .executeUpdate((post) => ({ title: post.title + suffix }))
    .returning((post) => ({ id: post.id, comments: post.comments.count() }))
    .toSql();
  return {
    firstPage,
    searched,
    leaderboard,
    adults,
    sql: listPosts(db, { page: 1 }).toSql(),
    write,
  };
});

// installation: the context's layer on a client's
const BlogDbLive = BlogDb.layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })));

Effect.runPromise(program.pipe(Effect.provide(BlogDbLive))).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
