/**
 * SQL text is assembled as a tree of fragments so that bind parameters can be
 * numbered once, at the end, in the order they appear.
 */
export class Param {
  readonly value: unknown;
  /** optional cast appended to the placeholder, e.g. `text` */
  readonly cast: string | undefined;
  constructor(value: unknown, cast?: string) {
    this.value = value;
    this.cast = cast;
  }
}

export type Frag = string | Param | ReadonlyArray<Frag>;

export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const join = (frags: ReadonlyArray<Frag>, separator: string): Frag => {
  if (frags.length === 1) return frags[0]!;
  const out: Array<Frag> = [];
  for (let i = 0; i < frags.length; i++) {
    if (i > 0) out.push(separator);
    out.push(frags[i]!);
  }
  return out;
};

export const and = (frags: ReadonlyArray<Frag>): Frag =>
  frags.length === 0 ? "TRUE" : frags.length === 1 ? frags[0]! : ["(", join(frags, " AND "), ")"];

export interface Compiled {
  readonly sql: string;
  readonly params: Array<unknown>;
}

export const compileFrag = (frag: Frag): Compiled => {
  const params: Array<unknown> = [];
  const seen = new Map<Param, number>();
  let sql = "";
  const walk = (f: Frag): void => {
    if (typeof f === "string") {
      sql += f;
    } else if (f instanceof Param) {
      let index = seen.get(f);
      if (index === undefined) {
        params.push(f.value);
        index = params.length;
        seen.set(f, index);
      }
      sql += f.cast === undefined ? `$${index}` : `$${index}::${f.cast}`;
    } else {
      for (let i = 0; i < f.length; i++) walk(f[i]!);
    }
  };
  walk(frag);
  return { sql, params };
};
