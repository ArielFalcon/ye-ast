import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { Evidence, Fact, FactProvenance } from "../core/domain/shared/fact.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportedFile } from "../core/domain/impact/importers-fact.ts";
import type { OutlineDeclaration } from "../core/domain/outline/outline-fact.ts";
import type { CallSite } from "../core/domain/topology/call-site.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type {
  AnchorId, EvidenceFinding, EvidenceId, EvidenceSet, FileCategory, FileId, Part, PartId, PartKind, PartOf, ReadRecord,
  SnapshotId, SourceId,
} from "./composition-contract.ts";
import { isCompositionId, jsonPointer } from "./composition-identity.ts";
import {
  MERGE_BASE, SHA_A, SHA_B, entrypointsValue, factOf, impactValue, inputsOf, shaRef, sourceFixture, unknownFactOf, workspaceImpactValue,
  type FixtureKind,
} from "./composition-fixtures.ts";
import { normalizeSource } from "./composition-normalize.ts";
import type { ExecutedSource } from "./query-runner.ts";

const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const KINDS: readonly FixtureKind[] = ["entrypoints", "impact-local", "impact-workspace", "callers-local", "callers-workspace", "importers", "outline", "workspace", "decisions"];
const fixture = (kind: FixtureKind): ExecutedSource => sourceFixture(kind as "entrypoints");

// An independent index over the tables: it resolves references and finds parts by the public position they support.

class Tables {
  readonly source: SourceId;
  constructor(readonly set: EvidenceSet) {
    assert.equal(set.sources.length, 1);
    this.source = set.sources[0]!.id;
  }
  snapshot(id: SnapshotId) { return found(this.set.snapshots.find((s) => s.id === id), id).value; }
  file(id: FileId) { return found(this.set.files.find((f) => f.id === id), id); }
  path(id: FileId) { return this.file(id).path; }
  anchor(id: AnchorId) { return found(this.set.anchors.find((a) => a.id === id), id); }
  handler(id: AnchorId): Handler {
    const anchor = this.anchor(id);
    return { path: this.path(anchor.file), symbol: anchor.symbol, line: anchor.line, ...(anchor.endLine === undefined ? {} : { endLine: anchor.endLine }) };
  }
  evidenceRecord(id: EvidenceId) { return found(this.set.evidence.find((e) => e.id === id), id); }
  evidence(ids: readonly EvidenceId[]): Evidence[] { return ids.map((id) => this.evidenceRecord(id).value); }
  repoEvidence(ids: readonly EvidenceId[]): RepositoryEvidence[] { return ids.map((id) => ({ ...this.evidenceRecord(id).value, repo: this.evidenceRecord(id).repo })); }
  part(id: PartId) { return found(this.set.parts.find((p) => p.id === id), id); }
  partOf<K extends PartKind>(id: PartId, kind: K): PartOf<K> {
    const part = this.part(id);
    assert.equal(part.kind, kind);
    return part as PartOf<K>;
  }
  /** The parts that support exactly this public position. */
  at(pointer: string): Part[] {
    return this.set.parts.filter((p) => p.supports.some((s) => s.source === this.source && s.pointer === pointer));
  }
  one<K extends PartKind>(pointer: string, kind: K): PartOf<K> | undefined {
    const parts = this.at(pointer).filter((p) => p.kind === kind);
    assert.ok(parts.length <= 1, `one ${kind} at ${pointer}`);
    return parts[0] as PartOf<K> | undefined;
  }
  /** Consecutive array positions `prefix/0..n-1`, each held by exactly one part of the given kinds. */
  list<K extends PartKind>(prefix: string, ...kinds: K[]): PartOf<K>[] {
    const out: PartOf<K>[] = [];
    for (let i = 0; ; i++) {
      const parts = this.at(`${prefix}/${i}`).filter((p): p is PartOf<K> => (kinds as string[]).includes(p.kind));
      if (parts.length === 0) return out;
      assert.equal(parts.length, 1, `${prefix}/${i}`);
      out.push(parts[0]!);
    }
  }
  read(owner: ReadRecord["owner"]): ReadRecord | undefined {
    const key = canonicalJson(owner);
    return this.set.reads.find((r) => canonicalJson(r.owner) === key);
  }
  provenance(read: ReadRecord): FactProvenance {
    const base = { schema: read.schema, snapshot: this.snapshot(read.snapshot), producer: read.producer, inputs: read.inputs, evidence: this.evidence(read.evidence) };
    if (read.analysis.status === "unknown") return { ...base, status: "unknown", reason: read.analysis.reason };
    if (read.analysis.status === "partial") return { ...base, status: "partial", cuts: read.analysis.cuts };
    return { ...base, status: "complete" };
  }
  fact<T>(read: ReadRecord, value: () => T): Fact<T> {
    const provenance = this.provenance(read);
    return provenance.status === "unknown" ? provenance : { ...provenance, value: value() };
  }
  finding<T>(f: EvidenceFinding<T>, evidence: (ids: readonly EvidenceId[]) => Evidence[] = (ids) => this.evidence(ids)) {
    return f.status === "complete" ? { status: f.status, value: f.value, evidence: evidence(f.evidence) } : { status: f.status, reason: f.reason, evidence: evidence(f.evidence) };
  }
}

function found<T>(value: T | undefined, id: string): T {
  assert.ok(value !== undefined, `unresolved reference ${id}`);
  return value;
}

// Reconstruction: the public fact rebuilt from the tables alone, by public position.

function rebuildEntry(t: Tables, part: PartOf<"entrypoint">): Entrypoint {
  const entry = part.entry;
  switch (entry.kind) {
    case "http-route": return { ...entry, handler: t.handler(entry.handler), basePath: t.finding(entry.basePath) };
    case "ui-route": return { ...entry, component: entry.component === "unknown" ? "unknown" : t.handler(entry.component) };
    case "listener": return { ...entry, handler: t.handler(entry.handler) };
    case "job": return { ...entry, handler: t.handler(entry.handler) };
  }
}

