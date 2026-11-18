// What effect-linq costs and buys, measured with strobe (https://github.com/anomalyco/strobe).
// Three implementations of the same journeys against the same Postgres table:
//
//   raw         hand-written SQL through Effect SQL, rows decoded with the same schemas
//   statements  effect-linq queries, insert() and executeUpdate()
//   session     effect-linq with change tracking: load, assign, saveChanges()
//
//   bunx strobe bench perf/linq.bench.ts --check --head .                       does it run?
//   bunx strobe bench perf/linq.bench.ts --base raw --head statements           what the library adds
//   bunx strobe bench perf/linq.bench.ts --base statements --head session       what tracking adds
//   bunx strobe bench perf/linq.bench.ts --base <git ref> --head .              did a change help?
//
// Needs the test database (see README). Lambdas are compiled by the loader hook, as in
// `node --import @blitz/effect-linq/register`.
import { bench, script } from "@hona/strobe";

const node = {
  runtime: "node",
  env: { NODE_OPTIONS: "--import=./src/register.ts" },
} as const;

const journey = (name: string) => ({
  // wall time: the database's share is the point of batching
  primary: "run.duration",
  metrics: ["cpu.work"],
  run: (ctx: { call(name: string): Promise<unknown> }) => ctx.call(name),
});

export default bench({
  // creates and fills the table; the first implementation to get here does the work
  setup: (ctx) => ctx.call("prepare"),
  targets: {
    raw: script("./raw.ts", node),
    statements: script("./statements.ts", node),
    session: script("./session.ts", node),
  },
  cases: {
    // 30 queries of 1,000 rows
    read1000: journey("read1000"),
    // 4 queries of 10,000 rows
    read10000: journey("read10000"),
    // 5 times: load 100 rows and set each to a different value
    edit100: journey("edit100"),
    // 4 times: insert 1,000 rows (and delete them again)
    insert1000: journey("insert1000"),
    // 200 scans of 10,000 tracked rows for changes; no database in the measured run
    detect10000: {
      targets: ["session"],
      primary: "cpu.work",
      metrics: ["run.duration"],
      run: async (ctx) => {
        // loads the rows on the first run only
        await ctx.untimed(() => ctx.call("track10000"));
        await ctx.call("detect10000");
      },
    },
  },
});
