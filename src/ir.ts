/**
 * The expression IR shared by the build-time compiler and the runtime
 * translator. It is plain JSON: values captured from the enclosing scope are
 * referenced by index into a per-call-site array of thunks.
 */

/** A lambda parameter: a name, an object destructuring or a tuple destructuring. */
export type Pattern =
  | string
  | { readonly o: ReadonlyArray<readonly [key: string, pattern: Pattern]> }
  | { readonly a: ReadonlyArray<Pattern | null> };

export type Node =
  /** reference to a lambda parameter (or a name bound by destructuring) */
  | { readonly t: "p"; readonly n: string }
  /** captured value: index into the call site's thunk array */
  | { readonly t: "c"; readonly i: number }
  /** literal: string, number, boolean or null (`undefined` is lowered to null) */
  | {
      readonly t: "l";
      readonly v: string | number | boolean | null;
      /** the literal is `undefined`, which JSON cannot hold */
      readonly u?: boolean;
    }
  /** bigint literal */
  | { readonly t: "big"; readonly v: string }
  /** member access `o.n` */
  | { readonly t: "m"; readonly o: Node; readonly n: string }
  /** method call `o.n(...a)` */
  | { readonly t: "call"; readonly o: Node; readonly n: string; readonly a: ReadonlyArray<Node> }
  /** call of a captured function `f(...a)`; `n` is the source text of the callee */
  | { readonly t: "fn"; readonly f: Node; readonly n: string; readonly a: ReadonlyArray<Node> }
  /** binary or logical operator */
  | { readonly t: "b"; readonly op: BinaryOp; readonly l: Node; readonly r: Node }
  /** unary operator */
  | { readonly t: "u"; readonly op: "!" | "-" | "+"; readonly a: Node }
  /** conditional `c ? a : b` */
  | { readonly t: "?"; readonly c: Node; readonly a: Node; readonly b: Node }
  /** template literal */
  | { readonly t: "tpl"; readonly q: ReadonlyArray<string>; readonly e: ReadonlyArray<Node> }
  /** object literal; a key of "..." is a spread */
  | { readonly t: "o"; readonly p: ReadonlyArray<readonly [key: string, value: Node]> }
  /** array literal */
  | { readonly t: "a"; readonly e: ReadonlyArray<Node> }
  /** nested lambda */
  | { readonly t: "fnx"; readonly p: ReadonlyArray<Pattern>; readonly b: Node }
  /** a construct the compiler could not lower; raised when the lambda is used */
  | { readonly t: "err"; readonly m: string; readonly at: string };

export type BinaryOp =
  | "==="
  | "!=="
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&&"
  | "||"
  | "??";

/** The static part of a quoted lambda, hoisted to module scope by the compiler. */
export interface LambdaAst {
  readonly v: 1;
  readonly p: ReadonlyArray<Pattern>;
  readonly b: Node;
  /** `file:line:column` of the lambda, for diagnostics */
  readonly loc: string;
}

/** What the compiler attaches to a lambda at its call site. */
export interface Quote {
  readonly ast: LambdaAst;
  readonly captures: ReadonlyArray<() => unknown>;
}

export const QuoteSymbol: unique symbol = Symbol.for("effect-linq/quote") as never;

export const IR_VERSION = 1;