function rebuildImpact(t: Tables, prefix: string): ImpactValue {
  const seeds = t.list(`${prefix}/seeds`, "seed");
  const changes = t.list(`${prefix}/changedEntrypoints`, "entrypoint-change");
  const contracts = t.list(`${prefix}/changedContracts`, "contract-change");
  const symbols = t.list(`${prefix}/symbols`, "symbol-reach");
  const reached = t.list(`${prefix}/entrypoints`, "entrypoint-reach");
  const cost = found(t.one(`${prefix}/cost`, "walk-cost"), `${prefix}/cost`);
  const modulesCost = t.one(`${prefix}/modules/cost`, "walk-cost");
  const context = found(t.one(prefix, "impact-context"), prefix);
  const indexOf = (ref: { status: string; index: number }) => ref.index;
  return {
    ...(context.mergeBase === undefined ? {} : { mergeBase: context.mergeBase }),
    seeds: seeds.map((s) => { const { path: file, ...rest } = t.handler(s.anchor); return { file, ...rest, basis: s.basis }; }),
    ...(context.changedEntrypoints.state === "absent" ? {} : { changedEntrypoints: changes.map((c) => ({ change: c.change, kind: c.kindName, name: c.name, handler: t.handler(c.handler) })) }),
    ...(context.changedContracts.state === "absent" ? {} : { changedContracts: contracts.map(({ contract: { handlers, ...operation } }) => ({ ...operation, ...(handlers === undefined ? {} : { handlers: handlers.map((anchor) => t.handler(anchor)) }) })) }),
    symbols: symbols.map((s) => {
      const { path: file, ...at } = t.handler(s.anchor);
      return { file, ...at, kind: s.kindName, depth: s.depth, confidence: s.confidence, fanIn: s.fanIn, ...(s.via === undefined ? {} : { via: { file: t.path(s.via.target.file), symbol: s.via.target.symbol, ...(s.via.lines === undefined ? {} : { lines: s.via.lines }), basis: s.via.basis } }) };
    }),
    entrypoints: reached.map((r) => ({ kind: r.kindName, ...(r.name === undefined ? {} : { name: r.name }), handler: t.handler(r.handler), depth: r.depth, confidence: r.confidence, seeds: r.seeds.map(indexOf) })),
    ...(modulesCost === undefined ? {} : {
      modules: {
        origins: t.list(`${prefix}/modules/origins`, "module-origin").map((o) => ({ file: o.file, change: o.change })),
        modules: t.list(`${prefix}/modules/modules`, "module-reach").map((m) => ({ file: t.path(m.file), snapshot: m.side, depth: m.depth, origins: m.origins.map(indexOf), ...(m.via === undefined ? {} : { via: m.via }) })),
        cost: { expansionsUsed: modulesCost.expansionsUsed },
      },
    }),
    cost: { expansionsUsed: cost.expansionsUsed },
  };
}

function rebuildSite(t: Tables, part: PartOf<"call-site">): CallSite {
  const { location, target, ...rest } = part.site;
  return { ...rest, file: t.path(location.file), line: location.line, ...(location.endLine === undefined ? {} : { endLine: location.endLine }), target: t.finding(target) };
}

function rebuildWorkspaceImpact(t: Tables): WorkspaceImpactValue {
  const context = found(t.one("/value/workspace", "workspace-context"), "context").context;
  assert.ok(context.family === "impact" || context.family === "callers");
  const sections: Record<string, Fact<RepoImpact>> = {};
  for (const read of t.set.reads) {
    if (read.owner.kind !== "section") continue;
    const repo = read.owner.repo;
    const prefix = jsonPointer(["value", "sections", repo, "value"]);
    sections[repo] = t.fact(read, () => {
      const reads = t.set.reads
        .flatMap((r) => (r.owner.kind === "read" && r.owner.repo === repo ? [{ index: r.owner.index, kind: r.owner.readKind, fact: t.provenance(r) }] : []))
        .sort((x, y) => x.index - y.index)
        .map(({ kind, fact }) => ({ kind, fact }));
      const sites = (field: string) => t.list(`${prefix}/${field}`, "call-site").map((p) => rebuildSite(t, p));
      return { reads, ...(t.one(`${prefix}/impact/cost`, "walk-cost") === undefined ? {} : { impact: rebuildImpact(t, `${prefix}/impact`) }), callSites: sites("callSites"), unmatched: sites("unmatched"), external: sites("external"), unresolved: t.list(`${prefix}/unresolved`, "unresolved-call-site").map((p) => p.site) };
    });
  }
  const links = t.list("/value/links", "workspace-link").map((p) => {
    assert.ok(p.direction !== undefined && p.reach !== undefined);
    return {
      link: rebuildLink(t, p.link),
      direction: p.direction,
      reach: p.reach.map((r) => (r.status === "missing" ? r.linkId : t.partOf(r.part, "workspace-link").link.id)),
      ...(p.operations === undefined ? {} : { operations: p.operations }),
    };
  });
  return { workspace: context.workspace, trigger: context.trigger, repositorySnapshots: context.repositorySnapshots.map((e) => ({ repo: e.repo, snapshot: t.snapshot(e.snapshot) })), sections, links };
}

function rebuildLink(t: Tables, { from, to, ...link }: PartOf<"workspace-link">["link"]) {
  return { ...link, from: { repo: from.repo, file: t.path(from.file), line: from.line, symbol: from.symbol }, to: { repo: to.repo, kind: to.kind, name: to.name, handler: t.handler(to.handler) } };
}

const CATEGORIES: readonly FileCategory[] = ["importers", "reexporters", "dynamicImporters", "typeImporters", "users", "unresolvedNamers"];

function rebuildDeclaration(t: Tables, id: PartId): OutlineDeclaration {
  const d = t.partOf(id, "outline-declaration");
  const a = t.anchor(d.anchor);
  return { kind: d.kindName, name: a.symbol, line: a.line, endLine: found(a.endLine, "endLine"), ...(d.children !== undefined && { children: d.children.map((child) => rebuildDeclaration(t, child)) }) };
}

