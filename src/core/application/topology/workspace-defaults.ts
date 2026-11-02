import type { Result } from "../../domain/shared/result.ts";
import type { FixedLayerFault } from "../../ports/fixed-layer-store.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceRepositoryRequest } from "../../ports/workspace-repos.port.ts";

/** The repositories and gateways a workspace request works over. */
export interface WorkspaceInForce {
  repos: readonly WorkspaceRepositoryRequest[];
  gateways: readonly { prefix: string; repo: string }[];
}

/** What a workspace request declares itself, beside the repository it is bound to. */
export interface WorkspaceAsk {
  repo: { path: string };
  repos?: readonly WorkspaceRepositoryRequest[];
  gateways?: readonly { prefix: string; repo: string }[];
}

/**
 * The workspace a request works over: the repositories and gateways it names, or, when it names no repository, the ones
 * the repository persists. A request that names repositories overrides the persisted workspace entirely, and a gateway
 * the request declares itself always wins.
 */
export async function workspaceInForce(ask: WorkspaceAsk, defaults: WorkspaceDefaults | undefined): Promise<Result<WorkspaceInForce, FixedLayerFault>> {
  const named = ask.repos ?? [];
  if (named.length > 0) return { ok: true, value: { repos: named, gateways: ask.gateways ?? [] } };
  if (defaults === undefined) return { ok: true, value: { repos: [], gateways: ask.gateways ?? [] } };
  const persisted = await defaults.of(ask.repo.path);
  if (!persisted.ok) return persisted;
  const manifest = persisted.value;
  return { ok: true, value: { repos: manifest?.repos ?? [], gateways: ask.gateways ?? manifest?.gateways ?? [] } };
}
