import { PgClient } from "@effect/sql-pg";
import { Redacted, Schema } from "effect";
// The engine's tests declare tables with the internal layer that `entity` builds
// on, so that they cover it directly; tests/models.ts uses the public API.
import { database } from "../src/query.ts";
import * as Table from "../src/table.ts";
import { DATABASE_URL } from "./global-setup.ts";

export const UserId = Schema.Number.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const Users = Table.make(
  "users",
  {
    id: UserId,
    name: Schema.String,
    email: Schema.String,
    age: Schema.NullOr(Schema.Number),
    isAdmin: Schema.Boolean,
    // numeric arrives as a string; decode it to a number
    balance: Schema.NumberFromString,
    managerId: Schema.NullOr(UserId),
    createdAt: Schema.DateTimeUtcFromDate,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const Profiles = Table.make(
  "profiles",
  {
    userId: UserId,
    bio: Schema.NullOr(Schema.String),
    avatar: Schema.NullOr(Schema.Uint8Array),
  },
  { schema: "linq_test", columns: Table.snakeCase, primaryKey: "userId" },
);

export const Posts = Table.make(
  "posts",
  {
    id: Schema.Number,
    authorId: UserId,
    title: Schema.String,
    body: Schema.String,
    views: Schema.BigInt,
    published: Schema.Boolean,
    tags: Schema.Array(Schema.String),
    meta: Schema.NullOr(
      Schema.Struct({ featured: Schema.Boolean, rank: Schema.optional(Schema.Number) }),
    ),
    createdAt: Schema.Date,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const Comments = Table.make(
  "comments",
  {
    id: Schema.Number,
    postId: Schema.Number,
    authorId: UserId,
    body: Schema.String,
    score: Schema.Number,
    createdAt: Schema.Date,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const db = database(
  { users: Users, profiles: Profiles, posts: Posts, comments: Comments },
  (r) => ({
    users: {
      posts: r.many(Posts, (user, post) => post.authorId === user.id),
      comments: r.many(Comments, (user, comment) => comment.authorId === user.id),
      profile: r.optional(Profiles, (user, profile) => profile.userId === user.id),
      manager: r.optional(Users, (user, manager) => user.managerId === manager.id),
      reports: r.many(Users, (user, report) => report.managerId === user.id),
    },
    posts: {
      author: r.one(Users, (post, user) => post.authorId === user.id),
      comments: r.many(Comments, (post, comment) => comment.postId === post.id),
    },
    comments: {
      post: r.one(Posts, (comment, post) => comment.postId === post.id),
      author: r.one(Users, (comment, user) => comment.authorId === user.id),
    },
  }),
);

export const PgLive = PgClient.layer({ url: Redacted.make(DATABASE_URL) });

// ---- tables used by the write tests only, so that reads stay deterministic.
// Each test file that writes has its own copy (a prefix), as files run in parallel.

export const AuthorId = Schema.Number.pipe(Schema.brand("AuthorId"));
export type AuthorId = typeof AuthorId.Type;

export const writeDb = <const P extends string>(prefix: P) => {
  const Authors = Table.make(
    `${prefix}_authors`,
    {
      id: AuthorId,
      name: Schema.String,
      email: Schema.String,
      age: Schema.NullOr(Schema.Int),
      balance: Schema.NumberFromString,
      active: Schema.Boolean,
      managerId: Schema.NullOr(AuthorId),
      createdAt: Schema.DateTimeUtcFromDate,
    },
    {
      schema: "linq_test",
      columns: Table.snakeCase,
      defaults: ["id", "balance", "active", "createdAt"],
    },
  );
  const Books = Table.make(
    `${prefix}_books`,
    {
      id: Schema.Number,
      authorId: AuthorId,
      title: Schema.String,
      tags: Schema.Array(Schema.String),
      meta: Schema.NullOr(
        Schema.Struct({ featured: Schema.Boolean, rank: Schema.optional(Schema.Number) }),
      ),
      raw: Schema.NullOr(Schema.Struct({ note: Schema.String })),
      cover: Schema.NullOr(Schema.Uint8Array),
      views: Schema.BigInt,
      publishedAt: Schema.NullOr(Schema.Date),
    },
    { schema: "linq_test", columns: Table.snakeCase, defaults: ["id", "tags", "views"] },
  );
  const Stock = Table.make(
    `${prefix}_stock`,
    { warehouse: Schema.String, sku: Schema.String, qty: Schema.Number },
    { schema: "linq_test", primaryKey: ["warehouse", "sku"] },
  );
  const Log = Table.make(`${prefix}_log`, { message: Schema.String }, { schema: "linq_test" });
  const Accounts = Table.make(
    `${prefix}_accounts`,
    {
      id: Schema.Number,
      owner: Schema.String,
      balance: Schema.NumberFromString,
      version: Schema.Number,
    },
    { schema: "linq_test", defaults: ["id", "balance", "version"], version: "version" },
  );
  const tables = { authors: Authors, books: Books, stock: Stock, log: Log, accounts: Accounts };
  return {
    ...tables,
    truncate: `truncate ${Object.values(tables)
      .map((table) => `linq_test.${table.name}`)
      .join(", ")} restart identity cascade`,
    db: database(tables, (r) => ({
      authors: {
        books: r.many(Books, (author, book) => book.authorId === author.id),
        manager: r.optional(Authors, (author, manager) => author.managerId === manager.id),
      },
      books: {
        author: r.one(Authors, (book, author) => book.authorId === author.id),
      },
    })),
  };
};

const w = writeDb("w");
export const Authors = w.authors;
export const wdb = w.db;
export const truncateW = w.truncate;
