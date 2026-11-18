/**
 * Installs the Bun plugin with its defaults. Preload it:
 *
 *     bun --preload @blitz/effect-linq/bun/register main.ts
 *
 * or in `bunfig.toml`: `preload = ["@blitz/effect-linq/bun/register"]`.
 */
import { linq } from "./bun.ts";

const bun = (globalThis as { Bun?: { plugin(plugin: unknown): unknown } }).Bun;
if (bun === undefined) {
  throw new Error(
    "@blitz/effect-linq/bun/register needs Bun; under Node use --import @blitz/effect-linq/register",
  );
}
bun.plugin(linq());
