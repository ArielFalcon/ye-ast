import { formatAccessPath } from "../../domain/contracts/access-path.ts";
import { writtenChange, type ChangeEntry } from "../../domain/contracts/change.ts";
import type { ConsequencesValue } from "../../domain/contracts/consequence-fact.ts";
import type { Hypothesis } from "../../domain/contracts/hypothesis.ts";
import type { OperationShape } from "../../domain/contracts/payload-shape.ts";
import { deriveChanges, type DerivationFrontier, type RetiredValue } from "../../domain/contracts/shape-derivation.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Fact, UnknownReason } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ConsequencesFault } from "../../ports/consumer-queries.port.ts";
import type { ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import { consequencesOn } from "./consumer-queries.ts";

/** The sources of the repository a request is bound to at a revision: what the shape readers read. */
export interface RevisionSources {
  filesAt(request: WorkspaceRequest, revision: string): Promise<Result<readonly SourceFile[], WorkspaceFault>>;
}

export interface ContractChangeDeps {
  sources: ConsumerSources;
  revisions: RevisionSources;
  /** In precedence order: a shape a reader states for an operation wins over the same operation's shape from any later reader. */
  shapes: readonly PayloadShapes[];
}

export interface ContractChangeRequest {
  /** The workspace the consequences are answered on: the head of the change. */
  workspace: WorkspaceRequest;
  base: string;
  head: string;
}

/** One property of one operation's response that the change altered, with what following it found. */
export interface DerivedConsequences {
  operation: string;
  property: string;
  change: ChangeEntry | readonly ChangeEntry[];
  /** Where the operation sits in the contract at each revision. */
  places: { base: Evidence; head: Evidence };
  consequences: Result<Fact<ConsequencesValue>, ConsequencesFault>;
}

/** A guarantee the head gives that the base did not: listed with its place and not followed. */
export interface GainedGuaranteeItem {
  operation: string;
  property: string;
  retired: RetiredValue;
  places: { base: Evidence; head: Evidence };
}

/** A place the change could not be derived at, so nothing at or below it is decided. */
export interface ChangeFrontier {
  kind: DerivationFrontier["kind"] | "ambiguous-operation" | "unreadable-contract";
  operation?: string;
  property?: string;
  side?: "base" | "head";
  reason?: UnknownReason;
  detail?: string;
  evidence: readonly Evidence[];
}

export interface ContractChangeValue {
  base: string;
  head: string;
  derived: readonly DerivedConsequences[];
  gained: readonly GainedGuaranteeItem[];
  frontiers: readonly ChangeFrontier[];
  /** Operations only one revision declares, by name: they derive no hypothesis. */
  operations: { added: readonly string[]; removed: readonly string[] };
}

export interface ContractChangeQueries {
  /**
   * What a change between two revisions did to the response of each operation, from the contract both revisions state,
   * and what depends on it at the head. An operation or place whose shape cannot be stated is a frontier, never silence.
   */
  consequencesOfChange(request: ContractChangeRequest): Promise<Result<ContractChangeValue, WorkspaceFault>>;
}

export function createContractChangeQueries({ sources, revisions, shapes }: ContractChangeDeps): ContractChangeQueries {
  return {
    async consequencesOfChange({ workspace, base, head }) {
      const before = await revisions.filesAt(workspace, base);
      if (!before.ok) return before;
      const after = await revisions.filesAt(workspace, head);
      if (!after.ok) return after;
      const plan = planChange(before.value, after.value, shapes);
      const answered = plan.hypotheses.length === 0 ? { ok: true as const, value: [] } : await sources.withWorkspace(workspace, async (prepared) => {
        const results: Result<Fact<ConsequencesValue>, ConsequencesFault>[] = [];
        for (const { hypothesis } of plan.hypotheses) results.push(await consequencesOn(prepared, hypothesis));
        return results;
      });
      if (!answered.ok) return answered;
      const derived = plan.hypotheses.map(({ hypothesis, operation, property, places }, index): DerivedConsequences => ({ operation, property, change: writtenChange(hypothesis.change), places, consequences: answered.value[index]! }));
      return { ok: true, value: { base, head, derived, gained: plan.gained, frontiers: plan.frontiers, operations: plan.operations } };
    },
  };
}

export interface PlannedHypothesis {
  hypothesis: Hypothesis;
  operation: string;
  property: string;
  places: { base: Evidence; head: Evidence };
}

export interface ChangePlan {
  hypotheses: readonly PlannedHypothesis[];
  gained: readonly GainedGuaranteeItem[];
  frontiers: readonly ChangeFrontier[];
  operations: { added: readonly string[]; removed: readonly string[] };
}

interface Held {
  shape: OperationShape;
  place: Evidence;
}

interface Reading {
  held: ReadonlyMap<string, readonly Held[]>;
  unreadable: readonly Evidence[];
}

/**
 * The hypotheses a change between two sets of sources derives, with what cannot be derived. A reader that could not read
 * a declared source stops the readers after it for that revision, so a contract that cannot be read is never replaced by
 * what the code does. An operation whose sources are the same at both revisions derives nothing.
 */
export function planChange(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[], shapes: readonly PayloadShapes[]): ChangePlan {
  const before = read(baseFiles, shapes);
  const after = read(headFiles, shapes);
  const changed = changedSources(baseFiles, headFiles);
  const hypotheses: PlannedHypothesis[] = [];
  const gained: GainedGuaranteeItem[] = [];
  const frontiers: ChangeFrontier[] = [];
  const operations = { added: [] as string[], removed: [] as string[] };

  const unreadable = new Map([...before.unreadable, ...after.unreadable].filter((place) => changed(place.path)).map((place) => [`${place.path}:${place.line}`, place]));
  for (const place of unreadable.values()) frontiers.push({ kind: "unreadable-contract", evidence: [place] });

  for (const operation of [...new Set([...before.held.keys(), ...after.held.keys()])].sort(compareText)) {
    const [base, ...otherBase] = before.held.get(operation) ?? [];
    const [head, ...otherHead] = after.held.get(operation) ?? [];
    if (base === undefined) operations.added.push(operation);
    else if (head === undefined) operations.removed.push(operation);
    else if (![base, ...otherBase, head, ...otherHead].some(({ shape, place }) => changed(place.path) || shape.files.some(changed))) continue;
    else if (otherBase.length > 0 || otherHead.length > 0 || base.shape.basePath === undefined || head.shape.basePath === undefined) {
      const detail = otherBase.length > 0 || otherHead.length > 0 ? "declared more than once" : "servers disagree";
      frontiers.push({ kind: "ambiguous-operation", operation, detail, evidence: [base, ...otherBase, head, ...otherHead].map(({ place }) => place) });
    } else {
      const places = { base: base.place, head: head.place };
      const derivation = deriveChanges(base.shape.shape, head.shape.shape);
      const [method, path] = [head.shape.method, head.shape.path];
      for (const { property, change } of derivation.hypotheses) hypotheses.push({ hypothesis: { method, path, target: "response", property, change }, operation, property: formatAccessPath(property), places });
      for (const { path: at, retired } of derivation.gained) gained.push({ operation, property: formatAccessPath(at), retired, places });
      for (const { path: at, evidence, ...frontier } of derivation.frontiers) frontiers.push({ ...frontier, operation, property: formatAccessPath(at), evidence: evidence ?? [base.place, head.place] });
    }
  }
  return { hypotheses, gained, frontiers, operations };
}

function read(files: readonly SourceFile[], providers: readonly PayloadShapes[]): Reading {
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
      const key = `${finding.value.method} ${finding.value.path}`;
      claimed.set(key, [...(claimed.get(key) ?? []), { shape: finding.value, place: finding.evidence[0]! }]);
    }
    for (const [key, entries] of claimed) if (!held.has(key)) held.set(key, entries);
    if (stopped) break;
  }
  return { held, unreadable };
}

/** Whether a source differs between the two revisions, or is in only one. */
function changedSources(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[]): (path: string) => boolean {
  const base = new Map(baseFiles.map((file) => [file.path, file.content]));
  const head = new Map(headFiles.map((file) => [file.path, file.content]));
  return (path) => base.get(path) !== head.get(path);
}