/** Rebuilds the public fact of a fixture source from its evidence set; absent and empty are told apart only by tables. */
function reconstruct(source: ExecutedSource, t: Tables): Fact<unknown> {
  const root = found(t.read({ kind: "fact" }), "root read");
  return t.fact<unknown>(root, () => {
    switch (source.family) {
      case "entrypoints": {
        const section = found(t.read({ kind: "entrypoints" }), "entrypoints read");
        return { entrypoints: t.fact(section, () => t.list("/value/entrypoints/value", "entrypoint", "unknown-finding").map((p) => p.kind === "entrypoint" ? { status: "complete", value: rebuildEntry(t, p), evidence: t.evidence(p.evidence) } : { status: "unknown", reason: p.reason, evidence: t.evidence(p.evidence) })) };
      }
      case "impact":
      case "callers":
        return source.branch === "local" ? rebuildImpact(t, "/value") : rebuildWorkspaceImpact(t);
      case "importers":
        return {
          files: t.list("/value/files", "file-query").map((q, i): ImportedFile => {
            const file: Record<string, unknown> = { file: t.path(q.file) };
            for (const { name, collection } of q.categories) if (collection.state === "present") file[name] = t.list(`/value/files/${i}/${name}`, "file-dependency").map((d) => t.path(d.from));
            return file as unknown as ImportedFile;
          }),
        };
      case "outline":
        return {
          files: t.list("/value/files", "outline-file").map((f) => ({
            file: t.path(f.file),
            declarations: f.declarations.map((id) => rebuildDeclaration(t, id)),
            imports: f.imports.map(({ target, bindings, ...item }) => ({
              ...item,
              target: target.kind === "repository" ? { kind: "repository", file: t.path(t.partOf(target.dependency, "file-dependency").to) } : target,
              bindings: bindings.map(({ declaration, ...binding }) => {
                if (declaration === undefined) return binding;
                const a = t.anchor(declaration.anchor);
                return { ...binding, declaration: { file: t.path(a.file), name: a.symbol, kind: declaration.kindName, line: a.line, endLine: found(a.endLine, "endLine") } };
              }),
            })),
          })),
          unheld: t.list("/value/unheld", "unheld-file").map((u) => t.path(u.file)),
        };
      case "workspace": {
        const context = found(t.one("/value/workspace", "workspace-context"), "context").context;
        assert.equal(context.family, "workspace");
        if (context.family !== "workspace") throw new Error("unreachable");
        const sections: Record<string, unknown> = {};
        for (const read of t.set.reads) {
          if (read.owner.kind !== "section") continue;
          const prefix = jsonPointer(["value", "sections", read.owner.repo, "value"]);
          sections[read.owner.repo] = t.fact(read, () => ({
            names: t.list(`${prefix}/names`, "outward-name").map((n) => ({ name: n.name, kind: n.kindName, evidence: t.evidence(n.evidence) })),
            unresolved: t.list(`${prefix}/unresolved`, "unresolved-call-site").map((u) => u.site),
          }));
        }
        return {
          workspace: context.workspace,
          repositorySnapshots: context.repositorySnapshots.map((e) => ({ repo: e.repo, snapshot: t.snapshot(e.snapshot) })),
          sections,
          candidates: t.list("/value/candidates", "name-candidate").map((c) => ({ name: c.name, repo: c.repo, basis: c.basis, evidence: t.repoEvidence(c.evidence) })),
          unserved: t.list("/value/unserved", "outward-name").map((n) => ({ name: n.name, kind: n.kindName, evidence: t.repoEvidence(n.evidence) })),
          links: t.list("/value/links", "workspace-link").map((p) => rebuildLink(t, p.link)),
          unlinked: t.list("/value/unlinked", "unlinked-call-site").map(({ site: { from, ...site } }) => ({ from: { repo: from.repo, file: t.path(from.file), line: from.line, symbol: from.symbol }, ...site })),
        };
      }
      case "decisions": {
        const context = found(t.one("/value/source", "workspace-context"), "context").context;
        assert.equal(context.family, "decisions");
        if (context.family !== "decisions") throw new Error("unreachable");
        return {
          decisions: t.list("/value/decisions", "decision").map((d) => ({
            id: d.decisionId, kind: d.kindName, subject: d.subject, evidence: t.repoEvidence(d.evidence),
            ...(d.outwardKinds === undefined ? {} : { outwardKinds: d.outwardKinds }),
            options: d.options.map((o) => ({ ...o, evidence: t.repoEvidence(o.evidence) })),
            allowsFreeText: d.allowsFreeText, required: d.required,
          })),
          repositories: context.repositories.map((e) => ({ repo: e.repo, snapshot: t.snapshot(e.snapshot) })),
          source: context.source,
        };
      }
    }
  });
}

/** Resolves an RFC 6901 pointer in a value, or reports that it does not exist. */
function resolve(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value };
  let current: unknown = value;
  for (const token of pointer.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) return { found: false };
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

