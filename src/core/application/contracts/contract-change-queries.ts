import { formatAccessPath } from "../../domain/contracts/access-path.ts";
import type { ChangeFrontier, ConsequencesValue, DerivationValue } from "../../domain/contracts/consequence-fact.ts";
import type { ResponseHypothesis } from "../../domain/contracts/hypothesis.ts";
import type { OperationShape } from "../../domain/contracts/payload-shape.ts";
import { deriveChanges, type DerivationFrontier, type RetiredValue } from "../../domain/contracts/shape-derivation.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
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
        for (const { hypothesis, operation, property, places } of plan.hypotheses) answered.push(await answerOn(prepared, factBase, hypothesis, { operation, property, places: { base: place(places.base), head: place(places.head) } }));
        const value: DerivationValue = {
          gained: plan.gained.map(({ places, ...gained }) => ({ ...gained, places: { base: place(places.base), head: place(places.head) } })),
          operations: plan.operations,
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

/** A guarantee the head gives that the base did not, before it is placed in a repository. */
interface PlannedGain {
  operation: string;
  property: string;
  retired: RetiredValue;
  places: { base: Evidence; head: Evidence };
}

/** A place the change could not be derived at, before it is placed in a repository. */
interface PlannedFrontier {
  kind: DerivationFrontier["kind"] | "ambiguous-operation" | "unserved-operation" | "unreadable-contract";
  operation?: string;
  property?: string;
  side?: "base" | "head";
  reason?: UnknownReason;
  detail?: string;
  evidence: readonly Evidence[];
}

export interface PlannedHypothesis {
  hypothesis: ResponseHypothesis;
  operation: string;
  property: string;
  places: { base: Evidence; head: Evidence };
}

export interface ChangePlan {
  hypotheses: readonly PlannedHypothesis[];
  gained: readonly PlannedGain[];
  frontiers: readonly PlannedFrontier[];
  operations: { added: readonly string[]; removed: readonly string[] };
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
  const gained: PlannedGain[] = [];
  const frontiers: PlannedFrontier[] = [];
  const operations = { added: [] as string[], removed: [] as string[] };
  if (!sourcesDiffer(baseFiles, headFiles)) return { hypotheses, gained, frontiers, operations };
  const before = read(baseFiles, shapes, serving);
  const after = read(headFiles, shapes, serving);
  const changed = changedSources(baseFiles, headFiles);

  const unreadable = new Map([...before.unreadable, ...after.unreadable].filter((place) => changed(place.path)).map((place) => [`${place.path}:${place.line}`, place]));
  for (const place of unreadable.values()) frontiers.push({ kind: "unreadable-contract", evidence: [place] });

  for (const operation of [...new Set([...before.held.keys(), ...after.held.keys()])].sort(compareText)) {
    const [base, ...otherBase] = before.held.get(operation) ?? [];
    const [head, ...otherHead] = after.held.get(operation) ?? [];
    if (base === undefined) operations.added.push(operation);
    else if (head === undefined) operations.removed.push(operation);
    else if (![base, ...otherBase, head, ...otherHead].some(({ shape, place }) => changed(place.path) || shape.files.some(changed))) continue;
    else {
      const entries = [base, ...otherBase, head, ...otherHead];
      const undecided = undecidedOperation(entries, otherBase.length > 0 || otherHead.length > 0);
      if (undecided !== undefined) {
        frontiers.push({ ...undecided, operation, evidence: entries.map(({ place }) => place) });
        continue;
      }
      const places = { base: base.place, head: head.place };
      const derivation = deriveChanges(base.shape.shape, head.shape.shape);
      const { method, path } = head.identity;
      for (const { property, change } of derivation.hypotheses) hypotheses.push({ hypothesis: { method, path, target: "response", property, change }, operation, property: formatAccessPath(property), places });
      for (const { path: at, retired } of derivation.gained) gained.push({ operation, property: formatAccessPath(at), retired, places });
      for (const { path: at, evidence, ...frontier } of derivation.frontiers) frontiers.push({ ...frontier, operation, property: formatAccessPath(at), evidence: evidence ?? [base.place, head.place] });
    }
  }
  return { hypotheses, gained, frontiers, operations };
}

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
const writtenPath = ({ basePath, path }: OperationShape): string => `${basePath ?? ""}${path}`;

function read(files: readonly SourceFile[], providers: readonly PayloadShapes[], serving: ServingWorkspace["serving"]): Reading {
  const held = new Map<string, Held[]>();
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
      const entry = heldOperation(finding.value, finding.evidence[0]!, serving);
      const key = `${entry.identity.method} ${entry.identity.path}`;
      claimed.set(key, [...(claimed.get(key) ?? []), entry]);
    }
    for (const [key, entries] of claimed) if (!held.has(key)) held.set(key, entries);
    if (stopped) break;
  }
  return { held, unreadable };
}

function heldOperation(shape: OperationShape, place: Evidence, serving: ServingWorkspace["serving"]): Held {
  const written = { method: shape.method, path: writtenPath(shape) };
  if (shape.basePath === undefined) return { shape, place, identity: written };
  const served = serving(written);
  return served.kind === "served" ? { shape, place, identity: { method: served.method, path: served.path } } : { shape, place, identity: written, unserved: served };
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
