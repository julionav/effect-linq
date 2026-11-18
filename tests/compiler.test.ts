import { describe, expect, test } from "vite-plus/test";
import { compile, DEFAULT_FUNCTIONS, DEFAULT_METHODS, mayContainSite } from "../src/compiler.ts";
import type { LambdaAst } from "../src/ir.ts";
import { linq } from "../src/vite.ts";

const QUOTE = Symbol.for("effect-linq/quote");

/** Compiles `source` and evaluates it, returning what the module exports. */
const evaluate = (source: string, scope: Record<string, unknown> = {}): any => {
  const result = compile(source, "/app/src/file.js", { root: "/app" });
  if (result === null) throw new Error("not transformed");
  const names = Object.keys(scope);
  return new Function(...names, `${result.code}\nreturn out;`)(...names.map((n) => scope[n]));
};

/** A stand-in for a query: records the lambdas it is given. */
const recorder = (): any => {
  const calls: Array<{ method: string; ast: LambdaAst; captures: Array<unknown> }> = [];
  const self: any = new Proxy(
    {},
    {
      get: (_, method: string | symbol) =>
        typeof method === "symbol"
          ? () => 0
          : method === "calls"
            ? calls
            : (...args: Array<any>) => {
                for (const arg of args) {
                  if (typeof arg === "function" && arg[QUOTE]) {
                    const quote = arg[QUOTE];
                    calls.push({
                      method,
                      ast: quote.ast,
                      captures: quote.captures.map((thunk: () => unknown) => thunk()),
                    });
                  }
                }
                return self;
              },
    },
  );
  return self;
};

