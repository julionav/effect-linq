/** The journeys with change tracking: load into a session, assign, saveChanges. */
import { Effect } from "effect";
import { session } from "../src/index.ts";
import { cleanup, db, newItem, nextPrice, prepare, repeat, REPEAT, run } from "./common.ts";

export { prepare };

const byId = db.items.orderBy((i) => i.id);

export const read1000 = () => repeat(REPEAT.read1000, () => session().load(byId.take(1000)));
export const read10000 = () => repeat(REPEAT.read10000, () => session().load(byId.take(10_000)));

/** Load 100 rows, assign, and save: one SELECT and one UPDATE. */
export const edit100 = () =>
  repeat(REPEAT.edit100, () =>
    Effect.gen(function* () {
      const uow = session();
      const rows = yield* uow.load(db.items.where((i) => i.id <= 100));
      for (const row of rows) row.price = nextPrice(row.price, row.id);
      yield* uow.saveChanges();
    }),
  );

export const insert1000 = () =>
  repeat(REPEAT.insert1000, () =>
    Effect.gen(function* () {
      const uow = session();
      for (let i = 0; i < 1000; i++) uow.add(db.items, newItem(i));
      yield* uow.saveChanges();
      yield* cleanup;
    }),
  );

// ---- only a session has these

let tracked: ReturnType<typeof session> | undefined;

/** Tracks 10,000 rows once, outside the measured runs. */
export const track10000 = async (): Promise<number> => {
  if (tracked !== undefined) return tracked.size;
  tracked = session();
  return (await run(tracked.load(byId.take(10_000)))).length;
};

/** Looks for changes among 10,000 tracked rows, 200 times: what saveChanges costs when little changed. */
export const detect10000 = (): number => {
  let found = 0;
  for (let i = 0; i < 200; i++) if (tracked!.hasChanges()) found++;
  return found;
};
