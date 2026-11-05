/**
 * The internal references of a materialized composition: what every record of every table points at, and the check that
 * each of them resolves. A broken reference is a defect of normalization or materialization (`CompositionInvariantFault`),
 * never a semantic issue; the explicit missing variants (`OriginReference`/`LinkReference` missing, `ComparisonRef`
 * unavailable) are values, not references, and pass.
 */
import type { Result } from "../core/domain/shared/result.ts";
import type {
  CompositionInvariantFault, CompositionIssue, EvidenceOrigin, MaterializedGraph, Part, RelationValue, Support,
} from "./composition-contract.ts";
import { isCompositionId, type IdKind } from "./composition-identity.ts";

/** One reference a record holds: the table it points into, the field that holds it, and the id. */
export type Reference = { kind: IdKind; field: string; id: string };

const ref = (kind: IdKind, field: string, id: string): Reference => ({ kind, field, id });
const many = (kind: IdKind, field: string, ids: readonly string[]): Reference[] => ids.map((id) => ref(kind, field, id));

export function originReferences(origin: EvidenceOrigin, field: string): Reference[] {
  return origin.kind === "snapshot" ? [ref("snapshot", `${field}.snapshot`, origin.snapshot)] : [ref("read", `${field}.read`, origin.read)];
}

/** Every reference a part's payload holds, exhaustively by kind. */
export function partReferences(part: Part): Reference[] {
  switch (part.kind) {
    case "entrypoint": {
      const entry = part.entry;
      const handler = entry.kind === "ui-route"
        ? (entry.component === "unknown" ? [] : [ref("anchor", "entry.component", entry.component)])
        : [ref("anchor", "entry.handler", entry.handler)];
      const basePath = entry.kind === "http-route" ? many("evidence", "entry.basePath.evidence", entry.basePath.evidence) : [];
      return [...handler, ...basePath, ...many("evidence", "evidence", part.evidence)];
    }
    case "unknown-finding":
      return many("evidence", "evidence", part.evidence);
    case "seed":
      return [ref("anchor", "anchor", part.anchor), ...(part.comparison === undefined ? [] : comparisonReferences(part.comparison))];
    case "symbol-reach":
      return [ref("anchor", "anchor", part.anchor), ...(part.via === undefined ? [] : [ref("file", "via.target.file", part.via.target.file)])];
    case "entrypoint-reach":
      return [ref("anchor", "handler", part.handler), ...part.seeds.flatMap((seed) => (seed.status === "present" ? [ref("part", "seeds.part", seed.part)] : []))];
    case "entrypoint-change":
      return [ref("anchor", "handler", part.handler), ...comparisonReferences(part.comparison)];
    case "module-origin":
      return comparisonReferences(part.comparison);
    case "module-reach":
      return [ref("file", "file", part.file), ...part.origins.flatMap((origin) => (origin.status === "present" ? [ref("part", "origins.part", origin.part)] : []))];
    case "file-dependency":
      return [ref("file", "from", part.from), ref("file", "to", part.to)];
    case "file-query":
    case "unheld-file":
      return [ref("file", "file", part.file)];
    case "outline-declaration":
      return [ref("anchor", "anchor", part.anchor)];
    case "outline-file":
      return [ref("file", "file", part.file), ...many("part", "declarations", part.declarations), ...many("part", "imports", part.imports)];
    case "outward-name":
      return [...originReferences(part.origin, "origin"), ...many("evidence", "evidence", part.evidence)];
    case "name-candidate":
      return [ref("read", "context", part.context), ...many("evidence", "evidence", part.evidence)];
    case "call-site":
      return [ref("file", "site.location.file", part.site.location.file), ...many("evidence", "site.target.evidence", part.site.target.evidence)];
    case "unresolved-call-site":
      return [];
    case "workspace-link":
      return [
        ref("file", "link.from.file", part.link.from.file), ref("anchor", "link.to.handler", part.link.to.handler),
        ...part.reach.flatMap((reach) => (reach.status === "present" ? [ref("part", "reach.part", reach.part)] : [])),
      ];
    case "workspace-context": {
      const context = part.context;
      const vector = context.family === "decisions" ? context.repositories : context.repositorySnapshots;
      return vector.map((entry) => ref("snapshot", "context.repositorySnapshots.snapshot", entry.snapshot));
    }
    case "decision":
      return [ref("read", "context", part.context), ...many("evidence", "evidence", part.evidence), ...part.options.flatMap((option) => many("evidence", "options.evidence", option.evidence))];
    case "walk-cost":
    case "impact-context":
      return [ref("read", "owner", part.owner)];
    default:
      return unreachable(part);
  }
}

