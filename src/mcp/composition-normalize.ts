/**
 * Normalization of one executed source into its evidence set: seven exhaustive adapters over the public,
 * redacted `SourcePayload`, by typed fields only. Every public appearance becomes a support (source, owning read, RFC
 * 6901 pointer into `read.fact`); identical objects share one record and keep every support, so original order and
 * multiplicity are recovered by position. No relation is inferred, no text is parsed and no coordinate is invented: a
 * repository outside the source vector, a missing merge base or external configuration keep a `query-context` origin.
 */
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Cut, Evidence, Fact, FactProvenance, Finding, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportedFile, ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { OutlineDeclaration, OutlineValue } from "../core/domain/outline/outline-fact.ts";
import { hasUnprovedUses } from "../core/domain/outline/outline-uses.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { CallSite } from "../core/domain/topology/call-site.ts";
import type { Link } from "../core/domain/topology/link.ts";
import type { Decision } from "../core/domain/decisions/decision.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import { analysis } from "./select-evidence.ts";
import type { ExecutedSource, PublicWorkspaceValue } from "./query-runner.ts";
import { recoveryContext, type RecoveryContext } from "./recovery.ts";
import type {
  AnchorId, AnchorRecord, ComparisonRef, EntryData, EvidenceFinding, EvidenceId, EvidenceOrigin, EvidenceRecord,
  EvidenceSet, FileCategory, FileDependencyCategory, FileId, FileRecord, LinkData, LinkReference, OriginReference, OutlineImportRecord, OutlineUseRecord, Part, PartId,
  PartPayload, ReadAnalysis, ReadId, ReadOwner, ReadRecord, RedactionRecord, RecordedCollectionState, SnapshotId, SnapshotRecord,
  SnapshotVectorEntry, SourceFamilyRef, SourceId, Support,
} from "./composition-contract.ts";
import {
  anchorId, evidenceId, fileId, jsonPointer, partId, readId, snapshotId, sortById, sourceId, unionSupports,
  type Occurrence, type SourceContext,
} from "./composition-identity.ts";

/** Normalizes one executed source. Pure and deterministic: the same public source always yields the same set. */
export function normalizeSource(source: ExecutedSource, digest: Digest, options?: { discriminator: number }): EvidenceSet {
  const family = familyRef(source);
  if (options !== undefined && (!Number.isSafeInteger(options.discriminator) || options.discriminator < 0)) throw new Error("Invalid normalization discriminator");
  const id = sourceId(digest, { ...family, context: contextOf(source), fact: source.read.fact, ...(options === undefined ? {} : { discriminator: options.discriminator }) });
  const builder = new Builder(digest, id, source.identityGuard.changedIdentityPointers);
  const root = builder.read({ kind: "fact" }, "", source.read.fact);
  const vector = adapt(source, builder, root);
  return builder.finish({ ...family, id, rootRead: root.id, snapshotVector: vector, analysis: analysis(source.read.fact) });
}

function familyRef(source: ExecutedSource): SourceFamilyRef {
  return source.family === "impact" || source.family === "callers" ? { family: source.family, branch: source.branch } : { family: source.family };
}

/**
 * The context half of the source identity. The three recoverable families reuse the `mcp-r1` context; the other four
 * take the same fields from the public fact, with the effective offline policy where the family has one.
 */
function contextOf(source: ExecutedSource): SourceContext {
  const fact: Fact<unknown> = source.read.fact;
  const selected = fact.snapshot.repo;
  const fresh = (context: RecoveryContext): SourceContext => {
    const { replay: _replay, mergeBase: _mergeBase, ...rest } = context;
    return { kind: "fresh", context: rest };
  };
  switch (source.family) {
    case "entrypoints":
      return { kind: "recovery", context: recoveryContext(fact, selected) };
    case "impact":
    case "callers": {
      if (source.branch === "local") {
        const base = source.family === "impact" && source.read.fact.status !== "unknown" ? source.read.fact.value.mergeBase : undefined;
        return { kind: "recovery", context: recoveryContext(fact, selected, undefined, base) };
      }
      const base = source.family === "impact" && source.read.fact.status !== "unknown" ? source.read.fact.value.trigger.mergeBase : undefined;
      return { kind: "recovery", context: recoveryContext(fact, selected, { replay: source.read.workspaceReplay, offline: source.query.arguments.offline }, base) };
    }
    case "importers":
    case "outline":
    case "trace":
      return fresh(recoveryContext(fact, selected));
    case "workspace":
    case "decisions":
      return fresh(recoveryContext(fact, selected, { replay: undefined, offline: source.query.arguments.offline }));
    default:
      return unreachable(source);
  }
}

function readAnalysisOf(fact: FactProvenance): ReadAnalysis {
  if (fact.status === "unknown") return { status: "unknown", reason: fact.reason };
  if (fact.status === "partial") return { status: "partial", cuts: fact.cuts };
  return { status: "complete" };
}

/** Whether the fact serialized an optional collection, and how many observations it recorded. */
function collectionState(collection: readonly unknown[] | undefined): RecordedCollectionState {
  return collection === undefined ? { state: "absent" } : { state: "present", count: collection.length };
}

