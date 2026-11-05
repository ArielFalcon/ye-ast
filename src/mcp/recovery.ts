import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { isFullObjectId } from "../core/domain/shared/revision.ts";
import type { DeclaredConfig, DeclaredScope, Fact, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { ScopeRequest } from "../core/domain/shared/scope.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import { isWorkspaceReplayContext, type WorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { CallersTarget } from "../core/ports/impact-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";

type Arguments = { repo: string; revision?: string; live?: true; scope?: ScopeRequest };
export type Recovery =
  | { version: 1; status: "available"; resultIdentity: string; query: { name: "ye_ast_entrypoints"; arguments: Arguments } }
  | { version: 1; status: "available"; resultIdentity: string; query: { name: "ye_ast_callers" | "ye_ast_impact"; arguments: Record<string, unknown> } }
  | { version: 1; status: "unavailable"; reason: "deadline" | "unresolved-context" | "redacted-context" };

/**
 * The normalized context an `mcp-r1` identity digests beside the public fact: the selected repository, the fact's
 * snapshot, declared scope and config, and for a workspace read its replay context and effective offline policy; impact
 * adds its merge base. Recovery and composition source identity share this one definition.
 */
export type RecoveryContext = {
  repo: string; snapshot: SnapshotRef; declaredScope: DeclaredScope; declaredConfig: DeclaredConfig;
  replay?: WorkspaceReplayContext | undefined; offline?: boolean; mergeBase?: string;
};
export function recoveryContext(fact: Fact<unknown>, selected: string, crossing?: { replay: WorkspaceReplayContext | undefined; offline: boolean | undefined }, mergeBase?: string): RecoveryContext {
  return {
    repo: selected, snapshot: fact.snapshot, declaredScope: fact.inputs.declaredScope, declaredConfig: fact.inputs.declaredConfig,
    ...(crossing === undefined ? {} : { replay: crossing.replay, offline: crossing.offline === true || fact.inputs.trust === "untrusted" }),
    ...(mergeBase === undefined ? {} : { mergeBase }),
  };
}

function hasDeadline(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDeadline);
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (object.status === "unknown" && object.reason === "deadline") || object.kind === "deadline" || Object.values(object).some(hasDeadline);
}

export function entrypointRecovery(fact: Fact<unknown>, original: Fact<unknown>, selected: string, requestedScope: ScopeRequest | undefined, live: boolean, digest: Digest, redaction: Redaction, validate: (args: unknown) => boolean): Recovery {
  const unavailable = (reason: "deadline" | "unresolved-context" | "redacted-context"): Recovery => ({ version: 1, status: "unavailable", reason });
  if (hasDeadline(original) || hasDeadline(fact)) return unavailable("deadline");
  const snap = fact.snapshot;
  if (live ? snap.kind !== "live" || !isFullObjectId(snap.head) || !snap.stateId : snap.kind !== "sha" || !isFullObjectId(snap.sha)) return unavailable("unresolved-context");
  const declared = fact.inputs?.declaredScope;
  if (!declared || !Array.isArray(declared.include) || !Array.isArray(declared.exclude) || !fact.inputs.declaredConfig) return unavailable("unresolved-context");
  const originalScope = original.inputs?.declaredScope;
  if (!originalScope || canonicalJson({ include: originalScope.include, exclude: originalScope.exclude }) !== canonicalJson({ include: declared.include, exclude: declared.exclude })) return unavailable("redacted-context");
  const effectiveScope = { ...(declared.include.length ? { include: declared.include } : {}), ...(declared.exclude.length ? { exclude: declared.exclude } : {}) };
  const args: Arguments = { repo: selected, ...(snap.kind === "live" ? { live: true as const } : { revision: snap.sha }), ...(Object.keys(effectiveScope).length ? { scope: effectiveScope } : {}) };
  if (canonicalJson(redaction.redactValue({ selected, requestedScope, args })) !== canonicalJson({ selected, requestedScope, args })) return unavailable("redacted-context");
  if (!validate(args)) return unavailable("unresolved-context");
  const context = recoveryContext(fact, selected);
  return { version: 1, status: "available", resultIdentity: `mcp-r1:${digest.of(canonicalJson(["mcp-recovery-v1", "ye_ast_entrypoints", context, fact]))}`, query: { name: "ye_ast_entrypoints", arguments: args } };
}

type RecoveryOptions = {
  fact: Fact<unknown>; original: Fact<unknown>; selected: string;
  requestedScope: ScopeRequest | undefined; requestedBudget: unknown; live: boolean;
  workspace: unknown; offline: boolean | undefined; replay: WorkspaceReplayContext | undefined;
  digest: Digest; redaction: Redaction; validate: (args: unknown) => boolean;
};
type Unavailable = Extract<Recovery, { status: "unavailable" }>;
const unavailable = (reason: Unavailable["reason"]): Unavailable => ({ version: 1, status: "unavailable", reason });

