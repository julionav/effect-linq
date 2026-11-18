/**
 * Build-time compiler: finds lambdas passed to query operators and attaches a
 * data representation (see `ir.ts`) to each one.
 *
 * `db.users.where(u => u.age >= minAge)` becomes
 * `db.users.where(__linq_q(u => u.age >= minAge, __linq_0, [() => (minAge)]))`
 * where `__linq_0` is the static expression tree, hoisted to module scope.
 *
 * The transform is purely syntactic (no type information), so it also wraps
 * lambdas passed to unrelated methods that happen to share a name. That is
 * harmless: the lambda stays a normal function, with one extra property.
 */
import MagicString from "magic-string";
import { parseSync } from "oxc-parser";
import type { BinaryOp, LambdaAst, Node, Pattern } from "./ir.ts";

export interface CompileOptions {
  /**
   * Method names whose lambda arguments are quoted, in addition to the
   * built-in query operators.
   */
  readonly methods?: ReadonlyArray<string>;
  /**
   * Free functions whose lambda arguments are quoted, in addition to `quote`.
   */
  readonly functions?: ReadonlyArray<string>;
  /** Path the reported locations are made relative to. */
  readonly root?: string;
  readonly sourceMap?: boolean;
}

export interface Diagnostic {
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface CompileResult {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]> | null;
  /** Lambdas that use constructs with no SQL translation. */
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  /** Number of lambdas quoted. */
  readonly sites: number;
  /** The expression tree of each lambda, in the order they are numbered. */
  readonly asts: ReadonlyArray<LambdaAst>;
}

/** Query operators that take a lambda. */
export const DEFAULT_METHODS: ReadonlyArray<string> = [
  "where",
  "select",
  "selectMany",
  "orderBy",
  "orderByDescending",
  "thenBy",
  "thenByDescending",
  "groupBy",
  "join",
  "leftJoin",
  "first",
  "firstOption",
  "count",
  "any",
  "all",
  "sum",
  "min",
  "max",
  "average",
  "one",
  "optional",
  "many",
  "hasOne",
  "hasOptional",
  "hasMany",
  "executeUpdate",
  "returning",
  "onConflictDoUpdate",
];

export const DEFAULT_FUNCTIONS: ReadonlyArray<string> = ["quote"];

const HELPER = "__linq_q";
const TREES = "__linq_a";
// Function declarations, so that they are usable before the module body has
// run (a function hoisted out of an import cycle may reach a query early).
// `n` restores the name a `const helper = (row) => ...` would have inferred.
const helperSource = (trees: string): string =>
  `function ${HELPER}(f, i, c, n) { f[Symbol.for("effect-linq/quote")] = { ast: ${TREES}()[i], captures: c }; ` +
  `if (n) Object.defineProperty(f, "name", { value: n, configurable: true }); return f; } ` +
  `function ${TREES}() { return ${TREES}.v ??= [${trees}]; }`;

type Ast = any;

const BINARY_OPS = new Set<string>([
  "===",
  "!==",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&&",
  "||",
  "??",
]);

const isFunctionNode = (node: Ast): boolean =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

/** Strips wrappers that have no runtime meaning. */
const unwrap = (node: Ast): Ast => {
  for (;;) {
    switch (node.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSInstantiationExpression":
      case "ChainExpression":
        node = node.expression;
        continue;
      default:
        return node;
    }
  }
};

const children = (node: Ast, visit: (child: Ast, key: string) => void): void => {
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object" && typeof item.type === "string") {
          visit(item, key);
        }
      }
    } else if (typeof value.type === "string") {
      visit(value, key);
    }
  }
};

/** Names bound by a binding pattern. */
const patternNames = (pattern: Ast, out: Set<string>): void => {
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) patternNames(element, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, out);
      break;
  }
};

/**
 * Names that are certainly rebound throughout a function: its parameters and
 * the declarations at the top level of its body. A declaration in a nested
 * block only shadows part of the function, so it is not counted; a use of the
 * name is then taken to refer to the outer binding, which errs on the side of
 * translating rather than capturing.
 */
