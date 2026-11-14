import type { DependenceDerivation } from "./impact-fact.ts";
import type { ImportOrigin } from "../relations/resolved-reference.ts";
import type { Finding } from "../shared/fact.ts";
import { JAVA_PROFILE, profileOf } from "../languages/profiles.ts";

/** The edges the impact walk follows (RFC-0010 "Edge policy"). */

/** Code that runs or holds code that runs: it calls, instantiates and, where it uses a name, references. */
const CODE_KINDS = ["function", "method", "class", "component", "constant", "variable"] as const;
/** What can use a declaration without calling it: a route names its page, a type names the types in its shape. */
const REFERRER_KINDS = [...CODE_KINDS, "interface", "type_alias", "route"] as const;
/** What a reference can point at and break: code, and the types that shape data (a DTO). */
const REFERENCED_KINDS = ["function", "method", "constant", "variable", "class", "component", "interface", "type_alias", "enum"] as const;
/** Class fields: their initializer is code that runs, so it calls and instantiates; what a field references is its type. */
export const FIELD_KINDS = ["property", "field"] as const;
/** Declarations that are types: they own members and extend or implement other types. */
const TYPE_KINDS = ["class", "component", "interface", "enum"] as const;
/** Declarations that are classes: a class, or a component an Angular decorator declares. */
const CLASS_KINDS = ["class", "component"] as const;
/** Declarations that hold a value, which a call may find any object in. */
const VALUE_KINDS = ["constant", "variable"] as const;

export const EDGE_POLICY = {
  rules: [
    { edges: ["calls", "instantiates"], from: [...CODE_KINDS, ...FIELD_KINDS], to: "any" },
    { edges: ["references"], from: REFERRER_KINDS, to: REFERENCED_KINDS },
    { edges: ["extends", "implements"], from: TYPE_KINDS, to: TYPE_KINDS },
  ],
  typeReferences: { from: TYPE_KINDS, to: TYPE_KINDS },
  /**
   * A read of a constant a language pack proves (ADR-0083): from the declaration whose code writes it, which is where the
   * relation's source is placed, to the constant. A type reached through the constant still expands only through
   * `ownerThroughMember`.
   */
  constantReferences: { from: [...CODE_KINDS, ...FIELD_KINDS], to: ["constant"] },
  /**
   * Relations ye-ast reads from Angular sources (RFC-0007 rows A2 and A4): a class injects another, or uses it in its
   * template or as a host directive. The source depends on the target, as with a reference. They are read, not guessed,
   * so each is as certain as a resolved edge.
   */
  relations: { kinds: ["injects", "uses-component", "uses-directive", "uses-pipe"], from: CLASS_KINDS, to: CLASS_KINDS, confidence: 1 },
  /** A member stands for the type that declares it, at the same depth. */
  ownerKinds: TYPE_KINDS,
  /**
   * Members that may declare a class body of their own (a Java enum constant's): one that holds a declaration is asked of
   * its language pack, and a body the pack places below a type reads as a class.
   */
  bodiedMemberKinds: ["enum_member"],
  /** The type kind a bodied member the language pack places below a type reads as. */
  bodiedMemberType: "class",
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
   * A file, the dependent a use in its top-level statements names (ADR-0082). It leads nowhere: what loads a file is the
   * answer of `importers`, so it reaches no entrypoint and holds no cut of the declarations it contains.
   */
  fileKind: "file",
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

/** Whether a reached symbol is a file a top-level use names as a dependent, which the walk's answer stops at. */
export function isFileDependent(kind: string): boolean {
  return kind === EDGE_POLICY.fileKind;
}

/** The rows a `references` relation into a declaration of `targetKind` follows: into a constant, the constant row; otherwise the type row. */
export function referenceRow(targetKind: string): { from: readonly string[]; to: readonly string[] } {
  return (EDGE_POLICY.constantReferences.to as readonly string[]).includes(targetKind) ? EDGE_POLICY.constantReferences : EDGE_POLICY.typeReferences;
}

export function followsRelation({ kind, sourceKind, targetKind }: PolicyEdge): boolean {
  if (kind === "references") {
    const row = referenceRow(targetKind);
    return row.from.includes(sourceKind) && row.to.includes(targetKind);
  }
  const { kinds, from, to } = EDGE_POLICY.relations;
  return (kinds as readonly string[]).includes(kind) && (from as readonly string[]).includes(sourceKind) && (to as readonly string[]).includes(targetKind);
}

export { CALL_EDGE_KINDS } from "./call-kinds.ts";

/** The declarations a relation ends at, and the only ones that can own a local an `inject()` call initializes. */
export const LOCAL_OWNER_KINDS: readonly string[] = [...EDGE_POLICY.relations.from, "function"];

export function isClassKind(kind: string): boolean {
  return (CLASS_KINDS as readonly string[]).includes(kind);
}

/** Declarations that can own a member a value receiver stands for: a class, a component, an enum, or an interface (JLS 9.2). */
export function isOwnerKind(kind: string): boolean {
  return (EDGE_POLICY.ownerKinds as readonly string[]).includes(kind);
}

/** Whether a declaration of `kind` in `file` is a Java type target (RFC-0027 U0 condition a). */
export function isJavaTypeKind(kind: string, file: string): boolean {
  return isOwnerKind(kind) && profileOf(file) === JAVA_PROFILE;
}

export function holdsValue(kind: string): boolean {
  return (VALUE_KINDS as readonly string[]).includes(kind);
}

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

/**
 * How a graph edge whose target was settled is known: bound by a source proof or by its name alone (ADR-0036), or bound
 * by the type checker to the edge's own target (ADR-0037).
 */
export type ReceiverSettlement = "proven" | "typed" | "name-match";

/**
 * The score and the derivation of a graph edge the walk follows. An edge whose receiver a source proof binds to the
 * callee's class counts as certain as ye-ast's own proofs; one the index matched by name on a value receiver no proof
 * binds counts as a heuristic edge without a score, whatever score the index gave it; a heuristic edge is a name match.
 */
export function followedEdge(score: EdgeScore, settled?: ReceiverSettlement): { confidence: number; derivation: DependenceDerivation } {
  if (settled === "proven" || settled === "typed") return { confidence: EDGE_POLICY.relations.confidence, derivation: settled };
  if (settled === "name-match") return { confidence: EDGE_POLICY.unscoredHeuristicConfidence, derivation: "name-match" };
  return { confidence: edgeConfidence(score), derivation: score.provenance === "heuristic" ? "name-match" : "resolved" };
}

/**
 * `bare`: the site spells its root alone. `pastRoot`: a call that reads a member, or calls, between its root and its own
 * member (`readsPastRoot`), so the root proves where the chain starts and not what the call runs.
 */
export type RootOrigin = Finding<ImportOrigin> & { bare?: true; pastRoot?: true };

/**
 * Whether a site of `kind` whose chain spells `names` names from its root on (the root type after a Java package) reads
 * past its root: a call below the root's own member (`System.out.println`, `other.logger.flush`), whose receiver is a
 * value the repository may have stored there.
 */
export function readsPastRoot(kind: string, names: number): boolean {
  return kind === "calls" && names > 2;
}

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
