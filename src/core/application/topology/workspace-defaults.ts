import type { TrustMode } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { FixedLayerFault } from "../../ports/fixed-layer-store.port.ts";
import type { WorkspaceDefaults, WorkspaceManifest } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceRepositoryRequest, WorkspaceSource } from "../../ports/workspace-repos.port.ts";

/** The repositories and gateways a workspace request works over, and where they were declared. */
export interface WorkspaceInForce {
  repos: readonly WorkspaceRepositoryRequest[];
  gateways: readonly { prefix: string; repo: string }[];
  source: WorkspaceSource;
}

/** What a workspace request declares itself, beside the repository it is bound to. */
export interface WorkspaceAsk {
  repo: { path: string };
  repos?: readonly WorkspaceRepositoryRequest[];
  gateways?: readonly { prefix: string; repo: string }[];
}

/**
 * The workspace a request works over: the repositories and gateways it names, or, when it names none and the trust mode
 * lets the repository state it, the ones the repository persists. A request that names repositories overrides the
 * persisted workspace entirely, and a gateway the request declares itself always wins. `source` says which of the two
 * answered, and `none` that neither did.
 *
 * A repository the mode does not trust states nothing about the world outside it, so its persisted workspace is never
 * read: under `untrusted` the manifest it names would reach repositories the caller never asked about (ADR-0010
 * decision 2, RFC-0001). The caller names repositories instead, and that request is honoured in both modes.
 */
export async function workspaceInForce(ask: WorkspaceAsk, defaults: WorkspaceDefaults | undefined, trust: TrustMode): Promise<Result<WorkspaceInForce, FixedLayerFault>> {
  const named = ask.repos ?? [];
  if (named.length > 0) return { ok: true, value: { repos: named, gateways: ask.gateways ?? [], source: "request" } };
  const available: Result<WorkspaceManifest | undefined, FixedLayerFault> = defaults === undefined || trust !== "trusted" ? { ok: true, value: undefined } : await defaults.of(ask.repo.path);
  if (!available.ok) return available;
  const manifest = available.value;
  if (manifest === undefined) return { ok: true, value: { repos: [], gateways: ask.gateways ?? [], source: "none" } };
  return { ok: true, value: { repos: manifest.repos, gateways: ask.gateways ?? manifest.gateways ?? [], source: "persisted" } };
}
