/** The segment that stands for any element of an array. */
export const ELEMENT = "[]";

/** Property names and `[]` array elements, from the root of a value to a property inside it; empty is the value itself. */
export type AccessPath = readonly string[];

const PART = /^([^.[\]]*)((?:\[\])*)$/;

export function parseAccessPath(text: string): AccessPath | undefined {
  if (text === "") return [];
  const segments: string[] = [];
  for (const [index, part] of text.split(".").entries()) {
    const match = PART.exec(part);
    if (match === null) return undefined;
    const [, name = "", elements = ""] = match;
    if (name === "" && !(index === 0 && elements !== "")) return undefined;
    if (name !== "") segments.push(name);
    for (let at = 0; at < elements.length; at += ELEMENT.length) segments.push(ELEMENT);
  }
  return segments;
}

export function formatAccessPath(path: AccessPath): string {
  return path.reduce((text, segment, index) => (segment === ELEMENT || index === 0 ? text + segment : `${text}.${segment}`), "");
}

export function startsWith(path: AccessPath, prefix: AccessPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/**
 * How a path the code reads sits against the changed path of the same value: `exact` reads the changed value itself,
 * `beyond` reads inside it (a dereference of it), `contains` reads a value that holds it, `disjoint` never touches it.
 */
export type PathRelation = "exact" | "beyond" | "contains" | "disjoint";

export function relatePaths(read: AccessPath, changed: AccessPath): PathRelation {
  if (read.length === changed.length && startsWith(read, changed)) return "exact";
  if (startsWith(read, changed)) return "beyond";
  if (startsWith(changed, read)) return "contains";
  return "disjoint";
}

/** The value found at `from` of a source value sits at `to` of the value built from it. */
export interface PathMapping {
  from: AccessPath;
  to: AccessPath;
}

/** Where the changed path sits in the projected value: once per mapping that carries it, none when the projection drops it. */
export function rewritePath(changed: AccessPath, mappings: readonly PathMapping[]): AccessPath[] {
  return mappings.filter(({ from }) => startsWith(changed, from)).map(({ from, to }) => [...to, ...changed.slice(from.length)]);
}
