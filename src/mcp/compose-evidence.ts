/**
 * Union and materialization of composed evidence. `mergeEvidence` is a pure union by canonical ids that
 * keeps every appearance (supports by source/read/pointer); `materializeEvidence` derives bindings, entities, relations,
 * the five closed connections and the issues from the whole set at once, so the result never depends on arrival order.
 * No alias is fused irreversibly, no relation is inferred from text, no transitive walk or breakage is derived.
 */
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { compareText, joinsFact } from "../core/domain/shared/code-node.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import type {
  AnchorId, AnchorRecord, Attestation, BindingRecord, BoundAnchor, CallLocation, CompositionIssue, Connection,
  ConnectionRule, EntityId, EntityRecord, EntryIdentity, EvidenceId, EvidenceSet, FileId, FileRecord, IssueDetail,
  MaterializedComposition, Part, PartId, PartOf, ReadId, ReadOwner, ReadRecord, RedactionRecord, RelationId,
  RelationRecord, RelationValue, SnapshotId, SourceId, Support,
} from "./composition-contract.ts";
import type { CutOwner } from "./select-evidence.ts";
import {
  COMPOSITION_KEY_VERSION, compareSupport, compositionKey, fileId, isCompositionId, sameCanonical, sortById, sortedUnique, unionSupports,
} from "./composition-identity.ts";
import { partReferences } from "./compose-evidence-references.ts";

export { validateCompositionReferences, validateCompositionIssues } from "./compose-evidence-references.ts";

/**
 * The union of two evidence sets by canonical id. Records with supports union them; records without supports must be
 * identical under one id. Commutative, associative and idempotent; resolves no alias and removes no conflict.
 */
export function mergeEvidence(left: EvidenceSet, right: EvidenceSet): EvidenceSet {
  return {
    snapshots: unionById(left.snapshots, right.snapshots, identical),
    sources: unionById(left.sources, right.sources, identical),
    reads: unionById(left.reads, right.reads, identical),
    files: unionById(left.files, right.files, withSupports),
    anchors: unionById(left.anchors, right.anchors, withSupports),
    evidence: unionById(left.evidence, right.evidence, withSupports),
    parts: unionById(left.parts, right.parts, withSupports),
    redactions: unionRedactions(left.redactions, right.redactions),
  };
}

function unionById<T extends { id: string }>(left: readonly T[], right: readonly T[], fuse: (a: T, b: T) => T): T[] {
  const byId = new Map<string, T>();
  for (const record of [...left, ...right]) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing === undefined ? record : fuse(existing, record));
  }
  return sortById([...byId.values()]);
}

/** One id names one content: two contents under one id are a normalization defect, never a pick. */
function identical<T extends { id: string }>(a: T, b: T): T {
  if (!sameCanonical(a, b)) throw new Error(`Composition record ${a.id} carries two different contents`);
  return a;
}

function withSupports<T extends { id: string; supports: readonly Support[] }>(a: T, b: T): T {
  const { supports: left, ...restA } = a;
  const { supports: right, ...restB } = b;
  if (!sameCanonical(restA, restB)) throw new Error(`Composition record ${a.id} carries two different contents`);
  return { ...a, supports: unionSupports(left, right) };
}

function unionRedactions(left: readonly RedactionRecord[], right: readonly RedactionRecord[]): RedactionRecord[] {
  return unionSupports(left, right);
}

type Attesting = { parts: readonly PartId[]; reads: readonly ReadId[]; locations?: readonly CallLocation[]; confidence?: number; extraSnapshots?: readonly SnapshotId[] };
type Check = { ok: true } | { ok: false; mismatches: readonly CompositionIssue[] };
type DeclarationEntity = Extract<EntityRecord, { kind: "declaration" }>;

const IMPORT_CATEGORIES = new Set(["importer", "reexporter", "dynamic-importer", "type-importer", "outline-import"]);
const simpleName = (symbol: string) => symbol.slice(symbol.lastIndexOf(".") + 1);
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const byCanonical = <T>(a: T, b: T) => compareText(canonicalJson(a), canonicalJson(b));

/** Bindings, entities, relations, connections and issues of the whole set; the set's own tables pass through. */
export function materializeEvidence(set: EvidenceSet, digest: Digest): MaterializedComposition {
  return new Materializer(set, digest).run();
}

class Materializer {
  private readonly snapshots;
  private readonly sources;
  private readonly reads;
  private readonly files;
  private readonly anchors;
  private readonly parts;
  private readonly redactions = new Map<ReadId, string[]>();
  private readonly issues = new Map<string, CompositionIssue>();
  private readonly derivedFiles = new Map<FileId, FileRecord>();
  private readonly bindings = new Map<AnchorId, BoundAnchor>();
  private readonly declarations = new Map<EntityId, DeclarationEntity>();
  private readonly entrypoints = new Map<EntityId, Extract<EntityRecord, { kind: "entrypoint" }>>();
  private readonly relations = new Map<RelationId, { value: RelationValue; attestations: Map<string, Attestation> }>();
  private readonly connections = new Map<string, Connection>();
  private readonly membership = new Map<SourceId, string | undefined>();