function unreachable(value: never): never {
  throw new Error(`Unsupported source ${JSON.stringify(value)}`);
}

// The accumulator: ids only through composition-identity, supports merged per id, occurrence-local ids under redaction.

/** Where a coordinate lives: its origin and its owner repository. */
type Place = { origin: EvidenceOrigin; repo: string };
/** A read as the adapters use it: its id, its pointer in the public fact and the place of its own snapshot. */
type ReadContext = { id: ReadId; pointer: string; here: Place; snapshot: SnapshotId };
type Coordinate = { path: string; symbol: string; line: number; endLine?: number };
type Supported<T> = T & { supports: Support[] };

class Builder {
  private readonly snapshots = new Map<SnapshotId, SnapshotRecord>();
  private readonly reads = new Map<ReadId, ReadRecord>();
  private readonly readPointers: { id: ReadId; pointer: string }[] = [];
  private readonly files = new Map<FileId, Supported<Omit<FileRecord, "supports">>>();
  private readonly anchors = new Map<AnchorId, Supported<Omit<AnchorRecord, "supports">>>();
  private readonly evidences = new Map<EvidenceId, Supported<Omit<EvidenceRecord, "supports">>>();
  private readonly parts = new Map<PartId, { payload: PartPayload; supports: Support[] }>();
  /** Repository → snapshot of the source vector; set once the adapter has read it. */
  vector = new Map<string, SnapshotId>();

  constructor(readonly digest: Digest, readonly source: SourceId, private readonly changed: readonly string[]) {}

  /** Whether redaction altered this position, an enclosing one (a rewritten key set) or one inside it. */
  private affected(pointer: string): boolean {
    return this.changed.some((c) => c === "" || c === pointer || pointer.startsWith(`${c}/`) || c.startsWith(`${pointer}/`));
  }

  /** The occurrence that makes an id local, when redaction altered any of the positions it stands for. */
  local(read: ReadId, pointers: readonly string[]): Occurrence | undefined {
    const hit = pointers.find((pointer) => this.affected(pointer));
    return hit === undefined ? undefined : { source: this.source, read, pointer: hit };
  }

  support(read: ReadId, pointer: string): Support {
    return { source: this.source, read, pointer };
  }

  snapshot(value: SnapshotRef, read: ReadId, pointer: string): SnapshotId {
    const occurrence = this.local(read, [pointer]);
    const id = snapshotId(this.digest, value, occurrence);
    this.snapshots.set(id, { id, value, identity: occurrence === undefined ? "exact" : "redacted" });
    return id;
  }

  /** A read of the given owner at `pointer`, with its snapshot and its own evidence in order. */
  read(owner: ReadOwner, pointer: string, fact: FactProvenance): ReadContext {
    const id = readId(this.digest, this.source, owner);
    const snapshot = this.snapshot(fact.snapshot, id, `${pointer}/snapshot`);
    const here: Place = { origin: { kind: "snapshot", snapshot }, repo: fact.snapshot.repo };
    const evidence = fact.evidence.map((value, index) => this.evidence(here, value, id, `${pointer}/evidence/${index}`));
    this.reads.set(id, { id, source: this.source, owner, schema: fact.schema, producer: fact.producer, inputs: fact.inputs, snapshot, evidence, analysis: readAnalysisOf(fact) });
    this.readPointers.push({ id, pointer });
    return { id, pointer, here, snapshot };
  }

  /** The place of a repository: its vector snapshot, or a coordinate local to the read when the vector lacks it. */
  placeOf(repo: string, read: ReadId): Place {
    const snapshot = this.vector.get(repo);
    return snapshot === undefined ? { origin: { kind: "query-context", read }, repo } : { origin: { kind: "snapshot", snapshot }, repo };
  }

  file(place: Place, path: string, read: ReadId, pointer: string): FileId {
    const key = { origin: place.origin, repo: place.repo, path };
    const id = fileId(this.digest, key, this.local(read, [pointer]));
    const record = this.files.get(id) ?? { id, ...key, supports: [] };
    record.supports.push(this.support(read, pointer));
    this.files.set(id, record);
    return id;
  }

  /** A declarative coordinate at `pointer`, whose path is the field at `filePointer`. */
  anchor(place: Place, at: Coordinate, read: ReadId, pointer: string, filePointer: string): AnchorId {
    const file = this.file(place, at.path, read, filePointer);
    const key = { file, symbol: at.symbol, line: at.line, ...(at.endLine === undefined ? {} : { endLine: at.endLine }) };
    const id = anchorId(this.digest, key, this.local(read, [pointer]));
    const record = this.anchors.get(id) ?? { id, ...key, supports: [] };
    record.supports.push(this.support(read, pointer));
    this.anchors.set(id, record);
    return id;
  }

  evidence(place: Place, value: Evidence, read: ReadId, pointer: string): EvidenceId {
    const key = { origin: place.origin, repo: place.repo, value };
    const id = evidenceId(this.digest, key, this.local(read, [pointer]));
    const record = this.evidences.get(id) ?? { id, ...key, supports: [] };
    record.supports.push(this.support(read, pointer));
    this.evidences.set(id, record);
    return id;
  }

