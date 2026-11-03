/**
 * One place a fact found a name it could not settle: a repository-relative file, with a 1-based line and column.
 * `symbol` is the simple name the syntax gives the callee, when it gives one.
 */
export interface ReferenceSite {
  file: string;
  line: number;
  column: number;
  symbol?: string;
}

/**
 * What a reference names, as the facts need it: a declaration inside the repository, or a module outside it.
 * A repository target carries its span, so a consumer joins it to a graph node the way every other fact is joined
 * (RFC-0010 "Entrypoint join").
 */
export type ResolvedTarget =
  | { kind: "repository"; file: string; symbol: string; line: number; endLine: number }
  | { kind: "external"; module: string };

/**
 * Where a name a file uses comes from: a file of the repository, or a package outside it. It carries no span, because an
 * import names a module and never a declaration; it is what tells a reference that cannot reach the repository's code
 * apart from one that can.
 */
/**
 * What a reference names, as far as its own file proves: a declaration of the repository, a package outside it, or a name
 * the language's own libraries declare. `external` and `ambient` both mean no repository declaration can be named, so
 * both retire the cut a name tail attributed (`RFC-0016` S10).
 */
export type ImportOrigin = { kind: "repository"; file: string } | { kind: "external"; module: string } | { kind: "ambient"; name: string };