  constructor(private readonly set: EvidenceSet, private readonly digest: Digest) {
    this.snapshots = new Map(set.snapshots.map((record) => [record.id, record]));
    this.sources = new Map(set.sources.map((record) => [record.id, record]));
    this.reads = new Map(set.reads.map((record) => [record.id, record]));
    this.files = new Map(set.files.map((record) => [record.id, record]));
    this.anchors = new Map(set.anchors.map((record) => [record.id, record]));
    this.parts = new Map(set.parts.map((record) => [record.id, record]));
    for (const redaction of set.redactions) this.redactions.set(redaction.read, [...(this.redactions.get(redaction.read) ?? []), redaction.pointer]);
  }

  run(): MaterializedComposition {
    this.redactedIdentities();
    this.snapshotDifferences();
    this.provenance();
    this.evidenceProvenance();
    for (const anchor of this.set.anchors) this.bindings.set(anchor.id, this.bind(anchor));
    this.entrypointEntities();
    this.servesEntrypoint();
    this.symbolDependences();
    this.fileRelations();
    this.moduleRelations();
    this.originRelations();
    this.workspaceMatches();
    this.nameCandidates();
    this.sharedEvidence();
    this.handlerDeclarations();
    this.reachedHandlers();
    this.changeDependents();
    this.sharedFileImports();
    this.sharedSupports();

    const files = unionById(this.set.files, [...this.derivedFiles.values()], withSupports);
    const relations: RelationRecord[] = sortById([...this.relations].map(([id, relation]) => ({ id, value: relation.value, attestations: [...relation.attestations.values()].sort(byCanonical) })));
    const bindings: BindingRecord[] = [...this.bindings].map(([anchor, binding]) => ({ anchor, binding })).sort((a, b) => compareText(a.anchor, b.anchor));
    return {
      graph: {
        snapshots: this.set.snapshots, sources: this.set.sources, reads: this.set.reads, files, anchors: this.set.anchors,
        evidence: this.set.evidence, parts: this.set.parts,
        entities: sortById<EntityRecord>([...this.declarations.values(), ...this.entrypoints.values()]),
        bindings, relations, connections: sortById([...this.connections.values()]),
      },
      issues: [...this.issues.values()].sort(byCanonical),
    };
  }

  private redactedSupport(support: Support): boolean {
    return (this.redactions.get(support.read) ?? []).some((pointer) => overlaps(pointer, support.pointer));
  }

  /** The reads of a record's appearances that redaction did not touch, in id order. */
  private cleanReads(record: { supports: readonly Support[] }): ReadId[] {
    return sortedUnique(record.supports.filter((support) => !this.redactedSupport(support)).map((support) => support.read));
  }

  private readsOfPart(id: PartId): ReadId[] {
    const part = this.parts.get(id);
    return part === undefined ? [] : this.cleanReads(part);
  }

  private supportsOf(record: { supports: readonly Support[] }, reads: readonly ReadId[]): Support[] {
    return record.supports.filter((support) => reads.includes(support.read) && !this.redactedSupport(support));
  }

  private part<K extends Part["kind"]>(kind: K): PartOf<K>[] {
    return this.set.parts.filter((part): part is PartOf<K> => part.kind === kind);
  }

  private issue(detail: IssueDetail, supports: readonly Support[]): void {
    const issue: CompositionIssue = { ...detail, sources: sortedUnique(supports.map((s) => s.source)), reads: sortedUnique(supports.map((s) => s.read)) };
    this.issues.set(canonicalJson(issue), issue);
  }

  /** The declared workspace a source read under: members, their origin and the declared gateways. */
  private workspaceOf(source: SourceId): string | undefined {
    if (this.membership.has(source)) return this.membership.get(source);
    const declared = this.part("workspace-context")
      .filter((part) => part.supports.some((support) => support.source === source))
      .flatMap((part) => {
        const context = part.context;
        if (context.family === "decisions") return [];
        const gateways = context.workspace.gateways.map((gateway) => ({ prefix: gateway.prefix, repo: gateway.repo })).sort(byCanonical);
        return [canonicalJson({ repos: context.workspace.repos, source: context.workspace.source, gateways })];
      });
    const value = declared.length === 0 ? undefined : canonicalJson(sortedUnique(declared));
    this.membership.set(source, value);
    return value;
  }

  private contextOf(read: ReadRecord) {
    const { trust, engines, typeRoot } = read.inputs;
    return {
      snapshot: read.snapshot, trust, producer: read.producer, schema: read.schema,
      engines: Object.fromEntries(Object.entries(engines).sort(([a], [b]) => compareText(a, b))),
      ...(typeRoot === undefined ? {} : { typeRoot: typeRoot.identity }),
      ...(this.workspaceOf(read.source) === undefined ? {} : { workspace: this.workspaceOf(read.source) }),
    };
  }

