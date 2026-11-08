import { dependencyDiagnosticText, effectText, unresolvedLabel } from "./presentation.ts";
/**
 * Deterministic text of a composition. Summary and details are self-sufficient: every subject they
 * cite is declared once in a local legend (S sources, V snapshots, N subjects, L relations, C connections), the first
 * reference to a subject carries its name beside its label, shared context is printed once by exact equality, and every
 * uncertainty stays next to what it limits. Connections follow the source legend; summary opens with what was joined and
 * states what each source holds. Summary counts what it omits, including the enumeration context: beside a read that
 * declares a subject, what only reads declaring none hold and no listed connection cites. Details lists every recorded observation
 * compactly; full only navigates the result JSON, never a second listing. No joins, no inference and no text
 * interpretation: every statement is a projection of the materialized tables.
 */
import type { Cut, Evidence } from "../core/domain/shared/fact.ts";
import type { BasePath, BasePathKeys } from "../core/domain/entrypoints/http-route.ts";
import type { ResponseMode } from "./presentation.ts";
import { shareExactContext } from "./presentation-sharing.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { ComposeFull, ComposeReceipt, CompositionResult } from "./composition-contract.ts";
import type { AnchorId, Attestation, ComparisonRef, CompositionIssue, Connection, EntityId, EntityRecord, EntryData, EvidenceFinding, EvidenceId, EvidenceOrigin, FileId, OriginReference, Part, PartId, PartKind, PartOf, ReadId, ReadOwner, ReadRecord, RelationId, RelationRecord, SnapshotId, SourceDescriptor, SourceId } from "../core/ports/evidence-composition.port.ts";
import type { CutOwner } from "../core/domain/composition/source-read.ts";

/** The action receipt: verification and complete safe repeat queries; findings and coverage belong to text. */
export function composeReceipt(result: CompositionResult, mode: "summary" | "details"): ComposeReceipt {
  return { kind: "composition-receipt", compositionSchema: 1, mode, verification: result.verification, requests: result.requests };
}

/** The full composition: every table once, `graph.sources` as the only source table, delivery sidecars when present. */
export function composeFull(result: CompositionResult): ComposeFull {
  return {
    kind: "composition", compositionSchema: 1, mode: "full", verification: result.verification, requests: result.requests,
    graph: result.graph, coverage: result.coverage, counts: result.counts, ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
  };
}

export function renderComposition(result: CompositionResult, mode: ResponseMode): string {
  return mode === "full" ? renderFull(result) : new CompactView(result, mode === "details").render().join("\n");
}

// Full: navigation only.

/**
 * Counts, verification and one pointer per table; what each table means is the server instructions' job, not a manual
 * repeated in every answer.
 */
function renderFull(result: CompositionResult): string {
  const { graph, coverage, counts } = result;
  const tables = (["sources", "snapshots", "reads", "files", "anchors", "evidence", "parts", "entities", "bindings", "relations", "connections"] as const)
    .map((name) => `graph.${name} (${graph[name].length})`);
  return [
    `Composition full: ${counts.sources} sources, ${counts.reads} recorded reads (${coverage.reads.complete} complete, ${coverage.reads.partial} partial, ${coverage.reads.unknown} unknown), ${counts.unknownFindings} unknown findings, ${counts.unknownComponents} unknown components.`,
    ...(result.verification.status === "available" ? [] : [verificationLine(result)]),
    `Tables: ${tables.join(", ")}.`,
    `coverage.issues (${coverage.issues.length}), unknowns (${coverage.unknowns.length}), limits (${coverage.limits.length}); requests (${result.requests.length})${result.delivery === undefined ? "" : `; delivery (${result.delivery.length})`}.`,
  ].join("\n");
}

function changedOperationsText(operations: NonNullable<PartOf<"workspace-link">["operations"]>): string {
  const listed = operations.map((operation) => `${operation.change} ${operation.method} ${operation.path}${operation.parts === undefined ? "" : ` (${operation.parts.join(", ")})`}`);
  return `calls changed operations ${listed.join(", ")} (a call, not proof the changed data is read)`;
}

function verificationLine(result: CompositionResult): string {
  return result.verification.status === "available"
    ? "Verification: available at verification.identity in the result JSON; send every available requests[].query with it as expect to verify this set."
    : `Verification: unavailable (${result.verification.reason}); an expect cannot be checked.`;
}

const PART_ORDER: readonly PartKind[] = [
  "entrypoint", "unknown-finding", "entrypoint-change", "contract-change", "seed", "symbol-reach", "entrypoint-reach", "module-origin", "module-reach",
  "file-dependency", "call-site", "unresolved-call-site", "unlinked-call-site", "workspace-link", "outward-name", "name-candidate", "unheld-file",
  "outline-declaration", "outline-file", "file-query", "trace-root", "trace-step", "reading-range",
  "consequence-use", "consequence-producer", "derived-contract-change",
];
/** Kinds summary counts instead of listing: bulk observations already represented by subjects, relations or coverage. */
const SUMMARY_COUNTED: ReadonlySet<PartKind> = new Set(["outline-declaration", "outline-file", "file-query", "trace-step", "reading-range"]);
/** Families whose own summary lists cut places, so a composition summary lists them for their reads too. */
const SUMMARY_LOCATED_CUTS: ReadonlySet<string | undefined> = new Set(["importers"]);
/** Kinds a source line counts as its holdings; context, cost and bookkeeping parts are stated elsewhere. */
const HELD_KINDS: readonly PartKind[] = [...PART_ORDER, "decision"];
/** What a connection rule does not establish; a rule that only names its members has no warning. Stated once per rule. */
const RULE_WARNING: Partial<Record<Connection["rule"], string>> = {
  "change-dependent": "a recorded dependence on a diff seed; not a proof of breakage",
  "reached-handler": "seed associations stay those of the reach",
  "shared-file-import": "each category kept",
  "used-import": "a recorded use; not proof the dependence goes through this import at runtime",
  "shared-support": "the same evidence location; not causality",
};

/** What a relation kind does not establish; stated once, on the first relation of that kind. */
const RELATION_NOTE: Partial<Record<RelationRecord["value"]["kind"], string>> = {
  "symbol-dependence": "recorded dependence, no breakage claim",
  "file-import": "categories per attestation; not static/runtime evidence nor a symbol use",
  "file-use": "users category; not an import",
  "unresolved-file-name": "unresolved; not a dependency",
  "module-dependence": "not proof of execution",
  "entrypoint-origin": "association, not a call chain",
  "workspace-match": "admitted link; not a consequence",
  "candidate-for-name": "candidate only",
  "shares-evidence": "same location, not causality",
};

const span = (line: number, endLine: number | undefined) => `${line}${endLine === undefined ? "" : `-${endLine}`}`;
const quoted = (value: string) => JSON.stringify(value);
const unique = <T>(values: readonly T[]) => [...new Set(values)];

class CompactView {
  private readonly parts: Map<PartId, Part>;
  private readonly files;
  private readonly anchors;
  private readonly entities: Map<EntityId, EntityRecord>;
  private readonly evidence;
  private readonly reads: Map<ReadId, ReadRecord>;
  private readonly relationIndex: Map<RelationId, number>;
  private readonly sources: Map<SourceId, SourceDescriptor>;
  private readonly bindings;
  private readonly snapshotLabels: Map<SnapshotId, string>;
  /** Per repository, the one snapshot every source vector agrees on; locations there are printed unmarked. */
  private readonly primary = new Map<string, SnapshotId>();
  private readonly entityLabels = new Map<EntityId, string>();
  private readonly covered = new Set<PartId>();
  private readonly omitted = new Map<string, number>();
  /** Caveats already stated: each relation kind and connection rule explains itself once. */
  private readonly noted = new Set<string>();
  /** Subjects already named: each name is stated once, at the first reference. */
  private readonly named = new Set<EntityId>();
  /** Sources with a read that declares what it asks about: targets, files or a change selection. */
  private readonly asking: ReadonlySet<SourceId>;
  /** Summary beside an asking source: what only enumerating reads hold is context, counted unless a listed connection cites it. */
  private readonly countsContext: boolean;
  /** Connections the text lists, with their position in the connection table. */
  private readonly listedConnections: readonly { connection: Connection; index: number }[];
  private readonly joinedRelations: ReadonlySet<RelationId>;
  /** Sources in request order: `S1` first. */
  private readonly orderedSources: readonly SourceDescriptor[];
  private readonly unjoined = { sources: new Set<SourceId>(), connections: 0, relations: 0, observations: 0 };

