import type { FileChange } from "./diff-reader.ts";
import type { ComponentRef } from "./seeds.ts";

export interface ResourceOwner extends ComponentRef {
  resources: readonly string[];
}

export function resourceOwners(declarations: readonly ResourceOwner[]): Map<string, ComponentRef[]> {
  const owners = new Map<string, ComponentRef[]>();
  for (const owner of declarations) for (const resource of owner.resources) {
    const refs = owners.get(resource) ?? [];
    refs.push({ file: owner.file, name: owner.name, line: owner.line });
    owners.set(resource, refs);
  }
  return owners;
}

export function resourceImpact(head: readonly ResourceOwner[], before: readonly ResourceOwner[], changes: readonly FileChange[]): { owners: Map<string, ComponentRef[]>; covered: Set<string> } {
  const owners = resourceOwners(head);
  const covered = new Set(owners.keys());
  const current = new Map(head.map((owner) => [ownerKey(owner), owner]));
  const former = resourceOwners(before);
  const removed = new Set(changes.flatMap((change) => change.removedNames.map((name) => ownerKey({ file: change.path, name }))));
  for (const change of changes) {
    if (!change.deleted) continue;
    const previous = former.get(change.path);
    if (previous === undefined) continue;
    const refs = new Map((owners.get(change.path) ?? []).map((owner) => [ownerKey(owner), owner]));
    let accounted = true;
    for (const owner of previous) {
      const key = ownerKey(owner);
      const survivor = current.get(key);
      if (survivor !== undefined) refs.set(key, { file: survivor.file, name: survivor.name, line: survivor.line });
      else if (!removed.has(key)) accounted = false;
    }
    if (refs.size > 0) owners.set(change.path, [...refs.values()]);
    if (accounted) covered.add(change.path);
    else covered.delete(change.path);
  }
  return { owners, covered };
}

function ownerKey(owner: Pick<ComponentRef, "file" | "name">): string {
  return JSON.stringify([owner.file, owner.name]);
}
