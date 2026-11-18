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
    if (!existsSync(join(example, "node_modules/@blitz/effect-linq"))) {
      mkdirSync(join(example, "node_modules/@blitz"), { recursive: true });
      symlinkSync(root, join(example, "node_modules/@blitz/effect-linq"), "dir");
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
    const hooked = exec(
      "node",
      ["--import", "@blitz/effect-linq/register", "src/main.ts"],
      example,
    );
    expect(hooked).toBe(built);
  });

  test("the Bun plugin runs the same program from TypeScript source", () => {
    const built = exec("node", ["dist/main.mjs"], example);
    const preloaded = exec(
      "bun",
      ["--preload", "@blitz/effect-linq/bun/register", "src/main.ts"],
      example,
    );
    expect(preloaded).toBe(built);
  });

  test("a bundle made by Bun.build with the plugin runs without it", () => {
    const built = exec("node", ["dist/main.mjs"], example);
    exec("bun", ["build.bun.ts"], example);
    const bundle = readFileSync(join(example, "dist-bun/main.js"), "utf8");
    expect(bundle.includes("oxc-parser")).toBe(false);
    expect(exec("bun", ["dist-bun/main.js"], example)).toBe(built);
  });

  test("the Bun plugin transforms the files it is told to and passes the rest through", async () => {
    const { linq } = await import("../src/bun.ts");
    const loaders: Array<{
      filter: RegExp;
      load: (args: { path: string }) => { contents: string; loader: string };
    }> = [];
    linq({ exclude: /schema\.ts$/ }).setup({
      onLoad: (constraints, load) => loaders.push({ filter: constraints.filter, load }),
    });
    const [{ filter, load }] = loaders as [(typeof loaders)[number]];
    const main = join(example, "src/main.ts");
    const schema = join(example, "src/schema.ts");
    expect(filter.test(main)).toBe(true);
    expect(filter.test(join(example, "package.json"))).toBe(false);
    expect(load({ path: main })).toMatchObject({ loader: "ts" });
    expect(load({ path: main }).contents).toContain("__linq_q(");
    // excluded: handed back as it is
    expect(load({ path: schema }).contents).toBe(readFileSync(schema, "utf8"));
    // nothing to compile: handed back as it is
    const config = join(example, "vite.config.ts");
    expect(load({ path: config }).contents).toBe(readFileSync(config, "utf8"));
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