  constructor(private readonly result: CompositionResult, private readonly details: boolean) {
    const graph = result.graph;
    this.parts = new Map(graph.parts.map((part) => [part.id, part]));
    this.files = new Map(graph.files.map((file) => [file.id, file]));
    this.anchors = new Map(graph.anchors.map((anchor) => [anchor.id, anchor]));
    this.entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
    this.evidence = new Map(graph.evidence.map((record) => [record.id, record]));
    this.reads = new Map(graph.reads.map((read) => [read.id, read]));
    this.relationIndex = new Map(graph.relations.map((relation, position) => [relation.id, position]));
    this.sources = new Map(graph.sources.map((source) => [source.id, source]));
    this.bindings = new Map(graph.bindings.map((binding) => [binding.anchor, binding.binding]));
    this.snapshotLabels = new Map(graph.snapshots.map((snapshot, index) => [snapshot.id, `V${index + 1}`]));
    for (const [repo, entries] of Map.groupBy(graph.sources.flatMap((source) => source.snapshotVector), (entry) => entry.repo)) {
      const snapshots = unique(entries.map((entry) => entry.snapshot));
      if (snapshots.length === 1 && snapshots[0] !== undefined) this.primary.set(repo, snapshots[0]);
    }
    this.orderedSources = graph.sources.toSorted((a, b) => a.requestIndex - b.requestIndex);
    this.asking = new Set(graph.reads.filter((read) => declaresSubject(read)).map((read) => read.source));
    this.countsContext = !details && this.asking.size > 0;
    this.listedConnections = graph.connections.flatMap((connection, index) => {
      if (this.isListed(connection.supports)) return [{ connection, index }];
      this.countUnjoined(connection.supports, "connections");
      return [];
    });
    this.joinedRelations = new Set(this.listedConnections.flatMap(({ connection }) => connection.relations));
  }

  render(): string[] {
    const { graph, counts } = this.result;
    this.claimSubjectParts();
    const connections = this.listedConnections.map(({ connection, index }) => this.connection(connection, index));
    const relations = this.relationLines();
    const findings = this.findingLines();
    const decisions = this.decisionLines();
    const coverage = this.coverageLines();
    const subjects = this.subjectLines();
    const navigation = this.navigationLines();
    return [
      this.details ? "Composition details:" : `Composition summary (S# = requests[#-1]): ${counts.sources} sources, ${counts.entities} subjects, ${counts.relations} relations, ${counts.connections} connections, ${counts.parts} observations.`,
      ...(this.details ? [] : [this.joinedLine()]),
      ...(this.result.verification.status === "available" ? [] : [verificationLine(this.result)]),
      ...this.identityLines(),
      ...(graph.sources.some(source => source.family === "trace") ? [`effects (${graph.parts.reduce((count, part) => count + (part.kind === "trace-step" ? part.effects?.length ?? 0 : 0), 0)})`] : []),
      ...connections,
      ...this.contextLines(),
      ...subjects,
      ...relations,
      ...section("Findings", findings),
      ...section("Decisions (recommendations are not user decisions, trust grants or approvals)", decisions),
      ...section("Coverage", coverage),
      ...navigation,
    ];
  }

  // ----- context -----

  private sourceLabel(id: SourceId): string {
    const source = this.sources.get(id);
    return source === undefined ? "S?" : `S${source.requestIndex + 1}`;
  }

  /** Listed connections per rule in table order and the sources in no connection at all, or that nothing was joined. */
  private joinedLine(): string {
    if (this.listedConnections.length === 0) {
      return `Joined: no connection${this.result.graph.connections.length === 0 ? "" : " with a read that declares a subject"}; each source answers alone below.`;
    }
    const rules = [...Map.groupBy(this.listedConnections, ({ connection }) => connection.rule)].map(([rule, members]) => `${rule} ${members.length}`);
    const alone = this.orderedSources.filter((source) => !this.result.graph.connections.some((connection) => connection.supports.some((support) => support.source === source.id)));
    return `Joined: ${rules.join(", ")}${alone.length === 0 ? "" : `; ${alone.map((source) => this.sourceLabel(source.id)).join(", ")} in no connection`}.`;
  }

  /** The snapshot and source legend every later line cites. */
  private identityLines(): string[] {
    const { graph } = this.result;
    const lines = graph.snapshots.map((snapshot) => {
      const value = snapshot.value;
      const text = value.kind === "sha" ? `${value.repo} @ ${value.sha}` : `${value.repo} live head ${value.head} state ${value.stateId}`;
      return `${this.snapshotLabels.get(snapshot.id)} = ${text}${snapshot.identity === "redacted" ? " (redacted identity: local, never joined)" : ""}`;
    });
    for (const source of this.orderedSources) lines.push(this.sourceLine(source));
    if (graph.snapshots.some((snapshot) => this.primary.get(snapshot.value.repo) !== snapshot.id)) {
      lines.push(`Unmarked locations: ${[...this.primary].toSorted(([a], [b]) => compareText(a, b)).map(([repo, snapshot]) => `${repo} ${this.snapshotLabels.get(snapshot)}`).join(", ") || "none"}; others are marked @V#.`);
    }
    return lines;
  }

  private contextLines(): string[] {
    const { graph } = this.result;
    const lines = this.readContextLines();
    for (const part of graph.parts) if (part.kind === "workspace-context") lines.push(`Workspace of ${this.supportLabels(part)}: ${this.workspaceContext(part)}`);
    lines.push(...this.deliveryLines());
    return lines;
  }

  /**
   * Trust and declared scope always; producer and schema only where reads differ, grouped by exact value.
   * Engines and index origin are provenance that full keeps per read; an incompatibility is listed as an issue.
   */
  private readContextLines(): string[] {
    const reads = this.result.graph.reads.toSorted((a, b) => compareText(this.readLabel(a.id), this.readLabel(b.id)));
    const shared: string[] = [];
    const varying: string[] = [];
    const field = <C>(name: string, valueOf: (read: ReadRecord) => C, text: (value: C) => string | undefined, always: boolean) => {
      const groups = shareExactContext(reads, valueOf);
      if (groups.contexts.length === 1) {
        const value = groups.contexts[0];
        const rendered = value === undefined || !always ? undefined : text(value);
        if (rendered !== undefined && rendered !== "") shared.push(rendered);
        return;
      }
      varying.push(`${name} by read: ${groups.contexts.map((value, index) => `${text(value) || "none"} (${this.readGroup(groups.rows.filter((row) => row.contextIndex === index).map((row) => row.value))})`).join("; ")}`);
    };
    field("trust", (read) => read.inputs.trust, (trust) => `trust ${trust}`, true);
    field("scope", (read) => read.inputs.declaredScope, (scope) => [
      scope.languages.length > 0 ? `languages ${scope.languages.join(", ")}` : undefined,
      scope.frameworks.length > 0 ? `frameworks ${scope.frameworks.join(", ")}` : undefined,
      scope.include.length > 0 ? `include ${scope.include.join(", ")}` : undefined,
      scope.exclude.length > 0 ? `exclude ${scope.exclude.join(", ")}` : undefined,
      scope.ignored === undefined ? undefined : `ignored ${scope.ignored}`,
    ].filter((part) => part !== undefined).join("; "), true);
    field("producer", (read) => read.producer, (producer) => `${producer.name} ${producer.version}`, false);
    field("schema", (read) => read.schema, (schema) => `${schema}`, false);
    return [...(shared.length === 0 ? [] : [`Context: ${shared.join("; ")}`]), ...varying.map((line) => `Context ${line}`)];
  }

