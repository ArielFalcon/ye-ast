import { declarationAnchor, placeAt } from "../impact/impact-cuts.ts";
import { fileReach } from "../languages/call-targets.ts";
import { compareText } from "../shared/code-node.ts";
import type { Cut } from "../shared/fact.ts";
import type { OutlinePlace, OutlineUse, OutlineUseTarget } from "./outline-fact.ts";

/** One use of the body as found: where it leads, how, and where, if the index places it. */
export interface FoundUse {
  target: OutlineUseTarget;
  relation: string;
  place?: OutlinePlace;
}

/** A use no binding proves: the name it is rooted at and where the body spells it. */
export interface UnprovedUse {
  root: string;
  line: number;
  spelling: string;
}

/** The uses once per target, with every relation and place, ordered by first place; a target placed nowhere comes last. */
export function outlineUses(found: readonly FoundUse[]): OutlineUse[] {
  const byTarget = new Map<string, { target: OutlineUseTarget; relations: Set<string>; at: Map<string, OutlinePlace> }>();
  for (const { target, relation, place } of found) {
    const key = targetKey(target);
    const entry = byTarget.get(key) ?? { target, relations: new Set<string>(), at: new Map<string, OutlinePlace>() };
    entry.relations.add(relation);
    if (place !== undefined) entry.at.set(`${place.line}:${place.column ?? ""}`, place);
    byTarget.set(key, entry);
  }
  return [...byTarget.values()]
    .map(({ target, relations, at }): OutlineUse => ({ ...target, relations: [...relations].sort(compareText), at: [...at.values()].sort(comparePlace) }))
    .sort((a, b) => comparePlace(a.at[0], b.at[0]) || compareText(targetKey(a), targetKey(b)));
}

/** One `unresolved-link` cut per name the declaration uses without a proof, anchored at the declaration, every place after it. */
export function unprovedUseCuts(file: string, path: string, unproved: readonly UnprovedUse[]): Cut[] {
  return [...Map.groupBy(unproved, (use) => use.root)].map(([, uses]) => ({
    kind: "unresolved-link",
    at: [declarationAnchor(file, path), ...[...new Set(uses.map((use) => placeAt(file, use.line, use.spelling)))].sort(compareText)],
    reason: "use-unproven",
    reach: fileReach(file),
  }));
}

/** Whether the declaration at `path` of `file` uses a name no binding proves: an `unresolved-link` cut is anchored at it. */
export function hasUnprovedUses(cuts: readonly Cut[], file: string, path: string): boolean {
  const anchor = declarationAnchor(file, path);
  return cuts.some((cut) => cut.kind === "unresolved-link" && cut.at[0] === anchor);
}

function targetKey(target: OutlineUseTarget): string {
  if ("declaration" in target) return JSON.stringify(["declaration", target.declaration.file, target.declaration.line, target.declaration.name]);
  return "module" in target ? JSON.stringify(["module", target.module]) : JSON.stringify(["global", target.global]);
}

function comparePlace(a: OutlinePlace | undefined, b: OutlinePlace | undefined): number {
  return (a?.line ?? Infinity) - (b?.line ?? Infinity) || (a?.column ?? Infinity) - (b?.column ?? Infinity);
}
