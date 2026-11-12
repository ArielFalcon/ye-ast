import type { Evidence } from "../shared/fact.ts";

export type RelationKind = "references" | "injects" | "uses-component" | "uses-directive" | "uses-pipe";

/** A declaration, placed by its file, its simple name and the line of its name. */
export interface SymbolRef {
  path: string;
  symbol: string;
  line: number;
}

/**
 * A source-proven relation between repository declarations: a written type reference, injection or template use.
 * The finding's evidence is the first place `from` does so. Each is joined to its
 * graph node by file, a line inside the node's span and simple name (RFC-0010 "Entrypoint join").
 */
export interface Relation {
  kind: RelationKind;
  /** The occurrence of a written type reference, distinct from its declaring owner's location. */
  at?: Evidence;
  /** `<from symbol>><to symbol>`, the tie-break of the finding order. */
  name: string;
  from: SymbolRef;
  to: SymbolRef;
}

export function relation(kind: RelationKind, from: SymbolRef, to: SymbolRef): Relation {
  return { kind, name: `${from.symbol}>${to.symbol}`, from, to };
}