test("normalizes every public family without presentation parsing", () => {
  for (const kind of KINDS) {
    const source = fixture(kind);
    const set = normalizeSource(source, digest);
    const t = new Tables(set);
    const fact = source.read.fact;
    assert.ok(isCompositionId("source", t.source), kind);
    assert.equal(set.sources[0]!.family, source.family);
    assert.deepEqual("branch" in set.sources[0]! ? set.sources[0].branch : undefined, "branch" in source ? source.branch : undefined, kind);
    assert.equal(set.sources[0]!.rootRead, found(t.read({ kind: "fact" }), kind).id);
    const ids = [...set.snapshots, ...set.reads, ...set.files, ...set.anchors, ...set.evidence, ...set.parts].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `${kind}: ids are unique`);
    for (const table of [set.snapshots, set.reads, set.files, set.anchors, set.evidence, set.parts]) {
      assert.deepEqual(table.map((r) => r.id), [...table.map((r) => r.id)].sort(), `${kind}: ordered by id`);
    }
    const reads = new Set(set.reads.map((r) => r.id));
    for (const record of [...set.files, ...set.anchors, ...set.evidence, ...set.parts]) {
      assert.ok(record.supports.length > 0, `${kind}: ${record.id} has a support`);
      for (const support of record.supports) {
        assert.equal(support.source, t.source);
        assert.ok(reads.has(support.read), `${kind}: support read`);
        assert.ok(resolve(fact, support.pointer).found, `${kind}: ${support.pointer} resolves in the public fact`);
      }
    }
    // Every reference a part, anchor or file holds resolves inside the set.
    const all = new Set(ids);
    const references = canonicalJson([set.parts, set.anchors, set.files, set.evidence]).match(/"(?:v1|f1|a1|e1|p1|r1):[0-9a-f]{64}"/g) ?? [];
    for (const reference of references) assert.ok(all.has(JSON.parse(reference)), `${kind}: ${reference} resolves`);
    // The reconstructed public fact equals the original one, field by field, except the reported contract gap.
    assert.deepEqual(reconstruct(source, t), fact, `${kind}: reconstruction`);
  }
});

test("an unknown root keeps its reason and evidence and yields no part", () => {
  const source = sourceFixture("impact-local", { fact: unknownFactOf<ImpactValue>("revision-unavailable", { evidence: [{ path: "x", line: 1 }] }) });
  const set = normalizeSource(source, digest);
  assert.equal(set.parts.length, 0);
  assert.deepEqual(set.reads.map((r) => r.analysis), [{ status: "unknown", reason: "revision-unavailable" }]);
  assert.deepEqual(set.sources[0]!.analysis, { status: "unknown", reason: "revision-unavailable" });
  assert.equal(set.evidence.length, 1);
  assert.deepEqual(reconstruct(source, new Tables(set)), source.read.fact);
});

test("entrypoints keep unknown basePath, unknown component, guards and outlet, and both aliases of one handler", () => {
  const t = new Tables(normalizeSource(sourceFixture("entrypoints"), digest));
  const [get, post, ui] = t.list("/value/entrypoints/value", "entrypoint", "unknown-finding");
  assert.ok(get?.kind === "entrypoint" && get.entry.kind === "http-route");
  assert.equal(get.entry.basePath.status, "unknown");
  assert.deepEqual(t.evidence(get.entry.basePath.evidence), [{ path: "src/main/resources/application.yml", line: 3 }]);
  assert.ok(post?.kind === "entrypoint" && post.entry.kind === "http-route");
  assert.equal(post.entry.handler, get.entry.handler, "two routes served by one handler share its anchor");
  assert.notEqual(post.id, get.id);
  assert.ok(ui?.kind === "entrypoint" && ui.entry.kind === "ui-route");
  assert.equal(ui.entry.component, "unknown");
  assert.equal(ui.entry.outlet, "aux");
  assert.equal(ui.entry.guards.length, 3);
  const unknown = t.list("/value/entrypoints/value", "entrypoint", "unknown-finding")[6];
  assert.ok(unknown?.kind === "unknown-finding");
  assert.equal(unknown.evidence.length, 2, "duplicated evidence keeps its multiplicity");
  assert.equal(unknown.evidence[0], unknown.evidence[1]);
  assert.equal(found(t.read({ kind: "entrypoints" }), "section").analysis.status, "partial");
});

test("impact remaps seed and module-origin indices into their own tables and keeps missing ones", () => {
  const set = normalizeSource(sourceFixture("impact-local"), digest);
  const t = new Tables(set);
  const seeds = t.list("/value/seeds", "seed").map((p) => p.id);
  const origins = t.list("/value/modules/origins", "module-origin").map((p) => p.id);
  const [route, unknown] = t.list("/value/entrypoints", "entrypoint-reach");
  assert.deepEqual(route?.seeds, [{ status: "present", index: 1, part: seeds[1] }, { status: "present", index: 0, part: seeds[0] }, { status: "present", index: 1, part: seeds[1] }]);
  assert.deepEqual(unknown?.seeds, [{ status: "missing", index: 7 }]);
  assert.equal(unknown?.kindName, "unknown");
  assert.equal(unknown?.name, undefined);
  const [head, base, lazy] = t.list("/value/modules/modules", "module-reach");
  assert.deepEqual(head?.origins, [{ status: "present", index: 2, part: origins[2] }, { status: "present", index: 1, part: origins[1] }]);
  assert.deepEqual(base?.origins, [{ status: "present", index: 0, part: origins[0] }]);
  assert.deepEqual(lazy?.origins, [{ status: "missing", index: 9 }]);
  for (const ref of [...(head?.origins ?? []), ...(base?.origins ?? [])]) assert.ok(ref.status === "present" && !seeds.includes(ref.part), "module origins never point at seeds");
  // Base resolves to the merge base of the owner, head to its snapshot.
  const origin = (file: FileId) => t.file(file).origin;
  const snapshotOf = (file: FileId) => { const o = origin(file); assert.equal(o.kind, "snapshot"); return o.kind === "snapshot" ? t.snapshot(o.snapshot) : undefined; };
  assert.deepEqual(snapshotOf(base!.file), shaRef("shop", MERGE_BASE));
  assert.deepEqual(snapshotOf(head!.file), shaRef("shop", SHA_A));
  const [removed, added] = t.list("/value/changedEntrypoints", "entrypoint-change");
  assert.deepEqual(snapshotOf(t.anchor(removed!.handler).file), shaRef("shop", MERGE_BASE), "a removed handler lives in the merge base");
  assert.deepEqual(snapshotOf(t.anchor(added!.handler).file), shaRef("shop", SHA_A));
  const deleted = t.partOf(origins[0]!, "module-origin");
  assert.deepEqual({ file: deleted.file, change: deleted.change }, { file: "src/gone.ts", change: "deleted" }, "a deleted origin names a path, not a head file");
  assert.equal(set.files.some((f) => f.path === "src/gone.ts" && f.origin.kind === "snapshot" && t.snapshot(f.origin.snapshot).kind === "sha" && canonicalJson(t.snapshot(f.origin.snapshot)) === canonicalJson(shaRef("shop", SHA_A))), false);
  // Comparisons and walk costs.
  assert.deepEqual(t.list("/value/seeds", "seed")[0]?.comparison, { status: "available", value: { repo: "shop", mergeBase: MERGE_BASE, head: set.reads[0]!.snapshot } });
  assert.deepEqual(t.one("/value/cost", "walk-cost")?.walk, "symbols");
  assert.deepEqual(t.one("/value/modules/cost", "walk-cost")?.walk, "modules");
  const report = t.list("/value/symbols", "symbol-reach")[1];
  assert.deepEqual(report?.via && { symbol: report.via.target.symbol, basis: report.via.basis, lines: report.via.lines }, { symbol: "fmt", basis: "reference", lines: undefined });
});