  /** Read labels of one group; a source whose every read is in the group is named once as `all S#`. */
  private readGroup(members: readonly ReadRecord[]): string {
    const ids = new Set(members.map((read) => read.id));
    const labels: string[] = [];
    const done = new Set<SourceId>();
    for (const read of members) {
      if (done.has(read.source)) continue;
      const own = this.result.graph.reads.filter((candidate) => candidate.source === read.source);
      if (own.length > 1 && own.every((candidate) => ids.has(candidate.id))) {
        labels.push(`all ${this.sourceLabel(read.source)}`);
        done.add(read.source);
      } else labels.push(this.readLabel(read.id));
    }
    return labels.join(", ");
  }

  private sourceLine(source: SourceDescriptor): string {
    const label = this.sourceLabel(source.id);
    const family = "branch" in source ? `${source.family}/${source.branch}` : source.family;
    const request = this.result.requests[source.requestIndex];
    const repeat = request === undefined ? " request missing" : request.status === "available" ? "" : ` request unavailable (${request.reason})`;
    const status = source.analysis.status === "unknown" ? `unknown (${source.analysis.reason})` : source.analysis.status;
    const vector = source.snapshotVector.map((entry) => this.snapshotLabels.get(entry.snapshot) ?? entry.repo).join(", ");
    const root = this.reads.get(source.rootRead);
    const config = root?.inputs.declaredConfig;
    const contexts = this.result.graph.parts.filter((part): part is PartOf<"impact-context"> => part.kind === "impact-context" && this.reads.get(part.owner)?.source === source.id);
    for (const part of contexts) this.covered.add(part.id);
    const grouped = shareExactContext(contexts, (part) => ({ mergeBase: part.mergeBase, changedEntrypoints: part.changedEntrypoints, changedContracts: part.changedContracts }));
    const extra = [
      config?.changed === undefined ? undefined : `changed ${config.changed.join(", ")} (seed selection, not consequence coverage)`,
      config?.targets === undefined ? undefined : `targets ${config.targets.join(", ")}`,
      ...this.declaredFiles(source, config?.files),
      config?.walk === undefined ? undefined : `walk ${Object.entries(config.walk).map(([key, value]) => `${key} ${value}`).join(", ")}`,
      config?.exportBudget === undefined ? undefined : `export budget ${config.exportBudget.maxEntries} entries/${config.exportBudget.maxBytes} bytes`,
      ...grouped.contexts.map((context, index) => `${grouped.rows.filter((row) => row.contextIndex === index).map((row) => this.readLabel(row.value.owner)).join(", ")}: ${context.mergeBase === undefined ? "no merge base" : `merge base ${context.mergeBase}`}, entrypoint changes: ${context.changedEntrypoints.state === "absent" ? "not provided" : context.changedEntrypoints.count}${context.changedContracts.state === "absent" ? "" : `, contract changes: ${context.changedContracts.count}`}`),
      this.details ? undefined : this.holdings(source.id),
    ].filter((part) => part !== undefined);
    return `${label} = ${family}${repeat}: ${status}; ${vector}${extra.length === 0 ? "" : `; ${extra.join("; ")}`}`;
  }

  /** What the source holds, by observation kind, listed or counted. */
  private holdings(source: SourceId): string {
    const held = Map.groupBy(this.result.graph.parts.filter((part) => part.supports.some((support) => support.source === source)), (part) => part.kind);
    const kinds = HELD_KINDS.flatMap((kind) => { const count = held.get(kind)?.length ?? 0; return count === 0 ? [] : [`${count} ${kind}`]; });
    return `holds ${kinds.join(", ") || "no observation"}`;
  }

  /**
   * Declared files the source's own file parts (outline file, unheld file, asked file) do not already print by the exact
   * path; those parts state each path with its result, so the declaration would repeat it.
   */
  private declaredFiles(source: SourceDescriptor, files: readonly string[] | undefined): string[] {
    if (files === undefined) return [];
    const printed = new Set(this.result.graph.parts.flatMap((part) => {
      const file = part.kind === "outline-file" || part.kind === "unheld-file" || part.kind === "file-query" ? this.files.get(part.file) : undefined;
      return file !== undefined && part.supports.some((support) => support.source === source.id) ? [file.path] : [];
    }));
    const rest = files.filter((path) => !printed.has(path));
    return rest.length === 0 ? [] : [`files ${rest.join(", ")}`];
  }

  private workspaceContext(part: PartOf<"workspace-context">): string {
    this.covered.add(part.id);
    const context = part.context;
    const snapshots = (entries: readonly { repo: string; snapshot: SnapshotId }[]) => entries.map((entry) => `${entry.repo} ${this.snapshotLabels.get(entry.snapshot)}`).join(", ");
    if (context.family === "decisions") return `decisions source ${context.source}; repositories ${snapshots(context.repositories)}`;
    const workspace = context.workspace;
    const gateways = workspace.gateways.map((gateway) => `${gateway.prefix}→${gateway.repo}${"basis" in gateway ? ` (${gateway.basis})` : ""}`);
    return [
      `repos ${workspace.repos.join(", ")}`, `source ${workspace.source}`, `gateways ${gateways.join(", ") || "none"}`,
      ..."unmatchedGateways" in workspace ? [`unmatched gateways ${workspace.unmatchedGateways.map((gateway) => `${gateway.prefix}→${gateway.repo}`).join(", ") || "none"}`, `unserved ${workspace.unserved.join(", ") || "none"}`] : [],
      ..."trigger" in context ? [`trigger ${context.trigger.repo}${context.trigger.mergeBase === undefined ? "" : ` merge base ${context.trigger.mergeBase}`}`] : [],
      `snapshots ${snapshots(context.repositorySnapshots)}`,
    ].join("; ");
  }

  private deliveryLines(): string[] {
    const lines: string[] = [];
    const roots: { repo: string; path: string; source: string }[] = [];
    for (const delivery of this.result.delivery ?? []) {
      const label = this.sourceLabel(delivery.source);
      if (delivery.live !== undefined) lines.push(`Live notice ${label}: tree changed after state ${delivery.live.stateId}; changed ${delivery.live.changed.join(", ")}`);
      for (const notice of delivery.workspaceLive ?? []) {
        lines.push(notice.kind === "stale"
          ? `Live notice ${label} ${notice.repo}: changed after state ${notice.notice.stateId}; changed ${notice.notice.changed.join(", ")}`
          : `Live notice ${label} ${notice.repo}: staleness unavailable (${notice.cause.kind})`);
      }
      for (const remote of delivery.freshness ?? []) if (remote.freshness.status === "unverified") lines.push(`Remote ${label} ${remote.repo}: unverified (${remote.freshness.reason})`);
      for (const resolution of delivery.resolution ?? []) if (resolution.step === "revision-unavailable" || this.details) lines.push(`Resolution ${label} ${resolution.repo}: ${resolution.step}${resolution.sha === undefined ? "" : ` ${resolution.sha}`}`);
      for (const root of delivery.repositoryRoots ?? []) roots.push({ ...root, source: label });
    }
    if (this.details && roots.length > 0) {
      /** One root per repository when every source agrees; otherwise each path names the sources that reported it. */
      const text = [...Map.groupBy(roots, (root) => root.repo)].toSorted(([a], [b]) => compareText(a, b)).map(([repo, entries]) => {
        const paths = [...Map.groupBy(entries, (entry) => entry.path)];
        return paths.length === 1 ? `${repo}=${paths[0]![0]}` : paths.map(([path, of]) => `${repo}=${path} (${of.map((entry) => entry.source).join(", ")})`).join(", ");
      });
      lines.push(`Roots: ${text.join(", ")}`);
    }
    return lines;
  }

