/**
 * Query pieces shared between files: the pattern the README recommends.
 * Everything here is used from `tests/sharing.test.ts`.
 */
import { type Query, quote, type RowIn } from "../../src/index.ts";
import { db } from "../schema.ts";

export type User = RowIn<typeof db.users>;
export type Post = RowIn<typeof db.posts>;

// ---- expressions: exported for other files, so they are declared with quote()

export const isAdult = quote(db.users, (u) => u.age !== null && u.age >= 18);

/** Parameters after the row are ordinary values. */
export const olderThan = quote(db.users, (u, age: number) => u.age !== null && u.age > age);

export const displayName = quote(db.users, (u) => `${u.name} <${u.email}>`);

/** An expression can use other expressions, relations and subqueries. */
export const publishedPosts = quote(db.users, (u) => u.posts.where((p) => p.published));
export const isActiveAuthor = quote(
  db.users,
  (u, minViews: bigint) => isAdult(u) && publishedPosts(u).some((p) => p.views >= minViews),
);

export const postSummary = quote(db.posts, (p) => ({
  id: p.id,
  title: p.title,
  by: displayName(p.author),
  comments: p.comments.count(),
}));

/** A function that returns an expression closes over its arguments. */
export const titleContains = (text: string) =>
  quote(db.posts, (p) => p.title.toLowerCase().includes(text.toLowerCase()));

// ---- query -> query functions: plain TypeScript, nothing special needed

export const published = <W>(posts: Query<Post, W>) => posts.where((p) => p.published);

export const newest =
  (count: number) =>
  <W>(posts: Query<Post, W>) =>
    posts.orderByDescending((p) => p.createdAt).take(count);

/** Generic over any row that has the columns it needs. */
export const page =
  (index: number, size: number) =>
  <T extends { readonly id: number }, W>(query: Query<T, W>) =>
    query
      .orderBy((row) => row.id)
      .skip(index * size)
      .take(size);

// ---- whole queries with parameters

export const postsByAuthor = (authorId: User["id"]) =>
  db.posts.where((p) => p.authorId === authorId).pipe(published);
