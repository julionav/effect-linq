import { Schema } from "effect";
import { Model } from "effect/schema";
import { DbContext, entity } from "@blitz/effect-linq";

export class User extends Model.Class<User>("User")({
  id: Model.GeneratedByDb(Schema.Number),
  name: Schema.String,
  email: Schema.String,
  age: Schema.NullOr(Schema.Number),
  isAdmin: Schema.Boolean,
  managerId: Schema.NullOr(Schema.Number),
  createdAt: Schema.DateTimeUtcFromDate,
}) {}

export class Post extends Model.Class<Post>("Post")({
  id: Model.GeneratedByDb(Schema.Number),
  authorId: Schema.Number,
  title: Schema.String,
  views: Schema.BigInt,
  published: Schema.Boolean,
  createdAt: Schema.Date,
}) {}

export class Comment extends Model.Class<Comment>("Comment")({
  id: Model.GeneratedByDb(Schema.Number),
  postId: Schema.Number,
  authorId: Schema.Number,
  body: Schema.String,
  score: Schema.Number,
}) {}

export class BlogDb extends DbContext.Service<BlogDb>()(
  "blog/BlogDb",
  {
    users: entity(User, (e) =>
      e
        .hasMany("posts", () => Post, { foreignKey: "authorId" })
        .hasOptional("manager", () => User, { foreignKey: "managerId" }),
    ),
    posts: entity(Post, (e) =>
      e
        .hasOne("author", () => User, { foreignKey: "authorId" })
        .hasMany("comments", () => Comment, { foreignKey: "postId" }),
    ),
    comments: entity(Comment, (e) => e.hasOne("author", () => User, { foreignKey: "authorId" })),
  },
  { schema: "linq_test", naming: "snake_case" },
) {}