  // ----- references -----

  private readLabel(id: ReadId): string {
    const read = this.reads.get(id);
    return read === undefined ? "S?" : `${this.sourceLabel(read.source)}${ownerText(read.owner)}`;
  }

  private supportLabels(part: { supports: readonly { read: ReadId }[] }): string {
    return unique(part.supports.map((support) => this.readLabel(support.read))).join(", ");
  }

  private context(origin: EvidenceOrigin): string {
    if (origin.kind === "query-context") return ` (context of ${this.readLabel(origin.read)}, snapshot unproven)`;
    const snapshot = this.result.graph.snapshots.find((record) => record.id === origin.snapshot);
    return snapshot !== undefined && this.primary.get(snapshot.value.repo) === origin.snapshot ? "" : ` @${this.snapshotLabels.get(origin.snapshot)}`;
  }

  private file(id: FileId): string {
    const file = this.files.get(id);
    return file === undefined ? "?" : `${file.path}${this.context(file.origin)}`;
  }

  /**
   * A subject reference: its label, declared in the legend, and at its first reference its most qualified name, so the
   * first line citing it reads without the legend. The legend states every alias.
   */
  private entity(id: EntityId): string {
    const label = this.label(id);
    if (this.named.has(id)) return label;
    this.named.add(id);
    const entity = this.entities.get(id);
    const names = entity === undefined ? [] : entity.kind === "entrypoint"
      ? entity.parts.flatMap((part) => { const record = this.parts.get(part); return record?.kind === "entrypoint" ? [record.entry.name] : []; })
      : entity.anchors.flatMap((anchor) => { const record = this.anchors.get(anchor); return record === undefined ? [] : [record.symbol]; });
    const [name] = names.toSorted((a, b) => b.length - a.length || compareText(a, b));
    return name === undefined ? label : `${label} ${name}`;
  }

  private label(id: EntityId): string {
    let label = this.entityLabels.get(id);
    if (label === undefined) {
      label = `N${this.entityLabels.size + 1}`;
      this.entityLabels.set(id, label);
      const entity = this.entities.get(id);
      if (entity?.kind === "entrypoint") for (const part of entity.parts) this.covered.add(part);
      if (entity?.kind === "declaration") for (const part of entity.declarations) this.covered.add(part);
      if (entity?.kind === "entrypoint" && entity.identity.kind !== "ui-route") this.label(entity.identity.handler);
      if (entity?.kind === "entrypoint" && entity.identity.kind === "ui-route" && entity.identity.component !== "unknown") this.label(entity.identity.component);
    }
    return label;
  }

  /** An anchor as its entity when bound, otherwise its literal coordinate and why it stayed unbound. */
  private anchor(id: AnchorId): string {
    const binding = this.bindings.get(id);
    if (binding?.status === "resolved") return this.entity(binding.entity);
    const anchor = this.anchors.get(id);
    const text = anchor === undefined ? "?" : `${this.file(anchor.file)}:${span(anchor.line, anchor.endLine)} ${anchor.symbol}`;
    return binding === undefined ? text : `${text} (unbound: ${binding.reason})`;
  }

  /** Locations in details; a count in summary unless the evidence is the only coordinate of what it supports. */
  private evidenceList(ids: readonly EvidenceId[], located = this.details): string {
    if (ids.length === 0) return "no evidence";
    if (!located) return `evidence ${ids.length}`;
    return `evidence ${ids.map((id) => {
      const record = this.evidence.get(id);
      return record === undefined ? "?" : `${evidenceText(record.value)}${this.context(record.origin)}`;
    }).join(", ")}`;
  }

  private finding<T>(finding: EvidenceFinding<T>, text: (value: T) => string): string {
    return `${finding.status === "unknown" ? `unknown (${finding.reason})` : text(finding.value)} with ${this.evidenceList(finding.evidence)}`;
  }

  private comparison(comparison: ComparisonRef | undefined): string {
    if (comparison === undefined) return "";
    return comparison.status === "available"
      ? ` of diff ${comparison.value.repo} ${comparison.value.mergeBase}..${this.snapshotLabels.get(comparison.value.head)}`
      : ` (comparison unavailable: ${comparison.reason})`;
  }

  private origins(references: readonly OriginReference[]): string {
    return references.map((reference) => (reference.status === "present" ? `#${reference.index}` : `#${reference.index} missing`)).join(", ");
  }

  private entry(entry: EntryData): string {
    switch (entry.kind) {
      case "http-route":
        return `http ${entry.method} ${entry.path}${entry.version === undefined ? "" : ` version ${entry.version}`}, handler ${this.anchor(entry.handler)}; basePath ${this.finding(entry.basePath, (value) => basePathText(value))}`;
      case "ui-route":
        return `ui ${entry.path}${entry.outlet === undefined ? "" : ` outlet ${entry.outlet}`}, component ${entry.component === "unknown" ? "unknown" : this.anchor(entry.component)}; guards ${entry.guards.map((guard) => `${guard.name}${guard.path === undefined ? "" : ` (${guard.path})`}${guard.external === true ? " (external)" : ""}`).join(", ") || "none"}`;
      case "listener":
        return `listener ${entry.protocol} ${entry.destination}, handler ${this.anchor(entry.handler)}`;
      case "job":
        return `job ${entry.trigger.attribute}=${entry.trigger.value}, handler ${this.anchor(entry.handler)}`;
    }
  }