test("an impact without a recorded merge base never fabricates a comparison or a base location", () => {
  const value = impactValue();
  delete value.mergeBase;
  const t = new Tables(normalizeSource(sourceFixture("impact-local", { value }), digest));
  const read = found(t.read({ kind: "fact" }), "root").id;
  for (const seed of t.list("/value/seeds", "seed")) assert.deepEqual(seed.comparison, { status: "unavailable", reason: "missing-provenance", read });
  const base = t.list("/value/modules/modules", "module-reach")[1]!;
  assert.deepEqual(t.file(base.file).origin, { kind: "query-context", read });
  const removed = t.list("/value/changedEntrypoints", "entrypoint-change")[0]!;
  assert.deepEqual(t.file(t.anchor(removed.handler).file).origin, { kind: "query-context", read });
  assert.equal(t.set.snapshots.length, 1, "only the head snapshot");
  // Callers record no comparison at all.
  const callers = new Tables(normalizeSource(sourceFixture("callers-local"), digest));
  for (const seed of callers.list("/value/seeds", "seed")) assert.equal(seed.comparison, undefined);
});

test("importers tell absent optional categories from empty ones and keep overlapping categories apart", () => {
  const t = new Tables(normalizeSource(sourceFixture("importers"), digest));
  const [service, empty] = t.list("/value/files", "file-query");
  assert.deepEqual(service?.categories.filter(c => c.collection.state === "present").map(c => c.name), ["importers", "reexporters", "typeImporters", "users", "unresolvedNamers"]);
  assert.deepEqual(empty?.categories.filter(c => c.collection.state === "present").map(c => c.name), ["importers", "dynamicImporters", "users", "unresolvedNamers"]);
  assert.deepEqual(t.list("/value/files/0/reexporters", "file-dependency"), [], "present and empty");
  assert.deepEqual(service?.categories.find(c => c.name === "reexporters")?.collection, {state:"present",count:0});
  assert.deepEqual(service?.categories.find(c => c.name === "dynamicImporters")?.collection, {state:"absent"});
  const [ui, again] = t.list("/value/files/0/importers", "file-dependency");
  assert.equal(ui?.id, again?.id, "a repeated importer is one part with two supports");
  assert.equal(ui?.supports.length, 2);
  const user = t.list("/value/files/0/users", "file-dependency")[0];
  assert.equal(user?.from, ui?.from, "the same consumer file");
  assert.notEqual(user?.id, ui?.id, "a user is not an importer");
  assert.equal(user?.category, "user");
  assert.equal(t.list("/value/files/0/unresolvedNamers", "file-dependency")[0]?.category, "unresolved-namer");
  assert.equal(t.list("/value/files/1/dynamicImporters", "file-dependency")[0]?.category, "dynamic-importer");
  assert.ok(!CATEGORIES.some((c) => t.set.parts.some((p) => p.kind === "file-dependency" && p.category === (c as string))), "categories use the closed dependency names");
});

test("outline keeps duplicate declarations by reference, empty files and unheld files", () => {
  const t = new Tables(normalizeSource(sourceFixture("outline"), digest));
  const [controller, empty] = t.list("/value/files", "outline-file");
  assert.equal(controller?.declarations.length, 4);
  assert.equal(controller?.declarations[1], controller?.declarations[2], "two indistinguishable declarations share one object and keep both references");
  assert.equal(t.partOf(controller!.declarations[1]!, "outline-declaration").supports.length, 2);
  const dependencies = controller!.imports.flatMap(({ target }) => target.kind === "repository" ? [target.dependency] : []);
  assert.deepEqual(dependencies.map((id) => t.path(t.partOf(id, "file-dependency").to)), ["src/OrderService.java", "src/OrderService.java"]);
  assert.equal(dependencies[0], dependencies[1], "two statements of one repository target share one file dependency");
  assert.equal(t.set.files.some((f) => f.path === "java.util"), false, "an external target creates no file");
  assert.deepEqual([empty?.declarations, empty?.imports], [[], []]);
  assert.deepEqual(t.list("/value/unheld", "unheld-file").map((u) => t.path(u.file)), ["src/Missing.java", "src/generated/Out.java"]);
  assert.equal(t.at("/value/unheld/0").some((p) => p.kind === "outline-file"), false, "unheld is not an empty outline file");
  assert.equal(t.set.parts.some((p) => p.kind === "symbol-reach"), false, "no inferred dependency");
});

test("a proven outline binding anchors the declaration it reaches, so compose can join it with other answers", () => {
  const t = new Tables(normalizeSource(sourceFixture("outline"), digest));
  const [controller] = t.list("/value/files", "outline-file");
  const declaration = controller?.imports[0]?.bindings[0]?.declaration;
  assert.ok(declaration);
  const anchor = t.anchor(declaration.anchor);
  assert.deepEqual({ file: t.path(anchor.file), symbol: anchor.symbol, line: anchor.line, endLine: anchor.endLine, kindName: declaration.kindName }, { file: "src/OrderService.java", symbol: "OrderService", line: 3, endLine: 50, kindName: "class" });
});

