/**
 * Runs one journey of one implementation in a loop, for profiling:
 *
 *     node --cpu-prof --cpu-prof-dir=/tmp/prof --import ./src/register.ts perf/profile.ts statements edit100 40
 */
const [impl = "statements", journey = "edit100", rounds = "40"] = process.argv.slice(2);
const module: Record<string, () => Promise<unknown>> = await import(`./${impl}.ts`);
await module.prepare!();
const run = module[journey] ?? (() => Promise.reject(new Error(`no journey ${journey}`)));
for (let i = 0; i < 5; i++) await run();
const start = performance.now();
for (let i = 0; i < Number(rounds); i++) await run();
console.log(
  `${impl} ${journey}: ${((performance.now() - start) / Number(rounds)).toFixed(2)} ms per run`,
);
process.exit(0);
