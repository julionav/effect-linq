/**
 * End to end, as a consumer would use the published package: the library is
 * built with `vp pack`, an example application is built against it (minified,
 * with the plugin in strict mode), and run by plain Node. The same program is
 * then run from source through the Node loader hook.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples/blog");
const vp = join(root, "node_modules/.bin/vp");

const exec = (command: string, args: Array<string>, cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("built package", () => {
  beforeAll(() => {
    exec(vp, ["pack"], root);
    if (!existsSync(join(example, "node_modules/effect-linq"))) {
      mkdirSync(join(example, "node_modules"), { recursive: true });
      symlinkSync(root, join(example, "node_modules/effect-linq"), "dir");
    }
    exec(vp, ["pack"], example);
  }, 120_000);

  test("a minified production build runs without the plugin at runtime", () => {
    const bundle = readFileSync(join(example, "dist/main.mjs"), "utf8");
    // minified: parameter names are gone from the code, but the expression trees keep them
    expect(bundle.split("\n").length).toBeLessThan(200);
    expect(/t:[`"']m[`"'],o:/.test(bundle)).toBe(true);
    expect(bundle.includes("oxc-parser")).toBe(false);

    const result = JSON.parse(exec("node", ["dist/main.mjs"], example));
    expect(result.adults).toBe(3);
    expect(result.firstPage.map((post: any) => post.id)).toEqual([5, 3]);
    expect(result.firstPage[0]).toEqual({
      id: 5,
      title: "100% kernel_stuff",
      author: "Linus",
      boss: "Ada",
      comments: [
        { body: "Fast", by: "Ada" },
        { body: "Agreed", by: "Margaret" },
      ],
    });
    expect(result.searched.map((post: any) => post.title)).toEqual(["Bernoulli numbers"]);
    expect(result.leaderboard).toEqual([
      { name: "Ada", posts: 2, bestComment: 5 },
      { name: "Grace", posts: 1, bestComment: 2 },
      { name: "Linus", posts: 1, bestComment: 7 },
    ]);
    expect(result.sql.params).toEqual([]);
    expect(result.sql.sql).toContain("LIMIT 2 OFFSET 2");
  });

  test("the Node loader hook runs the same program from TypeScript source", () => {
    const built = exec("node", ["dist/main.mjs"], example);
    const hooked = exec("node", ["--import", "effect-linq/register", "src/main.ts"], example);
    expect(hooked).toBe(built);
  });

  test("without the plugin, the failure is immediate and explains itself", () => {
    let message = "";
    try {
      exec("node", ["src/main.ts"], example);
    } catch (error) {
      message = String((error as { stderr?: unknown }).stderr);
    }
    expect(message).toMatch(/was not compiled to an expression tree/);
    expect(message).toMatch(/Add the effect-linq plugin/);
  });
});
