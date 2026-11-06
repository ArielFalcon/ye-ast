import type { ImportOrigin } from "../relations/resolved-reference.ts";
import type { Finding } from "../shared/fact.ts";

/** The edges the impact walk follows (RFC-0010 "Edge policy"). */

/** Code that runs or holds code that runs: it calls, instantiates and, where it uses a name, references. */
const CODE_KINDS = ["function", "method", "class", "component", "constant", "variable"] as const;
/** What can use a declaration without calling it: a route names its page, a type names the types in its shape. */
const REFERRER_KINDS = [...CODE_KINDS, "interface", "type_alias", "route"] as const;
/** What a reference can point at and break: code, and the types that shape data (a DTO). */
const REFERENCED_KINDS = ["function", "method", "constant", "variable", "class", "component", "interface", "type_alias", "enum"] as const;
/** Class fields: their initializer is code that runs, so it calls and instantiates; what a field references is its type. */
export const FIELD_KINDS = ["property", "field"] as const;
const TYPE_KINDS = ["class", "component", "interface"] as const;
const ANGULAR_CLASS_KINDS = ["class", "component"] as const;

export const EDGE_POLICY = {
  rules: [
    { edges: ["calls", "instantiates"], from: [...CODE_KINDS, ...FIELD_KINDS], to: "any" },
    { edges: ["references"], from: REFERRER_KINDS, to: REFERENCED_KINDS },
    { edges: ["extends", "implements"], from: TYPE_KINDS, to: TYPE_KINDS },
  ],
  /**
   * Relations ye-ast reads from Angular sources (RFC-0007 rows A2 and A4): a class injects another, or uses it in its
   * template or as a host directive. The source depends on the target, as with a reference. They are read, not guessed,
   * so each is as certain as a resolved edge.
   */
  relations: { kinds: ["injects", "uses-component", "uses-directive", "uses-pipe"], from: ANGULAR_CLASS_KINDS, to: ANGULAR_CLASS_KINDS, confidence: 1 },
  /** A member stands for the type that declares it, at the same depth. */
  ownerKinds: TYPE_KINDS,
  /**
   * The members that stand for their type. A reference named `this.<member>` or `this.<member>.<rest>`, made inside the
   * type that declares the member, is a use of that member.
   */
  memberKinds: ["method", ...FIELD_KINDS],
  /**
   * What a type reached only through one of its members expands into: a subtype, and a template that renders it. Whoever
   * uses the member is reached through its own call edge, or through `fieldMemberUses`, and an injection into the type
   * says nothing more about the member, so neither joins (ADR-0017). A type that is a seed, or that is reached through its
   * own edges, keeps every row above.
   */
  ownerThroughMember: { edges: ["extends", "implements"], relations: ["uses-component", "uses-directive", "uses-pipe"] },
  /**
   * A reference of these kinds named `this.<field>.<member>`, made inside a class whose own field has a fixed origin, is
   * settled by that origin: a use of the member when the field holds the member's type, and none when it holds a type
   * outside the member's type and its subtypes. Either way the place leaves the member's `unresolved-link` cut.
   */
  fieldMemberUses: ["calls", "references"],
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

export type RootOrigin = Finding<ImportOrigin> & { bare?: true };

/** What an edge the graph resolved really reaches: its own target, nothing, or another declaration the source proves. */
export type EdgeVerdict<D> = { kind: "keep" } | { kind: "drop" } | { kind: "redirect"; to: D };

/**
 * The verdict on one edge from the root of the name it spells at its position. A root bound outside the repository (imported
 * from a package, or declared by the language's own libraries) cannot name a declaration of the repository, whatever the
 * graph matched it to, so the edge is no dependence; nor can a root spelled alone that a parameter binds, whose value the
 * callers pass. A root spelled alone whose origin names its declaration (`declared`) names that declaration only: an edge
 * into its declaring file stays, and one into another file names `proven` when the graph places the declaration, and
 * nothing when it does not. Otherwise a root spelled alone that an import binds to `proven`, a declaration of the
 * repository other than the edge's `target`, names `proven`. A root that is unknown, bound inside without a proven
 * declaration, or reached through a longer chain (`a.b`, whose member the binding does not name) proves nothing against it.
 */
export function edgeVerdict<D>(root: RootOrigin, proven: D | undefined, target: { id: D; file: string }): EdgeVerdict<D> {
  if (root.status !== "complete") return { kind: "keep" };
  if (root.value.kind === "external" || root.value.kind === "ambient" || (root.value.kind === "local-parameter" && root.bare === true)) return { kind: "drop" };
  if (root.value.kind !== "repository" || root.bare !== true) return { kind: "keep" };
  if (root.value.declared !== undefined) {
    if (target.file === root.value.file) return { kind: "keep" };
    if (proven === undefined) return { kind: "drop" };
  }
  return proven !== undefined && proven !== target.id ? { kind: "redirect", to: proven } : { kind: "keep" };
}