  /**
   * Evidence that names its repository: resolved through the source vector, never the trigger's snapshot; `external`
   * evidence (configuration the read consulted outside the commit tree) stays local to the read.
   */
  repositoryEvidence(value: RepositoryEvidence, read: ReadId, pointer: string, external: boolean): EvidenceId {
    const { repo, ...evidence } = value;
    const place: Place = external ? { origin: { kind: "query-context", read }, repo } : this.placeOf(repo, read);
    return this.evidence(place, evidence, read, pointer);
  }

  finding<T>(place: Place, finding: Finding<T>, read: ReadId, pointer: string): EvidenceFinding<T> {
    const evidence = finding.evidence.map((value, index) => this.evidence(place, value, read, `${pointer}/evidence/${index}`));
    return finding.status === "complete" ? { status: "complete", value: finding.value, evidence } : { status: "unknown", reason: finding.reason, evidence };
  }

  /** A part supported at every given position; its id is local when redaction touched any of them. */
  part(payload: PartPayload, read: ReadId, pointers: readonly [string, ...string[]]): PartId {
    return this.partWithId(partId(this.digest, payload, this.local(read, pointers)), payload, read, pointers);
  }

  partWithId(id: PartId, payload: PartPayload, read: ReadId, pointers: readonly string[]): PartId {
    const record = this.parts.get(id) ?? { payload, supports: [] };
    record.supports.push(...pointers.map((pointer) => this.support(read, pointer)));
    this.parts.set(id, record);
    return id;
  }

  finish(source: EvidenceSet["sources"][number]): EvidenceSet {
    const owner = (pointer: string): ReadId => {
      const enclosing = this.readPointers.filter((read) => read.pointer === "" || pointer === read.pointer || pointer.startsWith(`${read.pointer}/`));
      return enclosing.reduce((best, read) => (read.pointer.length > best.pointer.length ? read : best)).id;
    };
    const redactions: RedactionRecord[] = [...new Set(this.changed)].sort(compareText).map((pointer) => ({ source: this.source, read: owner(pointer), pointer }));
    const supported = <T extends { supports: Support[] }>(record: T) => ({ ...record, supports: unionSupports(record.supports) });
    return {
      snapshots: sortById([...this.snapshots.values()]),
      sources: [source],
      reads: sortById([...this.reads.values()]),
      files: sortById([...this.files.values()].map(supported)),
      anchors: sortById([...this.anchors.values()].map(supported)),
      evidence: sortById([...this.evidences.values()].map(supported)),
      parts: sortById([...this.parts].map(([id, { payload, supports }]): Part => ({ ...payload, id, supports: unionSupports(supports) }))),
      redactions,
    };
  }
}

// Adapters. Each returns the source's snapshot vector, sorted by repository.

function adapt(source: ExecutedSource, b: Builder, root: ReadContext): readonly SnapshotVectorEntry[] {
  switch (source.family) {
    case "entrypoints":
      return local(b, root, source.read.fact, (value) => entrypoints(b, value));
    case "impact":
    case "callers": {
      if (source.branch === "local") {
        const mode = source.family === "impact" ? { mergeBase: source.read.fact.status === "unknown" ? undefined : source.read.fact.value.mergeBase, pointer: "/value/mergeBase" } : undefined;
        return local(b, root, source.read.fact, (value) => impact(b, root, "/value", value, mode));
      }
      return workspaceImpact(b, root, source.family, source.read.fact);
    }
    case "importers":
      return local(b, root, source.read.fact, (value) => importers(b, root, value));
    case "outline":
      return local(b, root, source.read.fact, (value) => outline(b, root, value, source.read.fact.status === "partial" ? source.read.fact.cuts : []));
    case "trace":
      return local(b, root, source.read.fact, (value) => trace(b, root, value));
    case "workspace":
      return workspace(b, root, source.read.fact);
    case "decisions":
      return decisions(b, root, source.read.fact);
    default:
      return unreachable(source);
  }
}

/** A single-repository family: its vector is its own snapshot. */
function local<T>(b: Builder, root: ReadContext, fact: Fact<T>, adapt: (value: T) => void): readonly SnapshotVectorEntry[] {
  b.vector = new Map([[root.here.repo, root.snapshot]]);
  if (fact.status !== "unknown") adapt(fact.value);
  return [{ repo: root.here.repo, snapshot: root.snapshot }];
}

/**
 * The vector of a workspace-capable read: its entries in original order (kept by the context part) and sorted by repo
 * (the source record), with the root snapshot added when the value omits its repository.
 */
function vectorOf(b: Builder, root: ReadContext, entries: readonly { repo: string; snapshot: SnapshotRef }[], field: string): { original: SnapshotVectorEntry[]; sorted: SnapshotVectorEntry[] } {
  const original = entries.map((entry, index) => ({ repo: entry.repo, snapshot: b.snapshot(entry.snapshot, root.id, `/value/${field}/${index}/snapshot`) }));
  b.vector = new Map(original.map((entry) => [entry.repo, entry.snapshot]));
  if (!b.vector.has(root.here.repo)) b.vector.set(root.here.repo, root.snapshot);
  const sorted = [...b.vector].map(([repo, snapshot]) => ({ repo, snapshot })).sort((x, y) => compareText(x.repo, y.repo));
  return { original, sorted };
}

