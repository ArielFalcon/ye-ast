/** The edges the impact walk follows (RFC-0010 "Edge policy"). The tables are part of the producer version. */

/** Code that runs or holds code that runs: it calls, instantiates and, where it uses a name, references. */
const CODE_KINDS = ["function", "method", "class", "component", "constant", "variable"] as const;
/** What can use a declaration without calling it: a route names its page, a type names the types in its shape. */
const REFERRER_KINDS = [...CODE_KINDS, "interface", "type_alias", "route"] as const;
/** What a reference can point at and break: code, and the types that shape data (a DTO). */
const REFERENCED_KINDS = ["function", "method", "constant", "variable", "class", "component", "interface", "type_alias", "enum"] as const;
const TYPE_KINDS = ["class", "component", "interface"] as const;
const ANGULAR_CLASS_KINDS = ["class", "component"] as const;

export const EDGE_POLICY = {
  rules: [
    { edges: ["calls", "instantiates"], from: CODE_KINDS, to: "any" },
    { edges: ["references"], from: REFERRER_KINDS, to: REFERENCED_KINDS },
    { edges: ["extends", "implements"], from: TYPE_KINDS, to: TYPE_KINDS },
  ],
  /**
   * Relations ye-ast reads from Angular sources (RFC-0007 rows A2 and A4): a class injects another, or uses it in its
   * template or as a host directive. The source depends on the target, as with a reference. They are read, not guessed,
   * so each is as certain as a resolved edge.
   */
  relations: { kinds: ["injects", "uses-component", "uses-directive", "uses-pipe"], from: ANGULAR_CLASS_KINDS, to: ANGULAR_CLASS_KINDS, confidence: 1 },
  /** A method stands for the type that declares it, at the same depth. */
  ownerKinds: TYPE_KINDS,
  /** A value or class that nothing calls is reached through the top-level code of the files that import it. */
  injectableKinds: ["constant", "variable", "class", "component"],
  /** The code a file runs at its top level, as the importer fallback and the top-level use of an import reach it. */
  topLevelCodeKinds: ["function", "class", "component"],
  /**
   * Edges codegraph synthesizes that ye-ast does not follow: template and event wiring, and interface bridges it derives
   * itself. A derived bridge between a method and the same-named method of a type above or below it spends one hop, the
   * same as a call.
   */
  ignoredSynthesizers: ["angular-template", "angular-event", "interface-impl"],
  /** The confidence of a heuristic edge that carries no score. */
  unscoredHeuristicConfidence: 0.3,
} as const;

export interface PolicyEdge {
  kind: string;
  sourceKind: string;
  targetKind: string;
}

export function followsEdge({ kind, sourceKind, targetKind }: PolicyEdge): boolean {
  return EDGE_POLICY.rules.some(
    (rule) => (rule.edges as readonly string[]).includes(kind) && (rule.from as readonly string[]).includes(sourceKind) && (rule.to === "any" || (rule.to as readonly string[]).includes(targetKind)),
  );
}

export function followsRelation({ kind, sourceKind, targetKind }: PolicyEdge): boolean {
  const { kinds, from, to } = EDGE_POLICY.relations;
  return (kinds as readonly string[]).includes(kind) && (from as readonly string[]).includes(sourceKind) && (to as readonly string[]).includes(targetKind);
}

/**
 * The edges that count towards a symbol's fan-in and the hub bound: a call or an instantiation says the symbol is used
 * by that caller, where a reference or a hierarchy edge only says the two are related. Bridges, importers and Angular
 * relations count towards neither.
 */
export const CALL_EDGE_KINDS: readonly string[] = ["calls", "instantiates"];

/** The followed edges' kinds, for asking a store only for them. */
export const FOLLOWED_EDGE_KINDS: readonly string[] = EDGE_POLICY.rules.flatMap((rule) => rule.edges);

export interface EdgeScore {
  confidence: number | null;
  provenance: "tree-sitter" | "scip" | "heuristic" | null;
  synthesizedBy: string | null;
}

export function isIgnoredEdge({ synthesizedBy }: EdgeScore): boolean {
  return EDGE_POLICY.ignoredSynthesizers.some((name) => name === synthesizedBy);
}

/** The score an edge counts in a path: its own, 1 when it is certain, and the heuristic default when it is heuristic without one. */
export function edgeConfidence({ confidence, provenance }: EdgeScore): number {
  if (confidence !== null) return confidence;
  return provenance === "heuristic" ? EDGE_POLICY.unscoredHeuristicConfidence : 1;
}