  /** The digest of the required context of an observation: its reads' contexts and any endpoint snapshots. */
  private contextKey(reads: readonly ReadId[], extraSnapshots: readonly SnapshotId[] = []): string {
    const contexts = sortedUnique(reads.flatMap((read) => {
      const record = this.reads.get(read);
      return record === undefined ? [] : [canonicalJson(this.contextOf(record))];
    }));
    return this.digest.of(canonicalJson([COMPOSITION_KEY_VERSION, "attestation-context", contexts, sortedUnique(extraSnapshots)]));
  }

  /**
   * Every pair of the reads a connection needs, jointly. Equal schema, producer and trust; equal versions of the
   * engines both name; equal type roots between the reads that attribute a type-resolved dependence (`typed`; a read that
   * only locates an endpoint needs none); equal declared
   * workspace when both declare one; one exact snapshot per repository. Never transitive: no read bridges a conflict.
   */
  private compatible(readIds: readonly ReadId[], typed: readonly ReadId[], purpose: "derive" | "corroborate" = "derive"): Check {
    const reads = sortedUnique(readIds).flatMap((id) => this.reads.get(id) ?? []);
    const mismatches: CompositionIssue[] = [];
    let blocked = false;
    for (const read of reads) if (this.snapshots.get(read.snapshot)?.identity !== "exact") blocked = true;
    for (const [index, a] of reads.entries()) {
      for (const b of reads.slice(index + 1)) {
        const pair = [a.id, b.id];
        const sources = sortedUnique([a.source, b.source]);
        const mismatch = (field: Extract<IssueDetail, { kind: "context-mismatch" }>["field"], reason: "different" | "unavailable") =>
          mismatches.push({ kind: "context-mismatch", field, reason, sources, reads: sortedUnique(pair) });
        if (a.schema !== b.schema) mismatch("schema", "different");
        if (a.producer.name !== b.producer.name || (purpose === "derive" && a.producer.version !== b.producer.version)) mismatch("producer", "different");
        if (a.inputs.trust !== b.inputs.trust) mismatch("trust", "different");
        const engines = Object.keys(a.inputs.engines).filter((name) => Object.hasOwn(b.inputs.engines, name));
        if (engines.some((name) => a.inputs.engines[name] !== b.inputs.engines[name])) mismatch("engine", "different");
        if (typed.includes(a.id) && typed.includes(b.id)) {
          const left = a.inputs.typeRoot?.identity;
          const right = b.inputs.typeRoot?.identity;
          if ((left === undefined) !== (right === undefined)) mismatch("typeRoot", "unavailable");
          else if (left !== right) mismatch("typeRoot", "different");
        }
        const workspaceA = this.workspaceOf(a.source);
        const workspaceB = this.workspaceOf(b.source);
        if (workspaceA !== undefined && workspaceB !== undefined && workspaceA !== workspaceB) mismatch("workspace", "different");
        const snapA = this.snapshots.get(a.snapshot)?.value;
        const snapB = this.snapshots.get(b.snapshot)?.value;
        if (snapA !== undefined && snapB !== undefined && snapA.repo === snapB.repo && a.snapshot !== b.snapshot) blocked = true;
      }
    }
    if (mismatches.length > 0) return { ok: false, mismatches };
    return blocked ? { ok: false, mismatches: [] } : { ok: true };
  }

  private guarded(reads: readonly ReadId[], typed: readonly ReadId[] = [], purpose: "derive" | "corroborate" = "derive"): boolean {
    const check = this.compatible(reads, typed, purpose);
    if (!check.ok) for (const mismatch of check.mismatches) this.issues.set(canonicalJson(mismatch), mismatch);
    return check.ok;
  }

  private redactedIdentities(): void {
    for (const redaction of this.set.redactions) {
      const read = this.reads.get(redaction.read);
      if (read === undefined) continue;
      this.issue({ kind: "redacted-identity", owner: cutOwner(read.owner), pointer: redaction.pointer }, [redaction]);
    }
  }

  private snapshotDifferences(): void {
    const byRepo = new Map<string, Map<SnapshotId, Support[]>>();
    const note = (snapshot: SnapshotId, support: Support) => {
      const record = this.snapshots.get(snapshot);
      if (record === undefined || record.identity !== "exact") return;
      const repo = byRepo.get(record.value.repo) ?? new Map<SnapshotId, Support[]>();
      repo.set(snapshot, [...(repo.get(snapshot) ?? []), support]);
      byRepo.set(record.value.repo, repo);
    };
    for (const read of this.set.reads) note(read.snapshot, { source: read.source, read: read.id, pointer: "" });
    for (const source of this.set.sources) for (const entry of source.snapshotVector) note(entry.snapshot, { source: source.id, read: source.rootRead, pointer: "" });
    for (const [repo, snapshots] of byRepo) {
      if (snapshots.size < 2) continue;
      this.issue({ kind: "snapshot-difference", repo, snapshots: sortedUnique([...snapshots.keys()]) }, [...snapshots.values()].flat());
    }
  }