const declaredNames = (fn: Ast): Set<string> => {
  const names = new Set<string>();
  for (const param of fn.params) patternNames(param, names);
  const statements: Array<Ast> = fn.body?.body ?? fn.body?.statements ?? [];
  if (!Array.isArray(statements)) return names;
  for (const node of statements) {
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) patternNames(declarator.id, names);
    } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (node.id) names.add(node.id.name);
    }
  }
  return names;
};

/** Does a non-arrow function use something that means another thing outside of it? */
const usesOwnContext = (fn: Ast): boolean => {
  const own: string | undefined = fn.id?.name;
  let found = false;
  const walk = (node: Ast): void => {
    if (found) return;
    if (
      node.type === "ThisExpression" ||
      node.type === "MetaProperty" ||
      node.type === "Super" ||
      (node.type === "Identifier" && (node.name === "arguments" || node.name === own))
    ) {
      found = true;
      return;
    }
    // nested non-arrow functions have their own `this` and `arguments`
    if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return;
    children(node, walk);
  };
  walk(fn.body);
  return found;
};

/** A TypeScript `this` parameter is a type annotation, not a parameter. */
const realParams = (fn: Ast): Array<Ast> =>
  fn.params.length > 0 && fn.params[0].type === "Identifier" && fn.params[0].name === "this"
    ? fn.params.slice(1)
    : fn.params;

interface Site {
  readonly fn: Ast;
  readonly method: string;
  readonly index: number;
  astName: string;
  thunks: Array<Ast>;
  /** found by name rather than at an operator call: never reported at build time */
  readonly silent?: boolean;
  /** the helper's name, which wrapping the function would otherwise lose */
  readonly name?: string;
}

