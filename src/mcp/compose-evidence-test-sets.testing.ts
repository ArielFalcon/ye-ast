/**
 * Small typed evidence sets for the materialization tests, built directly with the identity helpers (no normalizer).
 * Synthetic: they exercise the union and materialization rules, never a real MCP answer.
 */
import { createHash } from "node:crypto";
import { SCHEMA, type Evidence, type FactInputs, type Producer, type SchemaVersion, type SnapshotRef } from "../core/domain/shared/fact.ts";
import type { AnchorId, EvidenceId, EvidenceOrigin, EvidenceRecord, EvidenceSet, FileId, FileRecord, AnchorRecord, Part, PartId, PartPayload, ReadId, ReadOwner, ReadRecord, RedactionRecord, SnapshotId, SnapshotRecord, SourceFamilyRef, SourceId, SourceRecord, Support } from "../core/ports/evidence-composition.port.ts";
import { anchorId, compareSupport, compositionKey, evidenceId, fileId, partId, readId, snapshotId, sortById, unionSupports, type Occurrence } from "./composition-identity.ts";

export const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const sha = (repo: string, value = SHA_A): SnapshotRef => ({ repo, kind: "sha", sha: value });

export type ReadContext = {
  trust?: FactInputs["trust"];
  producer?: Producer;
  schema?: SchemaVersion;
  engines?: Record<string, string>;
  /** Differences that never block a connection by themselves. */
  scopeInclude?: readonly string[];
  walkDepth?: number;
  targets?: readonly string[];
};

function inputs(context: ReadContext): FactInputs {
  return {
    trust: context.trust ?? "trusted",
    scope: "s".repeat(64),
    declaredScope: { languages: [], frameworks: [], include: context.scopeInclude ?? [], exclude: [] },
    content: "c".repeat(64),
    config: "g".repeat(64),
    declaredConfig: {
      ...(context.walkDepth === undefined ? {} : { walk: { depth: context.walkDepth } }),
      ...(context.targets === undefined ? {} : { targets: context.targets }),
    },
    engines: context.engines ?? {},
  };
}

/** One source with its root read; `section` adds further reads of the same source. */
export class SetBuilder {
  readonly source: SourceId;
  readonly read: ReadId;
  readonly snapshot: SnapshotId;
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly reads: ReadRecord[] = [];
  private readonly files = new Map<string, FileRecord>();
  private readonly anchors = new Map<string, AnchorRecord>();
  private readonly evidenceRecords = new Map<string, EvidenceRecord>();
  private readonly parts = new Map<string, Part>();
  private readonly redactions: RedactionRecord[] = [];
  private readonly family: SourceFamilyRef;
  private readonly snapshotRef: SnapshotRef;
  private readonly context: ReadContext;
  private counter = 0;

  constructor(name: string, family: SourceFamilyRef, snapshot: SnapshotRef, context: ReadContext = {}) {
    this.family = family;
    this.snapshotRef = snapshot;
    this.context = context;
    this.source = compositionKey(digest, "source", { test: name });
    this.snapshot = this.snapshotOf(snapshot);
    this.read = this.addRead({ kind: "fact" }, snapshot);
  }

  snapshotOf(value: SnapshotRef, identity: "exact" | "redacted" = "exact", occurrence?: Occurrence): SnapshotId {
    const id = snapshotId(digest, value, occurrence);
    this.snapshots.set(id, { id, value, identity });
    return id;
  }

  addRead(owner: ReadOwner, snapshot: SnapshotRef = this.snapshotRef, context: ReadContext = this.context): ReadId {
    const id = readId(digest, this.source, owner);
    const snap = this.snapshotOf(snapshot);
    this.reads.push({
      id, source: this.source, owner, schema: context.schema ?? SCHEMA, producer: context.producer ?? { name: "ye-ast", version: "1.0.0" },
      inputs: inputs(context), snapshot: snap, evidence: [], analysis: { status: "complete" },
    });
    return id;
  }

  private support(pointer: string | undefined, read: ReadId): Support {
    return { source: this.source, read, pointer: pointer ?? `/test/${this.counter++}` };
  }

  origin(snapshot: SnapshotRef | "query-context" = this.snapshotRef, read: ReadId = this.read): EvidenceOrigin {
    return snapshot === "query-context" ? { kind: "query-context", read } : { kind: "snapshot", snapshot: this.snapshotOf(snapshot) };
  }

  file(path: string, options: { snapshot?: SnapshotRef | "query-context"; repo?: string; pointer?: string; read?: ReadId; occurrence?: Occurrence } = {}): FileId {
    const read = options.read ?? this.read;
    const origin = this.origin(options.snapshot, read);
    const repo = options.repo ?? (options.snapshot === undefined || options.snapshot === "query-context" ? this.snapshotRef.repo : options.snapshot.repo);
    const id = fileId(digest, { origin, repo, path }, options.occurrence);
    const support = this.support(options.pointer, read);
    const existing = this.files.get(id);
    this.files.set(id, { id, repo, origin, path, supports: unionSupports(existing?.supports ?? [], [support]) });
    return id;
  }

  anchor(file: FileId, symbol: string, line: number, endLine?: number, options: { pointer?: string; read?: ReadId; occurrence?: Occurrence } = {}): AnchorId {
    const coordinate = { file, symbol, line, ...(endLine === undefined ? {} : { endLine }) };
    const id = anchorId(digest, coordinate, options.occurrence);
    const support = this.support(options.pointer, options.read ?? this.read);
    this.anchors.set(id, { id, ...coordinate, supports: unionSupports(this.anchors.get(id)?.supports ?? [], [support]) });
    return id;
  }

  evidence(value: Evidence, options: { snapshot?: SnapshotRef | "query-context"; repo?: string; pointer?: string; read?: ReadId } = {}): EvidenceId {
    const read = options.read ?? this.read;
    const origin = this.origin(options.snapshot, read);
    const repo = options.repo ?? this.snapshotRef.repo;
    const id = evidenceId(digest, { origin, repo, value });
    const support = this.support(options.pointer, read);
    this.evidenceRecords.set(id, { id, origin, repo, value, supports: unionSupports(this.evidenceRecords.get(id)?.supports ?? [], [support]) });
    return id;
  }

  part(payload: PartPayload, options: { pointer?: string; read?: ReadId; occurrence?: Occurrence } = {}): PartId {
    const id = partId(digest, payload, options.occurrence);
    const support = this.support(options.pointer, options.read ?? this.read);
    this.parts.set(id, { ...payload, id, supports: unionSupports(this.parts.get(id)?.supports ?? [], [support]) });
    return id;
  }

  redact(pointer: string, read: ReadId = this.read): void {
    this.redactions.push({ source: this.source, read, pointer });
  }

  build(): EvidenceSet {
    const sourceRecord = { ...this.family, id: this.source, rootRead: this.read, snapshotVector: [{ repo: this.snapshotRef.repo, snapshot: this.snapshot }], analysis: { status: "complete" } } satisfies SourceRecord;
    return {
      snapshots: sortById([...this.snapshots.values()]),
      sources: [sourceRecord],
      reads: sortById(this.reads),
      files: sortById([...this.files.values()]),
      anchors: sortById([...this.anchors.values()]),
      evidence: sortById([...this.evidenceRecords.values()]),
      parts: sortById([...this.parts.values()]),
      redactions: [...this.redactions].sort(compareSupport),
    };
  }
}