  /** A part as one line; `short` drops evidence and secondary fields for references inside other lines. */
  private describe(part: Part, short = false): string {
    switch (part.kind) {
      case "entrypoint": return short ? `entrypoint ${part.entry.name}` : `entrypoint ${entryName(part.entry)}${this.entry(part.entry)}; route ${this.routeEvidence(part)}`;
      case "unknown-finding": return `unknown ${this.ofConsequences(part) ? "consequence" : "entrypoint"} finding (${part.reason}), ${this.evidenceList(part.evidence, true)}`;
      case "seed": return `${part.basis === "requested" ? "requested target (not a change)" : `seed basis ${part.basis}`} ${this.anchor(part.anchor)}${short ? "" : this.comparison(part.comparison)}`;
      case "symbol-reach": return short ? `reached ${this.anchor(part.anchor)}` : `reached ${this.anchor(part.anchor)} ${part.kindName} depth ${part.depth} confidence ${part.confidence} fan-in ${part.fanIn}${part.via === undefined ? "" : `; via ${part.via.target.symbol} in ${this.file(part.via.target.file)} basis ${part.via.basis}${part.via.lines === undefined ? "" : ` lines ${part.via.lines.join(",")}`}`}`;
      case "entrypoint-reach": return short ? `reach of ${part.kindName} ${part.name ?? "(unnamed)"} handler ${this.anchor(part.handler)}` : `reached entrypoint ${part.kindName} ${part.name ?? "(unnamed)"} handler ${this.anchor(part.handler)} depth ${part.depth} confidence ${part.confidence}; seed indexes ${this.origins(part.seeds) || "none"}`;
      case "entrypoint-change": return `${part.change} ${part.kindName} ${part.name} handler ${this.anchor(part.handler)}${short ? "" : this.comparison(part.comparison)}`;
      case "contract-change": {
        const contract = part.contract;
        return `contract ${contract.change} ${contract.method} ${contract.path}${contract.operationId === undefined ? "" : ` operation ${contract.operationId}`} at ${contract.document}:${contract.line}${short ? "" : `${contract.parts === undefined ? "" : `; data changed: ${contract.parts.join(", ")}`}${contract.handlers === undefined ? "" : `; handlers ${contract.handlers.map((handler) => this.anchor(handler)).join(", ")}`}${this.comparison(part.comparison)}`}`;
      }
      case "module-origin": return `diff ${part.change} ${part.file}${short ? "" : this.comparison(part.comparison)}`;
      case "module-reach": return short ? `module ${this.file(part.file)} (${part.side})` : `module ${this.file(part.file)} (${part.side}) depth ${part.depth}; origin indexes ${this.origins(part.origins) || "none"}${part.via === undefined ? "" : `; via ${part.via.file}:${part.via.line} ${part.via.kind} ${quoted(part.via.specifier)}${part.via.typeOnly ? " type-only" : ""}${part.via.form === undefined ? "" : ` ${part.via.form}`}`}`;
      case "file-dependency": return `${this.file(part.from)} → ${this.file(part.to)} ${part.category}`;
      case "file-query": return `asked ${this.file(part.file)}: recorded entries ${part.categories.map(({ name, collection }) => `${name}: ${collection.state === "absent" ? "not provided" : collection.count}`).join(", ")}`;
      case "outline-declaration": return `outline declaration ${this.anchor(part.anchor)} ${part.kindName}${part.uses === undefined ? "" : `; uses ${part.uses.length === 0 ? (part.unproved ? "nothing proven outside its body (see its unresolved-link cuts)" : "nothing outside its body") : part.uses.map((use) => ("declaration" in use ? this.anchor(use.declaration.anchor) : "module" in use ? `${use.module} (package)` : `${use.global} (global)`)).join(", ")}`}`;
      case "outline-file": return `outline ${this.file(part.file)}: ${part.declarations.length === 0 ? "no declarations" : this.outlined(part.declarations).map((declaration) => this.describe(declaration, true)).join(", ")}; ${part.imports.length} imports`;
      case "unheld-file": return `unheld ${this.file(part.file)} (not read; not an empty file)`;
      case "trace-step": return short ? `trace step #${part.step} ${this.anchor(part.anchor)}` : [
        `trace step #${part.step} ${this.anchor(part.anchor)} ${part.kindName} depth ${part.depth}`,
        part.parent === undefined ? "" : ` under #${part.parent}`,
        part.at === undefined ? "" : ` at line ${part.at.line}${part.at.column === undefined ? "" : ` column ${part.at.column}`}`,
        part.via === undefined ? "" : ` via ${part.via}`,
        part.deferred ? " deferred" : "",
        part.seen === undefined ? "" : ` seen #${part.seen}`,
        part.leaves === undefined ? "" : `; leaves ${part.leaves.map((leaf) => `${this.anchor(leaf.anchor)}${leaf.deferred ? " (deferred)" : ""}`).join(", ")}`,
        part.external === undefined ? "" : `; external ${part.external.map((group) => `${group.kind === "import" ? group.module : group.kind}: ${group.names.join(", ")}`).join("; ")}`,
        part.alternatives === undefined ? "" : `; dispatch alternatives ${part.alternatives.map((alternative) => this.anchor(alternative)).join(", ")}`,
        part.effects === undefined ? "" : `; effects ${part.effects.map((effect) => `${effectText(effect)} at line ${effect.line}`).join("; ")}`,
      ].join("");
      case "trace-root": return `trace root ${quoted(part.target)} selects ${part.steps.map((step) => `#${step}`).join(", ") || "nothing"}`;
      case "reading-range": return `reading range ${this.file(part.file)}:${part.start}-${part.end} for ${part.steps.map((step) => `#${step}`).join(", ")}`;
      case "outward-name": return `${part.disposition} outward name ${part.kindName} ${quoted(part.name)}${this.context(part.origin)}${short ? "" : `, ${this.evidenceList(part.evidence)}`}`;
      case "name-candidate": return `candidate ${quoted(part.name)} served by ${part.repo} basis ${part.basis} (candidate only: no membership, trust or call)${short ? "" : `, ${this.evidenceList(part.evidence)}`}`;
      case "call-site": {
        const site = part.site;
        const target = this.finding(site.target, (value) => ("method" in value ? `${value.method} ${value.path}${value.base === undefined ? "" : ` base ${value.base}`}` : `${value.protocol} ${value.destination} ${value.role}`));
        return `${part.disposition} call site ${site.repo} ${this.file(site.location.file)}:${span(site.location.line, site.location.endLine)} ${site.symbol} ${site.transport}${short ? "" : `; target ${target}${site.stated === undefined ? "" : `; stated ${site.stated.method} ${site.stated.path}`}`}`;
      }
      case "unresolved-call-site": return `unresolved call site ${part.site.path}:${span(part.site.line, part.site.endLine)} ${part.site.symbol} ${part.site.transport}${part.site.via === undefined ? "" : ` via ${part.site.via}`}${part.site.stated === undefined ? "" : ` stated ${part.site.stated.method} ${part.site.stated.path}`}${this.details ? `; diagnostic ${JSON.stringify({ reason: part.site.reason, ...part.site.diagnostic, evidence: part.site.evidence })}` : ` ${unresolvedLabel(part.site)}`}`;
      case "workspace-link": {
        const link = part.link;
        const reach = part.reach?.map((reference) => (reference.status === "present" ? (reference.part === part.id ? "self" : "present") : `missing ${reference.linkId}`));
        return `link ${link.id}${part.direction === undefined ? "" : ` ${part.direction}`}: ${link.from.repo} ${this.file(link.from.file)}:${link.from.line} ${link.from.symbol} → ${link.to.repo} ${link.to.kind} ${link.to.name} handler ${this.anchor(link.to.handler)} basis ${link.basis} ${link.transport} confidence ${link.confidence}${link.profiles === undefined ? "" : ` profiles ${link.profiles.join(", ")}`}${short || reach === undefined ? "" : `; reach ${reach.join(", ") || "none"}`}${short ? "" : `${part.operations === undefined ? "" : `; ${changedOperationsText(part.operations)}`}`}`;
      }
      case "unlinked-call-site": return `${part.site.outcome} call site ${part.site.from.repo} ${this.file(part.site.from.file)}:${part.site.from.line} ${part.site.from.symbol} ${part.site.transport} ${quoted(part.site.name)}${part.site.repos === undefined ? "" : ` (${part.site.repos.join(", ")})`}`;
      case "workspace-context": return `workspace context ${this.workspaceContext(part)}`;
      case "decision": return `decision ${part.kindName} ${quoted(part.subject)}`;
      case "impact-context": return `impact context ${this.readLabel(part.owner)}`;
      case "walk-cost": return `${part.walk} walk used ${part.expansionsUsed} expansions (${this.readLabel(part.owner)})`;
      case "trace-totals": return `trace read ${part.expanded} bodies; reading plan ${part.lines} lines (${this.readLabel(part.owner)})`;
      case "consequence-use": return `consequence use ${this.hypothesis(part.hypothesis)}: ${part.verdict.kind === "review" ? `review (${part.verdict.reason})` : part.verdict.kind} in ${part.repo} at ${this.evidenceList([part.place], true)}; ${this.link(part.link)}${short ? "" : `; reads ${part.path}, changed ${part.changed}${this.hops(part.chain)}`}`;
      case "consequence-producer": return `consequence producer ${this.hypothesis(part.hypothesis)}: ${part.verdict.kind === "review" ? `review (${part.verdict.reason})` : part.verdict.kind} in ${part.repo} at ${this.evidenceList([part.place], true)}${part.verdict.kind === "incompatible" ? `, witness ${quoted(part.verdict.witness.value)} at ${this.evidenceList([part.verdict.witness.at], true)}` : ""}; ${this.link(part.link)}${short ? "" : `; property ${part.path}${this.hops(part.chain)}`}`;
      case "derived-contract-change": return `derived from the contract change ${part.operation} ${part.property}: ${this.hypothesis(part.hypothesis)}; contract ${this.evidenceList([part.places.base], true)} → ${this.evidenceList([part.places.head], true)}${part.handlers.length === 0 ? "" : `; handlers ${part.handlers.map((handler) => this.anchor(handler)).join(", ")}`}`;
    }
  }

