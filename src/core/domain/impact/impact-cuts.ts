import type { RemovedDeclaration } from "../change/seeds.ts";
import { compareText } from "../shared/code-node.ts";
import type { Cut } from "../shared/fact.ts";

/** A reference the index could not resolve to a declaration. */
export interface UnresolvedUse {
  name: string;
  kind: string;
  file: string;
  line: number;
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
}

const REFERENCED_BY: Readonly<Record<string, readonly string[]>> = {
  calls: ["function", "method"],
  instantiates: ["class", "component"],
  references: ["function", "method", "constant", "variable", "class", "component", "interface", "type_alias", "enum"],
  extends: ["class", "component", "interface"],
  implements: ["class", "component", "interface"],
};

/** Calls that load a module, a class or a file by a name the index cannot resolve. */
const DYNAMIC_LOADERS: ReadonlySet<string> = new Set(["import", "require", "forName", "loadClass", "import_module", "__import__"]);

/** The lead of a `Cut.at` that stops at a declaration: its file and name ([RFC-0002](../../../../docs/architecture/rfc/0002-facts-contract.md)). */
export function declarationAnchor(file: string, name: string): string {
  return `${file}::${name}`;
}

/** An entry of a `Cut.at` after its lead: a line of a file, followed by the reason it is named when there is one. */
export function placeAt(file: string, line: number, reason?: string): string {
  return reason === undefined ? `${file}:${line}` : `${file}:${line} ${reason}`;
}

/** The key of an unresolved reference at `place` whose relation to the declaration `anchor` names the walk settled. */
export function settledUseKey(anchor: string, place: string): string {
  return `${anchor}\0${place}`;
}

function unresolvedLinkAt(anchor: string, places: Iterable<string>): Cut {
  return { kind: "unresolved-link", at: [anchor, ...[...places].sort()] };
}

export function nameTail(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), name.lastIndexOf("#")) + 1);
}

/**
 * A walked declaration may have callers the index could not link: an unresolved reference whose name tail is its name
 * and whose kind can point at its kind is one cut at those references, led by the declaration they might call. A file
 * that loads modules by a name the index cannot resolve may load anything and is a cut of its own, unless every dynamic
 * load the reader found on that file and line has a string-literal specifier, which names its module like a static
 * import; a file the reader did not read keeps the cut.
 */
export function unresolvedLinkCuts(references: readonly UnresolvedUse[], walked: readonly WalkedDeclaration[], loads: readonly DynamicLoadUse[], settled: ReadonlySet<string> = new Set()): Cut[] {
  const byName = Map.groupBy(walked, (declaration) => declaration.name);
  const hidden = new Map<string, Set<string>>();
  const loaders = new Map<string, Set<string>>();
  const loadsAt = Map.groupBy(loads, (load) => placeAt(load.file, load.line));
  const namesModule = (place: string): boolean => {
    const here = loadsAt.get(place);
    return here !== undefined && here.every((load) => load.specifier !== undefined);
  };
  for (const reference of references) {
    const tail = nameTail(reference.name);
    const place = placeAt(reference.file, reference.line);
    if (reference.kind === "calls" && DYNAMIC_LOADERS.has(tail) && !namesModule(place)) loaders.set(reference.file, (loaders.get(reference.file) ?? new Set()).add(place));
    for (const declaration of byName.get(tail) ?? []) {
      if (!(REFERENCED_BY[reference.kind] ?? []).includes(declaration.kind)) continue;
      const key = declarationAnchor(declaration.file, declaration.name);
      if (settled.has(settledUseKey(key, place))) continue;
      hidden.set(key, (hidden.get(key) ?? new Set()).add(place));
    }
  }
  return [
    ...[...hidden].map(([declaration, places]) => unresolvedLinkAt(declaration, places)),
    ...[...loaders].map(([file, places]) => unresolvedLinkAt(file, places)),
  ];
}

/**
 * A declaration removed whole leaves no node for a caller to reach, so a reference at head that never resolved and names
 * it is the only trace: one cut per removed declaration, at every such reference.
 */
export function removedDeclarationCuts(references: readonly UnresolvedUse[], removed: readonly RemovedDeclaration[]): Cut[] {
  const byName = Map.groupBy(removed, (declaration) => declaration.name);
  const places = new Map<string, Set<string>>();
  for (const reference of references) {
    for (const declaration of byName.get(nameTail(reference.name)) ?? []) {
      const key = declarationAnchor(declaration.file, declaration.name);
      places.set(key, (places.get(key) ?? new Set()).add(placeAt(reference.file, reference.line)));
    }
  }
  return [...places].map(([declaration, at]) => unresolvedLinkAt(declaration, at));
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
    .map(([path, places]) => unresolvedLinkAt(path, places.map(({ line, reason }) => placeAt(path, line, reason))));
}
