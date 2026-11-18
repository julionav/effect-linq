/**
 * The build plugin. It is a plain Rollup-style plugin object, so it works in
 * Vite, Vitest, Rolldown and tsdown (`vp pack`).
 */
import { compile, type CompileOptions } from "./compiler.ts";

export interface LinqPluginOptions extends Pick<CompileOptions, "methods" | "functions"> {
  /**
   * Fail the build when a query lambda uses a construct that has no SQL
   * translation. When false (the default) a warning is printed and the error
   * is raised when the lambda is used, because the transform cannot tell a
   * query lambda from a lambda passed to an unrelated method of the same name.
   */
  readonly strict?: boolean;
  /** Files to transform. Defaults to JS and TS sources. */
  readonly include?: RegExp;
  /** Files to skip. Defaults to `node_modules`. */
  readonly exclude?: RegExp;
}

interface TransformContext {
  warn(message: string | { message: string; id?: string; loc?: object }): void;
  error(message: string | { message: string; id?: string; loc?: object }): never;
}

export interface LinqPlugin {
  readonly name: string;
  readonly enforce: "pre";
  configResolved(config: { readonly root: string }): void;
  transform(
    this: TransformContext,
    code: string,
    id: string,
  ): { code: string; map: any } | null | undefined;
}

export const linq = (options: LinqPluginOptions = {}): LinqPlugin => {
  const include = options.include ?? /\.[cm]?[jt]sx?$/;
  const exclude = options.exclude ?? /[\\/]node_modules[\\/]/;
  let root = process.cwd();
  return {
    name: "effect-linq",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split("?", 1)[0]!;
      if (!include.test(file) || exclude.test(file)) return null;
      const result = compile(code, file, {
        root,
        methods: options.methods,
        functions: options.functions,
      });
      if (result === null) return null;
      for (const diagnostic of result.diagnostics) {
        const report = {
          message: `[effect-linq] ${diagnostic.message}`,
          id: file,
          loc: { file, line: diagnostic.line, column: diagnostic.column - 1 },
        };
        if (options.strict) this.error(report);
        else this.warn(report);
      }
      return { code: result.code, map: result.map };
    },
  };
};

export default linq;