function entrypoints(b: Builder, value: EntrypointMap): void {
  const section = b.read({ kind: "entrypoints" }, "/value/entrypoints", value.entrypoints);
  if (value.entrypoints.status === "unknown") return;
  value.entrypoints.value.forEach((finding, index) => {
    const pointer = `/value/entrypoints/value/${index}`;
    const evidence = finding.evidence.map((item, j) => b.evidence(section.here, item, section.id, `${pointer}/evidence/${j}`));
    if (finding.status === "unknown") b.part({ kind: "unknown-finding", reason: finding.reason, evidence }, section.id, [pointer]);
    else b.part({ kind: "entrypoint", entry: entryData(b, section, finding.value, `${pointer}/value`), evidence }, section.id, [pointer]);
  });
}

function entryData(b: Builder, read: ReadContext, entry: Entrypoint, pointer: string): EntryData {
  const handlerOf = (at: Coordinate, field: string) => b.anchor(read.here, at, read.id, `${pointer}/${field}`, `${pointer}/${field}/path`);
  switch (entry.kind) {
    case "http-route": {
      const { handler, basePath, ...rest } = entry;
      return { ...rest, handler: handlerOf(handler, "handler"), basePath: b.finding(read.here, basePath, read.id, `${pointer}/basePath`) };
    }
    case "ui-route": {
      const { component, ...rest } = entry;
      return { ...rest, component: component === "unknown" ? "unknown" : handlerOf(component, "component") };
    }
    case "listener": {
      const { handler, ...rest } = entry;
      return { ...rest, handler: handlerOf(handler, "handler") };
    }
    case "job": {
      const { handler, ...rest } = entry;
      return { ...rest, handler: handlerOf(handler, "handler") };
    }
    default:
      return unreachable(entry);
  }
}

/** `diff` is set when the walk compares a change: its merge base, if recorded, and where the fact records it. */
type Diff = { mergeBase: string | undefined; pointer: string } | undefined;

function impact(b: Builder, read: ReadContext, prefix: string, value: ImpactValue, diff: Diff): void {
  b.part({ kind: "impact-context", owner: read.id, ...(value.mergeBase === undefined ? {} : { mergeBase: value.mergeBase }), changedEntrypoints: collectionState(value.changedEntrypoints), changedContracts: collectionState(value.changedContracts) }, read.id, [prefix]);
  const head = read.here;
  const base: Place = diff?.mergeBase === undefined
    ? { origin: { kind: "query-context", read: read.id }, repo: head.repo }
    : { origin: { kind: "snapshot", snapshot: b.snapshot({ repo: head.repo, kind: "sha", sha: diff.mergeBase }, read.id, diff.pointer) }, repo: head.repo };
  const comparison: ComparisonRef = diff?.mergeBase === undefined
    ? { status: "unavailable", reason: "missing-provenance", read: read.id }
    : { status: "available", value: { repo: head.repo, mergeBase: diff.mergeBase, head: read.snapshot } };
  const at = (pointer: string, item: { file: string; symbol: string; line: number; endLine?: number }, place: Place = head) =>
    b.anchor(place, { path: item.file, symbol: item.symbol, line: item.line, ...(item.endLine === undefined ? {} : { endLine: item.endLine }) }, read.id, pointer, `${pointer}/file`);
  const handler = (pointer: string, item: Coordinate, place: Place = head) => b.anchor(place, item, read.id, pointer, `${pointer}/path`);

  const seeds = value.seeds.map((seed, index) => {
    const pointer = `${prefix}/seeds/${index}`;
    return b.part({ kind: "seed", anchor: at(pointer, seed), basis: seed.basis, ...(diff === undefined ? {} : { comparison }) }, read.id, [pointer]);
  });
  value.changedEntrypoints?.forEach((change, index) => {
    const pointer = `${prefix}/changedEntrypoints/${index}`;
    b.part({ kind: "entrypoint-change", change: change.change, kindName: change.kind, name: change.name, handler: handler(`${pointer}/handler`, change.handler, change.change === "removed" ? base : head), comparison }, read.id, [pointer]);
  });
  value.changedContracts?.forEach(({ handlers, ...operation }, index) => {
    const pointer = `${prefix}/changedContracts/${index}`;
    const side = operation.change === "removed" ? base : head;
    const contract = { ...operation, ...(handlers === undefined ? {} : { handlers: handlers.map((item, j) => handler(`${pointer}/handlers/${j}`, item, side)) }) };
    b.part({ kind: "contract-change", contract, comparison }, read.id, [pointer]);
  });
  value.symbols.forEach((symbol, index) => {
    const pointer = `${prefix}/symbols/${index}`;
    const via = symbol.via === undefined ? undefined : {
      target: { file: b.file(head, symbol.via.file, read.id, `${pointer}/via/file`), symbol: symbol.via.symbol },
      ...(symbol.via.lines === undefined ? {} : { lines: symbol.via.lines }),
      basis: symbol.via.basis,
    };
    b.part({ kind: "symbol-reach", anchor: at(pointer, symbol), kindName: symbol.kind, depth: symbol.depth, confidence: symbol.confidence, fanIn: symbol.fanIn, ...(via === undefined ? {} : { via }) }, read.id, [pointer]);
  });
  value.entrypoints.forEach((reached, index) => {
    const pointer = `${prefix}/entrypoints/${index}`;
    b.part({ kind: "entrypoint-reach", kindName: reached.kind, ...(reached.name === undefined ? {} : { name: reached.name }), handler: handler(`${pointer}/handler`, reached.handler), depth: reached.depth, confidence: reached.confidence, seeds: references(reached.seeds, seeds) }, read.id, [pointer]);
  });
  if (value.modules !== undefined) {
    const modules = value.modules;
    const origins = modules.origins.map((origin, index) => b.part({ kind: "module-origin", comparison, file: origin.file, change: origin.change }, read.id, [`${prefix}/modules/origins/${index}`]));
    modules.modules.forEach((module, index) => {
      const pointer = `${prefix}/modules/modules/${index}`;
      const file = b.file(module.snapshot === "base" ? base : head, module.file, read.id, `${pointer}/file`);
      b.part({ kind: "module-reach", file, side: module.snapshot, depth: module.depth, origins: references(module.origins, origins), ...(module.via === undefined ? {} : { via: module.via }) }, read.id, [pointer]);
    });
    b.part({ kind: "walk-cost", owner: read.id, walk: "modules", expansionsUsed: modules.cost.expansionsUsed }, read.id, [`${prefix}/modules/cost`]);
  }
  b.part({ kind: "walk-cost", owner: read.id, walk: "symbols", expansionsUsed: value.cost.expansionsUsed }, read.id, [`${prefix}/cost`]);
}

