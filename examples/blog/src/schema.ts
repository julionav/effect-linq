import { Schema } from "effect";
import { database, Table } from "effect-linq";

export const Users = Table.make(
  "users",
  {
    id: Schema.Number,
    name: Schema.String,
    email: Schema.String,
    age: Schema.NullOr(Schema.Number),
    isAdmin: Schema.Boolean,
    managerId: Schema.NullOr(Schema.Number),
    createdAt: Schema.DateTimeUtcFromDate,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const Posts = Table.make(
  "posts",
  {
    id: Schema.Number,
    authorId: Schema.Number,
    title: Schema.String,
    views: Schema.BigInt,
    published: Schema.Boolean,
    createdAt: Schema.Date,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const Comments = Table.make(
  "comments",
  {
    id: Schema.Number,
    postId: Schema.Number,
    authorId: Schema.Number,
    body: Schema.String,
    score: Schema.Number,
  },
  { schema: "linq_test", columns: Table.snakeCase },
);

export const db = database({ users: Users, posts: Posts, comments: Comments }, (r) => ({
  users: {
    posts: r.many(Posts, (user, post) => post.authorId === user.id),
    manager: r.optional(Users, (user, manager) => user.managerId === manager.id),
  },
  posts: {
    author: r.one(Users, (post, user) => post.authorId === user.id),
    comments: r.many(Comments, (post, comment) => comment.postId === post.id),
  },
  comments: {
    author: r.one(Users, (comment, user) => comment.authorId === user.id),
  },
}));