  /** A part whose coordinates are local to a read, or whose comparison has no merge base, is reported, never placed. */
  private provenance(): void {
    for (const part of this.set.parts) {
      const side = part.kind === "module-reach" ? part.side : (part.kind === "entrypoint-change" && part.change === "removed") || (part.kind === "contract-change" && part.contract.change === "removed") ? "base" as const : undefined;
      const repos = new Set<string>();
      for (const reference of partReferences(part)) {
        const file = isCompositionId("file", reference.id) ? this.files.get(reference.id) : isCompositionId("anchor", reference.id) ? this.fileOfAnchor(reference.id) : undefined;
        if (file?.origin.kind === "query-context") repos.add(file.repo);
      }
      const comparison = part.kind === "seed" || part.kind === "entrypoint-change" || part.kind === "contract-change" || part.kind === "module-origin" ? part.comparison : undefined;
      if (comparison?.status === "unavailable") {
        const read = this.reads.get(comparison.read);
        const repo = read === undefined ? undefined : this.snapshots.get(read.snapshot)?.value.repo;
        if (repo !== undefined) repos.add(repo);
      }
      for (const repo of repos) this.issue({ kind: "missing-provenance", repo, part: part.id, ...(side === undefined ? {} : { side }) }, part.supports);
    }
  }

  /**
   * Query-context evidence of a repository the source's vector does not hold has no proven snapshot. Evidence of a
   * vector repository read from deliberately external configuration (decisions' `.git/config`) is context, not a gap.
   */
  private evidenceProvenance(): void {
    for (const record of this.set.evidence) {
      if (record.origin.kind !== "query-context") continue;
      const read = this.reads.get(record.origin.read);
      const source = read === undefined ? undefined : this.sources.get(read.source);
      if (source === undefined || source.snapshotVector.some((entry) => entry.repo === record.repo)) continue;
      const citing = this.set.parts.filter((part) => partReferences(part).some((reference) => reference.id === record.id));
      if (citing.length === 0) this.issue({ kind: "missing-provenance", repo: record.repo }, record.supports);
      for (const part of citing) this.issue({ kind: "missing-provenance", repo: record.repo, part: part.id }, [...record.supports, ...part.supports]);
    }
  }

  /** Why an anchor cannot be a physical coordinate shared across sources, if it cannot. */
  private blocked(anchor: AnchorRecord): "redacted" | "missing-provenance" | undefined {
    const file = this.files.get(anchor.file);
    if (anchor.supports.some((support) => this.redactedSupport(support)) || file === undefined || file.supports.some((support) => this.redactedSupport(support))) return "redacted";
    if (file.origin.kind === "query-context") return "missing-provenance";
    return this.snapshots.get(file.origin.snapshot)?.identity === "exact" ? undefined : "redacted";
  }

  /** Outline declarations that may identify a declaration: exact snapshot file, unredacted, with an unredacted read. */
  private outlineCandidates(file: FileId): { part: PartOf<"outline-declaration">; anchor: AnchorRecord }[] {
    return this.part("outline-declaration").flatMap((part) => {
      const anchor = this.anchors.get(part.anchor);
      return anchor !== undefined && anchor.file === file && this.blocked(anchor) === undefined && this.cleanReads(part).length > 0 ? [{ part, anchor }] : [];
    });
  }

  /** Indistinguishable appearances of one declaration inside one read: the projected-out id cannot be guessed back. */
  private duplicated(part: Part): boolean {
    const reads = part.supports.map((support) => support.read);
    return new Set(reads).size !== reads.length;
  }

