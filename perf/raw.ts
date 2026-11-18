/** The journeys as hand-written SQL through Effect SQL: the baseline for what the library adds. */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { cleanup, Item, newItem, nextPrice, prepare, repeat, REPEAT } from "./common.ts";

export { prepare };

interface Wire {
  readonly id: number;
  readonly owner_id: number;
  readonly name: string;
  readonly price: string;
  readonly active: boolean;
  readonly created_at: Date;
}

// what a careful hand-written data layer does: decode each row through the same schemas
const decodePrice = Schema.decodeUnknownSync(Item.fields.price);
const decodeCreatedAt = Schema.decodeUnknownSync(Item.fields.createdAt);
const decode = (row: Wire) => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  price: decodePrice(row.price),
  active: row.active,
  createdAt: decodeCreatedAt(row.created_at),
});

const read = (limit: number) =>
  Effect.map(
    SqlClient.use(
      (sql) =>
        sql<Wire>`select id, owner_id, name, price, active, created_at from linq_bench.p_items order by id limit ${limit}`,
    ),
    (rows) => rows.map(decode),
  );

export const read1000 = () => repeat(REPEAT.read1000, () => read(1000));
export const read10000 = () => repeat(REPEAT.read10000, () => read(10_000));

/** Load 100 rows, then one UPDATE per row in a transaction: the usual hand-written shape. */
export const edit100 = () =>
  repeat(REPEAT.edit100, () =>
    SqlClient.use((sql) =>
      Effect.gen(function* () {
        const rows =
          (yield* sql<Wire>`select id, owner_id, name, price, active, created_at from linq_bench.p_items where id <= 100`).map(
            decode,
          );
        yield* sql.withTransaction(
          Effect.forEach(
            rows,
            (row) =>
              sql`update linq_bench.p_items set price = ${String(nextPrice(row.price, row.id))} where id = ${row.id}`,
            { discard: true },
          ),
        );
      }),
    ),
  );

export const insert1000 = () =>
  repeat(REPEAT.insert1000, () =>
    SqlClient.use((sql) =>
      Effect.gen(function* () {
        const rows = Array.from({ length: 1000 }, (_, i): Record<string, unknown> => {
          const item = newItem(i);
          return {
            owner_id: item.ownerId,
            name: item.name,
            price: String(item.price),
            active: item.active,
          };
        });
        yield* sql`insert into linq_bench.p_items ${sql.insert(rows as [Record<string, unknown>, ...Array<Record<string, unknown>>])}`;
        yield* cleanup;
      }),
    ),
  );