function comparisonReferences(comparison: Extract<Part, { kind: "entrypoint-change" }>["comparison"]): Reference[] {
  return comparison.status === "available" ? [ref("snapshot", "comparison.value.head", comparison.value.head)] : [ref("read", "comparison.read", comparison.read)];
}

/** Every reference a relation value holds, exhaustively by kind. */
export function relationReferences(value: RelationValue): Reference[] {
  switch (value.kind) {
    case "serves-entrypoint":
      return [ref("entity", "value.entrypoint", value.entrypoint), ref("entity", "value.handler", value.handler)];
    case "symbol-dependence":
      return [ref("entity", "value.from", value.from), ref("entity", "value.to", value.to)];
    case "file-import":
    case "file-use":
    case "unresolved-file-name":
    case "module-dependence":
      return [ref("file", "value.from", value.from), ref("file", "value.to", value.to)];
    case "entrypoint-origin":
      return [ref("part", "value.entrypoint", value.entrypoint), ref("part", "value.seed", value.seed)];
    case "module-origin":
      return [ref("part", "value.module", value.module), ref("part", "value.origin", value.origin)];
    case "workspace-match":
      return [ref("file", "value.from.file", value.from.file), ref("entity", "value.to.handler", value.to.handler)];
    case "candidate-for-name":
      return [ref("part", "value.name", value.name)];
    case "shares-evidence":
      return [...many("part", "value.parts", value.parts), ref("evidence", "value.evidence", value.evidence)];
    default:
      return unreachable(value);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled composition variant ${JSON.stringify(value)}`);
}

type Fault = CompositionInvariantFault;
const fault = (table: string, id: string, field: string): Fault => ({ kind: "invalid-composition-reference", table, id, field });

/** Checks every reference of every table; the first broken one is returned with its table, record id and field. */
export function validateCompositionReferences(graph: MaterializedGraph): Result<void, CompositionInvariantFault> {
  const found = firstFault(graph);
  return found === undefined ? { ok: true, value: undefined } : { ok: false, fault: found };
}

/** Issues refer to the same graph even though they travel once in coverage, outside its tables. */
export function validateCompositionIssues(graph: MaterializedGraph, issues: readonly CompositionIssue[]): Result<void, CompositionInvariantFault> {
  const sources = new Set(graph.sources.map((source) => source.id));
  const reads = new Map(graph.reads.map((read) => [read.id, read.source]));
  const ids = {
    snapshot: new Set(graph.snapshots.map((record) => record.id)),
    anchor: new Set(graph.anchors.map((record) => record.id)),
    part: new Set(graph.parts.map((record) => record.id)),
    file: new Set(graph.files.map((record) => record.id)),
  };
  for (const [index, issue] of issues.entries()) {
    const fail = (field: string): Result<void, CompositionInvariantFault> => ({ ok: false, fault: fault("issues", String(index), field) });
    if (issue.sources.some((source) => !sources.has(source))) return fail("sources");
    if (issue.reads.some((read) => !reads.has(read) || !issue.sources.includes(reads.get(read)!))) return fail("reads");
    switch (issue.kind) {
      case "snapshot-difference":
        if (issue.snapshots.some((id) => !ids.snapshot.has(id))) return fail("snapshots");
        break;
      case "ambiguous-declaration":
        if (!ids.anchor.has(issue.anchor)) return fail("anchor");
        if (issue.candidates.some((id) => !ids.part.has(id))) return fail("candidates");
        break;
      case "conflicting-coordinate":
        if (issue.anchors.some((id) => !ids.anchor.has(id))) return fail("anchors");
        break;
      case "unresolved-endpoint":
        if (!ids.part.has(issue.part)) return fail("part");
        if (!ids.file.has(issue.target.file)) return fail("target.file");
        break;
      case "missing-origin-reference":
      case "missing-link-reference":
        if (!ids.part.has(issue.part)) return fail("part");
        break;
      case "missing-provenance":
        if (issue.part !== undefined && !ids.part.has(issue.part)) return fail("part");
        break;
      case "context-mismatch":
      case "redacted-identity":
        break;
      default:
        return unreachable(issue);
    }
  }
  return { ok: true, value: undefined };
}

function firstFault(graph: MaterializedGraph): Fault | undefined {
  const ids = new Map<IdKind, Set<string>>();
  const tables: [string, IdKind, readonly { id: string }[]][] = [
    ["snapshots", "snapshot", graph.snapshots], ["sources", "source", graph.sources], ["reads", "read", graph.reads],
    ["files", "file", graph.files], ["anchors", "anchor", graph.anchors], ["evidence", "evidence", graph.evidence],
    ["parts", "part", graph.parts], ["entities", "entity", graph.entities], ["relations", "relation", graph.relations],
    ["connections", "connection", graph.connections],
  ];
  for (const [table, kind, records] of tables) {
    const seen = new Set<string>();
    for (const record of records) {
      if (!isCompositionId(kind, record.id) || seen.has(record.id)) return fault(table, record.id, "id");
      seen.add(record.id);
    }
    ids.set(kind, seen);
  }
  const has = (reference: Reference) => ids.get(reference.kind)?.has(reference.id) === true;
  const readSource = new Map(graph.reads.map((read) => [read.id, read.source]));
  const check = (table: string, id: string, references: readonly Reference[]): Fault | undefined => {
    const broken = references.find((reference) => !has(reference));
    return broken === undefined ? undefined : fault(table, id, broken.field);
  };
  const supports = (table: string, id: string, list: readonly Support[]): Fault | undefined => {
    for (const support of list) {
      if (!has(ref("source", "supports.source", support.source))) return fault(table, id, "supports.source");
      if (readSource.get(support.read) !== support.source) return fault(table, id, "supports.read");
    }
    return undefined;
  };

  for (const source of graph.sources) {
    if (readSource.get(source.rootRead) !== source.id) return fault("sources", source.id, "rootRead");
    const broken = check("sources", source.id, source.snapshotVector.map((entry) => ref("snapshot", "snapshotVector.snapshot", entry.snapshot)));
    if (broken) return broken;
  }
  for (const read of graph.reads) {
    const broken = check("reads", read.id, [ref("source", "source", read.source), ref("snapshot", "snapshot", read.snapshot), ...many("evidence", "evidence", read.evidence)]);
    if (broken) return broken;
  }
  for (const file of graph.files) {
    const broken = check("files", file.id, originReferences(file.origin, "origin")) ?? supports("files", file.id, file.supports);
    if (broken) return broken;
  }
  for (const anchor of graph.anchors) {
    const broken = check("anchors", anchor.id, [ref("file", "file", anchor.file)]) ?? supports("anchors", anchor.id, anchor.supports);
    if (broken) return broken;
  }
  for (const record of graph.evidence) {
    const broken = check("evidence", record.id, originReferences(record.origin, "origin")) ?? supports("evidence", record.id, record.supports);
    if (broken) return broken;
  }
  for (const part of graph.parts) {
    const broken = check("parts", part.id, partReferences(part)) ?? supports("parts", part.id, part.supports);
    if (broken) return broken;
  }
  for (const entity of graph.entities) {
    const references = entity.kind === "declaration"
      ? [ref("file", "file", entity.file), ...many("anchor", "anchors", entity.anchors), ...many("part", "declarations", entity.declarations)]
      : [
          ref("snapshot", "snapshot", entity.snapshot), ...many("part", "parts", entity.parts),
          ...(entity.identity.kind === "ui-route"
            ? (entity.identity.component === "unknown" ? [] : [ref("entity", "identity.component", entity.identity.component)])
            : [ref("entity", "identity.handler", entity.identity.handler)]),
        ];
    const broken = check("entities", entity.id, references);
    if (broken) return broken;
  }
  const bound = new Set<string>();
  for (const { anchor, binding } of graph.bindings) {
    if (bound.has(anchor)) return fault("bindings", anchor, "anchor");
    bound.add(anchor);
    const references = [ref("anchor", "anchor", anchor), binding.status === "resolved" ? ref("entity", "binding.entity", binding.entity) : ref("anchor", "binding.anchor", binding.anchor)];
    const broken = check("bindings", anchor, references);
    if (broken) return broken;
    if (binding.status === "unresolved" && binding.anchor !== anchor) return fault("bindings", anchor, "binding.anchor");
  }
  for (const relation of graph.relations) {
    const references = [
      ...relationReferences(relation.value),
      ...relation.attestations.flatMap((attestation) => [
        ...many("part", "attestations.parts", attestation.parts), ...many("read", "attestations.reads", attestation.reads),
        ...(attestation.locations ?? []).map((location) => ref("file", "attestations.locations.file", location.file)),
      ]),
    ];
    const broken = check("relations", relation.id, references);
    if (broken) return broken;
  }
  for (const connection of graph.connections) {
    const references = [...many("part", "parts", connection.parts), ...many("relation", "relations", connection.relations), ...many("entity", "entities", connection.entities ?? [])];
    const broken = check("connections", connection.id, references) ?? supports("connections", connection.id, connection.supports);
    if (broken) return broken;
  }
  return undefined;
}