  private bind(anchor: AnchorRecord): BoundAnchor {
    const block = this.blocked(anchor);
    if (block !== undefined) return { status: "unresolved", anchor: anchor.id, reason: block };
    const path = this.files.get(anchor.file)?.path ?? "";
    const end = anchor.endLine ?? anchor.line;
    const joined = this.outlineCandidates(anchor.file).filter(({ anchor: outline }) => {
      const outlineEnd = outline.endLine ?? outline.line;
      const direct = joinsFact({ file: path, name: outline.symbol, startLine: outline.line, endLine: outlineEnd }, { path, line: anchor.line, symbol: anchor.symbol });
      const annotated = anchor.endLine !== undefined && joinsFact({ file: path, name: simpleName(anchor.symbol), startLine: anchor.line, endLine: anchor.endLine }, { path, line: outline.line, symbol: outline.symbol });
      return direct || annotated;
    });
    if (joined.length === 0) return { status: "resolved", entity: this.declaration({ anchor: anchor.id }, anchor.file, anchor.id, undefined) };
    const exact = joined.filter(({ anchor: outline }) => (outline.endLine ?? outline.line) === end);
    if (exact.length === 0) {
      this.issue({ kind: "conflicting-coordinate", anchors: sortedUnique([anchor.id, ...joined.map((candidate) => candidate.anchor.id)]) }, [...anchor.supports, ...joined.flatMap((candidate) => candidate.part.supports)]);
      return { status: "unresolved", anchor: anchor.id, reason: "conflicting-coordinate" };
    }
    const [only] = exact;
    if (only === undefined || exact.length > 1 || this.duplicated(only.part)) {
      this.issue({ kind: "ambiguous-declaration", anchor: anchor.id, candidates: sortedUnique(exact.map((candidate) => candidate.part.id)) }, [...anchor.supports, ...exact.flatMap((candidate) => candidate.part.supports)]);
      return { status: "unresolved", anchor: anchor.id, reason: "ambiguous" };
    }
    return { status: "resolved", entity: this.declaration({ outline: only.part.id }, anchor.file, anchor.id, only.part.id) };
  }

  private declaration(key: { anchor: AnchorId } | { outline: PartId }, file: FileId, anchor: AnchorId, outline: PartId | undefined): EntityId {
    const id = compositionKey(this.digest, "entity", { kind: "declaration", ...key });
    const existing = this.declarations.get(id);
    this.declarations.set(id, {
      id, kind: "declaration", file,
      anchors: sortedUnique([...(existing?.anchors ?? []), anchor]),
      declarations: sortedUnique([...(existing?.declarations ?? []), ...(outline === undefined ? [] : [outline])]),
    });
    return id;
  }

  private fileOfAnchor(anchor: AnchorId): FileRecord | undefined {
    const record = this.anchors.get(anchor);
    return record === undefined ? undefined : this.files.get(record.file);
  }

  private entityOf(anchor: AnchorId): EntityId | undefined {
    const binding = this.bindings.get(anchor);
    return binding?.status === "resolved" ? binding.entity : undefined;
  }

  private snapshotOfAnchor(anchor: AnchorId): SnapshotId | undefined {
    const file = this.fileOfAnchor(anchor);
    return file?.origin.kind === "snapshot" ? file.origin.snapshot : undefined;
  }

  private entrypointEntities(): void {
    for (const part of this.part("entrypoint")) {
      const reads = this.cleanReads(part);
      if (reads.length === 0) continue;
      const entry = part.entry;
      const handlerAnchor = entry.kind === "ui-route" ? (entry.component === "unknown" ? undefined : entry.component) : entry.handler;
      const handler = handlerAnchor === undefined ? undefined : this.entityOf(handlerAnchor);
      if (handlerAnchor !== undefined && handler === undefined) continue;
      const identity = entryIdentity(entry, handler);
      if (identity === undefined) continue;
      const snapshots = handlerAnchor === undefined
        ? sortedUnique(reads.flatMap((read) => this.reads.get(read)?.snapshot ?? [])).filter((snapshot) => this.snapshots.get(snapshot)?.identity === "exact")
        : [this.snapshotOfAnchor(handlerAnchor)].filter((snapshot): snapshot is SnapshotId => snapshot !== undefined);
      for (const snapshot of snapshots) {
        const id = compositionKey(this.digest, "entity", { kind: "entrypoint", snapshot, identity });
        const existing = this.entrypoints.get(id);
        this.entrypoints.set(id, { id, kind: "entrypoint", snapshot, identity, parts: sortedUnique([...(existing?.parts ?? []), part.id]) });
      }
    }
  }

  private relate(value: RelationValue, attesting: Attesting): RelationId {
    const id = compositionKey(this.digest, "relation", value);
    const relation = this.relations.get(id) ?? { value, attestations: new Map<string, Attestation>() };
    const attestation: Attestation = {
      contextKey: this.contextKey(attesting.reads, attesting.extraSnapshots),
      parts: sortedUnique(attesting.parts), reads: sortedUnique(attesting.reads),
      ...(attesting.locations === undefined ? {} : { locations: attesting.locations }),
      ...(attesting.confidence === undefined ? {} : { confidence: attesting.confidence }),
    };
    relation.attestations.set(canonicalJson(attestation), attestation);
    this.relations.set(id, relation);
    return id;
  }

  private relationsOf<K extends RelationValue["kind"]>(kind: K): { id: RelationId; value: Extract<RelationValue, { kind: K }>; attestations: Attestation[] }[] {
    const ofKind = (value: RelationValue): value is Extract<RelationValue, { kind: K }> => value.kind === kind;
    return [...this.relations].flatMap(([id, { value, attestations }]) => (ofKind(value) ? [{ id, value, attestations: [...attestations.values()] }] : []));
  }