  /** Whether every source that observed this part is a contract consequences read. */
  private ofConsequences(part: Part): boolean {
    return part.supports.length > 0 && part.supports.every((support) => this.sources.get(support.source)?.family === "contract_consequences");
  }

  private hypothesis(hypothesis: PartOf<"consequence-use">["hypothesis"]): string {
    return `${hypothesis.method} ${hypothesis.path} ${hypothesis.target} ${hypothesis.property}`;
  }

  private link(link: PartOf<"consequence-use">["link"]): string {
    return `call ${this.file(link.call.file)}:${link.call.line} ${link.call.symbol} → handler ${this.anchor(link.handler)} basis ${link.basis}`;
  }

  private hops(chain: PartOf<"consequence-use">["chain"]): string {
    return chain.length === 0 ? "" : `; chain ${chain.map((hop) => `${hop.step} ${this.evidenceList([hop.evidence], true).replace(/^evidence /, "")}`).join(" → ")}`;
  }

  private partRef(id: PartId): string {
    const part = this.parts.get(id);
    return part === undefined ? "?" : this.describe(part, true);
  }

  // ----- subjects, relations, connections -----

  /**
   * Entrypoint subjects, then declaration subjects grouped under their file. An outline file and its declarations are
   * that block (heading and rows), never a second listing. Summary lists an outline file's declarations, as the outline
   * summary does, and elsewhere keeps only the cited declarations and counts the rest.
   */
  private subjectLines(): string[] {
    const lines: string[] = [];
    for (let index = 0; index < this.entityLabels.size; index++) {
      const [id, label] = [...this.entityLabels.entries()][index]!;
      const entity = this.entities.get(id);
      if (entity?.kind === "entrypoint") lines.push(`${label} = ${this.entrypointText(entity)}`);
    }
    type Row = { entity: EntityId } | { unbound: PartOf<"outline-declaration"> };
    const blocks = new Map<FileId, { outlines: PartOf<"outline-file">[]; rows: Row[] }>();
    const placed = new Set<EntityId>();
    const block = (file: FileId) => blocks.get(file) ?? blocks.set(file, { outlines: [], rows: [] }).get(file)!;
    const place = (file: FileId, entity: EntityId) => {
      if (placed.has(entity)) return;
      placed.add(entity);
      block(file).rows.push({ entity });
    };
    for (const part of this.result.graph.parts) {
      if (part.kind !== "outline-file") continue;
      this.covered.add(part.id);
      block(part.file).outlines.push(part);
      for (const declaration of this.outlined(part.declarations)) {
        this.covered.add(declaration.id);
        const binding = this.bindings.get(declaration.anchor);
        const entity = binding?.status === "resolved" ? this.entities.get(binding.entity) : undefined;
        if (entity?.kind === "declaration") place(entity.file, entity.id);
        else block(part.file).rows.push({ unbound: declaration });
      }
    }
    for (const entity of this.result.graph.entities) if (entity.kind === "declaration") place(entity.file, entity.id);
    let unlisted = 0;
    for (const [file, { outlines, rows }] of blocks) {
      const shown = rows.filter((row) => this.details || outlines.length > 0 || ("entity" in row ? this.entityLabels.has(row.entity) : true));
      unlisted += rows.length - shown.length;
      if (shown.length === 0 && outlines.length === 0) continue;
      const heading = unique(outlines.map((part) => this.supportLabels(part)));
      const outline = outlines.length === 0 ? "" : ` [${outlines.map((part) => `outline ${this.supportLabels(part)}: ${this.outlined(part.declarations).length} declarations, ${part.imports.length} imports`).join("; ")}]`;
      lines.push(`${this.file(file)}${outline}`);
      for (const row of shown) lines.push(`  ${"entity" in row ? this.declarationRow(row.entity, heading) : `${this.anchor(row.unbound.anchor)} ${row.unbound.kindName}`}`);
    }
    if (unlisted > 0) this.omitted.set("uncited declarations", unlisted);
    return lines;
  }

  /**
   * Coverage is decided by type before any section renders: an outline file and every declaration it lists are its
   * subject block, so no later section lists them again whatever the render order.
   */
  private claimSubjectParts(): void {
    for (const part of this.result.graph.parts) {
      if (part.kind !== "outline-file") continue;
      this.covered.add(part.id);
      for (const declaration of this.outlined(part.declarations)) this.covered.add(declaration.id);
    }
  }

  /** The outline declarations of `ids` and every child under them, each parent before its children. */
  private outlined(ids: readonly PartId[]): PartOf<"outline-declaration">[] {
    return ids.flatMap((id) => {
      const declaration = this.parts.get(id);
      return declaration?.kind === "outline-declaration" ? [declaration, ...this.outlined(declaration.children ?? [])] : [];
    });
  }

  /** A declaration row: label when cited, every recorded span and alias, outline kinds, and supports unlike its file's. */
  private declarationRow(id: EntityId, heading: readonly string[]): string {
    const entity = this.entities.get(id);
    if (entity?.kind !== "declaration") return "?";
    const anchors = entity.anchors.map((anchor) => this.anchors.get(anchor)).filter((anchor) => anchor !== undefined);
    const spans = shareExactContext(anchors, (anchor) => span(anchor.line, anchor.endLine));
    const groups = spans.contexts.map((text, index) => `${text} ${unique(spans.rows.filter((row) => row.contextIndex === index).map((row) => row.value.symbol)).join(" | ")}`);
    const declarations = entity.declarations.map((part) => this.parts.get(part)).filter((part): part is PartOf<"outline-declaration"> => part?.kind === "outline-declaration");
    for (const part of declarations) this.covered.add(part.id);
    const kinds = unique(declarations.map((part) => part.kindName));
    const supports = unique(declarations.map((part) => this.supportLabels(part)));
    const own = supports.length === 0 || (supports.length === heading.length && supports.every((label) => heading.includes(label))) ? "" : ` [outline ${supports.join(", ")}]`;
    const label = this.entityLabels.get(id);
    return `${label === undefined ? "" : `${label} = `}${groups.join("; ")}${kinds.length === 0 ? "" : ` ${kinds.join(", ")}`}${own}`;
  }

  private entrypointText(entity: Extract<EntityRecord, { kind: "entrypoint" }>): string {
    const parts = entity.parts.map((id) => this.parts.get(id)).filter((part): part is PartOf<"entrypoint"> => part?.kind === "entrypoint");
    const context = this.context({ kind: "snapshot", snapshot: entity.snapshot });
    return `${parts.map((part) => `${entryName(part.entry)}${this.entry(part.entry)}; route ${this.routeEvidence(part)} [${this.supportLabels(part)}]`).join(" | ")}${context}`;
  }

  /** Route evidence, or `same` when it is exactly the evidence the basePath finding already printed. */
  private routeEvidence(part: PartOf<"entrypoint">): string {
    const entry = part.entry;
    const same = entry.kind === "http-route" && entry.basePath.evidence.length === part.evidence.length && entry.basePath.evidence.every((id, index) => part.evidence[index] === id);
    return same ? "evidence same" : this.evidenceList(part.evidence);
  }

