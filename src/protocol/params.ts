import { isWorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import { isValidGlob, type ScopeRequest } from "../core/domain/shared/scope.ts";
import { isPositiveCount } from "../core/domain/shared/count.ts";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import type { AtRevision } from "../core/ports/live-queries.port.ts";
import { isWalkBoundField, WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { CallersTarget, ImpactCallersRequest, ImpactImportersRequest, ImpactOfChangeRequest } from "../core/ports/impact-queries.port.ts";
import type { OutlineRequest, OutlineSelector } from "../core/ports/outline-queries.port.ts";
import type { WorkspaceRequest } from "../core/ports/workspace-queries.port.ts";
import type { DecisionsRequest } from "../core/ports/decision-queries.port.ts";
import type { WorkspaceRepositoryRequest } from "../core/ports/workspace-repos.port.ts";
import { isId, isRecord } from "./guards.ts";
import { isTrustMode, type TrustMode } from "../core/domain/shared/fact.ts";
import type { RequestId } from "./protocol.ts";

export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

type Params = Readonly<Record<string, unknown>>;

const DEADLINE_PARAM = "deadlineMs";

/** The largest delay `setTimeout` honours; above it the timer fires at once. */
export const MAX_DEADLINE_MS = 2 ** 31 - 1;

function only(params: unknown, allowed: readonly string[]): Params {
  if (!isRecord(params)) throw new InvalidParamsError("params must be an object");
  for (const key of Object.keys(params)) {
    if (key !== DEADLINE_PARAM && !allowed.includes(key)) throw new InvalidParamsError(`unknown param ${key}`);
  }
  return params;
}

function text(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new InvalidParamsError(`${key} must be a non-empty string`);
  return value;
}

function positive(value: unknown, name: string): number {
  if (!isPositiveCount(value)) throw new InvalidParamsError(`${name} must be a positive integer`);
  return value;
}

function list<T>(params: Params, key: string, item: (value: unknown) => T): T[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) throw new InvalidParamsError(`${key} must be a non-empty array`);
  return value.map(item);
}

function budgetOf(params: Params): { budget?: ImpactBudget } {
  const value = params.budget;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new InvalidParamsError("budget must be an object");
  const budget: Partial<Record<WalkBoundsField, number>> = {};
  for (const [field, count] of Object.entries(value)) {
    if (!isWalkBoundField(field)) throw new InvalidParamsError(`unknown budget field ${field}`);
    budget[field] = positive(count, `budget.${field}`);
  }
  return { budget: budget as ImpactBudget };
}

function scopeOf(params: Params): { scope?: ScopeRequest } {
  const value = params.scope;
  if (value === undefined) return {};
  const fields = only(value, ["include", "exclude"]);
  const scope: ScopeRequest = {};
  for (const field of ["include", "exclude"] as const) {
    if (fields[field] !== undefined) scope[field] = list(fields, field, globOf);
  }
  return { scope };
}

function globOf(value: unknown): string {
  if (typeof value !== "string" || !isValidGlob(value)) throw new InvalidParamsError("globs must be relative, normalized, slash-separated patterns");
  return value;
}

function targetOf(value: unknown): CallersTarget {
  if (!isRecord(value)) throw new InvalidParamsError("a target must be an object");
  const file = text(value, "file");
  if ("symbol" in value) {
    only(value, ["file", "symbol"]);
    return { file, symbol: text(value, "symbol") };
  }
  only(value, ["file", "start", "end"]);
  const [start, end] = [positive(value.start, "start"), positive(value.end, "end")];
  if (start > end) throw new InvalidParamsError("start must not exceed end");
  return { file, start, end };
}

function selectorOf(value: unknown): OutlineSelector {
  if (!isRecord(value)) throw new InvalidParamsError("a focus selector must be an object");
  const file = text(value, "file");
  if ("symbol" in value) {
    only(value, ["file", "symbol"]);
    return { file, symbol: text(value, "symbol") };
  }
  only(value, ["file", "line"]);
  return { file, line: positive(value.line, "line") };
}

function fileOf(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new InvalidParamsError("files must be non-empty strings");
  return value;
}

function repositoryOf(value: unknown): WorkspaceRepositoryRequest {
  if (!isRecord(value)) throw new InvalidParamsError("a repository must be an object");
  const fields = only(value, ["path", "id", "revision", "remote", "live"]);
  if ("deadlineMs" in fields || ("live" in fields && (fields.live !== true || "revision" in fields))) throw new InvalidParamsError("invalid repository selector");
  for (const key of ["path", "id", "revision"] as const) {
    if (key in fields && (typeof fields[key] !== "string" || fields[key].trim() === "")) throw new InvalidParamsError(`${key} must be a non-empty string`);
  }
  const common = { path: text(fields, "path"),
    ...(fields.id === undefined ? {} : { id: text(fields, "id") }),
    ...(fields.remote === undefined ? {} : { remote: text(fields, "remote") }) };
  return fields.live === true ? { ...common, live: true } : { ...common, ...(fields.revision === undefined ? {} : { revision: text(fields, "revision") }) };
}

function gatewayOf(value: unknown): { prefix: string; repo: string } {
  if (!isRecord(value)) throw new InvalidParamsError("a gateway must be an object");
  const fields = only(value, ["prefix", "repo"]);
  return { prefix: text(fields, "prefix"), repo: text(fields, "repo") };
}

function flag(params: Params, key: string): boolean {
  const value = params[key];
  if (typeof value !== "boolean") throw new InvalidParamsError(`${key} must be a boolean`);
  return value;
}

/** The deadline in milliseconds from receipt, when the call carries one. */
export function deadlineOf(params: unknown): number | undefined {
  if (!isRecord(params) || params[DEADLINE_PARAM] === undefined) return undefined;
  const deadline = positive(params[DEADLINE_PARAM], DEADLINE_PARAM);
  if (deadline > MAX_DEADLINE_MS) throw new InvalidParamsError(`${DEADLINE_PARAM} must not exceed ${MAX_DEADLINE_MS}`);
  return deadline;
}

export function readMap(params: unknown): Omit<AtRevision<MapRequest>, "signal"> {
  const p = only(params, ["repo", "repoId", "revision", "scope"]);
  return { repo: text(p, "repo"), repoId: text(p, "repoId"), revision: text(p, "revision"), ...scopeOf(p) };
}

export function readOfChange(params: unknown): Omit<AtRevision<ImpactOfChangeRequest>, "signal"> {
  const p = only(params, ["repo", "repoId", "base", "head", "changed", "scope", "budget"]);
  return {
    repo: text(p, "repo"),
    repoId: text(p, "repoId"),
    base: text(p, "base"),
    head: text(p, "head"),
    ...(p.changed === undefined ? {} : { changed: list(p, "changed", globOf) }),
    ...scopeOf(p),
    ...budgetOf(p),
  };
}

export function readCallers(params: unknown): Omit<AtRevision<ImpactCallersRequest>, "signal"> {
  const p = only(params, ["repo", "source", "repoId", "revision", "targets", "scope", "budget"]);
  return { repo: text(p, "repo"), ...(p.source === undefined ? {} : { source: text(p, "source") }), repoId: text(p, "repoId"), revision: text(p, "revision"), targets: list(p, "targets", targetOf), ...scopeOf(p), ...budgetOf(p) };
}

export function readImporters(params: unknown): Omit<AtRevision<ImpactImportersRequest>, "signal"> {
  const p = only(params, ["repo", "repoId", "revision", "files", "scope"]);
  return { repo: text(p, "repo"), repoId: text(p, "repoId"), revision: text(p, "revision"), files: list(p, "files", fileOf), ...scopeOf(p) };
}

/** `Omit` over each member of a union, so the members stay told apart. */
type Unsignaled<T> = T extends unknown ? Omit<T, "signal"> : never;

export function readOutline(params: unknown): Unsignaled<Extract<OutlineRequest, { live?: undefined }>> {
  const p = only(params, ["repo", "repoId", "revision", "files", "focus", "scope"]);
  if ((p.files === undefined) === (p.focus === undefined)) throw new InvalidParamsError("give exactly one of files and focus");
  const subject = p.focus === undefined ? { files: list(p, "files", fileOf) } : { focus: list(p, "focus", selectorOf) };
  return { repo: text(p, "repo"), repoId: text(p, "repoId"), revision: text(p, "revision"), ...subject, ...scopeOf(p) };
}

export function readWorkspace(params: unknown): Omit<WorkspaceRequest, "signal"> {
  return workspaceFields(only(params, ["repo", "repos", "gateways", "scope", "offline", "replay"]));
}

function workspaceFields(p: Params): Omit<WorkspaceRequest, "signal"> {
  const replay = p.replay;
  if (replay !== undefined && (!isWorkspaceReplayContext(replay) || replay.snapshots.length === 0)) throw new InvalidParamsError("invalid workspace replay");
  return {
    ...(replay === undefined ? {} : { replay }),
    repo: repositoryOf(p.repo),
    ...(p.repos === undefined ? {} : { repos: list(p, "repos", repositoryOf) }),
    ...(p.gateways === undefined ? {} : { gateways: list(p, "gateways", gatewayOf) }),
    ...scopeOf(p),
    ...(p.offline === undefined ? {} : { offline: flag(p, "offline") }),
  };
}

export function readDecisions(params: unknown): Omit<DecisionsRequest, "signal"> {
  return workspaceFields(only(params, ["repo", "repos", "gateways", "scope", "offline"]));
}

export function readTrustMode(params: unknown): TrustMode {
  const mode = text(only(params, ["mode"]), "mode");
  if (!isTrustMode(mode)) throw new InvalidParamsError("mode must be trusted or untrusted");
  return mode;
}

export function readCancelledId(params: unknown): RequestId | undefined {
  const id = isRecord(params) ? params.id : undefined;
  return isId(id) ? id : undefined;
}