  private servesEntrypoint(): void {
    for (const entity of this.entrypoints.values()) {
      const handler = entity.identity.kind === "ui-route" ? entity.identity.component : entity.identity.handler;
      if (handler === "unknown") continue;
      for (const partId of entity.parts) {
        const part = this.parts.get(partId);
        if (part === undefined) continue;
        for (const read of this.cleanReads(part)) this.relate({ kind: "serves-entrypoint", entrypoint: entity.id, handler }, { parts: [partId], reads: [read] });
      }
    }
  }

  private symbolDependences(): void {
    for (const reach of this.part("symbol-reach")) {
      const via = reach.via;
      const from = this.entityOf(reach.anchor);
      const fromFile = this.anchors.get(reach.anchor)?.file;
      if (via === undefined || from === undefined || fromFile === undefined) continue;
      const locations = via.lines?.map((line) => ({ file: fromFile, line }));
      for (const read of this.cleanReads(reach)) {
        const target = this.resolveTarget(reach, read);
        if (target === undefined) {
          this.issue({ kind: "unresolved-endpoint", part: reach.id, target: via.target }, this.supportsOf(reach, [read]));
          continue;
        }
        this.relate({ kind: "symbol-dependence", from, to: target.entity, basis: via.basis }, {
          parts: [reach.id, ...target.parts], reads: [read, ...target.reads],
          ...(locations === undefined ? {} : { locations }), confidence: reach.confidence,
        });
      }
    }
  }

  /**
   * The owner read's own declarations, seeds or symbols with the literal file and symbol, when they name one
   * place; otherwise one compatible outline declaration of that file and simple name. Never a pick among several.
   */
  private resolveTarget(reach: PartOf<"symbol-reach">, read: ReadId): { entity: EntityId; parts: PartId[]; reads: ReadId[] } | undefined {
    const target = reach.via?.target;
    if (target === undefined) return undefined;
    const own = sortedUnique([...this.part("seed"), ...this.part("symbol-reach")].flatMap((part) => {
      const anchor = this.anchors.get(part.anchor);
      return anchor !== undefined && anchor.file === target.file && anchor.symbol === target.symbol && this.cleanReads(part).includes(read) ? [anchor.id] : [];
    }));
    const [only] = own;
    if (only !== undefined && own.length === 1) {
      const entity = this.entityOf(only);
      return entity === undefined ? undefined : { entity, parts: [], reads: [] };
    }
    const outline = this.outlineCandidates(target.file).filter(({ anchor }) => simpleName(anchor.symbol) === simpleName(target.symbol));
    const [candidate] = outline;
    if (candidate === undefined || outline.length > 1 || this.duplicated(candidate.part)) return undefined;
    const entity = this.entityOf(candidate.anchor.id);
    const reads = this.cleanReads(candidate.part).filter((outlineRead) => this.guarded([read, outlineRead]));
    return entity === undefined || reads.length === 0 ? undefined : { entity, parts: [candidate.part.id], reads };
  }

  private fileRelations(): void {
    for (const part of this.part("file-dependency")) {
      const kind = IMPORT_CATEGORIES.has(part.category) ? "file-import" : part.category === "user" ? "file-use" : "unresolved-file-name";
      for (const read of this.cleanReads(part)) this.relate({ kind, from: part.from, to: part.to }, { parts: [part.id], reads: [read] });
    }
  }

  private moduleRelations(): void {
    for (const part of this.part("module-reach")) {
      const via = part.via;
      const from = this.files.get(part.file);
      if (via === undefined || from === undefined || from.origin.kind !== "snapshot") continue;
      const reads = this.cleanReads(part);
      if (reads.length === 0) continue;
      const to = fileId(this.digest, { origin: from.origin, repo: from.repo, path: via.file });
      const supports = this.supportsOf(part, reads).map((support) => ({ ...support, pointer: `${support.pointer}/via/file` }));
      const existing = this.derivedFiles.get(to);
      this.derivedFiles.set(to, { id: to, repo: from.repo, origin: from.origin, path: via.file, supports: unionSupports(existing?.supports ?? [], supports) });
      const qualifier = { kind: via.kind, typeOnly: via.typeOnly, specifier: via.specifier, ...(via.form === undefined ? {} : { form: via.form }) };
      for (const read of reads) this.relate({ kind: "module-dependence", from: part.file, to, qualifier }, { parts: [part.id], reads: [read], locations: [{ file: part.file, line: via.line }] });
    }
  }