describe("compiler", () => {
  test("leaves files without query operators alone", () => {
    expect(compile("export const x = [1, 2].map((n) => n * 2)", "/a.ts")).toBe(null);
    expect(compile("const where = 1; export { where }", "/a.ts")).toBe(null);
  });

  test("lowers a lambda and captures the values it closes over", () => {
    const q = recorder();
    evaluate(`const min = 18; const out = q.where((u) => u.age >= min + 1 && u.name !== null)`, {
      q,
    });
    expect(q.calls).toHaveLength(1);
    const [{ ast, captures }] = q.calls;
    expect(captures).toEqual([19]);
    expect(ast.loc).toBe("src/file.js:1:37");
    expect(ast.p).toEqual(["u"]);
    expect(ast.b).toEqual({
      t: "b",
      op: "&&",
      l: { t: "b", op: ">=", l: { t: "m", o: { t: "p", n: "u" }, n: "age" }, r: { t: "c", i: 0 } },
      r: {
        t: "b",
        op: "!==",
        l: { t: "m", o: { t: "p", n: "u" }, n: "name" },
        r: { t: "l", v: null },
      },
    });
  });

  test("captures the largest subexpressions that do not depend on the row", () => {
    const q = recorder();
    evaluate(
      `const out = q.where((u) => ids.map((u) => u * 2).includes(u.id) || helper(1, 2) === u.x || u.y === obj.a.b)`,
      { q, ids: [1, 2], helper: (a: number, b: number) => a + b, obj: { a: { b: "deep" } } },
    );
    // `u` inside ids.map(u => ...) shadows the parameter, so the whole call is a capture
    expect(q.calls[0].captures).toEqual([[2, 4], 3, "deep"]);
  });

  test("captures are evaluated lazily, one by one", () => {
    const q = recorder();
    const source = `const out = q.where((u) => flag ? u.a === boom() : u.b === 1)`;
    const result = compile(source, "/f.js")!;
    const fn = new Function("q", "flag", "boom", `${result.code}\nreturn out`);
    let thunks: Array<() => unknown> = [];
    const spy: any = { where: (f: any) => ((thunks = f[QUOTE].captures), spy) };
    fn(spy, false, () => {
      throw new Error("must not run eagerly");
    });
    expect(thunks).toHaveLength(2);
    expect(thunks[0]!()).toBe(false);
    expect(() => thunks[1]!()).toThrow("must not run eagerly");
    expect(q.calls).toHaveLength(0);
  });

  test("nested lambdas, destructuring and literals", () => {
    const q = recorder();
    evaluate(
      `const out = q.select(({ id, tags: [first] }, extra) => ({ id, first, n: 10n, neg: -1, big: u => u, s: \`a\${id}b\`, ...extra, list: [id, null, undefined, true] }))`,
      { q },
    );
    const { ast } = q.calls[0];
    expect(ast.p).toEqual([
      {
        o: [
          ["id", "id"],
          ["tags", { a: ["first"] }],
        ],
      },
      "extra",
    ]);
    expect(ast.b).toEqual({
      t: "o",
      p: [
        ["id", { t: "p", n: "id" }],
        ["first", { t: "p", n: "first" }],
        ["n", { t: "big", v: "10" }],
        ["neg", { t: "l", v: -1 }],
        ["big", { t: "fnx", p: ["u"], b: { t: "p", n: "u" } }],
        ["s", { t: "tpl", q: ["a", "b"], e: [{ t: "p", n: "id" }] }],
        ["...", { t: "p", n: "extra" }],
        [
          "list",
          {
            t: "a",
            e: [
              { t: "p", n: "id" },
              { t: "l", v: null },
              { t: "l", v: null, u: true },
              { t: "l", v: true },
            ],
          },
        ],
      ],
    });
  });

  test("queries built inside a lambda are compiled inside the capture too", () => {
    const outer = recorder();
    const inner = recorder();
    evaluate(
      `const out = outer.where((u) => inner.where((p) => p.ok).count() > 0 && inner.where((p) => p.owner === u.id).any())`,
      { outer, inner },
    );
    expect(outer.calls).toHaveLength(1);
    // the first inner query does not depend on `u`: it is captured as a value, and
    // evaluating the capture ran inner.where with a compiled lambda
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].ast.b).toEqual({ t: "m", o: { t: "p", n: "p" }, n: "ok" });
    // the second depends on `u`: it is part of the outer expression tree
    const and = outer.calls[0].ast.b as any;
    expect(and.r.t).toBe("call");
    expect(and.r.o.a[0].t).toBe("fnx");
  });

  test("TypeScript syntax is understood and preserved", () => {
    const source = [
      `import type { User } from "./types"`,
      `export const out = db.users.where((u: User): boolean => (u.age as number)! >= (min satisfies number) && u.tags!.includes<string>(tag!))`,
    ].join("\n");
    const result = compile(source, "/app/src/q.ts", { root: "/app" })!;
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("(u: User): boolean =>");
    // captures are taken from inside type-only wrappers
    expect(result.code).toContain("[() => (min), () => (tag)]");
    const ast = result.asts[0]!;
    expect((ast.b as any).l.l).toEqual({ t: "m", o: { t: "p", n: "u" }, n: "age" });
  });

  test("the hoisted declarations follow the hashbang and directives", () => {
    const result = compile(
      `#!/usr/bin/env node\n"use client";\nexport const out = q.where((u) => u.a)`,
      "/f.js",
    )!;
    const lines = result.code.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).toMatch(/^"use client";; function __linq_q\(/);
    // no line is added: positions in stack traces stay those of the source
    expect(lines.length).toBe(3);
    const plain = compile(`export const out = q.where((u) => u.a)`, "/f.js")!.code;
    expect(plain).toMatch(/^function __linq_q\(/);
    expect(plain.split("\n").length).toBe(1);
    const hashbang = compile(
      `#!/usr/bin/env node\nexport const out = q.where((u) => u.a)`,
      "/f.js",
    )!;
    expect(hashbang.code.split("\n")[1]).toMatch(/^function __linq_q\(/);
  });

  test("produces a source map that maps the lambda back to its position", () => {
    const source = `export const a = 1;\nexport const out = q.where((u) => u.age > limit);\n`;
    const result = compile(source, "/app/f.ts")!;
    expect(result.map!.sources).toEqual(["/app/f.ts"]);
    expect(result.map!.sourcesContent).toEqual([source]);
    expect(result.map!.mappings.length).toBeGreaterThan(10);
    // the original lambda text is untouched, so the bundler maps into it precisely
    expect(result.code).toContain("(u) => u.age > limit");
  });

  test("unsupported constructs are diagnosed with a location", () => {
    const cases: Array<[string, RegExp]> = [
      [`q.where((u) => { const x = 1; return u.a > x })`, /single expression/],
      [`q.where(async (u) => u.a)`, /^$/],
      [`q.where((u) => u[key])`, /computed member access/],
      [`q.where((u) => new Date(u.a) > d)`, /`new` expressions/],
      [`q.where((u) => u.a instanceof Date)`, /`instanceof` operator/],
      [`q.where((u) => typeof u.a === "string")`, /`typeof` operator/],
      [`q.where((u = 1) => u)`, /default values/],
      [`q.where(({ a, ...rest }) => a)`, /rest elements/],
      [`q.where((u) => f(...u.args))`, /spread arguments/],
      [`q.where((u) => (u.a = 1))`, /assignments/],
      [`q.select((u) => ({ [u.k]: 1 }))`, /computed keys/],
      [`q.where((u) => u.fn()(1))`, /this call cannot be translated/],
    ];
    for (const [source, message] of cases) {
      const result = compile(`const out = ${source}`, "/app/src/f.js", { root: "/app" });
      if (message.source === "^$") {
        // async functions are never query lambdas
        expect(result).toBe(null);
        continue;
      }
      expect(result!.diagnostics, source).toHaveLength(1);
      expect(result!.diagnostics[0]!.message).toMatch(message);
      expect(result!.diagnostics[0]!.file).toBe("src/f.js");
      expect(result!.diagnostics[0]!.line).toBe(1);
    }
    // a block with a single return is fine
    expect(compile(`const out = q.where((u) => { return u.a })`, "/f.js")!.diagnostics).toEqual([]);
    expect(
      compile(`const out = q.where(function (u) { return u.a })`, "/f.js")!.diagnostics,
    ).toEqual([]);
  });

  test("an unsupported lambda still runs as a normal function", () => {
    const calls: Array<number> = [];
    const collection = { where: (f: (n: number) => boolean) => [1, 2, 3].filter(f) };
    const out = evaluate(`const out = collection.where((n) => { calls.push(n); return n > 1 })`, {
      collection,
      calls,
    });
    expect(out).toEqual([2, 3]);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("additional operator names can be registered", () => {
    expect(compile(`const out = q.filterBy((u) => u.a)`, "/f.js")).toBe(null);
    expect(
      compile(`const out = q.filterBy((u) => u.a)`, "/f.js", { methods: ["filterBy"] })!.sites,
    ).toBe(1);
    expect(compile(`const out = expr((u) => u.a)`, "/f.js", { functions: ["expr"] })!.sites).toBe(
      1,
    );
    expect(compile(`const out = quote((u) => u.a)`, "/f.js")!.sites).toBe(1);
  });

  test("files with syntax errors are left to the bundler", () => {
    expect(compile(`const out = q.where((u) => u.`, "/f.js")).toBe(null);
  });
});

describe("plugin", () => {
  const context = () => {
    const warnings: Array<any> = [];
    return {
      warnings,
      warn: (w: any) => void warnings.push(w),
      error: (e: any): never => {
        throw new Error(e.message);
      },
    };
  };

  test("transforms sources, skips node_modules and other file types", () => {
    const plugin = linq();
    plugin.configResolved({ root: "/app" });
    const source = `export const out = q.where((u) => u.a)`;
    const ctx = context();
    expect(plugin.transform.call(ctx, source, "/app/src/a.ts?v=1")!.code).toContain("__linq_q(");
    expect(plugin.transform.call(ctx, source, "/app/node_modules/x/a.js")).toBe(null);
    expect(plugin.transform.call(ctx, source, "/app/src/a.css")).toBe(null);
    expect(plugin.enforce).toBe("pre");
  });

  test("warns by default and fails the build in strict mode", () => {
    const source = `export const out = q.where((u) => { debugger; return u.a })`;
    const ctx = context();
    const lenient = linq();
    lenient.configResolved({ root: "/app" });
    expect(lenient.transform.call(ctx, source, "/app/src/a.ts")).not.toBe(null);
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0].message).toMatch(
      /\[effect-linq\] a query lambda must be a single expression/,
    );
    expect(ctx.warnings[0].loc).toMatchObject({ file: "/app/src/a.ts", line: 1 });
    const strict = linq({ strict: true });
    expect(() => strict.transform.call(context(), source, "/app/src/a.ts")).toThrow(
      /single expression/,
    );
  });
});