test("an outline focus keeps each matched declaration with its subtree, and no outline file a cut of the file would misstate", () => {
  const declaration: OutlineDeclaration = { kind: "method", name: "get", line: 10, endLine: 20, children: [{ kind: "function", name: "inner", line: 12, endLine: 14 }] };
  const value = { focus: [{ file: "src/Api.ts", selector: "Api.get", path: "Api.get", ancestors: [{ kind: "class", name: "Api", line: 3, endLine: 40 }], declaration, omitted: 4 }], unheld: [] };
  const t = new Tables(normalizeSource(sourceFixture("outline", { value, arguments: { repo: "shop", revision: SHA_A, focus: [{ file: "src/Api.ts", symbol: "Api.get" }] } }), digest));
  const [matched] = t.at("/value/focus/0/declaration").filter((p) => p.kind === "outline-declaration");
  assert.ok(matched);
  assert.deepEqual(rebuildDeclaration(t, matched.id), declaration);
  assert.equal(t.set.parts.some((p) => p.kind === "outline-file"), false);
});

test("workspace impact keeps reads with their kinds, call-site ancestors and stated requests, and link reach", () => {
  const set = normalizeSource(sourceFixture("impact-workspace"), digest);
  const t = new Tables(set);
  const web = found(t.read({ kind: "section", repo: "web" }), "web");
  const nested = set.reads.filter((r) => r.owner.kind === "read" && r.owner.repo === "web");
  assert.deepEqual(nested.map((r) => r.owner.kind === "read" && [r.owner.index, r.owner.readKind]).sort(), [[0, "discovery"], [1, "upstream"]]);
  assert.equal(found(t.read({ kind: "section", repo: "ghost" }), "ghost").analysis.status, "unknown");
  const prefix = "/value/sections/web/value";
  const [site] = t.list(`${prefix}/callSites`, "call-site");
  assert.equal(site?.disposition, "matched");
  assert.deepEqual(site?.site.ancestors, [{ symbol: "OrdersService", line: 3, endLine: 40 }]);
  assert.deepEqual(site?.site.stated, { method: "GET", path: "/orders" });
  const [bare] = t.list(`${prefix}/unmatched`, "call-site");
  assert.equal(bare?.disposition, "unmatched");
  assert.equal("ancestors" in bare!.site || "stated" in bare!.site, false);
  assert.equal(bare?.site.target.status, "unknown");
  assert.equal(t.list(`${prefix}/external`, "call-site")[0]?.disposition, "external");
  // Call-site evidence and location belong to the web snapshot, not the trigger's.
  const location = t.file(site!.site.location.file);
  assert.ok(location.origin.kind === "snapshot");
  assert.deepEqual(location.origin.kind === "snapshot" && t.snapshot(location.origin.snapshot), shaRef("web", SHA_B));
  assert.equal(web.snapshot, location.origin.kind === "snapshot" ? location.origin.snapshot : undefined);
  // Link reach: self, missing and another link, in order.
  const [first, second] = t.list("/value/links", "workspace-link");
  assert.deepEqual(first?.reach, [{ status: "present", part: first!.id }, { status: "missing", linkId: "link-missing" }, { status: "present", part: second!.id }]);
  assert.deepEqual(second?.reach, []);
  assert.deepEqual(first?.link.profiles, ["prod"]);
  // A link destination outside the vector stays a context-local reference.
  assert.deepEqual(t.file(t.anchor(second!.link.to.handler).file).origin, { kind: "query-context", read: set.sources[0]!.rootRead });
  assert.equal(set.sources[0]!.snapshotVector.map((e) => e.repo).join(), "shop,web", "the source vector is sorted by repo");
  const context = t.one("/value/workspace", "workspace-context")?.context;
  assert.deepEqual(context?.family === "impact" && context.repositorySnapshots.map((e) => e.repo), ["web", "shop"], "the context keeps its original order");
});

function removedRouteLink(mergeBase: string | undefined): Tables {
  const workspace = workspaceImpactValue("impact");
  const removed = impactValue().changedEntrypoints![0]!;
  assert.equal(removed.change, "removed");
  const link = { id: "link-removed", from: { repo: "web", file: "src/orders.service.ts", line: 30, symbol: "OrdersService.drop" }, to: { repo: "shop", kind: removed.kind, name: removed.name, handler: removed.handler }, transport: "http" as const, basis: "route-overlap" as const, confidence: 0.5 };
  const shop = workspace.sections.shop!;
  assert.ok(shop.status !== "unknown" && shop.value.impact !== undefined);
  const { mergeBase: _recorded, ...unrecorded } = shop.value.impact;
  const impact: ImpactValue = mergeBase === undefined ? unrecorded : { ...unrecorded, mergeBase };
  const value: WorkspaceImpactValue = {
    ...workspace,
    trigger: mergeBase === undefined ? { repo: "shop" } : { repo: "shop", mergeBase },
    sections: { ...workspace.sections, shop: { ...shop, value: { ...shop.value, impact } } },
    links: [{ link, direction: "upstream", reach: [] }],
  };
  return new Tables(normalizeSource(sourceFixture("impact-workspace", { value }), digest));
}

test("a link to a route the change removed lands in the handler the merge base holds, not in the trigger's head", () => {
  const t = removedRouteLink(MERGE_BASE);
  const change = t.list("/value/sections/shop/value/impact/changedEntrypoints", "entrypoint-change")[0]!;
  const handler = t.list("/value/links", "workspace-link")[0]!.link.to.handler;
  const origin = t.file(t.anchor(handler).file).origin;
  assert.deepEqual(origin.kind === "snapshot" && t.snapshot(origin.snapshot), shaRef("shop", MERGE_BASE));
  assert.equal(handler, change.handler, "one removed handler is one anchor");
});

test("a link to a removed route without a recorded merge base keeps a coordinate local to the read", () => {
  const t = removedRouteLink(undefined);
  const handler = t.list("/value/links", "workspace-link")[0]!.link.to.handler;
  assert.deepEqual(t.file(t.anchor(handler).file).origin, { kind: "query-context", read: t.set.sources[0]!.rootRead });
});