function prepare(options: RecoveryOptions) {
  const { fact, original, selected, live, workspace, replay } = options;
  if (hasDeadline(original) || hasDeadline(fact)) return { failure: unavailable("deadline") } as const;
  const snap = fact.snapshot;
  if (canonicalJson(snap) !== canonicalJson(original.snapshot)) return { failure: unavailable("redacted-context") } as const;
  if (live ? snap.kind !== "live" || !isFullObjectId(snap.head) || !snap.stateId : snap.kind !== "sha" || !isFullObjectId(snap.sha)) return { failure: unavailable("unresolved-context") } as const;
  if (workspace !== undefined && (!isWorkspaceReplayContext(replay) || !replay.snapshots.some((s) => s.repo === selected && canonicalJson(s) === canonicalJson(snap)))) return { failure: unavailable("unresolved-context") } as const;
  const declared = fact.inputs?.declaredScope;
  const config = fact.inputs?.declaredConfig;
  if (!declared || !Array.isArray(declared.include) || !Array.isArray(declared.exclude) || !config) return { failure: unavailable("unresolved-context") } as const;
  if (canonicalJson({ scope: original.inputs.declaredScope, config: original.inputs.declaredConfig }) !== canonicalJson({ scope: declared, config })) return { failure: unavailable("redacted-context") } as const;
  const scope = { ...(declared.include.length ? { include: declared.include } : {}), ...(declared.exclude.length ? { exclude: declared.exclude } : {}) };
  const common = { repo: selected, ...(Object.keys(scope).length ? { scope } : {}), ...(config.walk === undefined ? {} : { budget: config.walk }), ...(workspace === undefined ? {} : { workspace, replay, ...(options.offline === undefined ? {} : { offline: options.offline }) }) };
  const context = recoveryContext(fact, selected, workspace === undefined ? undefined : { replay, offline: options.offline });
  return { snap, config, common, context } as const;
}

function complete(options: RecoveryOptions, name: "ye_ast_callers" | "ye_ast_impact", args: Record<string, unknown>, context: object, sensitive: object): Recovery {
  const { selected, requestedScope, requestedBudget, workspace, replay, redaction, validate, digest, fact } = options;
  const inputs = { selected, requestedScope, requestedBudget, workspace, replay, ...sensitive, args };
  if (canonicalJson(redaction.redactValue(inputs)) !== canonicalJson(inputs)) return unavailable("redacted-context");
  if (!validate(args)) return unavailable("unresolved-context");
  const resultIdentity = `mcp-r1:${digest.of(canonicalJson(["mcp-recovery-v1", name, context, fact]))}`;
  return { version: 1, status: "available", resultIdentity, query: { name, arguments: args } };
}

export function callersRecovery(options: RecoveryOptions & { targets: readonly CallersTarget[] }): Recovery {
  const prepared = prepare(options);
  if ("failure" in prepared) return prepared.failure;
  const { snap, config, common, context } = prepared;
  if (!Array.isArray(config.targets)) return unavailable("unresolved-context");
  const args = { ...common, ...(snap.kind === "live" ? { live: true as const } : { revision: snap.sha }), targets: options.targets };
  return complete(options, "ye_ast_callers", args, context, { targets: options.targets });
}

export function impactRecovery(options: RecoveryOptions & { requestedChanged: readonly string[] | undefined }): Recovery {
  const prepared = prepare(options);
  if ("failure" in prepared) return prepared.failure;
  const { snap, config, common, context } = prepared;
  const mergeBase = (fact: Fact<unknown>): unknown => fact.status === "unknown" ? undefined : options.workspace === undefined ? (fact.value as ImpactValue).mergeBase : (fact.value as WorkspaceImpactValue).trigger?.mergeBase;
  const base = mergeBase(options.fact);
  if (base !== mergeBase(options.original)) return unavailable("redacted-context");
  if (typeof base !== "string" || !isFullObjectId(base)) return unavailable("unresolved-context");
  const args = { ...common, base, ...(snap.kind === "live" ? { live: true as const } : { head: snap.sha }), ...(config.changed === undefined ? {} : { changed: config.changed }) };
  return complete(options, "ye_ast_impact", args, recoveryContext(options.fact, options.selected, options.workspace === undefined ? undefined : { replay: options.replay, offline: options.offline }, base), { requestedChanged: options.requestedChanged });
}