describe("review findings", () => {
  const out = (source: string) => compile(source, "/app/f.ts", { root: "/app", sourceMap: false })!;
  const evaluate = (code: string, scope: Record<string, unknown> = {}) =>
    new Function(...Object.keys(scope), `${code.replaceAll("export ", "")}\nreturn out;`)(
      ...Object.values(scope),
    );
  const quoteOf = (fn: any): { ast: LambdaAst; captures: Array<() => unknown> } =>
    fn[Symbol.for("effect-linq/quote")];

  test("a nested lambda that uses the row in a destructuring default is not captured", () => {
    const result = out(`export const out = q.where((u) => xs.some(({ a = u.age }) => a > 1))`);
    expect(result.code).not.toContain("() => (xs.some(");
    // it is reported instead (default values have no translation)
    expect(result.diagnostics.length).toBe(1);
    // a declaration in a nested block does not hide the row from the rest of the function
    const block = out(
      `export const out = q.where((u) => xs.map((x) => { { const u = 1; } return u.a; }))`,
    );
    expect(block.code).not.toContain("() => (xs.map(");
  });

  test("the helpers are hoisted: a query built before the module body has run works", () => {
    const result = out(
      `const early = find();\nfunction find() { return q.where((u) => u.id === limit) }\nexport const out = early;`,
    );
    const q = { where: (fn: unknown) => fn };
    const fn = evaluate(result.code, { q, limit: 3 });
    expect(quoteOf(fn).ast.p).toEqual(["u"]);
    expect(quoteOf(fn).captures[0]!()).toBe(3);
  });

  test("function expressions that use their own context are rejected, not rewritten wrongly", () => {
    for (const body of ["this.min", "arguments[1]", "new.target", "self.limit"]) {
      const result = out(
        `export const out = q.where(function self(u) { return u.id === ${body} })`,
      );
      expect(result.diagnostics.length).toBe(1);
      expect(result.diagnostics[0]!.message).toContain("use an arrow function");
      expect(result.code).toContain(", 0, [])");
      // still valid JavaScript
      new Function(result.code.replaceAll("export ", ""));
    }
    // a plain function expression is fine, and an arrow keeps the enclosing `this` in its thunk
    expect(
      out(`export const out = q.where(function (u) { return u.id === 1 })`).diagnostics,
    ).toEqual([]);
    const arrow = out(`export class A { find() { return q.where((u) => u.id === this.min) } }`);
    expect(arrow.diagnostics).toEqual([]);
    expect(arrow.code).toContain("[() => (this.min)]");
  });

  test("a TypeScript `this` parameter is not a lambda parameter", () => {
    const result = out(`export const out = q.where(function (this: Ctx, u) { return u.id === 1 })`);
    expect(result.asts[0]!.p).toEqual(["u"]);
  });

  test("a parenthesized or cast lambda is still a lambda", () => {
    expect(out(`export const out = q.where(((u) => u.age > min))`).sites).toBe(1);
    const cast = out(`export const out = q.where((u => u.age > min) as any)`);
    expect(cast.sites).toBe(1);
    expect(cast.code).toContain("((__linq_q(u => u.age > min, 0, [() => (min)])) as any)");
  });

  test("a compiled helper keeps its name", () => {
    const result = out(
      `const isAdult = (u) => u.age >= 18;\nexport const out = [q.where(isAdult), isAdult];`,
    );
    const [, helper] = evaluate(result.code, { q: { where: (fn: unknown) => fn } });
    expect(helper.name).toBe("isAdult");
    expect(helper({ age: 20 })).toBe(true);
  });

  test("locations are relative to the root, and never absolute", () => {
    expect(out(`export const out = q.where((u) => u.a)`).asts[0]!.loc).toBe("f.ts:1:28");
    const outside = compile(`export const out = q.where((u) => u.a)`, "/app2/src/f.ts", {
      root: "/app",
    })!;
    expect(outside.asts[0]!.loc).toBe("f.ts:1:28");
    expect(compile(`export const out = q.where((u) => u.a)`, "/home/me/f.ts")!.asts[0]!.loc).toBe(
      "f.ts:1:28",
    );
  });
});

