/**
 * The canonical keys of composition: one id scheme, `prefix + ":" + Digest.of(canonicalJson([version,
 * kind, key]))`, and the orders and set operations every table uses. Pure: no alias resolution, compatibility, relation
 * inference or merging lives here. Normalization and materialization both build ids only through these functions.
 */
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Evidence, Fact, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import type { RecoveryContext } from "./recovery.ts";
import { escapePointer } from "./query-runner.ts";
import type {
  AnchorId, CompositionIdentity, EvidenceId, EvidenceOrigin, FileId, PartId, PartPayload, ReadId, ReadOwner,
  SnapshotId, SourceFamilyRef, SourceId, Support,
} from "./composition-contract.ts";

/** Changing what any key means changes this version, and with it every id. */
export const COMPOSITION_KEY_VERSION = "mcp-composition-v1";

/** The prefix of every wire id kind. */
export const ID_PREFIXES = {
  source: "s1", read: "r1", snapshot: "v1", file: "f1", anchor: "a1", evidence: "e1",
  part: "p1", entity: "n1", relation: "l1", connection: "c1",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;
export type IdOf<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}:${string}`;

/** Digest identities always have a namespace; they are distinct from Git's bare SHA-1/SHA-256 object ids. */
const DIGEST_ID = /^mcp-c1:[0-9a-f]{64}$/;
export type DigestNamespace = (typeof ID_PREFIXES)[IdKind] | "mcp-c1" | "mcp-r1";
export function namespacedDigestPattern(namespace: DigestNamespace): RegExp {
  return new RegExp(DIGEST_ID.source.replace("mcp-c1", namespace));
}

/** The one id builder: the key is canonical JSON, so object member order never matters and array order always does. */
export function compositionKey<K extends IdKind>(digest: Digest, kind: K, key: unknown): IdOf<K> {
  const value = digest.of(canonicalJson([COMPOSITION_KEY_VERSION, kind, key]));
  if (!DIGEST_ID.test(`mcp-c1:${value}`)) throw new Error("Composition digests must be 64 lowercase hex characters");
  return `${ID_PREFIXES[kind]}:${value}` as IdOf<K>;
}

/** Whether a string is a well-formed id of that kind. */
export function isCompositionId<K extends IdKind>(kind: K, value: unknown): value is IdOf<K> {
  return typeof value === "string" && namespacedDigestPattern(ID_PREFIXES[kind]).test(value);
}

/**
 * The occurrence an id is local to. Given, the id no longer shares a representation across appearances: used when
 * redaction altered an identity field, and for a workspace link before its reach is resolved.
 */
export type Occurrence = Support;

/** Every field of the snapshot: a sha and a live state never share an id, nor two live states of one head. */
export function snapshotId(digest: Digest, snapshot: SnapshotRef, occurrence?: Occurrence): SnapshotId {
  return compositionKey(digest, "snapshot", { snapshot, ...local(occurrence) });
}

/**
 * The context half of a source identity. Families with recovery reuse the `mcp-r1` context exactly; the other four use
 * the same fields, normalized from the public fact, plus the offline policy their read applied.
 */
export type SourceContext =
  | { kind: "recovery"; context: RecoveryContext }
  | { kind: "fresh"; context: Omit<RecoveryContext, "replay" | "mergeBase"> };

export type SourceIdentityInput = SourceFamilyRef & {
  context: SourceContext;
  /** The complete public, redacted fact before normalization: schema, producer, inputs, value/status/reason, provenance. */
  fact: Fact<unknown>;
  /** The ordinal of the query in the sorted unique sequence, only when redaction made distinct queries indistinguishable. */
  discriminator?: number;
};
export function sourceId(digest: Digest, input: SourceIdentityInput): SourceId {
  return compositionKey(digest, "source", input);
}

/** A read is its source and owner: two reads never become one because they share a snapshot. */
export function readId(digest: Digest, source: SourceId, owner: ReadOwner): ReadId {
  return compositionKey(digest, "read", { source, owner });
}

/** The exact relative path at its origin: no case folding, basename or symlink resolution. */
export function fileId(digest: Digest, file: { origin: EvidenceOrigin; repo: string; path: string }, occurrence?: Occurrence): FileId {
  return compositionKey(digest, "file", { origin: file.origin, repo: file.repo, path: file.path, ...local(occurrence) });
}

/** File, literal symbol, line and the presence and value of `endLine`. */
export function anchorId(digest: Digest, anchor: { file: FileId; symbol: string; line: number; endLine?: number }, occurrence?: Occurrence): AnchorId {
  return compositionKey(digest, "anchor", { file: anchor.file, symbol: anchor.symbol, line: anchor.line, ...(anchor.endLine === undefined ? {} : { endLine: anchor.endLine }), ...local(occurrence) });
}

/** Exact origin, repo and the whole evidence object, `via` and `confidence` included. */
export function evidenceId(digest: Digest, record: { origin: EvidenceOrigin; repo: string; value: Evidence }, occurrence?: Occurrence): EvidenceId {
  return compositionKey(digest, "evidence", { origin: record.origin, repo: record.repo, value: record.value, ...local(occurrence) });
}

/** The discriminant and typed payload, with its references; supports never enter the key. */
export function partId(digest: Digest, payload: PartPayload, occurrence?: Occurrence): PartId {
  return compositionKey(digest, "part", { payload, ...local(occurrence) });
}

/** The identity of a whole composition: its unique source ids as a set. */
export function compositionIdentity(digest: Digest, sources: readonly SourceId[]): CompositionIdentity {
  return `mcp-c1:${digest.of(canonicalJson([COMPOSITION_KEY_VERSION, sortedUnique(sources)]))}`;
}

function local(occurrence: Occurrence | undefined): { occurrence?: Occurrence } {
  return occurrence === undefined ? {} : { occurrence: { source: occurrence.source, read: occurrence.read, pointer: occurrence.pointer } };
}

/** An RFC 6901 pointer built from public keys and array indices. */
export function jsonPointer(segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${typeof segment === "number" ? String(segment) : escapePointer(segment)}`).join("");
}

/** Equality of values, ignoring object member order and never array order. */
export function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A set of strings: unique, in code-unit order. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

export function compareSupport(a: Support, b: Support): number {
  return compareText(a.source, b.source) || compareText(a.read, b.read) || compareText(a.pointer, b.pointer);
}

/** The union of support sets: unique, ordered by source, read, pointer. Commutative, associative and idempotent. */
export function unionSupports(...sets: readonly (readonly Support[])[]): Support[] {
  const byKey = new Map<string, Support>();
  for (const set of sets) for (const support of set) byKey.set(canonicalJson([support.source, support.read, support.pointer]), { source: support.source, read: support.read, pointer: support.pointer });
  return [...byKey.values()].sort(compareSupport);
}

/** Table order: by id. */
export function sortById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => compareText(a.id, b.id));
}