/** Recorded indices into the owner's own table, in order; an index outside the table stays `missing` with its number. */
function references(indices: readonly number[], table: readonly PartId[]): OriginReference[] {
  return indices.map((index) => {
    const part = Number.isInteger(index) ? table[index] : undefined;
    return part === undefined ? { status: "missing", index } : { status: "present", index, part };
  });
}

function workspaceImpact(b: Builder, root: ReadContext, family: "impact" | "callers", fact: Fact<WorkspaceImpactValue>): readonly SnapshotVectorEntry[] {
  if (fact.status === "unknown") return local(b, root, fact, () => undefined);
  const value = fact.value;
  const { original, sorted } = vectorOf(b, root, value.repositorySnapshots, "repositorySnapshots");
  b.part({ kind: "workspace-context", context: { family, workspace: value.workspace, trigger: value.trigger, repositorySnapshots: original } }, root.id, ["/value/workspace", "/value/trigger", "/value/repositorySnapshots"]);
  for (const [repo, section] of Object.entries(value.sections).sort(([x], [y]) => compareText(x, y))) {
    const pointer = jsonPointer(["value", "sections", repo]);
    const read = b.read({ kind: "section", repo }, pointer, section);
    if (section.status === "unknown") continue;
    repoImpact(b, read, repo, `${pointer}/value`, section.value, family === "impact" ? diffOf(value, repo, section.value) : undefined);
  }
  links(b, root, value.links, family === "impact" ? removedPlaceOf(b, root, value) : () => undefined);
  return sorted;
}

function diffOf(value: WorkspaceImpactValue, repo: string, section: RepoImpact): Diff {
  if (section.impact?.mergeBase !== undefined) return { mergeBase: section.impact.mergeBase, pointer: `${jsonPointer(["value", "sections", repo])}/value/impact/mergeBase` };
  return repo === value.trigger.repo ? { mergeBase: value.trigger.mergeBase, pointer: "/value/trigger/mergeBase" } : undefined;
}

/**
 * Where a link lands when it reaches an entrypoint the change removed from the trigger: the merge base that held its
 * handler, or a coordinate local to the read when no merge base is recorded; undefined for any other link.
 */
function removedPlaceOf(b: Builder, root: ReadContext, value: WorkspaceImpactValue): (to: Link["to"]) => Place | undefined {
  const repo = value.trigger.repo;
  const section = value.sections[repo];
  if (section === undefined || section.status === "unknown") return () => undefined;
  const removed = new Set((section.value.impact?.changedEntrypoints ?? []).filter(({ change }) => change === "removed").map(({ kind, name, handler }) => canonicalJson([kind, name, handler])));
  const diff = diffOf(value, repo, section.value);
  return (to) => {
    if (to.repo !== repo || !removed.has(canonicalJson([to.kind, to.name, to.handler]))) return undefined;
    return diff?.mergeBase === undefined
      ? { origin: { kind: "query-context", read: root.id }, repo }
      : { origin: { kind: "snapshot", snapshot: b.snapshot({ repo, kind: "sha", sha: diff.mergeBase }, root.id, diff.pointer) }, repo };
  };
}

