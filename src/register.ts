/**
 * Compiles query lambdas when modules are loaded by Node itself, for scripts
 * and servers that run without a bundler:
 *
 *     node --import effect-linq/register app.ts
 */
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { compile } from "./compiler.ts";

const root = process.cwd();
const SOURCE = /\.[cm]?[jt]sx?$/;
const EXCLUDED = /[\\/]node_modules[\\/]/;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:") || result.source == null) return result;
    const file = fileURLToPath(url);
    if (!SOURCE.test(file) || EXCLUDED.test(file)) return result;
    const source =
      typeof result.source === "string"
        ? result.source
        : Buffer.from(result.source as Uint8Array).toString("utf8");
    const compiled = compile(source, file, { root, sourceMap: false });
    if (compiled === null) return result;
    for (const diagnostic of compiled.diagnostics) {
      process.emitWarning(
        `${diagnostic.message} (${diagnostic.file}:${diagnostic.line}:${diagnostic.column})`,
        "LinqWarning",
      );
    }
    return { ...result, source: compiled.code };
  },
});
