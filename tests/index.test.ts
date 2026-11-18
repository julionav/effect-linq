import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { db, PgLive } from "./schema.ts";

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(PgLive)) as Effect.Effect<A, E>);

test("smoke", async () => {
  const minAge = 18;
  const q = db.users.where((u) => u.age !== null && u.age >= minAge).orderBy((u) => u.id);
  console.log(q.toSql());
  const rows = await run(q.toArray());
  console.log(rows);
  expect(rows.map((r) => r.name)).toEqual(["Ada", "Grace", "Margaret"]);
});
