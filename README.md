# effect-linq

LINQ to SQL for TypeScript, in the style of EF Core, on top of
[Effect SQL](https://effect.website). Entities are Effect models, the context is an Effect
service, and queries are plain lambdas, compiled to expression trees at build time and translated
to Postgres at run time.

```ts
const minAge = 18;

const query = db.users
  .where((u) => u.age !== null && u.age >= minAge && u.posts.some((p) => p.published))
  .orderByDescending((u) => u.createdAt)
  .take(20)
  .select((u) => ({
    name: u.name,
    boss: u.manager.name,
    posts: u.posts.count(),
    latest: u.posts
      .orderByDescending((p) => p.createdAt)
      .take(3)
      .select((p) => ({ title: p.title, comments: p.comments.count() })),
  }));

const rows = yield * query;
// one SQL statement; `minAge` is a bind parameter; `rows` is fully typed
```

Writes come in two styles: explicit statements (`insert`, `executeUpdate`, `executeDelete`), and
opt-in [change tracking](#change-tracking) through a session (`load`, assign, `saveChanges`).

Status: a working proof, not a release, and not published to npm. Postgres only.
See [Benchmarks](#benchmarks), [What is proven](#what-is-proven) and [Limitations](#limitations).

## Setup

Requirements: Effect 4.1 (`effect` and `@effect/sql-pg`), Postgres, and a build that can run a
Vite/Rollup-style plugin. Running TypeScript directly through the loader hook needs Node 22.15 or
later.

```sh
bun add effect-linq effect @effect/sql-pg   # once published; until then, from this repository
```

The lambdas need a build step. Add the plugin wherever your code is compiled:

```ts
// vite.config.ts (Vite, Vitest, and `vp pack` / tsdown / Rolldown all take the same plugin)
import { linq } from "effect-linq/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [linq()], // dev server and tests
  pack: { plugins: [linq({ strict: true })] }, // library / server builds
});
```

For code that Node runs directly, with no bundler:

```sh
node --import effect-linq/register app.ts
```

A lambda that was not compiled is rejected the moment it is passed to an operator, with a message
that says so. Nothing is ever guessed from `Function.prototype.toString`.

## Models

Entities are Effect [`Model.Class`](https://effect.website) classes. Nothing about them is
specific to this library:

```ts
import { Schema } from "effect";
import { Model } from "effect/schema";

export class User extends Model.Class<User>("User")({
  id: Model.GeneratedByDb(UserId),
  email: Schema.String,
  name: Schema.NonEmptyString,
  age: Schema.NullOr(Schema.Int),
  balance: Schema.NumberFromString, // numeric arrives as a string
  version: Model.GeneratedByDb(Schema.Int),
  createdAt: Model.DateTimeInsertFromDate, // set on insert
  updatedAt: Model.DateTimeUpdateFromDate, // refreshed on every update
}) {}

export class Post extends Model.Class<Post>("Post")({
  id: Model.GeneratedByDb(Schema.Int),
  authorId: UserId,
  title: Schema.String,
  published: Schema.Boolean,
  tags: Schema.Array(Schema.String),
}) {}
```

The model's variants decide how rows are read and written:

- **Rows are instances of the class** (`row instanceof User`), with the types of its select
  variant.
- **`insert` takes the insert variant.** Database-generated fields cannot be given, and what the
  application generates (`Model.DateTimeInsert`, `Model.UuidV4Insert`) is filled in.
- **Updates follow the update variant.** Fields it omits cannot be set, and fields it refreshes
  (`Model.DateTimeUpdate`) are set by every `executeUpdate` and every session save.

## The context

Everything the models do not say (table and column names, keys, column types, indexes,
relations) is configured once, with a fluent builder per entity, as in EF Core's
`OnModelCreating`. The context is an Effect service:

```ts
import { DbContext, entity } from "effect-linq";

export class AppDb extends DbContext.Service<AppDb>()(
  "app/AppDb",
  {
    users: entity(User, (e) =>
      e
        .hasKey("id")
        .property("balance", (p) => p.hasColumnType("numeric(12,2)").hasDefaultSql("0"))
        .property("version", (p) => p.hasDefaultSql("1").isConcurrencyToken())
        .hasIndex("email", { unique: true })
        .hasMany("posts", () => Post, { foreignKey: "authorId" }),
    ),
    posts: entity(Post, (e) =>
      e
        .toTable("blog_posts")
        .hasOne("author", () => User, { foreignKey: "authorId", onDelete: "cascade" }),
    ),
  },
  { naming: "snake_case" }, // also: schema
) {}
```

| Builder                              | What it sets                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `toTable(name, { schema })`          | the table; defaults to the entity's key under the naming convention                          |
| `hasKey(...fields)`                  | the primary key; defaults to `id`                                                            |
| `property(field, (p) => …)`          | `hasColumnName`, `hasColumnType`, `hasDefaultSql`, `useIdentityColumn`, `isConcurrencyToken` |
| `hasIndex(fields, { unique, name })` | an index                                                                                     |
| `hasOne` / `hasOptional` / `hasMany` | a relation, by `{ foreignKey, onDelete }` or by a lambda for anything else                   |

A relation given by `foreignKey` also becomes a foreign key constraint in migrations. A lambda
(`(user, post) => post.authorId === user.id && post.published`) is only a relation.

### Installing it

As with `services.AddDbContext<AppDb>(...)` in EF Core, the context is installed once, at the
composition root. This is the only place the rest of Effect SQL appears: the context's layer
goes on top of any Effect SQL Postgres client.

```ts
import { PgClient } from "@effect/sql-pg";
import { Layer, Redacted } from "effect";

const AppDbLive = AppDb.layer.pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })),
);
```

### Using it

Application code asks for the context like any other service, and needs nothing else:

```ts
const program = Effect.gen(function* () {
  const db = yield* AppDb;

  const adults = yield* db.users.where((u) => (u.age ?? 0) >= 18).orderBy((u) => u.name);
  const user = yield* db.users.insert({ email, name, age: 36, balance: 0 }).returning();
  yield* db.posts.where((p) => p.authorId === user.id && !p.published).executeDelete();
}); // Effect<void, SqlError | SchemaError, AppDb>

Effect.runPromise(program.pipe(Effect.provide(AppDbLive)));
```

A service of your own depends on it the same way:

```ts
export class Accounts extends Context.Service<Accounts, { … }>()("app/Accounts") {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const db = yield* AppDb;
      return Accounts.of({
        deposit: (id, amount) =>
          db.users.where((u) => u.id === id).executeUpdate((u) => ({ balance: u.balance + amount })),
      });
    }),
  );
}
```

| On the service            |                                                                              |
| ------------------------- | ---------------------------------------------------------------------------- |
| `db.users`, `db.posts`, … | queries and writes                                                           |
| `db.session()`            | a unit of work with [change tracking](#change-tracking)                      |
| `db.transaction(effect)`  | runs effects in one transaction; statements and session saves both take part |
| `AppDb.layer`             | the layer that provides the context, given a Postgres client                 |
| `AppDb.model`             | the model without a connection, for migrations and shared expressions        |

In tests, provide `AppDb.layer` over a different client layer (a test database or container);
nothing else changes.

### Migrations

Migrations are generated from the model and run by Effect's `Migrator`. `Migrations.add` compares
the model with a snapshot kept beside the migration files, writes the difference as the next
`<id>_<name>.ts`, and updates the snapshot. It never touches a database.

```ts
// scripts/add-migration.ts — run: node --import effect-linq/register scripts/add-migration.ts add_posts
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Migrations } from "effect-linq";
import { AppDb } from "../src/db.ts";

const added = await Effect.runPromise(
  Migrations.add({ context: AppDb.model, directory: "migrations", name: process.argv[2]! }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
console.log(added.file ?? "no changes", added.warnings);
```

The files are ordinary Effect migrations, so Effect's migrator runs them, before the context is
used:

```ts
import { PgMigrator } from "@effect/sql-pg";
import { fromFileSystem } from "effect/sql/MigratorFileSystem";

const MigratorLive = PgMigrator.layer({ loader: fromFileSystem("migrations") });

const AppLive = AppDb.layer.pipe(
  Layer.provideMerge(MigratorLive),
  Layer.provide(PgClient.layer({ url })),
);
```

Generated SQL covers tables, columns (type, nullability, default, identity), primary keys,
indexes and foreign keys. Column types are inferred from the schemas (`Schema.Int` → `integer`,
`Schema.BigInt` → `bigint`, `Schema.Date` → `timestamptz`, arrays, structs → `jsonb`) and stated
with `hasColumnType` where they cannot be. Destructive changes are written with a `WARNING`
comment. A rename is seen as a drop and an add: edit the file to `RENAME` when the data must be
kept. `Migrations.diff`, `snapshot` and `createScript` are available for other workflows.

### Relations

| Declared with | In a lambda                                 | In a result               |
| ------------- | ------------------------------------------- | ------------------------- |
| `hasOne`      | the row                                     | the row                   |
| `hasOptional` | the row, every column `T \| null`           | the row, or `null`        |
| `hasMany`     | a collection (`some`, `count`, `select`, …) | an array, in the same SQL |

Relations are only loaded when selected (`select(p => ({ author: p.author }))`) or included
(`db.posts.include("author")`); the result type follows.

## Operators

On a query, and on collections inside a lambda:

`where` · `select` · `selectMany` · `orderBy` / `orderByDescending` / `thenBy` / `thenByDescending` ·
`take` · `skip` · `distinct` · `groupBy` · `join` · `leftJoin` · `include`

Terminal (each returns an Effect; inside a lambda they are subqueries):

`yield* query` / `toArray()` · `first()` · `firstOption()` · `count()` · `any()` · `all()` · `sum()` ·
`min()` · `max()` · `average()`

Also `toSql()` for logging, `quote(fn)` to keep an expression in a variable, and
`query.asMany()` to use any query as a subquery.

### Inside a lambda

- Comparison, arithmetic and logical operators, `??`, `?:`, template literals, object and array
  literals, spread, destructured parameters, optional chaining.
- Strings: `startsWith`, `endsWith`, `includes`, `toLowerCase`, `toUpperCase`, `trim*`,
  `substring`, `slice`, `charAt`, `indexOf`, `replaceAll`, `concat`, `padStart`, `padEnd`, `length`.
- Numbers: `Math.abs/floor/ceil/round/trunc/sign/sqrt/pow/min/max`, `toFixed`, `Number()`.
- Dates: comparison, `getTime`, `toISOString`, and the `getUTC*` parts.
- Arrays: `ids.includes(u.id)` (one array parameter), `list.some(x => …)`, `[a, b].includes(x)`,
  and array columns (`p.tags.includes("x")`, `p.tags.length`).
- `Sql.like`, `Sql.ilike`, `Sql.now()`, and `Sql.fn("name")` to declare any SQL function.
- Anything that does not depend on the row is ordinary JavaScript, evaluated when the query runs
  and bound as a parameter. Conditions on such values fold away, so optional filters cost nothing:

```ts
db.users.where((u) => filter.name === undefined || u.name === filter.name);
// no WHERE clause at all when filter.name is undefined
```

## Writes

Each write is one SQL statement, run when its Effect is. Rows that were read are plain values:
changing them does nothing, and nothing is saved implicitly.

```ts
// insert: one row or many, as the model's insert variant; generated fields are left out
const user = yield * db.users.insert({ name: "Ada", age: 36 }).returning();
const count = yield * db.users.insert([a, b, c]);

// update and delete apply to the rows of a query, without loading them
yield * db.users.where((u) => u.id === id).executeUpdate({ name: "Ada L." });
yield *
  db.posts
    .where((p) => p.author.isAdmin && !p.published)
    .executeUpdate((p) => ({ views: p.views + 1n, title: `${p.author.name}: ${p.title}` }));
yield * db.posts.where((p) => p.createdAt < cutoff).executeDelete();

// upsert
yield *
  db.stock
    .insert({ warehouse, sku, qty })
    .onConflictDoUpdate(["warehouse", "sku"], (existing, proposed) => ({
      qty: existing.qty + proposed.qty,
    }));
```

- **Result.** Each is an Effect of the number of rows affected. `.returning()` gives the rows
  instead (the deleted rows, for a delete), and `.returning((row) => …)` a projection of them,
  which may include collections (`row.posts.count()`). `.toSql()` shows the statement.
- **Values** are validated and encoded by the column's schema, and are always bind parameters. A
  value that does not match is a `SchemaError` failure before any SQL runs. `Sql.now()` and other
  SQL functions can be used as values.
- **`executeUpdate`** takes a plain object, or a lambda over the row for values computed in the
  database (`u.balance + amount`, relations, subqueries). `undefined` leaves a column alone;
  `null` sets it to NULL. (`cond ? value : undefined` is an expression, and its `undefined` is
  NULL.)
- **Queries with joins or paging** work: `orderBy(…).take(10).executeDelete()` and conditions on
  relations become a subquery on the primary key.
- **No accidental full-table writes.** A statement that nothing narrows (no condition left after
  folding, no paging, no inner join) is rejected; pass `{ unfiltered: true }` to mean it.
- **Large inserts** are split to stay under Postgres' parameter limit, inside one transaction.
- **`onConflictDoNothing(target?)`** and **`onConflictDoUpdate(target, values?)`**; without
  `values`, the existing row takes every inserted value.
- The names `executeUpdate` / `executeDelete` (as in EF Core) are deliberate: the build step finds
  query lambdas by method name, and `update` is too common a name elsewhere (`Ref.update`).

## Change tracking

A session is a unit of work: it remembers the rows it loads, and `saveChanges` writes whatever
was changed on them. It is opt-in per unit of work; queries run outside a session are never
tracked.

```ts
const uow = db.session();
const order = yield * uow.first(db.orders.where((o) => o.id === id).include("lines"));
order.status = "shipped"; // rows are plain mutable objects
for (const line of order.lines) line.shipped = line.quantity;
uow.remove(order.lines[0]!);
const note = uow.add(db.notes, { orderId: order.id, text: "left the warehouse" });
yield * uow.saveChanges(); // one transaction
note.id; // generated values are filled in
```

- **Reading:** `uow.load(query)`, `uow.first(query)`, `uow.firstOption(query)` and
  `uow.find(db.orders, key)`. Every table row in the result is tracked, including rows reached
  through `include` or selected inside a projection.
- **Identity map:** a session holds one object per primary key. Loading a row again returns the
  same object with its local changes; `find` answers from the map without a query.
- **Detection is by snapshot,** with no proxies: `saveChanges` compares each row with a copy
  taken when it was loaded (see [How it is fast](#how-it-is-fast)). In-place changes (`row.tags.push("x")`, `row.meta.rank = 2`,
  `date.setHours(…)`) are noticed. Assigning an equal value is not a change.
- **`saveChanges` batches:** one `INSERT … RETURNING` per table, one `UPDATE` per table and set
  of changed columns (only those columns are written), one `DELETE` per table. Inserts run
  first, in the order tables were first added to; then updates; then deletes, in removal order.
- **A failed save writes nothing** and leaves the session as it was, so it can be retried. The
  exception is a transaction of your own around `saveChanges` that rolls back after it
  succeeded: the session then believes the changes were saved, so discard it.
- **Optimistic concurrency:** a row that is gone fails the save with `ConcurrencyError`. With
  `isConcurrencyToken()` on a number column, so does a row someone else changed; the column is
  checked and incremented on every save.
- **`uow.changes()`**, `hasChanges()`, `state(row)`, `detach(row)` and `clear()` inspect and
  manage what is tracked.

What it does not do: relations are not tracked. Pushing into `order.lines` or assigning
`line.order` changes nothing; use `add` and set the foreign key. A parent and its children are
saved with two `saveChanges` calls (the first yields the parent's key), inside
`sql.withTransaction` if they must be atomic. A session is for one fiber and one unit of work.

Measurements are under [Benchmarks](#benchmarks).

### How it is fast

- **Snapshots are stored by column.** Each table has one array per column, and a tracked row is
  a slot number: there is no snapshot object per row, and arrays of numbers stay unboxed.
- **The hot loops are generated per table.** Taking a snapshot and scanning for changes are
  compiled (`new Function`) into straight-line property reads for that table's columns, and
  arrays and structs get copy and compare functions generated from their schemas. Where code
  generation is not allowed (a Content Security Policy, some edge runtimes) a generic
  implementation with the same behaviour is used.
- **The scan is allowed false alarms, never misses.** It compares with `!==`; a row it flags is
  then compared exactly, which is where `NaN` and equal-but-distinct objects are sorted out.

Two alternatives were measured and rejected, both in `bench/tracking.ts`:

- **Proxies** know their changes for free, but every property read through one costs about 7×
  a plain read (360 µs against 47 µs for four properties of 10,000 rows), and reads far
  outnumber saves.
- **Native code** (Rust compiled to WebAssembly, `bench/wasm/diff.rs`). In its best case,
  numeric columns only, copying the current values into WebAssembly memory and comparing there
  takes 40 µs for 10,000 rows; the generated JavaScript takes 43 µs for the same columns. The
  rows live in the JavaScript heap, so reading them is the cost either way, and strings and
  objects cannot cross the boundary cheaply at all.

## Sharing queries

Lambdas do not have to be inline. There are three kinds of reusable piece.

**Expressions** are functions of a row. Declare them with `quote`; passing a query of the model
first types the row parameter:

```ts
// queries/users.ts
export const isAdult = quote(AppDb.model.users, (u) => u.age !== null && u.age >= 18);
export const olderThan = quote(
  AppDb.model.users,
  (u, age: number) => u.age !== null && u.age > age,
);
export const displayName = quote(AppDb.model.users, (u) => `${u.name} <${u.email}>`);
export const publishedPosts = quote(AppDb.model.users, (u) => u.posts.where((p) => p.published));

// an expression can use other expressions
export const isActiveAuthor = quote(
  AppDb.model.users,
  (u) => isAdult(u) && publishedPosts(u).some(),
);
```

They can be passed to an operator or called inside any lambda, on the row or a related one
(a required relation; an optional one has nullable columns, so it is a different type):

```ts
db.users.where(isAdult);
db.users.where((u) => olderThan(u, min) && !u.isAdmin).select((u) => displayName(u));
db.posts.where((p) => isActiveAuthor(p.author));
```

A call is expanded into the surrounding query, so the result is still one SQL statement and
extra arguments are bind parameters. The expression also remains the ordinary function it was,
so it can be called in unit tests (its parameter type is the query's row, relations included).

Inside one file, `quote` is optional: a module-level `const helper = (row) => …` that a query
refers to by name is picked up by the build step. Across files it is required, because the build
step sees one file at a time; a helper that was missed is reported when the query is built.

**Query functions** take a query and return one. They are plain TypeScript and compose with
`pipe`:

```ts
type Post = RowIn<typeof AppDb.model.posts>; // the row a query's lambdas receive

export const published = <W, Env>(posts: Query<Post, W, Env>) => posts.where((p) => p.published);
export const newest =
  (n: number) =>
  <W, Env>(posts: Query<Post, W, Env>) =>
    posts.orderByDescending((p) => p.createdAt).take(n);

db.posts.pipe(published, newest(10));
```

Keeping `W` and `Env` generic keeps the result writable (`.pipe(published).executeDelete()`)
and free of any requirement beyond the context.

**Whole queries with parameters** are functions that return a query; the result stays
composable: `const postsByAuthor = (id: UserId) => db.posts.where((p) => p.authorId === id)`.

## Semantics

The translation follows JavaScript, not SQL, wherever the two differ and it is practical:

- `a === b` is null-safe; `a !== 1` and `!(a === 1)` are true when `a` is null.
- Truthiness (`!s`, `s || fallback`, `Boolean(n)`) treats `null`, `''` and `0` as JavaScript does.
- `/` is floating-point division; `Math.round` rounds half up; `String(null)` is `"null"`.
- Values compared with a column are encoded through that column's schema.
- Strings, dates, arrays and captured numbers are always bind parameters. Only numbers written
  literally in a lambda, and `take`/`skip` counts (checked to be integers), are inlined.

## How it works

1. **Build time** (`effect-linq/compiler`, ~800 lines on `oxc-parser`). Every arrow function passed
   to a query operator is wrapped: the original function is kept, and a JSON expression tree is
   attached to it. The largest subexpressions that do not mention a lambda parameter become
   thunks, so captured variables are read lazily, at execution. The transform is syntactic (it
   knows method names, not types), so a lambda passed to some unrelated `.where()` is wrapped too;
   that is harmless, since it remains the same function.
2. **Run time.** Operators build an immutable list of steps. Executing replays them over symbolic
   values (row, column, constant, collection, group), producing a SQL fragment tree and a reader
   that turns driver rows into results. To-one relations become `LEFT JOIN`s, to-many relations
   correlated subqueries, nested collections `json_agg`, and anything applied after `take` /
   `distinct` / an aggregate wraps the query in a subquery.
3. **Execution** goes through the Effect SQL client the context was installed on, so pooling,
   transactions, tracing and errors are Effect SQL's.

## What is proven

Run `vp test` (needs Postgres, see below). 322 tests:

- **Differential** (`tests/differential.test.ts`): 140 expressions each run twice over the same 300
  rows, in Postgres and as the original JavaScript function, and must agree. This is what backs
  the semantics section.
- **Behaviour** (`tests/query.test.ts`): relations, nested collections, grouping, joins, paging,
  subqueries, codecs, bigint precision through JSON, injection attempts, transactions, errors.
- **SQL and plans** (`tests/sql.test.ts`): pinned SQL for representative queries, and `EXPLAIN`
  checks that parameters and relation joins stay index-friendly.
- **Writes** (`tests/write.test.ts`): every statement form against real tables, codecs both ways,
  40 concurrent increments with none lost, a 23,000-row insert that is split and rolls back as
  a whole, the full-table guard, transactions, pinned SQL and a plan check.
- **Change tracking** (`tests/session.test.ts`): detection for every column type including
  in-place changes, the identity map, batching (statement counts are asserted), failed saves
  that leave nothing behind, version conflicts under concurrency, and 25,000-row change sets.
- **Sharing** (`tests/sharing.test.ts`, `tests/shared/queries.ts`): expressions and query
  functions imported from another file, same-file helpers, and what the build step picks up.
- **Build** (`tests/e2e.test.ts`): the package is built with `vp pack`, an example app is built
  against it minified with the plugin in strict mode and run by plain Node; the same source run
  through the loader hook must print the same output.
- **Compiler and types** (`tests/compiler.test.ts`, `tests/types.test.ts`).
- **Model** (`tests/model.test.ts`, `tests/models.ts`): `Model.Class` entities configured with the
  builder; two generations of migrations generated from the model and run by `PgMigrator`; the
  context as a service, with another service depending on it, transactions and a swapped layer.
- **Review** (`tests/review.test.ts`): a regression test for each defect two independent reviews
  found, among them partial writes on a failed one-statement save, the full-table guard on
  queries that follow relations, and identity-map key collisions.

```sh
docker run -d --name linq-pg -e POSTGRES_PASSWORD=linq -e POSTGRES_DB=linq -p 54871:5432 postgres:17-alpine
vp test    # or set LINQ_TEST_DATABASE_URL
vp check
vp pack
```

## Benchmarks

Benchmarks use [strobe](https://github.com/anomalyco/strobe), which runs two sides in alternating
pairs of fresh processes and gives a verdict with a confidence interval, or says it cannot tell.
[`perf/linq.bench.ts`](perf/linq.bench.ts) has three implementations of the same journeys against
the same 20,000-row Postgres table:

- **raw**: hand-written SQL through Effect SQL, rows decoded with the same schemas
- **statements**: effect-linq queries, `insert()` and `executeUpdate()`
- **session**: effect-linq with change tracking

```sh
bun run bench:check      # each case once: does it run?
bun run bench:overhead   # raw -> statements: what the library adds
bun run bench            # statements -> session: what tracking adds
bunx strobe bench perf/linq.bench.ts --base main --head .   # did a change help?
```

Results on an Apple M4 Max, macOS, Postgres 17 in Docker on the same machine, Node 22. Each
figure is one measured run, which repeats the journey as noted. The machine was not idle (strobe
warned of background load and high variance), so read the intervals, not just the medians.

**What the library adds** (raw → statements):

| Journey                       | raw     | statements | Run time                         | CPU time        |
| ----------------------------- | ------- | ---------- | -------------------------------- | --------------- |
| 30 queries of 1,000 rows      | 28.6 ms | 29.2 ms    | no clear difference (−4% to +6%) | +7%             |
| 4 queries of 10,000 rows      | 30.0 ms | 30.7 ms    | no clear difference (−3% to +8%) | −5%, not tested |
| 5× load 100 rows, update each | 53.9 ms | 65.1 ms    | +22% (+5% to +42%), slower       | +33%            |
| 4× insert 1,000 rows          | 25.2 ms | 30.3 ms    | +15% (+3% to +32%), slower       | +99%            |

Reads cost the same as hand-written SQL. Writes cost more CPU: every value is validated and
encoded by its column's schema, and each `executeUpdate` is translated when it runs.

**What change tracking adds** (statements → session):

| Journey                       | statements | session | Run time                    | CPU time |
| ----------------------------- | ---------- | ------- | --------------------------- | -------- |
| 30 queries of 1,000 rows      | 29.1 ms    | 32.4 ms | +10% (+3% to +25%), slower  | +14%     |
| 4 queries of 10,000 rows      | 35.0 ms    | 40.1 ms | +15% (+11% to +23%), slower | +31%     |
| 5× load 100 rows, update each | 63.2 ms    | 18.5 ms | −71% (−75% to −69%), faster | −72%     |
| 4× insert 1,000 rows          | 28.8 ms    | 37.8 ms | +33% (+23% to +41%), slower | +98%     |

Tracking makes reads 10–15% slower and pays for itself when many rows are edited to different
values: one batched `UPDATE` instead of a hundred. Inserting through a session is slower than
`insert([...])`, because it returns and tracks every inserted row. When one expression describes
the change, a single set-based `executeUpdate` beats both and needs no read.

Looking for changes among 10,000 tracked rows takes about 77 µs (15.4 ms for 200 scans, 13.3 to
18.6 ms across six launches), roughly 8 ns per row.

`bun run bench:experiments` runs the two design experiments described under
[How it is fast](#how-it-is-fast) (proxies, and Rust compiled to WebAssembly).

## Limitations

Known gaps, roughly in the order they would matter:

- **Migrations are forward-only** (as Effect's `Migrator` is) and do not detect renames. There is
  no command-line tool yet: `Migrations.add` is called from a script. Check constraints, views,
  enums and extensions are not generated.
- **A `Model.Class` field must be in the select variant** to be a column, and fields that are
  not plain columns for Postgres (`Model.JsonFromString`, the SQLite-oriented variants) need a
  matching `hasColumnType`.

- **Change tracking does not follow relations:** no cascading saves of object graphs, no
  ordering of statements by foreign key beyond inserts-updates-deletes, and inserted rows are
  matched to their generated values by position in `RETURNING`.
- `returning()` cannot follow a to-one relation, and an `executeUpdate` over a join that yields
  the same row twice applies one of the values, as in SQL.
- **Postgres only**, tested on 17 with `@effect/sql-pg` 4.1. The SQL uses `json_agg`, `FILTER`,
  `LATERAL` and `starts_with`.
- **Where JavaScript is not followed:** `<`/`>` with null (SQL: no match; JS coerces null to 0),
  string ordering (database collation), `%` on float columns, division by zero (an error), and
  date parts from non-UTC getters (session time zone).
- **Equality between two nullable columns** uses `IS NOT DISTINCT FROM`, which cannot use an
  index. Relation joins are exempt (they use `=`).
- **Lambdas are found syntactically:** inline at the operator call, wrapped in `quote()`, or a
  module-level `const` arrow function in the same file (not `let`, `function` declarations or
  class members). Operators on your own wrapper types need the plugin's `methods` option. Lambda
  bodies are single expressions, and `function` lambdas cannot use `this` or `arguments`.
- **`strict: true` has no per-call opt-out:** an unrelated `.all(…)`, `.select(…)` or `.first(…)`
  call with a multi-statement arrow function (an Express or Hono `app.all(path, handler)`) fails
  the build. Use `exclude` for such files, or leave `strict` off for them.
- **Smaller divergences from JavaScript:** `a && b` used as a value is a boolean; a constant in
  the projection of a left-joined query is not null for unmatched rows; a `leftJoin` condition
  cannot follow a relation.
- **Update lambdas are checked for unknown columns when they run,** not by the type checker.
- **`include` is one level**, by name. For filtered or nested loading, use `select`.
- **`groupBy` must be followed by `select`**; groups cannot be materialized as arrays.
- **JSON columns** are read whole; there is no path navigation inside lambdas.
- **No streaming**, no compiled-query cache (translation is cheap, but it is done every time).
- Without `strict`, an unsupported construct is a build warning plus an error when the lambda is
  used, because the plugin cannot tell a query lambda from a lookalike.
- Built against Effect 4.1's SQL modules and checked with TypeScript 7 only.