  private originRelations(): void {
    for (const part of this.part("entrypoint-reach")) {
      const reads = this.cleanReads(part);
      for (const seed of part.seeds) {
        if (seed.status === "missing") this.issue({ kind: "missing-origin-reference", part: part.id, table: "seeds", index: seed.index }, part.supports);
        else for (const read of reads) this.relate({ kind: "entrypoint-origin", entrypoint: part.id, seed: seed.part }, { parts: [part.id, seed.part], reads: [read] });
      }
    }
    for (const part of this.part("module-reach")) {
      const reads = this.cleanReads(part);
      for (const origin of part.origins) {
        if (origin.status === "missing") this.issue({ kind: "missing-origin-reference", part: part.id, table: "module-origins", index: origin.index }, part.supports);
        else for (const read of reads) this.relate({ kind: "module-origin", module: part.id, origin: origin.part }, { parts: [part.id, origin.part], reads: [read] });
      }
    }
  }

  private workspaceMatches(): void {
    for (const part of this.part("workspace-link")) {
      const { link } = part;
      part.reach.forEach((reach, position) => {
        if (reach.status === "missing") this.issue({ kind: "missing-link-reference", part: part.id, linkId: reach.linkId, position }, part.supports);
      });
      const fromFile = this.files.get(link.from.file);
      const handler = this.entityOf(link.to.handler);
      const toSnapshot = this.snapshotOfAnchor(link.to.handler);
      if (fromFile?.origin.kind !== "snapshot" || handler === undefined || toSnapshot === undefined) continue;
      const value: RelationValue = {
        kind: "workspace-match", from: link.from, to: { repo: link.to.repo, kind: link.to.kind, name: link.to.name, handler },
        transport: link.transport, basis: link.basis, ...(link.profiles === undefined ? {} : { profiles: link.profiles }),
      };
      for (const read of this.cleanReads(part)) this.relate(value, { parts: [part.id], reads: [read], confidence: link.confidence, extraSnapshots: [fromFile.origin.snapshot, toSnapshot] });
    }
  }

  private nameCandidates(): void {
    const names = this.part("outward-name");
    for (const candidate of this.part("name-candidate")) {
      const reads = this.cleanReads(candidate);
      if (!reads.includes(candidate.context)) continue;
      const observed = names.filter((name) => name.name === candidate.name && this.cleanReads(name).includes(candidate.context));
      const [only] = observed;
      if (only === undefined || observed.length > 1) continue;
      this.relate({ kind: "candidate-for-name", name: only.id, repo: candidate.repo, basis: candidate.basis }, { parts: [candidate.id, only.id], reads: [candidate.context] });
    }
  }

  private sharedEvidence(): void {
    const citing = new Map<EvidenceId, PartId[]>();
    for (const part of this.set.parts) {
      if (this.cleanReads(part).length === 0) continue;
      for (const evidence of sortedUnique(partReferences(part).flatMap((reference) => (isCompositionId("evidence", reference.id) ? [reference.id] : [])))) {
        citing.set(evidence, [...(citing.get(evidence) ?? []), part.id]);
      }
    }
    for (const [evidence, cited] of citing) {
      const parts = sortedUnique(cited);
      for (const [index, left] of parts.entries()) {
        for (const right of parts.slice(index + 1)) {
          const value: RelationValue = { kind: "shares-evidence", parts: [left, right], evidence };
          for (const readLeft of this.readsOfPart(left)) {
            for (const readRight of this.readsOfPart(right)) this.relate(value, { parts: [left, right], reads: [readLeft, readRight] });
          }
        }
      }
    }
  }

  // The five closed connections. No transitive closure, no breakage, no unrecorded chain.

  private connect(rule: ConnectionRule, parts: readonly PartId[], relations: readonly RelationId[], reads: readonly ReadId[], entities?: readonly EntityId[]): void {
    const key = { rule, parts: sortedUnique(parts), relations: sortedUnique(relations), reads: sortedUnique(reads), ...(entities === undefined ? {} : { entities: sortedUnique(entities) }) };
    const id = compositionKey(this.digest, "connection", key);
    const supports = key.parts.flatMap((partId) => {
      const part = this.parts.get(partId);
      return part === undefined ? [] : this.supportsOf(part, key.reads);
    });
    const existing = this.connections.get(id);
    this.connections.set(id, {
      id, rule, parts: key.parts, relations: key.relations, supports: unionSupports(existing?.supports ?? [], supports).sort(compareSupport),
      ...(key.entities === undefined ? {} : { entities: key.entities }),
    });
  }

  /** `handler-declaration`: a serves-entrypoint whose handler binds one outline declaration. */
  private handlerDeclarations(): void {
    for (const serves of this.relationsOf("serves-entrypoint")) {
      const handler = this.declarations.get(serves.value.handler);
      const entity = this.entrypoints.get(serves.value.entrypoint);
      const [declaration] = handler?.declarations ?? [];
      const outline = declaration === undefined ? undefined : this.parts.get(declaration);
      if (entity === undefined || outline === undefined || handler?.declarations.length !== 1) continue;
      for (const attestation of serves.attestations) {
        for (const read of this.cleanReads(outline)) {
          if (this.guarded([...attestation.reads, read])) this.connect("handler-declaration", [...attestation.parts, outline.id], [serves.id], [...attestation.reads, read], [entity.id, handler.id]);
        }
      }
    }
  }