  /** The entity a part is represented by, when its subject already states it: a bound declaration or an entrypoint. */
  private representedBy(id: PartId): EntityId | undefined {
    const part = this.parts.get(id);
    if (part?.kind === "outline-declaration") {
      const binding = this.bindings.get(part.anchor);
      return binding?.status === "resolved" ? binding.entity : undefined;
    }
    if (part?.kind === "entrypoint") return this.result.graph.entities.find((entity) => entity.kind === "entrypoint" && entity.parts.includes(id))?.id;
    return undefined;
  }

  /** States a caveat the first time its key appears in this text. */
  private note(key: string, text: string | undefined): string {
    if (text === undefined || this.noted.has(key)) return "";
    this.noted.add(key);
    return `; ${text}`;
  }

  private attestations(attestations: readonly Attestation[]): string {
    return attestations.map((attestation) => {
      const reads = unique(attestation.reads.map((read) => this.readLabel(read))).join(", ");
      const outline = attestation.parts.map((id) => this.parts.get(id)).filter((part) => part?.kind === "outline-declaration");
      const categories = attestation.parts.map((id) => this.parts.get(id)).flatMap((part) => (part?.kind === "file-dependency" ? [part.category] : []));
      const operations = attestation.parts.map((id) => this.parts.get(id)).flatMap((part) => (part?.kind === "workspace-link" ? part.operations ?? [] : []));
      for (const id of attestation.parts) this.covered.add(id);
      return [
        reads,
        categories.length === 0 ? undefined : `category ${unique(categories).join(", ")}`,
        attestation.locations === undefined ? undefined : `sites ${attestation.locations.map((location) => span(location.line, location.endLine)).join(",")}`,
        attestation.confidence === undefined ? undefined : `confidence ${attestation.confidence}`,
        operations.length === 0 ? undefined : changedOperationsText(operations),
        outline.length === 0 ? undefined : `endpoint located by outline declaration ${unique(outline.map((part) => this.supportLabels(part!))).join(", ")}`,
      ].filter((part) => part !== undefined).join(" ");
    }).join("; ");
  }

  private relationLines(): string[] {
    return this.result.graph.relations.flatMap((relation, index) => {
      const reads = relation.attestations.flatMap((attestation) => attestation.reads.flatMap((id) => this.reads.get(id) ?? []));
      if (this.joinedRelations.has(relation.id) || this.isListed(reads)) return [this.relationLine(relation, index)];
      this.countUnjoined(reads, "relations");
      return [];
    });
  }

  private relationLine(relation: RelationRecord, index: number): string {
    return `L${index + 1} = ${this.relationText(relation)} [${this.attestations(relation.attestations)}]${this.note(relation.value.kind, RELATION_NOTE[relation.value.kind])}`;
  }

  private relationText(relation: RelationRecord): string {
    const value = relation.value;
    switch (value.kind) {
      case "serves-entrypoint": return `${this.entity(value.entrypoint)} served by ${this.entity(value.handler)}`;
      case "symbol-dependence": return `${this.entity(value.from)} → ${this.entity(value.to)} symbol-dependence basis ${value.basis}`;
      case "file-import": return `${this.file(value.from)} → ${this.file(value.to)} file-import`;
      case "file-use": return `${this.file(value.from)} → ${this.file(value.to)} file-use`;
      case "unresolved-file-name": return `${this.file(value.from)} names ${this.file(value.to)} unresolved-file-name`;
      case "module-dependence": return `${this.file(value.from)} → ${this.file(value.to)} module-dependence ${value.qualifier.kind} ${quoted(value.qualifier.specifier)}${value.qualifier.typeOnly ? " type-only" : ""}${value.qualifier.form === undefined ? "" : ` ${value.qualifier.form}`}`;
      case "entrypoint-origin": return `${this.partRef(value.entrypoint)} entrypoint-origin ${this.partRef(value.seed)}`;
      case "module-origin": return `${this.partRef(value.module)} module-origin ${this.partRef(value.origin)}`;
      case "workspace-match": return `${value.from.repo} ${this.file(value.from.file)}:${span(value.from.line, value.from.endLine)} ${value.from.symbol} → ${value.to.repo} ${value.to.kind} ${value.to.name} handler ${this.entity(value.to.handler)} workspace-match basis ${value.basis} ${value.transport}${value.profiles === undefined ? "" : ` profiles ${value.profiles.join(", ")}`}`;
      case "candidate-for-name": return `${this.partRef(value.name)} candidate-for-name ${value.repo} basis ${value.basis}`;
      case "shares-evidence": {
        const record = this.evidence.get(value.evidence);
        return `${value.parts.map((part) => this.partRef(part)).join(", ")} shares-evidence ${record === undefined ? "?" : evidenceText(record.value)}`;
      }
    }
  }

  /** Relations by label, entities by label, and a part only when no cited relation or subject already states it. */
  private connection(connection: Connection, index: number): string {
    const relations = connection.relations.map((id) => `L${(this.relationIndex.get(id) ?? -1) + 1}`);
    const relationParts = new Set(connection.relations.flatMap((id) => this.result.graph.relations[this.relationIndex.get(id) ?? -1]?.attestations.flatMap((attestation) => attestation.parts) ?? []));
    const subjects = unique([...(connection.entities ?? []), ...connection.parts.flatMap((id) => { const entity = relationParts.has(id) ? undefined : this.representedBy(id); return entity === undefined ? [] : [entity]; })]).map((id) => this.entity(id));
    const parts = connection.parts.filter((id) => !relationParts.has(id) && this.representedBy(id) === undefined).map((id) => this.partRef(id));
    for (const id of connection.parts) this.covered.add(id);
    const sources = unique(connection.supports.map((support) => this.sourceLabel(support.source))).join(", ");
    return `C${index + 1} = ${connection.rule}: ${[...relations, ...subjects, ...parts].join(", ")} [${sources}]${this.note(connection.rule, RULE_WARNING[connection.rule])}`;
  }

  // ----- findings and decisions -----

  private findingLines(): string[] {
    const lines: string[] = [];
    for (const kind of PART_ORDER) {
      const parts = this.result.graph.parts.filter((part) => part.kind === kind && !this.covered.has(part.id));
      if (parts.length === 0) continue;
      if (!this.details && SUMMARY_COUNTED.has(kind)) {
        this.omitted.set(`${kind} observations`, parts.length);
        continue;
      }
      for (const part of parts) {
        if (lacksSubject(part) || this.isListed(part.supports)) lines.push(`  ${this.describe(part)} [${this.supportLabels(part)}]`);
        else this.countUnjoined(part.supports, "observations");
      }
    }
    const costs = this.result.graph.parts.filter((part): part is PartOf<"walk-cost"> => part.kind === "walk-cost");
    if (this.details) {
      const grouped = shareExactContext(costs, (part) => ({ walk: part.walk, used: part.expansionsUsed }));
      grouped.contexts.forEach((cost, index) => lines.push(`  ${cost.walk} walk used ${cost.used} expansions (${grouped.rows.filter((row) => row.contextIndex === index).map((row) => this.readLabel(row.value.owner)).join(", ")})`));
    } else if (costs.length > 0) this.omitted.set("walk costs", costs.length);
    return lines;
  }

  private decisionLines(): string[] {
    return this.result.graph.parts.filter((part): part is PartOf<"decision"> => part.kind === "decision").flatMap((part) => [
      `  ${part.kindName} ${quoted(part.subject)} (${part.decisionId})${part.required ? " required" : ""}${part.allowsFreeText ? ", free text allowed" : ""}${part.outwardKinds === undefined ? "" : `, outward kinds ${part.outwardKinds.join(", ")}`}; context ${this.readLabel(part.context)}; ${this.evidenceList(part.evidence)}`,
      ...part.options.map((option) => `    option ${quoted(option.value)}${option.basis === undefined ? "" : ` basis ${option.basis}`}${option.recommended ? " recommended" : ""}; ${this.evidenceList(option.evidence)}`),
    ]);
  }

  // ----- coverage and navigation -----

