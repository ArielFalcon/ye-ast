import type { Result } from "../core/domain/shared/result.ts";

export interface RepositoryBinding { path: string; repoId: string }
export interface RepositoryTargetFault {
  kind: "unknown-repository" | "ambiguous-repository";
  detail: string;
  repository: string;
  available: readonly string[];
}

/** Copies the declared bindings so later host mutations cannot change the server's authority. */
export function repositoryCatalog(launch: RepositoryBinding, additional: readonly RepositoryBinding[] = []) {
  const byId = new Map<string, RepositoryBinding[]>();
  const byPath = new Map<string, string>();
  let valid = true;
  for (const original of [launch, ...additional]) {
    const binding = { path: original.path, repoId: original.repoId };
    if (binding.path.length === 0 || binding.repoId.length === 0) valid = false;
    const entries = byId.get(binding.repoId) ?? [];
    if (!entries.some((entry) => entry.path === binding.path)) entries.push(binding);
    byId.set(binding.repoId, entries);
    const previous = byPath.get(binding.path);
    if (previous !== undefined && previous !== binding.repoId) valid = false;
    byPath.set(binding.path, binding.repoId);
    if (entries.length > 1) valid = false;
  }
  const available = [...byId.keys()].sort();
  const defaultId = launch.repoId;
  function resolve(requested?: string): Result<RepositoryBinding, RepositoryTargetFault> {
    const id = requested ?? defaultId;
    const entries = byId.get(id);
    if (entries === undefined || entries.length !== 1) {
      const kind = entries === undefined ? "unknown-repository" : "ambiguous-repository";
      return { ok: false, fault: { kind, detail: `Repository ID ${id} is ${entries === undefined ? "not declared" : "ambiguous"}`, repository: id, available: [...available] } };
    }
    return { ok: true, value: { ...entries[0]! } };
  }
  return { valid, available: [...available], resolve };
}