function repoImpact(b: Builder, section: ReadContext, repo: string, prefix: string, value: RepoImpact, diff: Diff): void {
  value.reads.forEach((read, index) => b.read({ kind: "read", repo, index, readKind: read.kind }, `${prefix}/reads/${index}/fact`, read.fact));
  if (value.impact !== undefined) impact(b, section, `${prefix}/impact`, value.impact, diff);
  const sites = (field: "callSites" | "unmatched" | "external", disposition: "matched" | "unmatched" | "external") =>
    value[field].forEach((site, index) => callSite(b, section, repo, `${prefix}/${field}/${index}`, site, disposition));
  sites("callSites", "matched");
  sites("unmatched", "unmatched");
  sites("external", "external");
  value.unresolved.forEach((site, index) => b.part({ kind: "unresolved-call-site", site }, section.id, [`${prefix}/unresolved/${index}`]));
}

function callSite(b: Builder, section: ReadContext, repo: string, pointer: string, site: CallSite, disposition: "matched" | "unmatched" | "external"): void {
  const place = site.repo === repo ? section.here : b.placeOf(site.repo, section.id);
  const { file, line, endLine, target, ...rest } = site;
  const location = { file: b.file(place, file, section.id, `${pointer}/file`), line, ...(endLine === undefined ? {} : { endLine }) };
  b.part({ kind: "call-site", site: { ...rest, location, target: b.finding(place, target, section.id, `${pointer}/target`) }, disposition }, section.id, [pointer]);
}

/**
 * A link's ends as every family records them: the caller's file and the handler's anchor in the repositories they name,
 * so one link read by two families is one `workspace-match` relation. `pointer` addresses the `Link` itself.
 */
function linkData(b: Builder, root: ReadContext, { from, to, ...link }: Link, pointer: string, toPlace: Place = b.placeOf(to.repo, root.id)): LinkData {
  return {
    ...link,
    from: { file: b.file(b.placeOf(from.repo, root.id), from.file, root.id, `${pointer}/from/file`), line: from.line, repo: from.repo, symbol: from.symbol },
    to: { repo: to.repo, kind: to.kind, name: to.name, handler: b.anchor(toPlace, to.handler, root.id, `${pointer}/to/handler`, `${pointer}/to/handler/path`) },
  };
}

/**
 * Admitted links. A link's id is local to its source position so self and cyclic reach resolve through the
 * source's own `Link.id` index without hashing part ids recursively; a reach id no link of the source carries, or one two
 * links share, stays `missing`.
 */
function links(b: Builder, root: ReadContext, items: WorkspaceImpactValue["links"], removedPlace: (to: Link["to"]) => Place | undefined): void {
  const prepared = items.map((item, index) => {
    const pointer = `/value/links/${index}`;
    const data = linkData(b, root, item.link, `${pointer}/link`, removedPlace(item.link.to));
    const operations = item.operations === undefined ? {} : { operations: item.operations };
    const id = partId(b.digest, { kind: "workspace-link", link: data, direction: item.direction, reach: [], ...operations }, { source: b.source, read: root.id, pointer });
    return { pointer, data, id, item, operations };
  });
  const byLinkId = new Map<string, PartId | null>();
  for (const { item, id } of prepared) byLinkId.set(item.link.id, byLinkId.has(item.link.id) ? null : id);
  for (const { pointer, data, id, item, operations } of prepared) {
    const reach = item.reach.map((linkId): LinkReference => {
      const part = byLinkId.get(linkId);
      return part === undefined || part === null ? { status: "missing", linkId } : { status: "present", part };
    });
    b.partWithId(id, { kind: "workspace-link", link: data, direction: item.direction, reach, ...operations }, root.id, [pointer]);
  }
}

/** The six `ImportedFile` categories in their declared order, each with its dependency name. */
const CATEGORIES: Readonly<Record<FileCategory, FileDependencyCategory>> = {
  importers: "importer",
  reexporters: "reexporter",
  dynamicImporters: "dynamic-importer",
  typeImporters: "type-importer",
  users: "user",
  unresolvedNamers: "unresolved-namer",
};

function importers(b: Builder, root: ReadContext, value: ImportersValue): void {
  value.files.forEach((imported: ImportedFile, index) => {
    const pointer = `/value/files/${index}`;
    const target = b.file(root.here, imported.file, root.id, `${pointer}/file`);
    const categories: { name: FileCategory; collection: RecordedCollectionState }[] = [];
    for (const category of Object.keys(CATEGORIES) as FileCategory[]) {
      const consumers = imported[category];
      categories.push({ name: category, collection: collectionState(consumers) });
      if (consumers === undefined) continue;
      consumers.forEach((consumer, j) => {
        const at = `${pointer}/${category}/${j}`;
        b.part({ kind: "file-dependency", from: b.file(root.here, consumer, root.id, at), to: target, category: CATEGORIES[category] }, root.id, [at]);
      });
    }
    b.part({ kind: "file-query", file: target, categories }, root.id, [pointer]);
  });
}