test("workspace names keep stated and unserved dispositions and resolve repository evidence by its own repo", () => {
  const set = normalizeSource(sourceFixture("workspace"), digest);
  const t = new Tables(set);
  const snap = (id: EvidenceId) => { const o = t.evidenceRecord(id).origin; return o.kind === "snapshot" ? t.snapshot(o.snapshot) : o; };
  const [api] = t.list("/value/sections/web/value/names", "outward-name");
  assert.equal(api?.disposition, "stated");
  assert.deepEqual(api?.origin.kind === "snapshot" && t.snapshot(api.origin.snapshot), { repo: "web", kind: "live", head: SHA_A, stateId: "state-1" });
  const [candidate] = t.list("/value/candidates", "name-candidate");
  assert.deepEqual(candidate?.evidence.map(snap), [shaRef("shop"), { repo: "web", kind: "live", head: SHA_A, stateId: "state-1" }]);
  assert.equal(candidate?.context, set.sources[0]!.rootRead);
  const [billing, ghost] = t.list("/value/unserved", "outward-name");
  assert.equal(billing?.disposition, "unserved");
  assert.deepEqual(ghost?.evidence.map(snap), [{ kind: "query-context", read: set.sources[0]!.rootRead }], "a repo outside the vector keeps a context-local origin");
  assert.equal(t.evidenceRecord(ghost!.evidence[0]!).repo, "ghost");
  assert.equal(t.list("/value/sections/shop/value/names", "outward-name").length, 0, "an unknown section has no parts");
  assert.deepEqual(set.parts.filter((p) => p.kind === "workspace-link"), t.list("/value/links", "workspace-link"), "a candidate is not a link");
});

test("decision preserves all option semantics and context evidence", () => {
  const set = normalizeSource(sourceFixture("decisions"), digest);
  const t = new Tables(set);
  const root = set.sources[0]!.rootRead;
  const [membership, repository, remote, trust, revision] = t.list("/value/decisions", "decision");
  assert.equal(membership?.context, root);
  assert.deepEqual(membership?.options.map((o) => [o.value, o.basis, o.recommended, o.evidence.length]), [["shop", "exact-name", true, 1], ["web", "route-overlap", false, 0]]);
  assert.deepEqual(repository?.options, []);
  assert.deepEqual(repository?.outwardKinds, ["configuration-url", "http-host"]);
  assert.equal(repository?.allowsFreeText, true);
  assert.equal(trust?.required, true);
  assert.equal(trust?.allowsFreeText, false);
  assert.deepEqual(trust?.options.map((o) => "basis" in o), [false, false], "an absent basis stays absent");
  assert.equal(revision?.options[0]?.basis, "default-branch");
  // `.git/config` behind an origin basis is external context, never the commit tree.
  const external = t.evidenceRecord(remote!.options[0]!.evidence[0]!);
  assert.deepEqual(external.origin, { kind: "query-context", read: root });
  assert.deepEqual(external.value, { path: ".git/config", line: 1, via: "origin" });
  assert.equal(external.repo, "web");
  // Repository code evidence uses the snapshot of its own repo; a repo outside the vector stays context-local.
  const [web, ghost] = repository!.evidence.map((id) => t.evidenceRecord(id));
  assert.deepEqual(web?.origin.kind === "snapshot" && t.snapshot(web.origin.snapshot), shaRef("web", SHA_B));
  assert.deepEqual(ghost?.origin, { kind: "query-context", read: root });
  assert.equal(set.files.length, 0, "decisions name no file and no entity");
  assert.equal(set.anchors.length, 0);
  // The same `.git/config` evidence in a non-origin option would be repository content; the classification follows the basis.
  const decisions = sourceFixture("decisions").read.fact;
  assert.ok(decisions.status !== "unknown");
});

test("an anchor is shared across families only on the same exact snapshot", () => {
  const entry = new Tables(normalizeSource(sourceFixture("entrypoints"), digest));
  const handler = entry.list("/value/entrypoints/value", "entrypoint", "unknown-finding")[0];
  assert.ok(handler?.kind === "entrypoint" && handler.entry.kind === "http-route");
  const impact = new Tables(normalizeSource(sourceFixture("impact-local"), digest));
  assert.equal(impact.list("/value/symbols", "symbol-reach")[0]?.anchor, handler.entry.handler);
  const other = new Tables(normalizeSource(sourceFixture("impact-local", { fact: factOf(impactValue(), { snapshot: shaRef("shop", SHA_B) }) }), digest));
  assert.notEqual(other.list("/value/symbols", "symbol-reach")[0]?.anchor, handler.entry.handler);
  const live = new Tables(normalizeSource(sourceFixture("impact-local", { fact: factOf(impactValue(), { snapshot: { repo: "shop", kind: "live", head: SHA_A, stateId: "x" } }) }), digest));
  assert.notEqual(live.list("/value/symbols", "symbol-reach")[0]?.anchor, handler.entry.handler);
});

