import { formatAccessPath } from "../../domain/contracts/access-path.ts";
import type { ChangeFrontier, ClassifiedDifference, ConsequencesValue, DerivationValue } from "../../domain/contracts/consequence-fact.ts";
import type { Hypothesis } from "../../domain/contracts/hypothesis.ts";
import { CONTRACT_CHANGE_RULES, type ContractChangeRule, type OperationDelta, type ResponseDelta, type RuleTarget } from "../../domain/contracts/contract-change-rules.ts";
import { NOTHING, type ExchangeDigests, type OperationRequest, type OperationShape } from "../../domain/contracts/payload-shape.ts";
import { deriveChanges, LISTING, REQUEST_READING, type Derivation, type DerivationFrontier } from "../../domain/contracts/shape-derivation.ts";
import { httpRouteName, type HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { withCuts, type Evidence, type UnknownReason } from "../../domain/shared/fact.ts";
import type { RepositoryEvidence } from "../../domain/shared/repository-evidence.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ConsequencesFault, ContractConsequencesQueries } from "../../ports/contract-consequences-queries.port.ts";
import type { ConsumerSources, ServingWorkspace, ServingOperation } from "../../ports/consumer-sources.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import { answerOn, assemble, type Answered } from "./contract-consequences-queries.ts";

export interface ContractChangeDeps {
  sources: ConsumerSources;
  revisions: RevisionSources;
  /** In precedence order: a shape a reader states for an operation wins over the same operation's shape from any later reader. */
  shapes: readonly PayloadShapes[];
}

/**
 * What a change between two revisions did to the response of each operation, from the contract both revisions state, and
 * what depends on it at the head: the hypotheses the change derives are answered on the one workspace this call prepares.
 */
export function createContractChange({ sources, revisions, shapes }: ContractChangeDeps): ContractConsequencesQueries["ofChange"] {
  return async ({ base, head, ...workspace }) => {
    if (workspace.repo.live === true) return contradiction("the consequences of a change between revisions are answered on its head commit, never on the working tree");
    const baseSha = await revisions.resolve(workspace, base);
    if (!baseSha.ok) return baseSha;
    const headSha = await revisions.resolve(workspace, head);
    if (!headSha.ok) return headSha;
    if (workspace.repo.revision !== undefined) {
      const bound = await revisions.resolve(workspace, workspace.repo.revision);
      if (!bound.ok) return bound;
      if (bound.value !== headSha.value) return contradiction(`the workspace is bound to ${workspace.repo.revision} (${bound.value}) but the head of the change is ${head} (${headSha.value})`);
    }
    const pinned: WorkspaceRequest = { ...workspace, repo: { ...workspace.repo, revision: headSha.value } };
    return sources.withWorkspace(pinned, async (prepared) => {
      const factBase = prepared.base({ base, head });
      const place = (evidence: Evidence): RepositoryEvidence => ({ ...evidence, repo: factBase.snapshot.repo });
      const derivationBase = { ...factBase, evidence: [] };
      const before = await revisions.filesAt(pinned, baseSha.value);
      const after = await revisions.filesAt(pinned, headSha.value);
      const answered: Answered[] = [];
      let derivation: NonNullable<ConsequencesValue["change"]>["derivation"] = { ...derivationBase, status: "unknown", reason: "revision-unavailable" };
      if (before.ok && after.ok) {
        const plan = planChange(before.value.files, after.value.files, shapes, prepared.serving);
        for (const { hypothesis, operation, property, rules, places } of plan.hypotheses) answered.push(await answerOn(prepared, factBase, hypothesis, { operation, property, rules, places: { base: place(places.base), head: place(places.head) } }));
        const value: DerivationValue = {
          differences: plan.differences.map(({ rule, places, ...difference }): ClassifiedDifference => ({
            rule: rule.id,
            level: rule.level,
            ...difference,
            places: { ...(places.base === undefined ? {} : { base: place(places.base) }), ...(places.head === undefined ? {} : { head: place(places.head) }) },
          })),
          frontiers: plan.frontiers.map(({ evidence, reason, ...frontier }): ChangeFrontier => ({ status: "unknown", reason: reason ?? defaultReason(frontier.kind), ...frontier, evidence: evidence.map(place) })),
        };
        derivation = withCuts(derivationBase, value, [...prepared.cuts, ...before.value.cuts, ...after.value.cuts]);
      }
      return assemble(prepared, factBase, answered, { base, head, snapshots: { base: baseSha.value, head: headSha.value }, derivation });
    });
  };
}

const defaultReason = (kind: ChangeFrontier["kind"]): UnknownReason => (kind === "unreadable-contract" ? "source-unreadable" : "unresolved");

const contradiction = (detail: string): Result<never, ConsequencesFault> => ({ ok: false, fault: { kind: "contradictory-revisions", detail } });

/** A difference the change made, classified by its rule, before it is placed in a repository. */
export interface PlannedDifference {
  rule: ContractChangeRule;
  target: RuleTarget;
  operation: string;
  /** The property of the payload the difference is at; absent for the operation itself. */
  property?: string;
  delta: ResponseDelta | OperationDelta;
  subject?: string;
  base?: unknown;
  head?: unknown;
  /** Where the operation sits in the contract at each revision that declares it. */
  places: { base?: Evidence; head?: Evidence };
}

/** A place the change could not be derived at, before it is placed in a repository. */
interface PlannedFrontier {
  kind: DerivationFrontier["kind"] | "request-unread" | "ambiguous-operation" | "unserved-operation" | "unreadable-contract";
  target?: "request" | "parameter";
  operation?: string;
  property?: string;
  side?: "base" | "head";
  reason?: UnknownReason;
  detail?: string;
  evidence: readonly Evidence[];
}

export interface PlannedHypothesis {
  hypothesis: Hypothesis;
  operation: string;
  property: string;
  /** The rules of the differences the hypothesis answers, sorted. */
  rules: readonly string[];
  places: { base: Evidence; head: Evidence };
}

export interface ChangePlan {
  hypotheses: readonly PlannedHypothesis[];
  /** In the order of the operations, each operation's own difference first, then its properties' in the order the derivation lists them. */
  differences: readonly PlannedDifference[];
  frontiers: readonly PlannedFrontier[];
}

/** An operation as one reader states it. */
interface Held {
  shape: OperationShape;
  place: Evidence;
  /** The operation as its handler's route names it; as the contract writes it when the workspace names no one route. */
  identity: { method: HttpMethod; path: string };
  unserved?: Exclude<ServingOperation, { kind: "served" }>;
}

interface Reading {
  held: ReadonlyMap<string, readonly Held[]>;
  /** What the operations accept, as the reader whose response shape is held states it. */
  requests: ReadonlyMap<string, OperationRequest>;
  unreadable: readonly Evidence[];
}

/**
 * The hypotheses a change between two sets of sources derives, with what cannot be derived. An operation a contract
 * declares is named as the route of the handler that serves it names it, which `serving` decides at the head, so the
 * readers agree on one operation whatever path they write it with; one that no route or several repositories serve is a
 * frontier. A reader that could not read a declared source stops the readers after it for that revision, so a contract
 * that cannot be read is never replaced by what the code does. An operation whose sources are the same at both
 * revisions derives nothing, and sources that are the same at both derive nothing at all.
 */
export function planChange(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[], shapes: readonly PayloadShapes[], serving: ServingWorkspace["serving"]): ChangePlan {
  const hypotheses: PlannedHypothesis[] = [];
  const differences: PlannedDifference[] = [];
  const frontiers: PlannedFrontier[] = [];
  if (!sourcesDiffer(baseFiles, headFiles)) return { hypotheses, differences, frontiers };
  const before = read(baseFiles, shapes, serving);
  const after = read(headFiles, shapes, serving);
  const changed = changedSources(baseFiles, headFiles);

  const unreadable = new Map([...before.unreadable, ...after.unreadable].filter((place) => changed(place.path)).map((place) => [`${place.path}:${place.line}`, place]));
  for (const place of unreadable.values()) frontiers.push({ kind: "unreadable-contract", evidence: [place] });

  const requestUnread: Evidence[] = [];
  for (const operation of [...new Set([...before.held.keys(), ...after.held.keys()])].sort(compareText)) {
    const [base, ...otherBase] = before.held.get(operation) ?? [];
    const [head, ...otherHead] = after.held.get(operation) ?? [];
    if (base === undefined) differences.push(operationDifference("added", operation, { head: head!.place }));
    else if (head === undefined) differences.push(operationDifference("removed", operation, { base: base.place }));
    else if (![base, ...otherBase, head, ...otherHead].some(({ shape, place }) => changed(place.path) || shape.files.some(changed))) continue;
    else {
      const entries = [base, ...otherBase, head, ...otherHead];
      const undecided = undecidedOperation(entries, otherBase.length > 0 || otherHead.length > 0);
      if (undecided !== undefined) {
        frontiers.push({ ...undecided, operation, evidence: entries.map(({ place }) => place) });
        continue;
      }
      const at: Located = { operation, ...head.identity, places: { base: base.place, head: head.place } };
      const request = planRequest(before.requests.get(operation), after.requests.get(operation), at);
      const exchange = exchangeDifferences(base.shape.digests, head.shape.digests);
      if (request === undefined) requestUnread.push(head.place);
      for (const delta of exchange?.responses ?? []) differences.push({ rule: CONTRACT_CHANGE_RULES.response[delta], target: "response", operation, delta, places: at.places });
      if (exchange?.request === true && request?.differences.length === 0 && request.frontiers.length === 0) frontiers.push({ kind: "unclassified-difference", operation, detail: "request", evidence: [base.place, head.place] });
      const response = deriveChanges(base.shape.shape, head.shape.shape);
      hypotheses.push(...response.hypotheses.map((hypothesis) => plannedHypothesis(at, "response", hypothesis)));
      differences.push(...classified("response", response, at));
      frontiers.push(...placedFrontiers(undefined, response, at));
      if (request !== undefined) {
        hypotheses.push(...request.hypotheses);
        differences.push(...request.differences);
        frontiers.push(...request.frontiers);
      }
    }
  }
  if (requestUnread.length > 0) frontiers.push({ kind: "request-unread", reason: "no-extractor", evidence: requestUnread });
  return { hypotheses, differences, frontiers };
}

/** An operation both revisions declare, with the route that names it and its contract place at each. */
interface Located {
  operation: string;
  method: HttpMethod;
  path: string;
  places: { base: Evidence; head: Evidence };
}

const NO_BODY: NonNullable<OperationRequest["body"]> = { shape: NOTHING, required: false };

/**
 * What a change did to an operation's request, when both revisions state it: the body read as a request, whose rejected
 * values derive hypotheses, and the parameters, whose differences are listed.
 */
function planRequest(base: OperationRequest | undefined, head: OperationRequest | undefined, at: Located): Pick<ChangePlan, "hypotheses" | "differences" | "frontiers"> | undefined {
  if (base === undefined || head === undefined) return undefined;
  const [bodyBase, bodyHead] = [base.body ?? NO_BODY, head.body ?? NO_BODY];
  const body = deriveChanges(bodyBase.shape, bodyHead.shape, REQUEST_READING, { base: !bodyBase.required, head: !bodyHead.required });
  const parameters = deriveChanges(base.parameters, head.parameters, LISTING);
  return {
    hypotheses: body.hypotheses.map((hypothesis) => plannedHypothesis(at, "request", hypothesis)),
    differences: [...classified("request", body, at), ...classified("parameter", parameters, at)],
    frontiers: [...placedFrontiers("request", body, at), ...placedFrontiers("parameter", parameters, at)],
  };
}

function plannedHypothesis(at: Located, target: "response" | "request", { property, change, differences }: Derivation<unknown>["hypotheses"][number]): PlannedHypothesis {
  const hypothesis = { method: at.method, path: at.path, target, property, change } as Hypothesis;
  const rules = differences.map(({ delta }) => CONTRACT_CHANGE_RULES[target][delta].id).sort(compareText);
  return { hypothesis, operation: at.operation, property: formatAccessPath(property), rules, places: at.places };
}

function classified(target: "response" | "request" | "parameter", derivation: Derivation<unknown>, at: Located): PlannedDifference[] {
  return derivation.differences.map(({ path, ...difference }) => ({ rule: CONTRACT_CHANGE_RULES[target][difference.delta], target, operation: at.operation, property: formatAccessPath(path), ...difference, places: at.places }));
}

function placedFrontiers(target: "request" | "parameter" | undefined, derivation: Derivation<unknown>, at: Located): PlannedFrontier[] {
  return derivation.frontiers.map(({ path, evidence, ...frontier }) => ({ ...frontier, ...(target === undefined ? {} : { target }), operation: at.operation, property: formatAccessPath(path), evidence: evidence ?? [at.places.base, at.places.head] }));
}

/**
 * What differs beside the success body, from the digests both revisions state: the response parts a rule names, and
 * whether the request differs, which a request reading may not classify. `undefined` when a revision's reader states no digests.
 */
function exchangeDifferences(base: ExchangeDigests | undefined, head: ExchangeDigests | undefined): { responses: ResponseDelta[]; request: boolean } | undefined {
  if (base === undefined || head === undefined) return undefined;
  const responses: ResponseDelta[] = [];
  if (base.errors !== head.errors) responses.push("errors-changed");
  if (base.envelope !== head.envelope) responses.push("envelope-changed");
  return { responses, request: base.request !== head.request };
}

const operationDifference = (delta: OperationDelta, operation: string, places: PlannedDifference["places"]): PlannedDifference => ({ rule: CONTRACT_CHANGE_RULES.operation[delta], target: "operation", operation, delta, places });

/** Why an operation cannot be followed from its entries, when it cannot: declared more than once, undecided servers, or not exactly one route that serves it. */
function undecidedOperation(entries: readonly Held[], repeated: boolean): Pick<PlannedFrontier, "kind" | "detail"> | undefined {
  if (repeated) return { kind: "ambiguous-operation", detail: "declared more than once" };
  if (entries.some(({ shape }) => shape.basePath === undefined)) return { kind: "ambiguous-operation", detail: "servers disagree" };
  const several = entries.find(({ unserved }) => unserved?.kind === "ambiguous")?.unserved;
  if (several?.kind === "ambiguous") return { kind: "ambiguous-operation", detail: `served by several repositories: ${several.repos.join(", ")}` };
  if (entries.some(({ unserved }) => unserved !== undefined)) return { kind: "unserved-operation", detail: "no route of the workspace serves it" };
  return undefined;
}

/** The path the contract serves the operation at: its base path, when it states one, before its path. */
const writtenPath = ({ basePath, path }: Pick<OperationShape, "basePath" | "path">): string => `${basePath ?? ""}${path}`;

function read(files: readonly SourceFile[], providers: readonly PayloadShapes[], serving: ServingWorkspace["serving"]): Reading {
  const held = new Map<string, Held[]>();
  const requests = new Map<string, OperationRequest>();
  const unreadable: Evidence[] = [];
  for (const provider of providers) {
    const claimed = new Map<string, Held[]>();
    let stopped = false;
    for (const finding of provider.responses(files)) {
      if (finding.status === "unknown") {
        unreadable.push(...finding.evidence);
        stopped = true;
        continue;
      }
      const entry = { shape: finding.value, place: finding.evidence[0]!, ...identityOf(finding.value, serving) };
      claimed.set(httpRouteName(entry.identity), [...(claimed.get(httpRouteName(entry.identity)) ?? []), entry]);
    }
    for (const [key, entries] of claimed) if (!held.has(key)) held.set(key, entries);
    for (const finding of provider.requests?.(files) ?? []) {
      if (finding.status !== "complete") continue;
      const key = httpRouteName(identityOf(finding.value, serving).identity);
      if (held.get(key) === claimed.get(key) && !requests.has(key)) requests.set(key, finding.value);
    }
    if (stopped) break;
  }
  return { held, requests, unreadable };
}

function identityOf(written: Pick<OperationShape, "method" | "path" | "basePath">, serving: ServingWorkspace["serving"]): Pick<Held, "identity" | "unserved"> {
  const identity = { method: written.method, path: writtenPath(written) };
  if (written.basePath === undefined) return { identity };
  const served = serving(identity);
  return served.kind === "served" ? { identity: { method: served.method, path: served.path } } : { identity, unserved: served };
}

/** Whether any source differs between the two revisions, or is in only one. */
function sourcesDiffer(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[]): boolean {
  const changed = changedSources(baseFiles, headFiles);
  return baseFiles.some((file) => changed(file.path)) || headFiles.some((file) => changed(file.path));
}

/** Whether a source differs between the two revisions, or is in only one. */
function changedSources(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[]): (path: string) => boolean {
  const base = new Map(baseFiles.map((file) => [file.path, file.content]));
  const head = new Map(headFiles.map((file) => [file.path, file.content]));
  return (path) => base.get(path) !== head.get(path);
}