/** Every step anchored at its declaration, so a trace joins the other answers about the same declarations. */
function trace(b: Builder, root: ReadContext, value: TraceValue): void {
  value.roots.forEach(({ target, steps }, index) => b.part({ kind: "trace-root", target, steps }, root.id, [`/value/roots/${index}`]));
  value.steps.forEach((step, index) => {
    const pointer = `/value/steps/${index}`;
    const anchor = b.anchor(root.here, { path: step.file, symbol: step.symbol, line: step.line, ...(step.endLine === undefined ? {} : { endLine: step.endLine }) }, root.id, pointer, `${pointer}/file`);
    /** A leaf spans `start`-`end` and anchors as a step of one line would, so both join the same declaration. */
    const leaves = step.leaves?.map((leaf, k) => {
      const at = `${pointer}/leaves/${k}`;
      const leafAnchor = b.anchor(root.here, { path: leaf.file, symbol: leaf.symbol, line: leaf.start, ...(leaf.end === leaf.start ? {} : { endLine: leaf.end }) }, root.id, at, `${at}/file`);
      return { anchor: leafAnchor, ...(leaf.deferred === undefined ? {} : { deferred: leaf.deferred }) };
    });
    const alternatives = step.alternatives?.map((body, k) => {
      const at = `${pointer}/alternatives/${k}`;
      return b.anchor(root.here, { path: body.file, symbol: body.symbol, line: body.start, ...(body.end === body.start ? {} : { endLine: body.end }) }, root.id, at, `${at}/file`);
    });
    b.part({
      kind: "trace-step", anchor, kindName: step.kind, step: step.id, depth: step.depth,
      ...(step.parent === undefined ? {} : { parent: step.parent }),
      ...(step.seen === undefined ? {} : { seen: step.seen }),
      ...(step.at === undefined ? {} : { at: step.at }),
      ...(step.via === undefined ? {} : { via: step.via }),
      ...(step.deferred === undefined ? {} : { deferred: step.deferred }),
      ...(leaves === undefined ? {} : { leaves }),
      ...(step.external === undefined ? {} : { external: step.external }),
      ...(alternatives === undefined ? {} : { alternatives }),
    }, root.id, [pointer]);
  });
  value.readingPlan.ranges.forEach(({ file, start, end, steps }, index) => {
    const pointer = `/value/readingPlan/ranges/${index}`;
    b.part({ kind: "reading-range", file: b.file(root.here, file, root.id, `${pointer}/file`), start, end, steps }, root.id, [pointer]);
  });
  b.part({ kind: "trace-totals", owner: root.id, lines: value.readingPlan.lines, expanded: value.cost.expanded }, root.id, ["/value/readingPlan/lines", "/value/cost"]);
}

function outline(b: Builder, root: ReadContext, value: OutlineValue, cuts: readonly Cut[]): void {
  const declared = (path: string, fileAt: string, declaration: OutlineDeclaration, at: string, uses?: readonly OutlineUseRecord[], unproved?: boolean): PartId => {
    const anchor = b.anchor(root.here, { path, symbol: declaration.name, line: declaration.line, endLine: declaration.endLine }, root.id, at, fileAt);
    const children = declaration.children?.map((child, k) => declared(path, fileAt, child, `${at}/children/${k}`));
    return b.part({ kind: "outline-declaration", anchor, kindName: declaration.kind, ...(children !== undefined && { children }), ...(uses !== undefined && { uses }), ...(unproved === true && { unproved }) }, root.id, [at]);
  };
  value.focus?.forEach((match, index) => {
    const pointer = `/value/focus/${index}`;
    const uses = match.uses?.map((use, j): OutlineUseRecord => {
      if (!("declaration" in use)) return use;
      const { declaration, ...rest } = use;
      const place = `${pointer}/uses/${j}/declaration`;
      const anchor = b.anchor(root.here, { path: declaration.file, symbol: declaration.name, line: declaration.line, endLine: declaration.endLine }, root.id, place, `${place}/file`);
      return { ...rest, declaration: { anchor, kindName: declaration.kind } };
    });
    declared(match.file, `${pointer}/file`, match.declaration, `${pointer}/declaration`, uses, hasUnprovedUses(cuts, match.file, match.path));
  });
  value.files?.forEach((held, index) => {
    const pointer = `/value/files/${index}`;
    const file = b.file(root.here, held.file, root.id, `${pointer}/file`);
    const declarations = held.declarations.map((declaration, j) => declared(held.file, `${pointer}/file`, declaration, `${pointer}/declarations/${j}`));
    const imports = held.imports.map(({ target, bindings, ...statement }, j): OutlineImportRecord => {
      const at = `${pointer}/imports/${j}`;
      const dependency = target.kind === "repository"
        ? { kind: "repository" as const, dependency: b.part({ kind: "file-dependency", from: file, to: b.file(root.here, target.file, root.id, `${at}/target/file`), category: "outline-import" }, root.id, [`${at}/target`]) }
        : target;
      return {
        ...statement,
        target: dependency,
        bindings: bindings.map(({ declaration, ...binding }, k) => {
          if (declaration === undefined) return binding;
          const place = `${at}/bindings/${k}/declaration`;
          const anchor = b.anchor(root.here, { path: declaration.file, symbol: declaration.name, line: declaration.line, endLine: declaration.endLine }, root.id, place, `${place}/file`);
          return { ...binding, declaration: { anchor, kindName: declaration.kind } };
        }),
      };
    });
    b.part({ kind: "outline-file", file, declarations, imports }, root.id, [pointer]);
  });
  value.unheld.forEach((path, index) => {
    const pointer = `/value/unheld/${index}`;
    b.part({ kind: "unheld-file", file: b.file(root.here, path, root.id, pointer) }, root.id, [pointer]);
  });
}

