import type { RemovedDeclaration } from "../change/seeds.ts";
import { CALL_EDGE_KINDS } from "./call-kinds.ts";
import { fileReach, mayRunDeclarationOf, sharesRuntime } from "../languages/call-targets.ts";
import { JAVA_PROFILE, profileOf } from "../languages/profiles.ts";
import { nameTail } from "../shared/call-place.ts";
import { compareText } from "../shared/code-node.ts";
import { CAPABILITY_ABSENT, type Cut, type CutReach, type CutReason } from "../shared/fact.ts";

/** A reference the index could not resolve to a declaration. */
export interface UnresolvedUse {
  /** The name as written, qualifier included: `Promise.resolve`, `this.svc.get`. */
  name: string;
  kind: string;
  file: string;
  line: number;
  column?: number;
  from?: string;
  /** The declarations the index considered for this reference, by qualified name; absent when it considered none. */
  candidates?: readonly string[];
}

/** A dynamic load a source declares: where, and the module it names when its specifier is a string literal. */
export interface DynamicLoadUse {
  file: string;
  line: number;
  specifier?: string;
}

export interface WalkedDeclaration {
  file: string;
  name: string;
  kind: string;
  /** The name that places the declaration in its container: `AddressService::resolve`. */
  qualifiedName: string;
}

/** Exact occurrence keys name their joined target anchors; only distinct admitted anchors can be excluded. */
export interface MemberReferenceProofs {
  targets: ReadonlyMap<string, string>;
  expanded: ReadonlySet<string>;
}

const REFERENCED_BY: Readonly<Record<string, readonly string[]>> = {
  calls: ["function", "method", "property"],
  instantiates: ["class", "component"],
  references: ["function", "method", "property", "constant", "variable", "class", "component", "interface", "type_alias", "enum"],
  extends: ["class", "component", "interface"],
  implements: ["class", "component", "interface"],
};

/** Calls that load a module, a class or a file by a name the index cannot resolve. */
const DYNAMIC_LOADERS: ReadonlySet<string> = new Set(["import", "require", "forName", "loadClass", "import_module", "__import__"]);

/**
 * Whether a declaration may be what an unresolved reference names: a call or an instantiation runs it, so a
 * configuration file declares none it runs; any other reference may still read a configuration key.
 */
function mayReach(reference: UnresolvedUse, declarationFile: string): boolean {
  return CALL_EDGE_KINDS.includes(reference.kind) ? mayRunDeclarationOf(reference.file, declarationFile) : sharesRuntime(reference.file, declarationFile);
}

/** The lead of a `Cut.at` that stops at a declaration: its file and name ([RFC-0002](../../../../docs/architecture/rfc/0002-facts-contract.md)). */
export function declarationAnchor(file: string, name: string): string {
  return `${file}::${name}`;
}

/** An entry of a `Cut.at` after its lead: a line of a file, followed by the reason it is named when there is one. */
export function placeAt(file: string, line: number, reason?: string): string {
  return reason === undefined ? `${file}:${line}` : `${file}:${line} ${reason}`;
}

/** Exact raw graph occurrence; missing or invalid coordinates cannot support a proof. */
export function referenceKey(reference: Pick<UnresolvedUse, "file" | "line" | "column" | "from" | "name" | "kind">): string | undefined {
  if (!Number.isInteger(reference.line) || reference.line < 1 || !Number.isInteger(reference.column) || reference.column! < 0 || !reference.from) return undefined;
  return JSON.stringify([reference.file, reference.line, reference.column, reference.from, reference.name, reference.kind]);
}

export function declarationUseKey(anchor: string, occurrence: string): string {
  return JSON.stringify([anchor, occurrence]);
}

/** Duplicate full graph tuples cannot identify either occurrence uniquely. */
export function uniqueReferenceKeys(references: readonly UnresolvedUse[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));
}

