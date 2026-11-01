export type RelationKind = "injects" | "uses-component" | "uses-directive" | "uses-pipe";

/** A declaration, placed by its file, its simple name and the line of its name. */
export interface SymbolRef {
  path: string;
  symbol: string;
  line: number;
}

/**
 * A relation the Angular sources declare between two declarations of the repository: `from` injects, or uses in its
 * template or as a host directive, `to`. The finding's evidence is the first place `from` does so. Each is joined to its
 * graph node by file, a line inside the node's span and simple name (RFC-0010 "Entrypoint join").
 */
export interface Relation {
  kind: RelationKind;
  /** `<from symbol>><to symbol>`, the tie-break of the finding order. */
  name: string;
  from: SymbolRef;
  to: SymbolRef;
}

export function relation(kind: RelationKind, from: SymbolRef, to: SymbolRef): Relation {
  return { kind, name: `${from.symbol}>${to.symbol}`, from, to };
}