class Unsupported extends Error {
  readonly node: Ast;
  constructor(message: string, node: Ast) {
    super(message);
    this.node = node;
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sitePatterns = new Map<string, RegExp>();

const isWordChar = (code: number): boolean =>
  (code >= 97 && code <= 122) || // a-z
  (code >= 65 && code <= 90) || // A-Z
  (code >= 48 && code <= 57) || // 0-9
  code === 95 || // _
  code === 36; // $

/**
 * Decides from the text alone whether a file can contain a query lambda, so
 * that the others are never parsed. It looks for a call of an operator whose
 * arguments hold a function, or a name the file declares with `const`.
 *
 * It errs on the side of parsing: anything it cannot read cheaply (a template
 * literal, a `/` that may start a regular expression, type arguments) counts
 * as a possible site.
 */
export const mayContainSite = (
  code: string,
  methods: ReadonlySet<string>,
  functions: ReadonlySet<string>,
): boolean => {
  const key = `${[...methods].join("|")}/${[...functions].join("|")}`;
  let pattern = sitePatterns.get(key);
  if (pattern === undefined) {
    const alternatives: Array<string> = [];
    if (methods.size > 0) {
      alternatives.push(`\\.\\s*(?:${[...methods].map(escapeRegExp).join("|")})`);
    }
    if (functions.size > 0) {
      alternatives.push(`(?<![.\\w$])(?:${[...functions].map(escapeRegExp).join("|")})`);
    }
    if (alternatives.length === 0) return false;
    pattern = new RegExp(`(?:${alternatives.join("|")})\\s*([(<])`, "g");
    sitePatterns.set(key, pattern);
  }
  let declared: Set<string> | undefined;
  /** Is `word` a `const` of this file that can hold a function? */
  const isHelper = (word: string): boolean => {
    if (declared === undefined) {
      declared = new Set();
      // `const name = (`, `= x =>`, `= function`, `= <T>(`, or any annotated const
      const helpers =
        /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::|=\s*(?:async\b|function\b|[(<]|[A-Za-z_$][\w$]*\s*=>))/g;
      for (const found of code.matchAll(helpers)) declared.add(found[1]!);
    }
    return declared.has(word);
  };
  /**
   * Reads code from `i` up to the bracket that closes the one it started in.
   * Returns the position of that bracket, or -1 when the code may hold a
   * query lambda (or cannot be read cheaply).
   */
  const scan = (i: number): number => {
    let depth = 1;
    for (; i < code.length; i++) {
      const char = code.charCodeAt(i);
      switch (char) {
        case 40: // (
        case 91: // [
        case 123: // {
          depth++;
          break;
        case 41: // )
        case 93: // ]
        case 125: // }
          if (--depth === 0) return i;
          break;
        case 34: // "
        case 39: {
          // '
          for (i++; i < code.length; i++) {
            const inner = code.charCodeAt(i);
            if (inner === 92) i++;
            else if (inner === char || inner === 10) break;
          }
          break;
        }
        case 96: {
          // ` : a template, whose ${} parts are code again
          for (i++; ; i++) {
            if (i >= code.length) return -1;
            const inner = code.charCodeAt(i);
            if (inner === 92) i++;
            else if (inner === 96) break;
            else if (inner === 36 && code.charCodeAt(i + 1) === 123) {
              i = scan(i + 2);
              if (i === -1) return -1;
            }
          }
          break;
        }
        case 47: {
          // /
          const next = code.charCodeAt(i + 1);
          if (next === 47) {
            const end = code.indexOf("\n", i);
            if (end === -1) return -1;
            i = end;
          } else if (next === 42) {
            const end = code.indexOf("*/", i + 2);
            if (end === -1) return -1;
            i = end + 1;
          } else {
            // a division or a regular expression: not worth telling apart
            return -1;
          }
          break;
        }
        case 61: // =
          if (code.charCodeAt(i + 1) === 62) return -1; // =>
          break;
        default:
          if (char >= 48 && char <= 57) {
            // a number: skip it whole, so that `1e3` is not read as a name
            while (i + 1 < code.length && isWordChar(code.charCodeAt(i + 1))) i++;
          } else if (isWordChar(char)) {
            const start = i;
            while (i + 1 < code.length && isWordChar(code.charCodeAt(i + 1))) i++;
            // a member name is not a reference: `row.name`
            if (code.charCodeAt(start - 1) === 46) break;
            const word = code.slice(start, i + 1);
            if (word === "function" || isHelper(word)) return -1;
          }
      }
    }
    return -1;
  };
  pattern.lastIndex = 0;
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
    if (match[1] === "<" || scan(pattern.lastIndex) === -1) return true;
  }
  return false;
};

export const compile = (
  code: string,
  id: string,
  options: CompileOptions = {},
): CompileResult | null => {
  const methods = new Set([...DEFAULT_METHODS, ...(options.methods ?? [])]);
  const functions = new Set([...DEFAULT_FUNCTIONS, ...(options.functions ?? [])]);

  // Cheap pre-filter: most files have no call site, and parsing is the cost.
  if (!mayContainSite(code, methods, functions)) return null;

  const parsed = parseSync(id, code);
  if (parsed.errors.length > 0) {
    // Leave syntax errors to the bundler, which reports them better.
    return null;
  }
  const program: Ast = parsed.program;

  // Locations end up in the shipped code: relative to the root, never an
  // absolute path of the machine that built it.
  const rootDir = options.root?.replace(/[\\/]+$/, "");
  const file =
    rootDir !== undefined && (id.startsWith(`${rootDir}/`) || id.startsWith(`${rootDir}\\`))
      ? id.slice(rootDir.length + 1)
      : (id.split(/[\\/]/).pop() ?? id);

  // line starts, for locations
  const lineStarts: Array<number> = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const position = (offset: number): { line: number; column: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
  };

  // ---------------------------------------------------------------- find sites
  const sites: Array<Site> = [];
  const findSites = (node: Ast): void => {
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      let method: string | undefined;
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        methods.has(callee.property.name)
      ) {
        method = callee.property.name;
      } else if (callee.type === "Identifier" && functions.has(callee.name)) {
        method = callee.name;
      }
      if (method !== undefined) {
        for (const argument of node.arguments) {
          // `where((u => ...) as any)` and `where(((u) => ...))` are lambdas too
          const arg = argument.type === "SpreadElement" ? argument : unwrap(argument);
          if (isFunctionNode(arg) && !arg.async && !arg.generator) {
            sites.push({ fn: arg, method, index: sites.length, astName: "", thunks: [] });
          } else if (arg.type === "Identifier") {
            named.add(arg.name);
          }
        }
      }
    }
    children(node, findSites);
  };

  // Module-level `const helper = (row) => ...` functions are query expressions
  // too when a query refers to them by name: passed to an operator
  // (`where(isAdult)`) or called inside a query lambda (`u => isAdult(u)`).
  const helpers = new Map<string, Ast>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || !declarator.init) continue;
      const init = unwrap(declarator.init);
      if (isFunctionNode(init) && !init.async && !init.generator) {
        helpers.set(declarator.id.name, init);
      }
    }
  }
  const named = new Set<string>();
  findSites(program);
  if (helpers.size > 0 && (sites.length > 0 || named.size > 0)) {
    // a name bound more than once in the file may not refer to the helper
    const bindings = new Map<string, number>();
    const bind = (pattern: Ast): void => {
      const names = new Set<string>();
      patternNames(pattern, names);
      for (const name of names) bindings.set(name, (bindings.get(name) ?? 0) + 1);
    };
    const countBindings = (node: Ast): void => {
      if (node.type === "VariableDeclarator") bind(node.id);
      else if (node.type === "CatchClause" && node.param) bind(node.param);
      else if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) bind(specifier.local);
      }
      if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
        bind(node.id);
      }
      if (Array.isArray(node.params)) for (const param of node.params) bind(param);
      children(node, countBindings);
    };
    countBindings(program);
    const taken = new Set<Ast>(sites.map((site) => site.fn));
    const queue: Array<Ast> = [];
    const adopt = (name: string): void => {
      const fn = helpers.get(name);
      if (fn === undefined || taken.has(fn) || bindings.get(name) !== 1) return;
      taken.add(fn);
      queue.push(fn);
      sites.push({
        fn,
        method: "quote",
        index: sites.length,
        astName: "",
        thunks: [],
        silent: true,
        name,
      });
    };
    const findCalls = (node: Ast): void => {
      if (node.type === "CallExpression") {
        const callee = unwrap(node.callee);
        if (callee.type === "Identifier") adopt(callee.name);
      }
      children(node, findCalls);
    };
    for (const name of named) adopt(name);
    const direct = sites.length;
    for (let i = 0; i < direct; i++) if (!sites[i]!.silent) findCalls(sites[i]!.fn.body);
    for (let fn = queue.pop(); fn !== undefined; fn = queue.pop()) findCalls(fn.body);
  }
  if (sites.length === 0) return null;
  sites.sort((a, b) => a.fn.start - b.fn.start);

  const diagnostics: Array<Diagnostic> = [];
  const hoisted: Array<string> = [];

  // ------------------------------------------------------------------ lowering
  const lowerSite = (site: Site): LambdaAst => {
    const thunks: Array<Ast> = site.thunks;

    /** Does `node` reference any name in `bound`? Respects shadowing. */
    const depends = (node: Ast, bound: ReadonlySet<string>): boolean => {
      if (bound.size === 0) return false;
      switch (node.type) {
        case "Identifier":
          return bound.has(node.name);
        case "MemberExpression":
          return depends(node.object, bound) || (node.computed && depends(node.property, bound));
        case "Property":
          return (node.computed && depends(node.key, bound)) || depends(node.value, bound);
        case "ArrowFunctionExpression":
        case "FunctionExpression":
        case "FunctionDeclaration": {
          const shadow = declaredNames(node);
          let inner = bound;
          for (const name of shadow) {
            if (inner.has(name)) {
              if (inner === bound) inner = new Set(bound);
              (inner as Set<string>).delete(name);
            }
          }
          // default values, anywhere in a parameter pattern, see the outer scope
          const defaults = (pattern: Ast): boolean => {
            switch (pattern?.type) {
              case "AssignmentPattern":
                return depends(pattern.right, bound) || defaults(pattern.left);
              case "ObjectPattern":
                return pattern.properties.some((prop: Ast) =>
                  prop.type === "RestElement"
                    ? defaults(prop.argument)
                    : (prop.computed && depends(prop.key, bound)) || defaults(prop.value),
                );
              case "ArrayPattern":
                return pattern.elements.some((element: Ast) => element && defaults(element));
              case "RestElement":
                return defaults(pattern.argument);
              case "TSParameterProperty":
                return defaults(pattern.parameter);
              default:
                return false;
            }
          };
          for (const param of node.params) if (defaults(param)) return true;
          return depends(node.body, inner);
        }
        default: {
          if (node.type.startsWith("TS") && !EXPRESSION_TS.has(node.type)) return false;
          let found = false;
          children(node, (child, key) => {
            if (found) return;
            if (key === "typeAnnotation" || key === "typeArguments" || key === "typeParameters") {
              return;
            }
            if (depends(child, bound)) found = true;
          });
          return found;
        }
      }
    };

    const containsSuspension = (node: Ast): boolean => {
      if (node.type === "AwaitExpression" || node.type === "YieldExpression") return true;
      if (isFunctionNode(node)) return false;
      let found = false;
      children(node, (child) => {
        if (!found && containsSuspension(child)) found = true;
      });
      return found;
    };

    const capture = (node: Ast): Node => {
      if (containsSuspension(node)) {
        throw new Unsupported("`await` and `yield` cannot be used inside a query lambda", node);
      }
      thunks.push(node);
      return { t: "c", i: thunks.length - 1 };
    };

    const lowerPattern = (pattern: Ast): Pattern => {
      switch (pattern.type) {
        case "Identifier":
          return pattern.name;
        case "ObjectPattern": {
          const props: Array<readonly [string, Pattern]> = [];
          for (const prop of pattern.properties) {
            if (prop.type === "RestElement") {
              throw new Unsupported("rest elements are not supported in query lambdas", prop);
            }
            if (prop.computed) {
              throw new Unsupported("computed keys are not supported in query lambdas", prop);
            }
            const key =
              prop.key.type === "Identifier" ? prop.key.name : String((prop.key as Ast).value);
            props.push([key, lowerPattern(prop.value)]);
          }
          return { o: props };
        }
        case "ArrayPattern":
          return {
            a: pattern.elements.map((element: Ast) =>
              element === null ? null : lowerPattern(element),
            ),
          };
        case "AssignmentPattern":
          throw new Unsupported("default values are not supported in query lambdas", pattern);
        default:
          throw new Unsupported(
            `unsupported parameter syntax (${pattern.type}) in a query lambda`,
            pattern,
          );
      }
    };

    const lowerLambda = (fn: Ast, outer: ReadonlySet<string>): { p: Array<Pattern>; b: Node } => {
      if (fn.async || fn.generator) {
        throw new Unsupported("async and generator functions cannot be translated to SQL", fn);
      }
      if (fn.type === "FunctionExpression" && usesOwnContext(fn)) {
        throw new Unsupported(
          "`this`, `arguments`, `new.target` and the function's own name cannot be used in a " +
            "query lambda; use an arrow function",
          fn,
        );
      }
      const bound = new Set(outer);
      const p: Array<Pattern> = [];
      for (const param of realParams(fn)) {
        p.push(lowerPattern(param));
        patternNames(param, bound);
      }
      let body: Ast = fn.body;
      if (body.type === "BlockStatement" || body.type === "FunctionBody") {
        const statements = body.body ?? body.statements;
        if (
          statements.length !== 1 ||
          statements[0].type !== "ReturnStatement" ||
          !statements[0].argument
        ) {
          throw new Unsupported(
            "a query lambda must be a single expression (or a block with a single `return`)",
            body,
          );
        }
        body = statements[0].argument;
      }
      return { p, b: lower(body, bound) };
    };

    const lower = (raw: Ast, bound: ReadonlySet<string>): Node => {
      const node = unwrap(raw);

      if (node.type === "Literal") {
        if (node.bigint !== undefined) return { t: "big", v: String(node.bigint) };
        if (node.regex !== undefined) return capture(node);
        const value = node.value;
        if (value === null || typeof value === "string" || typeof value === "boolean") {
          return { t: "l", v: value };
        }
        if (typeof value === "number") return { t: "l", v: value };
        return capture(node);
      }
      if (node.type === "Identifier" && node.name === "undefined" && !bound.has("undefined")) {
        return { t: "l", v: null, u: true };
      }
      if (
        node.type === "UnaryExpression" &&
        node.operator === "-" &&
        unwrap(node.argument).type === "Literal" &&
        typeof unwrap(node.argument).value === "number"
      ) {
        return { t: "l", v: -unwrap(node.argument).value };
      }
      if (!isFunctionNode(node) && !depends(node, bound)) return capture(node);

      switch (node.type) {
        case "Identifier":
          return { t: "p", n: node.name };

        case "MemberExpression": {
          if (node.computed) {
            const property = unwrap(node.property);
            if (
              property.type === "Literal" &&
              (typeof property.value === "string" || typeof property.value === "number")
            ) {
              return { t: "m", o: lower(node.object, bound), n: String(property.value) };
            }
            throw new Unsupported(
              "computed member access cannot be translated to SQL",
              node.property,
            );
          }
          if (node.property.type !== "Identifier") {
            throw new Unsupported("private members cannot be translated to SQL", node.property);
          }
          return { t: "m", o: lower(node.object, bound), n: node.property.name };
        }

        case "CallExpression": {
          const args: Array<Node> = [];
          for (const arg of node.arguments) {
            if (arg.type === "SpreadElement") {
              throw new Unsupported("spread arguments cannot be translated to SQL", arg);
            }
            args.push(lower(arg, bound));
          }
          const callee = unwrap(node.callee);
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier"
          ) {
            return { t: "call", o: lower(callee.object, bound), n: callee.property.name, a: args };
          }
          if (depends(callee, bound)) {
            throw new Unsupported("this call cannot be translated to SQL", callee);
          }
          return {
            t: "fn",
            f: capture(callee),
            n: code.slice(callee.start, callee.end),
            a: args,
          };
        }

        case "BinaryExpression":
        case "LogicalExpression": {
          if (!BINARY_OPS.has(node.operator)) {
            throw new Unsupported(
              `the \`${node.operator}\` operator cannot be translated to SQL`,
              node,
            );
          }
          return {
            t: "b",
            op: node.operator as BinaryOp,
            l: lower(node.left, bound),
            r: lower(node.right, bound),
          };
        }

        case "UnaryExpression": {
          if (node.operator !== "!" && node.operator !== "-" && node.operator !== "+") {
            throw new Unsupported(
              `the \`${node.operator}\` operator cannot be translated to SQL`,
              node,
            );
          }
          return { t: "u", op: node.operator, a: lower(node.argument, bound) };
        }

        case "ConditionalExpression":
          return {
            t: "?",
            c: lower(node.test, bound),
            a: lower(node.consequent, bound),
            b: lower(node.alternate, bound),
          };

        case "TemplateLiteral":
          return {
            t: "tpl",
            q: node.quasis.map((quasi: Ast) => quasi.value.cooked ?? quasi.value.raw),
            e: node.expressions.map((expression: Ast) => lower(expression, bound)),
          };

        case "ObjectExpression": {
          const props: Array<readonly [string, Node]> = [];
          for (const prop of node.properties) {
            if (prop.type === "SpreadElement") {
              props.push(["...", lower(prop.argument, bound)]);
              continue;
            }
            if (prop.computed) {
              throw new Unsupported("computed keys cannot be translated to SQL", prop.key);
            }
            if (prop.kind !== "init") {
              throw new Unsupported("getters and setters cannot be translated to SQL", prop);
            }
            const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
            if (key === "...") {
              throw new Unsupported('"..." is not a valid key in a query lambda', prop.key);
            }
            props.push([key, lower(prop.value, bound)]);
          }
          return { t: "o", p: props };
        }

        case "ArrayExpression": {
          const elements: Array<Node> = [];
          for (const element of node.elements) {
            if (element === null || element.type === "SpreadElement") {
              throw new Unsupported(
                "holes and spreads in array literals cannot be translated to SQL",
                element ?? node,
              );
            }
            elements.push(lower(element, bound));
          }
          return { t: "a", e: elements };
        }

        case "ArrowFunctionExpression":
        case "FunctionExpression": {
          const lambda = lowerLambda(node, bound);
          return { t: "fnx", p: lambda.p, b: lambda.b };
        }

        default:
          throw new Unsupported(describe(node), node);
      }
    };

    const start = position(site.fn.start);
    const loc = `${file}:${start.line}:${start.column}`;
    try {
      const lambda = lowerLambda(site.fn, new Set());
      return { v: 1, p: lambda.p, b: lambda.b, loc };
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      thunks.length = 0;
      const at = position(error.node.start);
      if (!site.silent) {
        diagnostics.push({
          message: error.message,
          file,
          line: at.line,
          column: at.column,
          offset: error.node.start,
        });
      }
      return {
        v: 1,
        p: [],
        b: { t: "err", m: error.message, at: `${file}:${at.line}:${at.column}` },
        loc,
      };
    }
  };

  const asts: Array<LambdaAst> = [];
  for (const site of sites) {
    const ast = lowerSite(site);
    site.astName = String(site.index);
    asts[site.index] = ast;
  }
  for (const ast of asts) hoisted.push(JSON.stringify(ast));

  // ----------------------------------------------------------------- rendering
  // Thunks are copies of source ranges. A copied range can itself contain call
  // sites (a query built inside a lambda), which must be wrapped in the copy too.
  const suffix = (site: Site): string => {
    const thunks = site.thunks
      .map((node) => `() => (${render(node.start, node.end, site)})`)
      .join(", ");
    const name = site.name === undefined ? "" : `, ${JSON.stringify(site.name)}`;
    return `, ${site.astName}, [${thunks}]${name})`;
  };
  const render = (start: number, end: number, exclude: Site | null): string => {
    let out = "";
    let pos = start;
    for (const site of sites) {
      if (site === exclude) continue;
      if (site.fn.start < pos || site.fn.end > end) continue;
      out += code.slice(pos, site.fn.start);
      out += `${HELPER}(${render(site.fn.start, site.fn.end, site)}${suffix(site)}`;
      pos = site.fn.end;
    }
    return out + code.slice(pos, end);
  };

  const s = new MagicString(code);
  for (const site of sites) {
    s.appendLeft(site.fn.start, `${HELPER}(`);
    s.appendRight(site.fn.end, suffix(site));
  }

  // The hoisted declarations go after the hashbang and the directive prologue,
  // without adding a line, so that line numbers stay those of the source.
  const prelude = helperSource(hoisted.join(", "));
  let insertAt = 0;
  if (program.hashbang) {
    insertAt = program.hashbang.end;
    if (code[insertAt] === "\r") insertAt++;
    if (code[insertAt] === "\n") insertAt++;
  }
  let afterDirective = false;
  for (const statement of program.body) {
    if (statement.type === "ExpressionStatement" && typeof statement.directive === "string") {
      insertAt = statement.end;
      afterDirective = true;
    } else break;
  }
  if (afterDirective) s.appendRight(insertAt, `; ${prelude}`);
  else if (insertAt === 0) s.prepend(`${prelude} `);
  else s.appendRight(insertAt, `${prelude} `);

  return {
    code: s.toString(),
    map:
      options.sourceMap === false
        ? null
        : s.generateMap({ hires: "boundary", source: id, includeContent: true }),
    diagnostics,
    sites: sites.length,
    asts,
  };
};

/** TS node types that wrap a runtime expression. */
const EXPRESSION_TS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

const describe = (node: Ast): string => {
  switch (node.type) {
    case "NewExpression":
      return "`new` expressions that depend on a query parameter cannot be translated to SQL";
    case "AwaitExpression":
    case "YieldExpression":
      return "`await` and `yield` cannot be used inside a query lambda";
    case "AssignmentExpression":
    case "UpdateExpression":
      return "assignments cannot be used inside a query lambda";
    case "TaggedTemplateExpression":
      return "tagged templates that depend on a query parameter cannot be translated to SQL";
    case "SequenceExpression":
      return "the comma operator cannot be translated to SQL";
    case "ThisExpression":
      return "`this` cannot be translated to SQL";
    default:
      return `this syntax (${node.type}) cannot be translated to SQL`;
  }
};
