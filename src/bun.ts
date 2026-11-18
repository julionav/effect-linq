/**
 * The plugin for Bun, for servers and scripts that Bun runs without a bundler.
 * Preload it with its defaults:
 *
 *     bun --preload @blitz/effect-linq/bun/register main.ts
 *
 * or, to choose the files, from a preload script of your own:
 *
 *     import { plugin } from "bun";
 *     import { linq } from "@blitz/effect-linq/bun";
 *     plugin(linq({ include: /[\\/]src[\\/].*\.ts$/ }));
 *
 * The same object works in `Bun.build({ plugins: [linq()] })`.
 */
import { readFileSync } from "node:fs";
import { compile, type CompileOptions } from "./compiler.ts";

export interface LinqBunOptions extends Pick<CompileOptions, "methods" | "functions"> {
  /**
   * Throw when a query lambda uses a construct that has no SQL translation.
   * When false (the default) a warning is printed and the error is raised
   * when the lambda is used.
   */
  readonly strict?: boolean;
  /** Files to transform. Defaults to JS and TS sources. */
  readonly include?: RegExp;
  /** Files to skip. Defaults to `node_modules`. */
  readonly exclude?: RegExp;
  /** Locations in messages are relative to it. Defaults to the working directory. */
  readonly root?: string;
}

type Loader = "js" | "jsx" | "ts" | "tsx";

/** The part of Bun's plugin API that is used, so that Bun's types are not needed. */
export interface LinqBunPlugin {
  readonly name: string;
  setup(build: {
    onLoad(
      constraints: { readonly filter: RegExp; readonly namespace?: string },
      callback: (args: { readonly path: string }) => { contents: string; loader: Loader },
    ): unknown;
  }): void;
}

const loaderOf = (path: string): Loader => {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  switch (extension) {
    case "tsx":
    case "jsx":
      return extension;
    case "ts":
    case "mts":
    case "cts":
      return "ts";
    default:
      return "js";
  }
};

export const linq = (options: LinqBunOptions = {}): LinqBunPlugin => {
  const include = options.include ?? /\.[cm]?[jt]sx?$/;
  const exclude = options.exclude ?? /[\\/]node_modules[\\/]/;
  const root = options.root ?? process.cwd();
  return {
    name: "effect-linq",
    setup(build) {
      build.onLoad({ filter: include, namespace: "file" }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const loader = loaderOf(path);
        if (exclude.test(path)) return { contents: source, loader };
        const result = compile(source, path, {
          root,
          sourceMap: false,
          methods: options.methods,
          functions: options.functions,
        });
        if (result === null) return { contents: source, loader };
        for (const diagnostic of result.diagnostics) {
          const message = `${diagnostic.message} (${diagnostic.file}:${diagnostic.line}:${diagnostic.column})`;
          if (options.strict) throw new Error(`[effect-linq] ${message}`);
          process.emitWarning(message, "LinqWarning");
        }
        return { contents: result.code, loader };
      });
    },
  };
};

export default linq;