  /**
   * Read statuses, then each exact partial/unknown analysis once with every read it holds for, each exact read evidence
   * list once (details; summary keeps those of incomplete reads), then every issue.
   */
  private coverageLines(): string[] {
    const { coverage } = this.result;
    const lines = [coverage.reads.partial + coverage.reads.unknown === 0 ? `  reads: ${coverage.reads.complete}, all complete` : `  reads: ${coverage.reads.complete} complete, ${coverage.reads.partial} partial, ${coverage.reads.unknown} unknown (owners nest)`];
    const reads = this.result.graph.reads.toSorted((a, b) => compareText(this.readLabel(a.id), this.readLabel(b.id)));
    const incomplete = shareExactContext(reads.filter((read) => read.analysis.status !== "complete"), (read) => read.analysis);
    incomplete.contexts.forEach((analysis, index) => {
      const group = incomplete.rows.filter((row) => row.contextIndex === index).map((row) => row.value);
      const members = this.readGroup(group);
      const located = this.details || group.some((read) => SUMMARY_LOCATED_CUTS.has(this.sources.get(read.source)?.family));
      lines.push(analysis.status === "unknown" ? `  ${members}: unknown (${analysis.reason})` : `  ${members}: partial; ${analysis.status === "partial" ? this.cuts(analysis.cuts, located) : ""}`);
    });
    const evidence = shareExactContext(reads.filter((read) => read.evidence.length > 0 && (this.details || read.analysis.status !== "complete")), (read) => read.evidence);
    evidence.contexts.forEach((ids, index) => lines.push(`  read ${this.evidenceList(ids)}: ${this.readGroup(evidence.rows.filter((row) => row.contextIndex === index).map((row) => row.value))}`));
    for (const issue of coverage.issues) lines.push(`  ${this.issue(issue)} [${issue.sources.map((source) => this.sourceLabel(source)).join(", ")}]`);
    return lines;
  }

  private cuts(cuts: readonly Cut[], located = this.details): string {
    return [...Map.groupBy(cuts, (cut) => cut.kind)].map(([kind, ofKind]) => {
      const places = ofKind.flatMap((cut) => cut.at);
      const dependencies = ofKind.flatMap((cut) => cut.dependency === undefined ? [] : [dependencyDiagnosticText(cut.dependency)]);
      const limits = unique(ofKind.flatMap((cut) => (cut.limit === undefined ? [] : [cut.limit])));
      return `${kind} cut ×${ofKind.length}, ${places.length} places${limits.length === 0 ? "" : `, limit ${limits.join("/")}`}${located ? `: ${places.join(", ")}` : ""}${dependencies.length === 0 ? "" : `; ${dependencies.join("; ")}`}`;
    }).join("; ");
  }

  private issue(issue: CompositionIssue): string {
    switch (issue.kind) {
      case "snapshot-difference": return `snapshot-difference ${issue.repo}: ${issue.snapshots.map((id) => this.snapshotLabels.get(id)).join(", ")} (separate partitions; nothing joins across them)`;
      case "context-mismatch": return `context-mismatch ${issue.field} ${issue.reason} (no connection combines them)`;
      case "ambiguous-declaration": return `ambiguous-declaration ${this.anchor(issue.anchor)}: ${issue.candidates.length} candidates ${issue.candidates.map((id) => this.partRef(id)).join(", ")} (left unresolved)`;
      case "conflicting-coordinate": return `conflicting-coordinate ${issue.anchors.map((id) => this.anchor(id)).join(", ")} (left unresolved)`;
      case "unresolved-endpoint": return `unresolved-endpoint ${this.partRef(issue.part)} → ${issue.target.symbol} in ${this.file(issue.target.file)} (no edge fabricated)`;
      case "missing-provenance": return `missing-provenance ${issue.repo}${issue.side === undefined ? "" : ` ${issue.side}`}${issue.part === undefined ? "" : ` for ${this.partRef(issue.part)}`} (snapshot unproven; kept local)`;
      case "missing-origin-reference": return `missing-origin-reference ${this.partRef(issue.part)} ${issue.table} index ${issue.index}`;
      case "missing-link-reference": return `missing-link-reference ${this.partRef(issue.part)} reach position ${issue.position} ${issue.linkId}`;
      case "redacted-identity": return `redacted-identity ${ownerText(issue.owner).trim() || "fact"}${issue.pointer === undefined ? "" : ` at ${issue.pointer}`} (joins blocked)`;
    }
  }

  private navigationLines(): string[] {
    const { graph } = this.result;
    const lines: string[] = [];
    if (!this.details) {
      this.omitted.set("evidence coordinates", graph.evidence.length);
      const counted = [...this.omitted].filter(([, count]) => count > 0).map(([name, count]) => `${name}: ${count}`);
      if (counted.length > 0) lines.push(`Omitted from summary (recorded objects): ${counted.join("; ")}; details lists them.`);
      const { sources, ...unjoined } = this.unjoined;
      const tallied = Object.entries(unjoined).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
      if (tallied.length > 0) {
        const held = this.orderedSources.filter((source) => sources.has(source.id)).map((source) => this.sourceLabel(source.id));
        lines.push(`Enumeration context not joined (held only by ${held.join(", ")}; no target, file or change declared): ${tallied.join(", ")}; details lists them.`);
      }
    }
    return lines;
  }

  /** Whether a record is listed: always outside the context count, otherwise when a source that asks supports it. */
  private isListed(supports: readonly { source: SourceId }[]): boolean {
    return !this.countsContext || supports.some((support) => this.asking.has(support.source));
  }

  private countUnjoined(supports: readonly { source: SourceId }[], kind: "connections" | "relations" | "observations"): void {
    for (const support of supports) this.unjoined.sources.add(support.source);
    this.unjoined[kind] += 1;
  }
}

/** An observation no connection rule can join for lack of a subject: an unknown finding, a UI route with no known component. */
function lacksSubject(part: Part): boolean {
  return part.kind === "unknown-finding" || (part.kind === "entrypoint" && part.entry.kind === "ui-route" && part.entry.component === "unknown");
}

/** A read asks about a subject when it declares targets, files or a change selection; a read declaring none enumerates. */
function declaresSubject(read: ReadRecord): boolean {
  const config = read.inputs.declaredConfig;
  return config.targets !== undefined || config.files !== undefined || config.changed !== undefined;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:`, ...lines];
}

function ownerText(owner: ReadOwner | CutOwner): string {
  switch (owner.kind) {
    case "fact": return "";
    case "entrypoints": return "/entrypoints";
    case "section": return `/${owner.repo}`;
    case "read": return `/${owner.repo}#${owner.index}${"readKind" in owner ? ` ${owner.readKind}` : ""}`;
  }
}

/** `name: ` unless the name is exactly the method and path, path or destination the entry text already states. */
function entryName(entry: EntryData): string {
  const stated = entry.kind === "http-route" ? `${entry.method} ${entry.path}` : entry.kind === "ui-route" ? entry.path : entry.kind === "listener" ? entry.destination : undefined;
  return entry.name === stated ? "" : `${entry.name}: `;
}

function evidenceText(evidence: Evidence): string {
  return `${evidence.path}:${span(evidence.line, evidence.endLine)}${evidence.via === undefined ? "" : ` via ${evidence.via}`}${evidence.confidence === undefined ? "" : ` confidence ${evidence.confidence}`}`;
}

function basePathText(value: BasePath): string {
  const keys = (record: BasePathKeys) => Object.entries(record).filter(([, text]) => text !== undefined).map(([key, text]) => `${key}=${text}`).join(", ") || "none";
  return [`default ${keys(value.default)}`, ...Object.entries(value.profiles).toSorted(([a], [b]) => compareText(a, b)).map(([profile, record]) => `${profile} ${keys(record)}`)].join("; ");
}