describe("the text check that decides whether a file is parsed", () => {
  const methods = new Set(DEFAULT_METHODS);
  const functions = new Set(DEFAULT_FUNCTIONS);
  const may = (code: string) => mayContainSite(code, methods, functions);

  test("files without a possible query lambda are skipped", () => {
    for (const code of [
      `const total = Math.max(a, b) + items.join(", ")`,
      `await Promise.all([load(1), load(2)])`,
      `const where = 1; wherever(x => x)`,
      `list.count(/* (u) => u */ 3)`,
      "const name = `${a.join(b)}`",
      `const n = 1; list.first(n)`,
      `rows.map((row) => row.id)`,
      `unquote((u) => u.a)`,
      `x.quote((u) => u.a)`,
    ]) {
      expect(may(code), code).toBe(false);
    }
  });

  test("anything that may hold one is parsed", () => {
    for (const code of [
      `q.where((u) => u.a)`,
      `q . where ( u => u.a )`,
      `q?.where(function (u) { return u.a })`,
      `q.where<User>(isAdult)`,
      `const isAdult = (u) => u.age > 17; q.where(isAdult)`,
      `const isAdult: Pred = make(); q.where(isAdult as any)`,
      `q.join(other, (a) => a.id, (b) => b.id)`,
      `q.select((u) => ({ n: \`\${u.a}\` }))`,
      "q.where(`x${(u) => u}`)",
      `q.count(a / b)`,
      `quote((u) => u.a)`,
      `q.where("(" , (u) => u.a)`,
      `q.where(`,
    ]) {
      expect(may(code), code).toBe(true);
    }
  });

  test("skipped files and parsed files compile to the same result", () => {
    // every site the compiler finds is in a file the text check lets through
    const sources = [
      `const f = async (u) => u; q.where(f)`,
      `export const big = (u) => u.age > 1e3; q.where(big)`,
      `q.orderBy((u) => u.a).thenBy((u) => u.b)`,
    ];
    for (const source of sources) {
      if (compile(source, "/f.ts") !== null) expect(may(source), source).toBe(true);
    }
  });
});