function workspace(b: Builder, root: ReadContext, fact: Fact<PublicWorkspaceValue>): readonly SnapshotVectorEntry[] {
  if (fact.status === "unknown") return local(b, root, fact, () => undefined);
  const value = fact.value;
  const { original, sorted } = vectorOf(b, root, value.repositorySnapshots, "repositorySnapshots");
  b.part({ kind: "workspace-context", context: { family: "workspace", workspace: value.workspace, repositorySnapshots: original } }, root.id, ["/value/workspace", "/value/repositorySnapshots"]);
  for (const [repo, section] of Object.entries(value.sections).sort(([x], [y]) => compareText(x, y))) {
    const pointer = jsonPointer(["value", "sections", repo]);
    const read = b.read({ kind: "section", repo }, pointer, section);
    if (section.status === "unknown") continue;
    section.value.names.forEach((name, index) => {
      const at = `${pointer}/value/names/${index}`;
      const evidence = name.evidence.map((item, j) => b.evidence(read.here, item, read.id, `${at}/evidence/${j}`));
      b.part({ kind: "outward-name", origin: read.here.origin, name: name.name, kindName: name.kind, evidence, disposition: "stated" }, read.id, [at]);
    });
    section.value.unresolved.forEach((site, index) => b.part({ kind: "unresolved-call-site", site }, read.id, [`${pointer}/value/unresolved/${index}`]));
  }
  value.candidates.forEach((candidate, index) => {
    const at = `/value/candidates/${index}`;
    const evidence = candidate.evidence.map((item, j) => b.repositoryEvidence(item, root.id, `${at}/evidence/${j}`, false));
    b.part({ kind: "name-candidate", context: root.id, name: candidate.name, repo: candidate.repo, basis: candidate.basis, evidence }, root.id, [at]);
  });
  value.unserved.forEach((name, index) => {
    const at = `/value/unserved/${index}`;
    const evidence = name.evidence.map((item, j) => b.repositoryEvidence(item, root.id, `${at}/evidence/${j}`, false));
    const repos = [...new Set(name.evidence.map((item) => item.repo))];
    const origin: EvidenceOrigin = repos.length === 1 ? b.placeOf(repos[0]!, root.id).origin : { kind: "query-context", read: root.id };
    b.part({ kind: "outward-name", origin, name: name.name, kindName: name.kind, evidence, disposition: "unserved" }, root.id, [at]);
  });
  value.links.forEach((link, index) => b.part({ kind: "workspace-link", link: linkData(b, root, link, `/value/links/${index}`) }, root.id, [`/value/links/${index}`]));
  value.unlinked.forEach(({ from, ...site }, index) => {
    const at = `/value/unlinked/${index}`;
    b.part({ kind: "unlinked-call-site", site: { ...site, from: { file: b.file(b.placeOf(from.repo, root.id), from.file, root.id, `${at}/from/file`), line: from.line, repo: from.repo, symbol: from.symbol } } }, root.id, [at]);
  });
  return sorted;
}

/**
 * Configuration a decision read outside the commit tree: an option the `origin` basis names, and every option of a
 * `remote` decision, cite the clone's configuration (`.git/config`), so their evidence stays local to the read. The
 * classification follows the producer's kind and basis, never the path.
 */
function external(decision: Decision, option?: Decision["options"][number]): boolean {
  return decision.kind === "remote" || option?.basis === "origin";
}

function decisions(b: Builder, root: ReadContext, fact: Fact<DecisionValue>): readonly SnapshotVectorEntry[] {
  if (fact.status === "unknown") return local(b, root, fact, () => undefined);
  const value = fact.value;
  const { original, sorted } = vectorOf(b, root, value.repositories, "repositories");
  b.part({ kind: "workspace-context", context: { family: "decisions", source: value.source, repositories: original } }, root.id, ["/value/source", "/value/repositories"]);
  value.decisions.forEach((decision, index) => {
    const at = `/value/decisions/${index}`;
    const evidence = decision.evidence.map((item, j) => b.repositoryEvidence(item, root.id, `${at}/evidence/${j}`, external(decision)));
    const options = decision.options.map((option, k) => ({
      ...option,
      evidence: option.evidence.map((item, j) => b.repositoryEvidence(item, root.id, `${at}/options/${k}/evidence/${j}`, external(decision, option))),
    }));
    b.part({
      kind: "decision", context: root.id, decisionId: decision.id, kindName: decision.kind, subject: decision.subject,
      ...(decision.outwardKinds === undefined ? {} : { outwardKinds: decision.outwardKinds }),
      allowsFreeText: decision.allowsFreeText, required: decision.required, evidence, options,
    }, root.id, [at]);
  });
  return sorted;
}
