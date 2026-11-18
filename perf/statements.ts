/** The journeys with effect-linq queries and explicit write statements, without change tracking. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { cleanup, db, newItem, nextPrice, prepare, repeat, REPEAT } from "./common.ts";

export { prepare };

const byId = db.items.orderBy((i) => i.id);

export const read1000 = () => repeat(REPEAT.read1000, () => byId.take(1000).toArray());
export const read10000 = () => repeat(REPEAT.read10000, () => byId.take(10_000).toArray());

/** Load 100 rows, then one executeUpdate per row in a transaction. */
export const edit100 = () =>
  repeat(REPEAT.edit100, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* db.items.where((i) => i.id <= 100);
      yield* sql.withTransaction(
        Effect.forEach(
          rows,
          (row) =>
            db.items
              .where((i) => i.id === row.id)
              .executeUpdate({ price: nextPrice(row.price, row.id) }),
          { discard: true },
        ),
      );
    }),
  );

export const insert1000 = () =>
  repeat(REPEAT.insert1000, () =>
    Effect.gen(function* () {
      yield* db.items.insert(Array.from({ length: 1000 }, (_, i) => newItem(i)));
      yield* cleanup;
    }),
  );