/** The identifier a qualified name is rooted at: `a.b()` is rooted at `a`, and `this.svc.get` at `this`. */
export function rootedName(name: string): string {
  return name.split(/[.:#]/)[0] ?? name;
}

function isKnownReference(reference: UnresolvedUse, known: ReadonlySet<string>, unique: ReadonlySet<string>): boolean {
  const key = referenceKey(reference);
  return key !== undefined && unique.has(key) && known.has(key);
}

/**
 * The written calls nothing binds that are attributed to a reached declaration (ADR-0041 decision 8): one cut per
 * declaration, led by it, at every such call, as a reference the index left unresolved that names it is cut.
 */
export function attributedCallCuts(calls: readonly { declaration: { file: string; name: string }; place: { file: string; line: number; name: string } }[]): Cut[] {
  return [...Map.groupBy(calls, ({ declaration }) => declarationAnchor(declaration.file, declaration.name))].map(([anchor, here]) => unresolvedLinkAt(anchor, new Set(here.map(({ place }) => placeAt(place.file, place.line, place.name))), "hidden-caller", callersOf([anchor])));
}

/**
 * One cut per place a call record is contradicted (ADR-0041 U6): the index placed a call where its source writes none, so
 * the record proves no dependence there. The cut names the targets the index held.
 */
export function contradictedCallCuts(calls: readonly { record: UnresolvedUse; target: { file: string; name: string } }[]): Cut[] {
  return [...Map.groupBy(calls, ({ record }) => placeAt(record.file, record.line, record.name))].map(([place, here]) => ({ kind: "unresolved-link", at: [place, ...[...new Set(here.map(({ target }) => declarationAnchor(target.file, target.name)))].sort()], reason: "contradicted", reach: { kind: "call-at", place } }));
}

function unresolvedLinkAt(anchor: string, places: Iterable<string>, reason: CutReason, reach: CutReach): Cut {
  return { kind: "unresolved-link", at: [anchor, ...[...places].sort()], reason, reach };
}

const callersOf = (declarations: Iterable<string>): CutReach => ({ kind: "callers-of", declarations: [...new Set(declarations)].sort() });

/** A cut at one file, which could hide anything in the file's runtime. */
export function fileCut(kind: Cut["kind"], file: string, reason: CutReason): Cut {
  return { kind, at: [file], reason, reach: fileReach(file) };
}

/** An asked file whose declarations the index does not place: not indexed when the export listed it, otherwise not exported. */
export function unheldCut(file: string, listed: ReadonlySet<string>): Cut {
  return listed.has(file) ? fileCut("no-extractor", file, "not-indexed") : fileCut("not-exported", file, "unwritten");
}

/** One unresolved-link cut per file, anchored at the file, its places after it, as `Cut.at` reads everywhere. */
function placeCuts(places: readonly { file: string; line: number; reason: string }[], reason: CutReason, reach: (file: string, here: readonly { reason: string }[]) => CutReach): Cut[] {
  return [...Map.groupBy(places, (place) => place.file)]
    .sort(([left], [right]) => compareText(left, right))
    .map(([file, here]) => unresolvedLinkAt(file, new Set(here.map((place) => placeAt(place.file, place.line, place.reason))), reason, reach(file, here)));
}

/** The module specifiers no resolver rule placed, one cut per importing file; a specifier names no file only when every statement of it in the file does. */
export function unresolvedSpecifierCuts(specifiers: readonly { file: string; line: number; specifier: string; namesNoFile?: true }[]): Cut[] {
  const named = new Set(specifiers.filter((edge) => edge.namesNoFile !== true).map(({ file, specifier }) => `${file}\0${specifier}`));
  return placeCuts(specifiers.map(({ file, line, specifier }) => ({ file, line, reason: specifier })), "specifier", (importer, here) => ({
    kind: "module",
    importer,
    specifiers: [...new Set(here.map(({ reason }) => reason))].sort().map((specifier) => (named.has(`${importer}\0${specifier}`) ? { specifier } : { specifier, namesNoFile: true })),
  }));
}

/** Places whose data a reader could not follow, for `reason`, one cut per file: what they would bind is anything. */
export function unresolvedPlaceCuts(places: readonly { file: string; line: number; reason: string }[], reason: CutReason): Cut[] {
  return placeCuts(places, reason, fileReach);
}

/** Whether the reference names a declaration without qualifying it, so its tail is the whole name. */
export function isBareName(name: string): boolean {
  return !/[.:#]/.test(name);
}

/**
 * Whether a reference names a declaration. A bare name is file-scoped, so it names a declaration of its own file, or
 * the one its import binds — never a homonym in another file it never imported (`RFC-0016` S12). A qualified one names
 * only a declaration the index considered for it, so a receiver that never resolved is never read as a homonym.
 */
function namesDeclaration(reference: UnresolvedUse, declaration: WalkedDeclaration, bound: ReadonlyMap<string, string>, proofKey: string | undefined): boolean {
  if (!isBareName(reference.name)) return (reference.candidates ?? []).includes(declaration.qualifiedName);
  if (reference.name !== declaration.name) return false;
  if (reference.file === declaration.file) return true;
  return proofKey !== undefined && bound.get(proofKey) === declaration.file;
}

/**
 * A walked declaration may have callers the index could not link: an unresolved reference that names it is one cut at
 * those references, led by the declaration they might call. A qualified reference no candidate attributes to the walked
 * declaration cuts the caller's file instead, led by it, so the name it might reach is not left out. A file that loads
 * modules by a name the index cannot resolve may load anything and is a cut of its own, unless every dynamic load the
 * reader found on that file and line has a string-literal specifier, which names its module like a static import; a file
 * the reader did not read keeps the cut.
 */
export function unresolvedLinkCuts(
  references: readonly UnresolvedUse[],
  walked: readonly WalkedDeclaration[],
  loads: readonly DynamicLoadUse[],
  settled: ReadonlySet<string> = new Set(),
  known: ReadonlySet<string> = new Set(),
  bound: ReadonlyMap<string, string> = new Map(),
  members?: MemberReferenceProofs,
): Cut[] {
  const unique = uniqueReferenceKeys(references);
  const byName = Map.groupBy(walked, (declaration) => declaration.name);
  const pointingCache = new Map<string, readonly WalkedDeclaration[]>();
  const hidden = new Map<string, Set<string>>();
  const unattributed = new Map<string, Set<string>>();
  const unattributedNames = new Map<string, Set<string>>();
  const loaders = new Map<string, Set<string>>();
  const loadsAt = Map.groupBy(loads, (load) => placeAt(load.file, load.line));
  const namesModule = (place: string): boolean => {
    const here = loadsAt.get(place);
    return here !== undefined && here.every((load) => load.specifier !== undefined);
  };
  for (const reference of references) {
    const occurrence = referenceKey(reference);
    const proofKey = occurrence !== undefined && unique.has(occurrence) ? occurrence : undefined;
    const tail = nameTail(reference.name);
    const place = placeAt(reference.file, reference.line);
    /**
     * A reference whose own root the file imports from outside is no cut. The proof is keyed by the complete graph occurrence, before line-based output aggregation.
     */
    if (isKnownReference(reference, known, unique)) continue;
    /** The same place, named by the reference as written: the reader settles a reference it is told, without opening the file. */
    const named = placeAt(reference.file, reference.line, reference.name);
    if (reference.kind === "calls" && DYNAMIC_LOADERS.has(tail) && !namesModule(place)) loaders.set(reference.file, (loaders.get(reference.file) ?? new Set()).add(named));
    const pointingKey = JSON.stringify([tail, reference.kind]);
    let pointing = pointingCache.get(pointingKey);
    if (pointing === undefined) {
      pointing = (byName.get(tail) ?? []).filter((declaration) => (REFERENCED_BY[reference.kind] ?? []).includes(declaration.kind));
      pointingCache.set(pointingKey, pointing);
    }
    pointing = pointing.filter((declaration) => mayReach(reference, declaration.file));
    const attributing = !isBareName(reference.name) && (reference.candidates?.length ?? 0) === 0 ? [] : pointing.filter((declaration) => namesDeclaration(reference, declaration, bound, proofKey));
    const actual = proofKey === undefined ? undefined : members?.targets.get(proofKey);
    const settledAt = (declaration: WalkedDeclaration): boolean => {
      if (proofKey === undefined) return false;
      const anchor = declarationAnchor(declaration.file, declaration.name);
      return (settled.size > 0 && settled.has(declarationUseKey(anchor, proofKey))) || (actual !== undefined && actual !== anchor && members?.expanded.has(anchor) === true);
    };
    for (const declaration of attributing) {
      const key = declarationAnchor(declaration.file, declaration.name);
      if (settledAt(declaration)) continue;
      hidden.set(key, (hidden.get(key) ?? new Set()).add(place));
    }
    const decided = pointing.some(settledAt);
    if (attributing.length === 0 && pointing.length > 0 && !decided) {
      unattributed.set(reference.file, (unattributed.get(reference.file) ?? new Set()).add(named));
      const names = unattributedNames.get(reference.file) ?? new Set();
      for (const declaration of pointing) names.add(declarationAnchor(declaration.file, declaration.name));
      unattributedNames.set(reference.file, names);
    }
  }
  return [
    ...[...hidden].map(([declaration, places]) => unresolvedLinkAt(declaration, places, "hidden-caller", callersOf([declaration]))),
    ...[...loaders].map(([file, places]) => unresolvedLinkAt(file, places, "dynamic-load", fileReach(file))),
    ...[...unattributed].map(([file, places]) => unresolvedLinkAt(file, places, "name-only", callersOf(unattributedNames.get(file)!))),
  ];
}

/**
 * A declaration removed whole leaves no node for a caller to reach, so a reference at head that never resolved and names
 * it is the only trace: one cut per removed declaration, at every such reference.
 */
export function removedDeclarationCuts(
  references: readonly UnresolvedUse[],
  removed: readonly RemovedDeclaration[],
  known: ReadonlySet<string> = new Set(),
  bound: ReadonlyMap<string, string> = new Map(),
  localParameters: ReadonlySet<string> = new Set(),
): Cut[] {
  const unique = uniqueReferenceKeys(references);
  const byName = Map.groupBy(removed, (declaration) => declaration.name);
  const places = new Map<string, Set<string>>();
  for (const reference of references) {
    if (isKnownReference(reference, known, unique)) continue;
    const key = referenceKey(reference);
    const proofKey = key !== undefined && unique.has(key) ? key : undefined;
    const imported = isBareName(reference.name) && proofKey !== undefined ? bound.get(proofKey) : undefined;
    for (const declaration of byName.get(nameTail(reference.name)) ?? []) {
      if (!mayReach(reference, declaration.file)) continue;
      if (imported !== undefined && imported !== declaration.file) continue;
      if (proofKey !== undefined && localParameters.has(proofKey) && reference.kind === "calls" && isBareName(reference.name) && reference.file !== declaration.file) continue;
      const key = declarationAnchor(declaration.file, declaration.name);
      places.set(key, (places.get(key) ?? new Set()).add(placeAt(reference.file, reference.line)));
    }
  }
  return [...places].map(([declaration, at]) => unresolvedLinkAt(declaration, at, "removed-declaration", callersOf([declaration])));
}

/**
 * The Java type kinds codegraph emits: an annotation type arrives as `interface`, a record as `class` (java-symbols.ts
 * maps `record_declaration` to `class`). A record is therefore covered by `class`, with no rule of its own.
 */
const JAVA_TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum"]);

/** Whether a declaration of `kind` in `file` is a Java type target (RFC-0027 U0 condition a). */
export function isJavaTypeKind(kind: string, file: string): boolean {
  return JAVA_TYPE_KINDS.has(kind) && profileOf(file) === JAVA_PROFILE;
}

/**
 * A Java type target whose type references no stage reads (ADR-0042 decision 1, RFC-0027 U0): the answer about its
 * dependents is partial at the target, reached by its callers, never complete with zero dependents.
 */
export function unreadTypeReferenceCut(target: { file: string; name: string }): Cut {
  const anchor = declarationAnchor(target.file, target.name);
  return { kind: "unresolved-link", at: [anchor], reason: "relation-unread", subReason: CAPABILITY_ABSENT, reach: callersOf([anchor]) };
}

/** An injection or template use the relation reader named but could not place: where, and why. */
export interface UnreadRelation {
  path: string;
  line: number;
  reason: string;
}

/**
 * An unread relation may be a dependence on a walked class that the walk could not follow. It cuts the answer only in a
 * file the walk reached, or a template that a reached component names (`templateOwners`, by the template's path): one
 * cut per such file, led by it and followed by every place with its reason.
 */
export function unreadRelationCuts(unread: readonly UnreadRelation[], walkedFiles: ReadonlySet<string>, templateOwners: ReadonlyMap<string, readonly string[]>): Cut[] {
  const reached = unread.filter(({ path }) => walkedFiles.has(path) || (templateOwners.get(path) ?? []).some((owner) => walkedFiles.has(owner)));
  return [...Map.groupBy(reached, ({ path }) => path)]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([path, places]) => unresolvedLinkAt(path, places.map(({ line, reason }) => placeAt(path, line, reason)), "relation-unread", fileReach(path)));
}