  /** `reached-handler`: a reached entrypoint and the one known entrypoint of the same kind, handler and name. */
  private reachedHandlers(): void {
    for (const reach of this.part("entrypoint-reach")) {
      const handler = this.entityOf(reach.handler);
      if (reach.kindName === "unknown" || handler === undefined) continue;
      const matches = [...this.entrypoints.values()].filter((entity) => {
        const identity = entity.identity;
        const entityHandler = identity.kind === "ui-route" ? identity.component : identity.handler;
        return identity.kind === reach.kindName && entityHandler === handler
          && (reach.name === undefined || entity.parts.some((partId) => { const part = this.parts.get(partId); return part?.kind === "entrypoint" && part.entry.name === reach.name; }));
      });
      const [entity] = matches;
      if (entity === undefined || matches.length > 1) continue;
      const serves = this.relationsOf("serves-entrypoint").filter((relation) => relation.value.entrypoint === entity.id).map((relation) => relation.id);
      for (const read of this.cleanReads(reach)) {
        for (const partId of entity.parts) {
          const part = this.parts.get(partId);
          for (const entityRead of part === undefined ? [] : this.cleanReads(part)) {
            if (this.guarded([read, entityRead])) this.connect("reached-handler", [reach.id, partId], serves, [read, entityRead], [entity.id, handler]);
          }
        }
      }
    }
  }

  /** `change-dependent`: a diff seed and a recorded symbol dependence onto the same entity, in the seed's head. */
  private changeDependents(): void {
    const dependences = this.relationsOf("symbol-dependence");
    for (const seed of this.part("seed")) {
      const comparison = seed.comparison;
      const target = this.entityOf(seed.anchor);
      if (comparison?.status !== "available" || target === undefined || this.snapshotOfAnchor(seed.anchor) !== comparison.value.head) continue;
      for (const dependence of dependences.filter((relation) => relation.value.to === target)) {
        for (const attestation of dependence.attestations) {
          for (const read of this.cleanReads(seed)) {
            const reads = [read, ...attestation.reads];
            const typed = reads.filter((candidate) => [seed.id, ...attestation.parts].some((partId) => {
              const part = this.parts.get(partId);
              return (part?.kind === "seed" || part?.kind === "symbol-reach") && this.cleanReads(part).includes(candidate);
            }));
            if (this.guarded(reads, typed)) this.connect("change-dependent", [seed.id, ...attestation.parts], [dependence.id], reads, [dependence.value.from, target]);
          }
        }
      }
    }
  }

  /** `shared-file-import`: the importers and outline attestations of one file-import, categories kept apart. */
  private sharedFileImports(): void {
    const outlineImport = (attestation: Attestation) => attestation.parts.some((partId) => { const part = this.parts.get(partId); return part?.kind === "file-dependency" && part.category === "outline-import"; });
    for (const relation of this.relationsOf("file-import")) {
      const outline = relation.attestations.filter(outlineImport);
      const importers = relation.attestations.filter((attestation) => !outlineImport(attestation));
      for (const left of importers) {
        for (const right of outline) {
          const reads = [...left.reads, ...right.reads];
          if (this.guarded(reads, [], "corroborate")) this.connect("shared-file-import", [...left.parts, ...right.parts], [relation.id], reads);
        }
      }
    }
  }

  /** `shared-support`: two findings citing one exact evidence; no causality or equivalence between them. */
  private sharedSupports(): void {
    for (const relation of this.relationsOf("shares-evidence")) {
      for (const attestation of relation.attestations) {
        if (this.guarded(attestation.reads, [], "corroborate")) this.connect("shared-support", relation.value.parts, [relation.id], attestation.reads);
      }
    }
  }
}

/** The identity of an entrypoint with its known handler as an entity; `undefined` when that handler is unbound. */
function entryIdentity(entry: Extract<Part, { kind: "entrypoint" }>["entry"], handler: EntityId | undefined): EntryIdentity | undefined {
  switch (entry.kind) {
    case "ui-route":
      return { kind: "ui-route", path: entry.path, ...(entry.outlet === undefined ? {} : { outlet: entry.outlet }), component: handler ?? "unknown" };
    case "http-route":
      return handler === undefined ? undefined : { kind: "http-route", method: entry.method, path: entry.path, ...(entry.version === undefined ? {} : { version: entry.version }), handler };
    case "listener":
      return handler === undefined ? undefined : { kind: "listener", protocol: entry.protocol, destination: entry.destination, handler };
    case "job":
      return handler === undefined ? undefined : { kind: "job", trigger: entry.trigger, handler };
  }
}

function cutOwner(owner: ReadOwner): CutOwner {
  return owner.kind === "read" ? { kind: "read", repo: owner.repo, index: owner.index } : owner;
}