test("source ids follow effective inputs, vector and public fact, never private arguments", () => {
  const id = (source: ExecutedSource) => normalizeSource(source, digest).sources[0]!.id;
  const base = id(sourceFixture("callers-local"));
  assert.equal(id(sourceFixture("callers-local", { arguments: { repo: "shop", revision: "main", targets: [{ file: "src/OrderService.java", symbol: "find" }] } })), base, "a ref resolved to the same snapshot is the same source");
  assert.notEqual(id(sourceFixture("callers-local", { fact: factOf(impactValue(), { inputs: inputsOf({ declaredConfig: { targets: ["src/Other.java#x"] } }) }) })), base);
  assert.notEqual(id(sourceFixture("impact-local")), id(sourceFixture("callers-local", { value: impactValue() })), "family is part of the identity");
  assert.notEqual(id(sourceFixture("impact-workspace")), id(sourceFixture("impact-workspace", { read: { workspaceReplay: { version: 1, declaration: `ws-r1:${"f".repeat(64)}`, snapshots: [] } } })), "workspace recovery context is part of the identity");
  const workspace = workspaceImpactValue("impact");
  const vector = id(sourceFixture("impact-workspace", { value: { ...workspace, repositorySnapshots: [{ repo: "shop", snapshot: shaRef("shop") }] } }));
  assert.notEqual(vector, id(sourceFixture("impact-workspace")), "the snapshot vector is part of the identity");
  assert.notEqual(id(sourceFixture("workspace", { arguments: { repo: "shop", offline: false } })), id(sourceFixture("workspace")), "the effective offline policy is part of the identity");
  const secret = "/Users/someone/private/web";
  const set = normalizeSource(sourceFixture("workspace", { arguments: { repo: "shop", repos: [{ path: secret }] } }), digest);
  assert.equal(canonicalJson(set).includes(secret), false, "private arguments never reach the set");
});

test("redaction makes the affected identities local to their occurrence and records them", () => {
  const value = impactValue();
  const redacted: ImpactValue = { ...value, symbols: value.symbols.map((s, i) => (i === 0 ? { ...s, symbol: "[REDACTED]" } : s)) };
  const plain = new Tables(normalizeSource(sourceFixture("impact-local", { value: redacted }), digest));
  const guarded = normalizeSource(sourceFixture("impact-local", { value: redacted, identityGuard: { changedIdentityPointers: ["/value/symbols/0/symbol"] } }), digest);
  const t = new Tables(guarded);
  const anchor = t.list("/value/symbols", "symbol-reach")[0]!.anchor;
  assert.notEqual(anchor, plain.list("/value/symbols", "symbol-reach")[0]!.anchor, "two redacted strings never share an identity");
  assert.deepEqual(guarded.redactions, [{ source: t.source, read: guarded.sources[0]!.rootRead, pointer: "/value/symbols/0/symbol" }]);
  assert.equal(t.list("/value/symbols", "symbol-reach")[1]!.anchor, plain.list("/value/symbols", "symbol-reach")[1]!.anchor, "unaffected positions keep shared ids");
  // A redacted snapshot is marked and kept local.
  const snapshot = normalizeSource(sourceFixture("outline", { fact: factOf(sourceFixture("outline").read.fact.status === "unknown" ? { files: [], unheld: [] } : { files: [], unheld: ["x"] }, { snapshot: shaRef("[REDACTED]") }), identityGuard: { changedSnapshot: true, changedIdentityPointers: ["/snapshot/repo"] } }), digest);
  assert.deepEqual(snapshot.snapshots.map((s) => s.identity), ["redacted"]);
  // A rewritten key set marks its whole object: every section below it is local.
  const sections = normalizeSource(sourceFixture("impact-workspace", { identityGuard: { changedIdentityPointers: ["/value/sections"] } }), digest);
  const shared = normalizeSource(sourceFixture("impact-workspace"), digest);
  const sectionReads = (s: EvidenceSet) => s.reads.filter((r) => r.owner.kind === "section").map((r) => r.snapshot);
  assert.equal(sectionReads(sections).some((id) => sectionReads(shared).includes(id)), false);
  assert.ok(sections.snapshots.some((s) => s.identity === "redacted"));
});

test("an entrypoint finding keeps its own evidence and shares identical evidence with other parts", () => {
  const set = normalizeSource(sourceFixture("entrypoints"), digest);
  const t = new Tables(set);
  const [get, post] = t.list("/value/entrypoints/value", "entrypoint", "unknown-finding");
  assert.ok(get?.kind === "entrypoint" && post?.kind === "entrypoint");
  assert.deepEqual(t.evidence(get.evidence), entrypointsValue().entrypoints.status === "unknown" ? [] : [{ path: "src/OrderController.java", line: 6, endLine: 9 }, { path: "src/OrderController.java", line: 5 }]);
  assert.equal(get.evidence[0], post.evidence[0], "identical evidence is one record");
  assert.equal(t.evidenceRecord(get.evidence[0]!).supports.length, 2);
});

// Regression tests for contract gaps discovered during normalization integration.

test("decision parts keep Decision.id", () => {
  const source = sourceFixture("decisions");
  const t = new Tables(normalizeSource(source, digest));
  assert.deepEqual(reconstruct(source, t), source.read.fact);
});

test("an impact without parts tells an absent merge base, changedEntrypoints and changedContracts from recorded empty ones", () => {
  const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };
  for (const recorded of [value, { ...value, changedEntrypoints: [], changedContracts: [], mergeBase: MERGE_BASE }]) {
    const source = sourceFixture("impact-local", { value: recorded });
    assert.deepEqual(reconstruct(source, new Tables(normalizeSource(source, digest))), source.read.fact);
  }
});

test("coordinator discriminator separates redaction-colliding source identities", () => {
  const source = sourceFixture("entrypoints", { identityGuard: { changedIdentityPointers: [], changedArguments: true, changedSnapshot: false } });
  const a = normalizeSource(source, digest, { discriminator: 0 });
  const b = normalizeSource(source, digest, { discriminator: 1 });
  assert.notEqual(a.sources[0]!.id, b.sources[0]!.id);
  assert.deepEqual(a, normalizeSource(source, digest, { discriminator: 0 }));
  assert.throws(() => normalizeSource(source, digest, { discriminator: -1 }));
  assert.throws(() => normalizeSource(source, digest, { discriminator: 0.5 }));
});

test("optional collection presence cannot be mistaken for a nonempty result", () => {
  const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };
  for (const [recorded, expected] of [
    [value, { state: "absent" }],
    [{ ...value, changedEntrypoints: [] }, { state: "present", count: 0 }],
  ] as const) {
    const set = normalizeSource(sourceFixture("impact-local", { value: recorded }), digest);
    const context = set.parts.find(part => part.kind === "impact-context");
    assert.deepEqual(context?.kind === "impact-context" && context.changedEntrypoints, expected);
  }
});
