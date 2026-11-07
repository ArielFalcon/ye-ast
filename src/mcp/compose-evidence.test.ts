import { test } from "node:test";
import assert from "node:assert/strict";
import type { SnapshotRef } from "../core/domain/shared/fact.ts";
import type {
  AnchorId, CompositionIssue, Connection, EntryData, EvidenceSet, FileId, MaterializedComposition, MaterializedGraph,
  PartId, ReadId, RelationKind, RelationRecord, SourceFamilyRef,
} from "./composition-contract.ts";
import { materializeEvidence, mergeEvidence, validateCompositionReferences } from "./compose-evidence.ts";
import { digest, SetBuilder, sha, SHA_A, SHA_B, type ReadContext } from "./compose-evidence-test-sets.testing.ts";

const ENTRYPOINTS: SourceFamilyRef = { family: "entrypoints" };
const OUTLINE: SourceFamilyRef = { family: "outline" };
const IMPACT: SourceFamilyRef = { family: "impact", branch: "local" };
const CALLERS: SourceFamilyRef = { family: "callers", branch: "local" };
const IMPORTERS: SourceFamilyRef = { family: "importers" };
const WORKSPACE_IMPACT: SourceFamilyRef = { family: "impact", branch: "workspace" };
const WORKSPACE: SourceFamilyRef = { family: "workspace" };
const DECISIONS: SourceFamilyRef = { family: "decisions" };
const CONSEQUENCES: SourceFamilyRef = { family: "contract_consequences" };
const PATH = "src/OrderController.java";
const HANDLER = "com.shop.OrderController.create";

function compose(...sets: EvidenceSet[]): MaterializedComposition {
  const [first, ...rest] = sets;
  assert.ok(first);
  const result = materializeEvidence(rest.reduce(mergeEvidence, first), digest);
  assert.deepEqual(validateCompositionReferences(result.graph), { ok: true, value: undefined }, "every materialized reference resolves");
  return result;
}

const relations = (graph: MaterializedGraph, kind: RelationKind): RelationRecord[] => graph.relations.filter((relation) => relation.value.kind === kind);
const connections = (graph: MaterializedGraph, rule: Connection["rule"]): Connection[] => graph.connections.filter((connection) => connection.rule === rule);
const issues = (result: MaterializedComposition, kind: CompositionIssue["kind"]): CompositionIssue[] => result.issues.filter((issue) => issue.kind === kind);
const binding = (graph: MaterializedGraph, anchor: AnchorId) => graph.bindings.find((record) => record.anchor === anchor)?.binding;
const entityOf = (graph: MaterializedGraph, anchor: AnchorId) => {
  const bound = binding(graph, anchor);
  assert.equal(bound?.status, "resolved", `anchor ${anchor} is bound`);
  return graph.entities.find((entity) => bound?.status === "resolved" && entity.id === bound.entity);
};

const httpRoute = (handler: AnchorId): EntryData => ({
  kind: "http-route", name: "POST /orders", method: "POST", path: "/orders", handler,
  basePath: { status: "unknown", reason: "unresolved", evidence: [] },
});

test("merges exact duplicate relation and unions provenance", () => {
  const impact = new SetBuilder("impact", IMPACT, sha("shop"), { walkDepth: 4 });
  const callers = new SetBuilder("callers", CALLERS, sha("shop"), { walkDepth: 2, targets: ["S"] });
  const shared = (builder: SetBuilder, confidence: number) => {
    const fileS = builder.file("src/S.java");
    const fileC = builder.file("src/C.java");
    const s = builder.anchor(fileS, "S", 5, 7);
    const c = builder.anchor(fileC, "C", 20, 30);
    const reach = builder.part({ kind: "symbol-reach", anchor: c, kindName: "method", depth: 1, confidence, fanIn: 2, via: { target: { file: fileS, symbol: "S" }, lines: [22], basis: "call" } });
    const evidence = builder.evidence({ path: "src/C.java", line: 22 });
    return { s, c, reach, evidence, fileC };
  };
  const i = shared(impact, 1);
  const seed = impact.part({ kind: "seed", anchor: i.s, basis: "lines", comparison: { status: "available", value: { repo: "shop", mergeBase: SHA_B, head: impact.snapshot } } });
  const k = shared(callers, 0.8);
  callers.part({ kind: "seed", anchor: k.s, basis: "requested" });

  const { graph } = compose(impact.build(), callers.build());
  assert.equal(i.s, k.s, "the same anchor in the same snapshot is one coordinate");
  const [dependence, ...more] = relations(graph, "symbol-dependence");
  assert.ok(dependence);
  assert.equal(more.length, 0, "one relation for C -> S");
  assert.deepEqual(dependence.value, { kind: "symbol-dependence", from: entityOf(graph, i.c)?.id, to: entityOf(graph, i.s)?.id, basis: "call" });
  assert.deepEqual(new Set(dependence.attestations.map((a) => a.reads.join())), new Set([impact.read, callers.read]), "one attestation per source context");
  assert.deepEqual(new Set(dependence.attestations.map((a) => a.confidence)), new Set([1, 0.8]), "confidences stay per attestation, never maximized");
  for (const attestation of dependence.attestations) assert.deepEqual(attestation.locations, [{ file: i.fileC, line: 22 }]);
  assert.equal(graph.entities.filter((entity) => entity.kind === "declaration").length, 2, "one S and one C");
  assert.equal(graph.evidence.length, 1, "one identical evidence");
  assert.deepEqual(new Set(graph.evidence[0]?.supports.map((support) => support.source)), new Set([impact.source, callers.source]));
  assert.equal(graph.parts.filter((part) => part.kind === "symbol-reach").length, 2, "depth/confidence/fanIn stay in each source's part");
  assert.deepEqual(graph.reads.map((read) => read.inputs.declaredConfig.walk?.depth).sort(), [2, 4], "budgets stay in each read");
  const [change] = connections(graph, "change-dependent");
  assert.ok(change?.parts.includes(seed), "C has a recorded dependence on the diff seed S");
  assert.ok(!connections(graph, "change-dependent").some((connection) => connection.parts.some((part) => graph.parts.find((p) => p.id === part)?.kind === "seed" && part !== seed)), "a requested seed is never a change");
});

test("merge keeps multiplicity positions and rejects nothing it cannot fuse", () => {
  const outline = new SetBuilder("outline", OUTLINE, sha("shop"));
  const file = outline.file(PATH);
  const anchor = outline.anchor(file, "create", 10, 20, { pointer: "/value/files/0/declarations/0" });
  outline.part({ kind: "outline-declaration", anchor, kindName: "method" }, { pointer: "/value/files/0/declarations/0" });
  outline.part({ kind: "outline-declaration", anchor, kindName: "method" }, { pointer: "/value/files/0/declarations/1" });
  const set = outline.build();
  const merged = mergeEvidence(set, set);
  assert.deepEqual(merged, set);
  assert.deepEqual(merged.parts[0]?.supports.map((support) => support.pointer), ["/value/files/0/declarations/0", "/value/files/0/declarations/1"]);
});

type Declaration = { symbol?: string; line: number; endLine: number; kindName?: string; duplicate?: boolean };
function handlerCase(handler: { symbol?: string; line: number; endLine?: number; redacted?: boolean }, declarations: readonly Declaration[], outlineSnapshot: SnapshotRef = sha("shop")) {
  const entrypoints = new SetBuilder("entrypoints", ENTRYPOINTS, sha("shop"));
  const pointer = "/value/entrypoints/value/0/value/handler";
  const handlerAnchor = entrypoints.anchor(entrypoints.file(PATH), handler.redacted === true ? "[REDACTED]" : handler.symbol ?? HANDLER, handler.line, handler.endLine, {
    pointer, ...(handler.redacted === true ? { occurrence: { source: entrypoints.source, read: entrypoints.read, pointer } } : {}),
  });
  if (handler.redacted === true) entrypoints.redact(`${pointer}/symbol`);
  const route = entrypoints.part({ kind: "entrypoint", entry: httpRoute(handlerAnchor), evidence: [] }, { pointer: "/value/entrypoints/value/0" });
  const outline = new SetBuilder("outline", OUTLINE, outlineSnapshot);
  const file = outline.file(PATH);
  const parts = declarations.map((declaration, index) => {
    const anchor = outline.anchor(file, declaration.symbol ?? "create", declaration.line, declaration.endLine, { pointer: `/value/files/0/declarations/${index}` });
    const payload = { kind: "outline-declaration" as const, anchor, kindName: declaration.kindName ?? "method" };
    const part = outline.part(payload, { pointer: `/value/files/0/declarations/${index}` });
    if (declaration.duplicate === true) outline.part(payload, { pointer: `/value/files/0/declarations/${index + 100}` });
    return part;
  });
  const result = compose(entrypoints.build(), outline.build());
  return { result, graph: result.graph, handlerAnchor, route, parts };
}

test("handler joins unique outline through joinsFact", () => {
  const exact = handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }]);
  const entity = entityOf(exact.graph, exact.handlerAnchor);
  assert.equal(entity?.kind, "declaration");
  assert.deepEqual(entity?.kind === "declaration" ? entity.declarations : [], exact.parts, "the qualified handler joins the simple outline name");
  assert.equal(entity?.kind === "declaration" ? entity.anchors.length : 0, 2, "both original spellings stay as anchors");
  const [serves] = relations(exact.graph, "serves-entrypoint");
  assert.ok(serves);
  const [joined] = connections(exact.graph, "handler-declaration");
  assert.deepEqual(joined?.relations, [serves.id]);
  assert.deepEqual(new Set(joined?.parts), new Set([exact.route, ...exact.parts]));

  const annotated = handlerCase({ line: 9, endLine: 20 }, [{ line: 10, endLine: 20 }]);
  const annotatedEntity = entityOf(annotated.graph, annotated.handlerAnchor);
  assert.deepEqual(annotatedEntity?.kind === "declaration" ? annotatedEntity.declarations : [], annotated.parts, "an annotation before the outline start joins by the explicit span");
  assert.equal(annotatedEntity?.kind === "declaration" ? annotatedEntity.anchors.length : 0, 2);
});

test("handler never joins an outline candidate that is not unique and exact", () => {
  const unjoined = (label: string, run: ReturnType<typeof handlerCase>) => {
    const entity = entityOf(run.graph, run.handlerAnchor);
    assert.deepEqual(entity?.kind === "declaration" ? entity.declarations : ["x"], [], `${label}: the handler stays its exact anchor`);
    assert.equal(connections(run.graph, "handler-declaration").length, 0, `${label}: no handler-declaration`);
  };
  const otherSnapshot = handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }], sha("shop", SHA_B));
  unjoined("homonym in another snapshot", otherSnapshot);
  assert.equal(issues(otherSnapshot.result, "snapshot-difference").length, 1);
  unjoined("homonym in another repo", handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }], sha("web")));
  unjoined("live state of the same head", handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }], { repo: "shop", kind: "live", head: SHA_A, stateId: "x" }));
  unjoined("case differs", handlerCase({ symbol: "com.shop.OrderController.Create", line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }]));
  unjoined("prefix differs", handlerCase({ symbol: "com.shop.OrderController.precreate", line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }]));

  const ambiguous = (label: string, run: ReturnType<typeof handlerCase>, candidates: readonly PartId[]) => {
    assert.deepEqual(binding(run.graph, run.handlerAnchor), { status: "unresolved", anchor: run.handlerAnchor, reason: "ambiguous" }, label);
    const issue = issues(run.result, "ambiguous-declaration").find((candidate) => candidate.kind === "ambiguous-declaration" && candidate.anchor === run.handlerAnchor);
    assert.deepEqual(issue?.kind === "ambiguous-declaration" ? new Set(issue.candidates) : undefined, new Set(candidates), `${label}: every candidate stays, none is picked`);
    assert.equal(relations(run.graph, "serves-entrypoint").length, 0, `${label}: no handler is invented`);
  };
  const duplicate = handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20, duplicate: true }]);
  ambiguous("two indistinguishable appearances in one source", duplicate, duplicate.parts);
  const overloads = handlerCase({ line: 10 }, [{ line: 10, endLine: 10, kindName: "method" }, { line: 10, endLine: 10, kindName: "constructor" }]);
  ambiguous("overloads on one line", overloads, overloads.parts);
  const nested = handlerCase({ line: 9, endLine: 20 }, [{ line: 10, endLine: 20 }, { line: 11, endLine: 20 }]);
  ambiguous("two nested candidates", nested, nested.parts);

  for (const [label, run] of [
    ["different end", handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 21 }])],
    ["omitted end is one line", handlerCase({ line: 10 }, [{ line: 10, endLine: 20 }])],
  ] as const) {
    assert.deepEqual(binding(run.graph, run.handlerAnchor), { status: "unresolved", anchor: run.handlerAnchor, reason: "conflicting-coordinate" }, label);
    const [conflict] = issues(run.result, "conflicting-coordinate");
    assert.deepEqual(conflict?.kind === "conflicting-coordinate" ? new Set(conflict.anchors) : undefined, new Set([run.handlerAnchor, ...run.graph.anchors.filter((a) => a.id !== run.handlerAnchor).map((a) => a.id)]), `${label}: both coordinates kept`);
  }
});

test("a redacted identity blocks every join and is reported, never deduplicated", () => {
  const run = handlerCase({ line: 10, endLine: 20, redacted: true }, [{ line: 10, endLine: 20 }]);
  assert.deepEqual(binding(run.graph, run.handlerAnchor), { status: "unresolved", anchor: run.handlerAnchor, reason: "redacted" });
  assert.equal(connections(run.graph, "handler-declaration").length, 0);
  const [issue] = issues(run.result, "redacted-identity");
  assert.deepEqual(issue && { ...issue }, { kind: "redacted-identity", owner: { kind: "fact" }, pointer: "/value/entrypoints/value/0/value/handler/symbol", sources: issue?.sources, reads: issue?.reads });
  assert.equal(issue?.sources.length, 1);
});

function viaCase(options: { seedInRead: boolean; outline: readonly { line: number; endLine: number }[]; basis?: "call" | "reference" }) {
  const callers = new SetBuilder("callers", CALLERS, sha("shop"));
  const fileS = callers.file("src/S.java");
  const c = callers.anchor(callers.file("src/C.java"), "C", 20, 30);
  const reach = callers.part({ kind: "symbol-reach", anchor: c, kindName: "method", depth: 1, confidence: 1, fanIn: 1, via: { target: { file: fileS, symbol: "S" }, basis: options.basis ?? "call" } });
  if (options.seedInRead) callers.part({ kind: "seed", anchor: callers.anchor(fileS, "S", 5, 7), basis: "requested" });
  const outline = new SetBuilder("outline", OUTLINE, sha("shop"));
  const file = outline.file("src/S.java");
  const declarations = options.outline.map((d, index) => outline.part({ kind: "outline-declaration", anchor: outline.anchor(file, "S", d.line, d.endLine), kindName: "method" }, { pointer: `/value/files/0/declarations/${index}` }));
  const result = compose(callers.build(), outline.build());
  return { result, graph: result.graph, reach, declarations, callers, outline };
}

test("unresolved via does not invent endpoint", () => {
  const overloaded = viaCase({ seedInRead: false, outline: [{ line: 5, endLine: 7 }, { line: 9, endLine: 11 }] });
  assert.equal(relations(overloaded.graph, "symbol-dependence").length, 0, "a named target with several declarations has no endpoint");
  const [unresolved] = issues(overloaded.result, "unresolved-endpoint");
  assert.equal(unresolved?.kind === "unresolved-endpoint" ? unresolved.part : undefined, overloaded.reach);
  assert.equal(overloaded.graph.parts.find((part) => part.id === overloaded.reach)?.kind, "symbol-reach", "the via stays in its part");

  const sameRead = viaCase({ seedInRead: true, outline: [{ line: 5, endLine: 7 }, { line: 9, endLine: 11 }] });
  const [fromRead] = relations(sameRead.graph, "symbol-dependence");
  assert.deepEqual(fromRead?.attestations.map((a) => ({ parts: a.parts, reads: a.reads })), [{ parts: [sameRead.reach], reads: [sameRead.callers.read] }], "the owner read resolves its own target");

  const fromOutline = viaCase({ seedInRead: false, outline: [{ line: 5, endLine: 7 }] });
  const [resolved] = relations(fromOutline.graph, "symbol-dependence");
  assert.deepEqual(new Set(resolved?.attestations[0]?.parts), new Set([fromOutline.reach, ...fromOutline.declarations]), "an outline-resolved endpoint keeps both supports");
  assert.deepEqual(new Set(resolved?.attestations[0]?.reads), new Set([fromOutline.callers.read, fromOutline.outline.read]));
  assert.equal(issues(fromOutline.result, "unresolved-endpoint").length, 0);

  const reference = viaCase({ seedInRead: true, outline: [], basis: "reference" });
  assert.deepEqual(relations(reference.graph, "symbol-dependence").map((r) => r.value.kind === "symbol-dependence" && r.value.basis), ["reference"], "a reference is never a call");
});

test("base and head modules stay on their side; a module-only impact relates only modules", () => {
  const impact = new SetBuilder("impact", IMPACT, sha("shop"));
  const comparison = { status: "available" as const, value: { repo: "shop", mergeBase: SHA_B, head: impact.snapshot } };
  const origin = impact.part({ kind: "module-origin", comparison, file: "src/a.ts", change: "modified" }, { pointer: "/value/modules/origins/0" });
  const head = impact.file("src/b.ts");
  const via = { file: "src/a.ts", line: 3, specifier: "./a", kind: "import" as const, typeOnly: false };
  const reach = impact.part({ kind: "module-reach", file: head, side: "head", depth: 1, origins: [{ status: "present", index: 0, part: origin }, { status: "missing", index: 3 }], via }, { pointer: "/value/modules/modules/0" });
  const base = impact.file("src/old.ts", { snapshot: sha("shop", SHA_B) });
  impact.part({ kind: "module-reach", file: base, side: "base", depth: 1, origins: [{ status: "present", index: 0, part: origin }] }, { pointer: "/value/modules/modules/1" });
  const unproven = impact.file("src/gone.ts", { snapshot: "query-context" });
  const baseWithoutMergeBase = impact.part({ kind: "module-reach", file: unproven, side: "base", depth: 1, origins: [], via: { ...via, file: "src/x.ts" } }, { pointer: "/value/modules/modules/2" });

  const result = compose(impact.build());
  const [dependence, ...rest] = relations(result.graph, "module-dependence");
  assert.equal(rest.length, 0, "no base endpoint without a merge base");
  assert.equal(dependence?.value.kind === "module-dependence" ? dependence.value.from : undefined, head);
  const target = result.graph.files.find((file) => dependence?.value.kind === "module-dependence" && file.id === dependence.value.to);
  assert.deepEqual(target && { path: target.path, origin: target.origin }, { path: "src/a.ts", origin: { kind: "snapshot", snapshot: impact.snapshot } }, "the via target is on the head side");
  assert.deepEqual(dependence?.value.kind === "module-dependence" ? dependence.value.qualifier : undefined, { kind: "import", typeOnly: false, specifier: "./a" });
  assert.deepEqual(dependence?.attestations[0]?.locations, [{ file: head, line: 3 }], "the via line belongs to the reached module");
  assert.equal(relations(result.graph, "module-origin").length, 2, "head and base modules each relate to their origin");
  assert.equal(result.graph.entities.length, 0, "a module-only impact has no declarations");
  assert.equal(relations(result.graph, "symbol-dependence").length, 0);
  assert.deepEqual(issues(result, "missing-origin-reference").map((issue) => issue.kind === "missing-origin-reference" && [issue.part, issue.table, issue.index]), [[reach, "module-origins", 3]]);
  assert.ok(issues(result, "missing-provenance").some((issue) => issue.kind === "missing-provenance" && issue.part === baseWithoutMergeBase && issue.side === "base"));
});

test("importer, user and unresolved categories stay distinct; imports are not calls", () => {
  const importers = new SetBuilder("importers", IMPORTERS, sha("shop"));
  const consumer = importers.file("src/x.ts");
  const target = importers.file("src/t.ts");
  const imported = importers.part({ kind: "file-dependency", from: consumer, to: target, category: "importer" });
  importers.part({ kind: "file-dependency", from: consumer, to: target, category: "user" });
  importers.part({ kind: "file-dependency", from: consumer, to: target, category: "unresolved-namer" });
  const outline = new SetBuilder("outline", OUTLINE, sha("shop"));
  const outlineImport = outline.part({ kind: "file-dependency", from: outline.file("src/x.ts"), to: outline.file("src/t.ts"), category: "outline-import" });

  const { graph } = compose(importers.build(), outline.build());
  assert.deepEqual(graph.relations.map((r) => r.value.kind).sort(), ["file-import", "file-use", "unresolved-file-name"]);
  const [fileImport] = relations(graph, "file-import");
  assert.deepEqual(new Set(fileImport?.attestations.flatMap((a) => a.parts)), new Set([imported, outlineImport]), "each attestation keeps its own category part");
  const [shared] = connections(graph, "shared-file-import");
  assert.deepEqual(shared?.relations, [fileImport?.id]);
  assert.deepEqual(new Set(shared?.parts), new Set([imported, outlineImport]));
  assert.equal(relations(graph, "symbol-dependence").length, 0, "an import is never a call");
});

function usedImportCase(options: { importFrom?: string; importTo?: string; callerSnapshot?: SnapshotRef; callerContext?: ReadContext } = {}) {
  const importers = new SetBuilder("used-importers", IMPORTERS, sha("shop"));
  const imported = importers.part({ kind: "file-dependency", from: importers.file(options.importFrom ?? "src/C.java"), to: importers.file(options.importTo ?? "src/S.java"), category: "importer" });
  const outline = new SetBuilder("used-outline", OUTLINE, sha("shop"));
  const outlineImport = outline.part({ kind: "file-dependency", from: outline.file("src/C.java"), to: outline.file("src/S.java"), category: "outline-import" });
  const callers = new SetBuilder("used-callers", CALLERS, options.callerSnapshot ?? sha("shop"), options.callerContext);
  const target = callers.file("src/S.java");
  const s = callers.anchor(target, "S", 5, 7);
  callers.part({ kind: "seed", anchor: s, basis: "requested" });
  const reach = callers.part({ kind: "symbol-reach", anchor: callers.anchor(callers.file("src/C.java"), "C", 20, 30), kindName: "method", depth: 1, confidence: 1, fanIn: 1, via: { target: { file: target, symbol: "S" }, lines: [22], basis: "call" } });
  const { graph } = compose(importers.build(), outline.build(), callers.build());
  return { graph, imported, outlineImport, reach };
}

test("an importer is joined with a recorded dependence from a declaration of its file onto one of the imported file", () => {
  const { graph, imported, outlineImport, reach } = usedImportCase();
  const [used, ...more] = connections(graph, "used-import");
  assert.equal(more.length, 0, "the outline attestation of the same import adds no second join");
  const [fileImport] = relations(graph, "file-import");
  const [dependence] = relations(graph, "symbol-dependence");
  assert.deepEqual(new Set(used?.relations), new Set([fileImport?.id, dependence?.id]));
  assert.deepEqual(new Set(used?.entities), new Set(dependence?.value.kind === "symbol-dependence" ? [dependence.value.from, dependence.value.to] : []));
  assert.deepEqual(new Set(used?.parts), new Set([imported, reach]));
  assert.ok(!used?.parts.includes(outlineImport), "the outline category stays apart");

  assert.equal(connections(usedImportCase({ importFrom: "src/X.java" }).graph, "used-import").length, 0, "the dependence starts in another file than the importer");
  assert.equal(connections(usedImportCase({ importTo: "src/X.java" }).graph, "used-import").length, 0, "the dependence lands in another file than the imported one");
  assert.equal(connections(usedImportCase({ callerSnapshot: sha("shop", SHA_B) }).graph, "used-import").length, 0, "another snapshot of the repository never joins");
  assert.equal(connections(usedImportCase({ callerContext: { producer: { name: "ye-ast", version: "0.0.1" } } }).graph, "used-import").length, 0, "a derived join keeps the strict producer guard");
});

function workspaceLink(builder: SetBuilder, options: { handlerSnapshot: SnapshotRef | "query-context"; basis?: "exact" | "base-path"; profiles?: readonly string[]; linkId?: string; reach?: readonly string[] }) {
  const from = builder.file("src/client.ts", { snapshot: sha("web") });
  const handlerFile = builder.file(PATH, { snapshot: options.handlerSnapshot, repo: "shop" });
  const handler = builder.anchor(handlerFile, HANDLER, 10, 20);
  const pointer = `/value/links/${options.linkId ?? "0"}`;
  const occurrence = { source: builder.source, read: builder.read, pointer };
  const reach = (options.reach ?? []).map((id) => ({ status: "missing" as const, linkId: id }));
  return builder.part({
    kind: "workspace-link", direction: "upstream", reach,
    link: {
      id: options.linkId ?? "L1", transport: "http", basis: options.basis ?? "exact", confidence: 0.9,
      ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
      from: { file: from, line: 4, repo: "web", symbol: "load" },
      to: { repo: "shop", kind: "http-route", name: "POST /orders", handler },
    },
  }, { pointer, occurrence });
}

test("a workspace link already admitted becomes one match per snapshot, basis and profiles", () => {
  const one = new SetBuilder("ws-one", WORKSPACE_IMPACT, sha("web"));
  const two = new SetBuilder("ws-two", WORKSPACE_IMPACT, sha("web"));
  workspaceLink(one, { handlerSnapshot: sha("shop") });
  workspaceLink(two, { handlerSnapshot: sha("shop") });
  const same = compose(one.build(), two.build());
  const [match, ...others] = relations(same.graph, "workspace-match");
  assert.equal(others.length, 0, "the same link in the same snapshots is one relation");
  assert.equal(match?.attestations.length, 2);

  const moved = new SetBuilder("ws-moved", WORKSPACE_IMPACT, sha("web"));
  workspaceLink(moved, { handlerSnapshot: sha("shop", SHA_B) });
  assert.equal(relations(compose(one.build(), moved.build()).graph, "workspace-match").length, 2, "a repeated Link.id in another snapshot is not joined");

  const profiled = new SetBuilder("ws-profiled", WORKSPACE_IMPACT, sha("web"));
  workspaceLink(profiled, { handlerSnapshot: sha("shop"), basis: "base-path", profiles: ["prod"] });
  assert.equal(relations(compose(one.build(), profiled.build()).graph, "workspace-match").length, 2, "basis and profiles distinguish relations");

  const unproven = new SetBuilder("ws-unproven", WORKSPACE_IMPACT, sha("web"));
  const part = workspaceLink(unproven, { handlerSnapshot: "query-context", reach: ["L9"] });
  const result = compose(unproven.build());
  assert.equal(relations(result.graph, "workspace-match").length, 0, "no match without the destination snapshot");
  assert.ok(result.graph.parts.some((p) => p.id === part), "the link stays as a part");
  assert.ok(issues(result, "missing-provenance").some((issue) => issue.kind === "missing-provenance" && issue.part === part));
  assert.deepEqual(issues(result, "missing-link-reference").map((issue) => issue.kind === "missing-link-reference" && [issue.linkId, issue.position]), [["L9", 0]]);
});

function linkedEntrypointCase(entries: readonly { name?: string; version?: string }[], catalogSnapshot: SnapshotRef = sha("shop"), catalogContext: ReadContext = {}) {
  const workspace = new SetBuilder("linked-workspace", WORKSPACE_IMPACT, sha("web"));
  const link = workspaceLink(workspace, { handlerSnapshot: sha("shop") });
  const entrypoints = new SetBuilder("linked-entrypoints", ENTRYPOINTS, catalogSnapshot, catalogContext);
  const handler = entrypoints.anchor(entrypoints.file(PATH), HANDLER, 10, 20);
  const catalog = entries.map((entry, index) => entrypoints.part({
    kind: "entrypoint", evidence: [],
    entry: { ...httpRoute(handler), ...(entry.name === undefined ? {} : { name: entry.name }), ...(entry.version === undefined ? {} : { version: entry.version }) },
  }, { pointer: `/value/entrypoints/${index}` }));
  const result = compose(workspace.build(), entrypoints.build());
  return { graph: result.graph, issues: result.issues, link, catalog };
}

test("a cross-repository link is joined with the one catalog entrypoint of its kind, handler and name", () => {
  const { graph, link, catalog: [entry] } = linkedEntrypointCase([{}]);
  const [linked, ...more] = connections(graph, "linked-entrypoint");
  assert.equal(more.length, 0);
  const [match] = relations(graph, "workspace-match");
  assert.ok(match && linked?.relations.includes(match.id), "the join cites the admitted link");
  assert.deepEqual(new Set(linked?.parts), new Set([link, entry]));
  const entity = graph.entities.find((candidate) => candidate.kind === "entrypoint");
  assert.deepEqual(new Set(linked?.entities), new Set([entity?.id, match?.value.kind === "workspace-match" ? match.value.to.handler : undefined]));

  assert.equal(connections(linkedEntrypointCase([{ name: "POST /orders v2" }]).graph, "linked-entrypoint").length, 0, "another name of the same handler never joins");
  assert.equal(connections(linkedEntrypointCase([{}, { version: "2" }]).graph, "linked-entrypoint").length, 0, "two catalog entrypoints of one kind, handler and name are never picked from");
  assert.equal(connections(linkedEntrypointCase([{}], sha("shop", SHA_B)).graph, "linked-entrypoint").length, 0, "a catalog of another snapshot never joins");
});

test("a name candidate is related to its exact name observation and never becomes a link", () => {
  const workspace = new SetBuilder("workspace", WORKSPACE, sha("web"));
  const evidence = workspace.evidence({ path: "src/client.ts", line: 4 }, { snapshot: sha("web"), repo: "web" });
  const name = workspace.part({ kind: "outward-name", origin: workspace.origin(sha("web")), name: "orders", kindName: "http-host", evidence: [evidence], disposition: "stated" });
  workspace.part({ kind: "name-candidate", context: workspace.read, name: "orders", repo: "shop", basis: "exact-name", evidence: [evidence] });
  const { graph } = compose(workspace.build());
  const [candidate] = relations(graph, "candidate-for-name");
  assert.deepEqual(candidate?.value, { kind: "candidate-for-name", name, repo: "shop", basis: "exact-name" });
  assert.equal(relations(graph, "workspace-match").length, 0);
});

test("decisions and workspace share support only through an evidence with the exact origin", () => {
  const workspace = new SetBuilder("workspace", WORKSPACE, sha("web"));
  const decisions = new SetBuilder("decisions", DECISIONS, sha("web"));
  const place = { path: "pom.xml", line: 7 };
  const stated = workspace.part({ kind: "outward-name", origin: workspace.origin(sha("web")), name: "orders", kindName: "dependency", evidence: [workspace.evidence(place, { snapshot: sha("web") })], disposition: "unserved" });
  const decision = (evidence: ReturnType<SetBuilder["evidence"]>) => decisions.part({ kind: "decision", context: decisions.read, decisionId: "repository:orders", kindName: "repository", subject: "orders", allowsFreeText: false, required: true, evidence: [evidence], options: [] });
  const gap = decision(decisions.evidence(place, { snapshot: sha("web") }));
  const { graph } = compose(workspace.build(), decisions.build());
  const [shares] = relations(graph, "shares-evidence");
  assert.deepEqual(shares?.value.kind === "shares-evidence" ? new Set(shares.value.parts) : undefined, new Set([stated, gap]));
  assert.equal(connections(graph, "shared-support").length, 1);

  const external = new SetBuilder("decisions-config", DECISIONS, sha("web"));
  external.part({ kind: "decision", context: external.read, decisionId: "remote:orders", kindName: "remote", subject: "orders", allowsFreeText: false, required: false, evidence: [external.evidence(place, { snapshot: "query-context" })], options: [] });
  const apart = compose(workspace.build(), external.build());
  assert.equal(relations(apart.graph, "shares-evidence").length, 0, "a query-context origin is not the snapshot's support");
  assert.equal(connections(apart.graph, "shared-support").length, 0);
});

test("query-context evidence is missing provenance only when its repository is absent from the source vector", () => {
  const workspace = new SetBuilder("workspace", WORKSPACE, sha("web"));
  const unplaced = workspace.evidence({ path: "src/Orders.java", line: 3 }, { snapshot: "query-context", repo: "orders" });
  const name = workspace.part({ kind: "outward-name", origin: workspace.origin("query-context"), name: "orders", kindName: "http-host", evidence: [unplaced], disposition: "unserved" });
  const decisions = new SetBuilder("decisions", DECISIONS, sha("web"));
  const external = decisions.evidence({ path: ".git/config", line: 1 }, { snapshot: "query-context", repo: "web" });
  const gap = decisions.part({ kind: "decision", context: decisions.read, decisionId: "remote:web", kindName: "remote", subject: "web", allowsFreeText: false, required: false, evidence: [], options: [{ value: "origin", basis: "origin", recommended: true, evidence: [external] }] });
  const result = compose(workspace.build(), decisions.build());
  const missing = issues(result, "missing-provenance");
  assert.ok(missing.some((issue) => issue.kind === "missing-provenance" && issue.repo === "orders" && issue.part === name), "a repo outside the vector has no proven snapshot");
  assert.ok(!missing.some((issue) => issue.kind === "missing-provenance" && (issue.repo === "web" || issue.part === gap)), "deliberately external configuration of a vector repo is not missing provenance");
});

test("an impact context part references its owner read", () => {
  const impact = new SetBuilder("impact", IMPACT, sha("shop"));
  impact.part({ kind: "impact-context", owner: impact.read, mergeBase: SHA_B, changedEntrypoints: { state: "present", count: 0 }, changedContracts: { state: "absent" } });
  const { graph } = compose(impact.build());
  const missingRead = "r1:" + "0".repeat(64) as ReadId;
  const result = validateCompositionReferences({ ...graph, parts: graph.parts.map((part) => (part.kind === "impact-context" ? { ...part, owner: missingRead } : part)) });
  assert.deepEqual(result.ok ? undefined : [result.fault.table, result.fault.field], ["parts", "owner"]);
});

test("an outline declaration references its children", () => {
  const outline = new SetBuilder("outline", OUTLINE, sha("shop"));
  const file = outline.file(PATH);
  const child = outline.part({ kind: "outline-declaration", anchor: outline.anchor(file, "check", 12, 14), kindName: "function" });
  outline.part({ kind: "outline-declaration", anchor: outline.anchor(file, "create", 10, 20), kindName: "method", children: [child] });
  const { graph } = compose(outline.build());
  const missingPart = "p1:" + "0".repeat(64) as PartId;
  const result = validateCompositionReferences({ ...graph, parts: graph.parts.map((part) => (part.kind === "outline-declaration" && part.children !== undefined ? { ...part, children: [missingPart] } : part)) });
  assert.deepEqual(result.ok ? undefined : [result.fault.table, result.fault.field], ["parts", "children"]);
});

function guardCase(entrypointsContext: ReadContext, outlineContext: ReadContext, outlineFamily: SourceFamilyRef = OUTLINE) {
  const entrypoints = new SetBuilder("entrypoints", ENTRYPOINTS, sha("shop"), entrypointsContext);
  const handler = entrypoints.anchor(entrypoints.file(PATH), HANDLER, 10, 20);
  entrypoints.part({ kind: "entrypoint", entry: httpRoute(handler), evidence: [] });
  const outline = new SetBuilder("outline", outlineFamily, sha("shop"), outlineContext);
  outline.part({ kind: "outline-declaration", anchor: outline.anchor(outline.file(PATH), "create", 10, 20), kindName: "method" });
  return compose(entrypoints.build(), outline.build());
}

test("semantic connections require compatible contexts and keep every read when they hold", () => {
  for (const [label, context] of [
    ["scope", { scopeInclude: ["src/**"] }], ["budget", { walkDepth: 3 }], ["targets", { targets: ["create"] }],
    ["an engine only one family used", { engines: { "outline-engine": "2" } }],
  ] as const) {
    const result = guardCase({ engines: { "spring-engine": "1" } }, context);
    assert.equal(connections(result.graph, "handler-declaration").length, 1, `${label} alone never blocks`);
  }
  for (const [label, context, field] of [
    ["trust", { trust: "untrusted" }, "trust"], ["producer", { producer: { name: "ye-ast", version: "2.0.0" } }, "producer"],
    ["schema", { schema: "0.11.0" }, "schema"], ["common engine", { engines: { shared: "2" } }, "engine"],
  ] as const) {
    const result = guardCase({ engines: { shared: "1" } }, context);
    assert.equal(connections(result.graph, "handler-declaration").length, 0, `${label} differs: no connection`);
    assert.ok(result.issues.some((issue) => issue.kind === "context-mismatch" && issue.field === field), `${label}: mismatch reported`);
    assert.equal(relations(result.graph, "serves-entrypoint").length, 1, `${label}: each observation stays`);
  }
});

function changeCase(seedContext: ReadContext, reachContext: ReadContext, outlineContext: ReadContext, workspace?: { seed: string; reach: string }) {
  const impact = new SetBuilder("impact", workspace === undefined ? IMPACT : WORKSPACE_IMPACT, sha("shop"), seedContext);
  const fileS = impact.file("src/S.java");
  impact.part({ kind: "seed", anchor: impact.anchor(fileS, "S", 5, 7), basis: "lines", comparison: { status: "available", value: { repo: "shop", mergeBase: SHA_B, head: impact.snapshot } } });
  const callers = new SetBuilder("callers", workspace === undefined ? CALLERS : { family: "callers", branch: "workspace" }, sha("shop"), reachContext);
  callers.part({ kind: "symbol-reach", anchor: callers.anchor(callers.file("src/C.java"), "C", 20, 30), kindName: "method", depth: 1, confidence: 1, fanIn: 1, via: { target: { file: callers.file("src/S.java"), symbol: "S" }, basis: "call" } });
  if (workspace !== undefined) {
    const context = (builder: SetBuilder, gateway: string) => builder.part({ kind: "workspace-context", context: { family: "impact", workspace: { repos: ["shop", "web"], gateways: [{ prefix: gateway, repo: "shop", basis: "gateway-prefix" }], unmatchedGateways: [], unserved: [], source: "request" }, trigger: { repo: "shop" }, repositorySnapshots: [{ repo: "shop", snapshot: builder.snapshot }] } });
    context(impact, workspace.seed);
    context(callers, workspace.reach);
  }
  const outline = new SetBuilder("outline", OUTLINE, sha("shop"), outlineContext);
  outline.part({ kind: "outline-declaration", anchor: outline.anchor(outline.file("src/S.java"), "S", 5, 7), kindName: "method" });
  return compose(impact.build(), callers.build(), outline.build());
}

test("compatibility is not transitive: A(X=1), B(no X), C(X=2) never connect A with C", () => {
  const consistent = changeCase({ engines: { X: "1" } }, { engines: { X: "1" } }, {});
  assert.equal(connections(consistent.graph, "change-dependent").length, 1, "control: A, B and C agree");
  const bridged = changeCase({ engines: { X: "1" } }, { engines: { X: "2" } }, {});
  assert.equal(relations(bridged.graph, "symbol-dependence").length, 1, "B still resolves C's endpoint");
  assert.equal(connections(bridged.graph, "change-dependent").length, 0, "B does not bridge A and C");
  assert.ok(bridged.issues.some((issue) => issue.kind === "context-mismatch" && issue.field === "engine"));
});


test("workspace membership and gateways must agree for a connection", () => {
  assert.equal(connections(changeCase({}, {}, {}, { seed: "/api", reach: "/api" }).graph, "change-dependent").length, 1);
  const differ = changeCase({}, {}, {}, { seed: "/api", reach: "/v2" });
  assert.equal(connections(differ.graph, "change-dependent").length, 0);
  assert.ok(differ.issues.some((issue) => issue.kind === "context-mismatch" && issue.field === "workspace"));
});

test("validateCompositionReferences resolves every reference and names the broken one", () => {
  const { graph } = handlerCase({ line: 10, endLine: 20 }, [{ line: 10, endLine: 20 }]);
  const builder = new SetBuilder("ws", WORKSPACE_IMPACT, sha("web"));
  workspaceLink(builder, { handlerSnapshot: sha("shop"), reach: ["L1"] });
  const workspace = compose(builder.build()).graph;
  assert.deepEqual(validateCompositionReferences(workspace), { ok: true, value: undefined }, "a missing reach id is an allowed variant");

  const missingAnchor = "a1:" + "0".repeat(64) as AnchorId;
  const missingRead = "r1:" + "0".repeat(64) as ReadId;
  const missingFile = "f1:" + "0".repeat(64) as FileId;
  const broken: [string, MaterializedGraph, string][] = [
    ["parts", { ...graph, parts: graph.parts.map((part) => (part.kind === "outline-declaration" ? { ...part, anchor: missingAnchor } : part)) }, "anchor"],
    ["anchors", { ...graph, anchors: graph.anchors.map((anchor) => ({ ...anchor, file: missingFile })) }, "file"],
    ["files", { ...graph, files: graph.files.map((file) => ({ ...file, supports: file.supports.map((s) => ({ ...s, read: missingRead })) })) }, "supports.read"],
    ["sources", { ...graph, sources: graph.sources.map((source) => ({ ...source, rootRead: missingRead })) }, "rootRead"],
    ["reads", { ...graph, reads: graph.reads.map((read) => ({ ...read, snapshot: "v1:" + "0".repeat(64) as `v1:${string}` })) }, "snapshot"],
    ["bindings", { ...graph, bindings: graph.bindings.map((b) => ({ ...b, binding: { status: "resolved" as const, entity: "n1:" + "0".repeat(64) as `n1:${string}` } })) }, "binding.entity"],
    ["entities", { ...graph, entities: graph.entities.map((e) => (e.kind === "declaration" ? { ...e, declarations: ["p1:" + "0".repeat(64) as PartId] } : e)) }, "declarations"],
    ["relations", { ...graph, relations: graph.relations.map((r) => ({ ...r, attestations: r.attestations.map((a) => ({ ...a, reads: [missingRead] })) })) }, "attestations.reads"],
    ["connections", { ...graph, connections: graph.connections.map((c) => ({ ...c, relations: ["l1:" + "0".repeat(64) as `l1:${string}`] })) }, "relations"],
    ["parts", { ...graph, parts: [...graph.parts, graph.parts[0]!] }, "id"],
  ];
  for (const [table, mutated, field] of broken) {
    const result = validateCompositionReferences(mutated);
    assert.equal(result.ok, false, `${table}.${field} is detected`);
    if (!result.ok) assert.deepEqual([result.fault.kind, result.fault.table, result.fault.field], ["invalid-composition-reference", table, field]);
  }
});


test("exact positive observations corroborate different producer versions without equating producers", () => {
  const imports = new SetBuilder("policy-importers", IMPORTERS, sha("shop"), { producer: {name:"ye-ast", version:"0.5.0"} });
  imports.part({kind:"file-dependency",from:imports.file("src/a.ts"),to:imports.file("src/b.ts"),category:"importer"});
  const outline = new SetBuilder("plain-outline", OUTLINE, sha("shop"), {producer:{name:"ye-ast",version:"0.4.0"}});
  outline.part({kind:"file-dependency",from:outline.file("src/a.ts"),to:outline.file("src/b.ts"),category:"outline-import"});
  const result = compose(imports.build(), outline.build());
  assert.equal(connections(result.graph,"shared-file-import").length,1);
  assert.equal(new Set(result.graph.reads.map(read=>read.producer.version)).size,2);
  assert.equal(relations(result.graph,"symbol-dependence").length,0);
  assert.equal(connections(guardCase({producer:{name:"ye-ast",version:"0.5.0"}},{producer:{name:"ye-ast",version:"0.4.0"}}).graph,"handler-declaration").length,0,"derivation retains strict producer guard");
});

function spellingCase(entrypointSymbol: string, reachSymbol: string, endLine: number | null = 20, entrypointsContext: ReadContext = {}) {
  const entrypoints = new SetBuilder("spelling-entrypoints", ENTRYPOINTS, sha("shop"), entrypointsContext);
  const handler = entrypoints.anchor(entrypoints.file(PATH), entrypointSymbol, 10, endLine ?? undefined);
  entrypoints.part({ kind: "entrypoint", entry: httpRoute(handler), evidence: [] });
  const callers = new SetBuilder("spelling-callers", CALLERS, sha("shop"));
  const reached = callers.anchor(callers.file(PATH), reachSymbol, 10, endLine ?? undefined);
  callers.part({ kind: "entrypoint-reach", kindName: "http-route", name: "POST /orders", handler: reached, depth: 1, confidence: 1, seeds: [] });
  const result = compose(entrypoints.build(), callers.build());
  return { graph: result.graph, issues: result.issues, handler, reached };
}

test("a qualified and a simple spelling of one span are one declaration without outline, so the reach joins its entrypoint", () => {
  const { graph, handler, reached } = spellingCase("OrderController.create", "create");
  assert.equal(entityOf(graph, handler)?.id, entityOf(graph, reached)?.id);
  assert.equal(connections(graph, "reached-handler").length, 1);
});

test("an entrypoint join needs compatible reads: the observing read and the catalog read keep the strict guard", () => {
  const otherProducer: ReadContext = { producer: { name: "ye-ast", version: "2.0.0" } };
  const producerMismatch = (found: readonly CompositionIssue[]) => found.some((issue) => issue.kind === "context-mismatch" && issue.field === "producer");

  const reached = spellingCase("OrderController.create", "create", 20, otherProducer);
  assert.equal(connections(reached.graph, "reached-handler").length, 0, "a reach never joins a catalog of another producer version");
  assert.ok(producerMismatch(reached.issues), "reached-handler: mismatch reported");

  const linked = linkedEntrypointCase([{}], sha("shop"), otherProducer);
  assert.equal(connections(linked.graph, "linked-entrypoint").length, 0, "a link never joins a catalog of another producer version");
  assert.ok(producerMismatch(linked.issues), "linked-entrypoint: mismatch reported");
});

test("two distinct qualified names of one span stay separate declarations", () => {
  const { graph, handler, reached } = spellingCase("OrderController.create", "LegacyController.create");
  assert.notEqual(entityOf(graph, handler)?.id, entityOf(graph, reached)?.id);
});

test("line-only anchors never join by name", () => {
  const { graph, handler, reached } = spellingCase("OrderController.create", "create", null);
  assert.notEqual(entityOf(graph, handler)?.id, entityOf(graph, reached)?.id);
});

test("every part citing one evidence location shares one relation and one support connection", () => {
  const workspace = new SetBuilder("workspace-many", WORKSPACE, sha("web"));
  const decisions = new SetBuilder("decisions-many", DECISIONS, sha("web"));
  const place = { path: "pom.xml", line: 7 };
  const stated = workspace.part({ kind: "outward-name", origin: workspace.origin(sha("web")), name: "orders", kindName: "dependency", evidence: [workspace.evidence(place, { snapshot: sha("web") })], disposition: "unserved" });
  const gaps = ["repository:orders", "remote:orders"].map((decisionId) => decisions.part({ kind: "decision", context: decisions.read, decisionId, kindName: "repository", subject: "orders", allowsFreeText: false, required: true, evidence: [decisions.evidence(place, { snapshot: sha("web") })], options: [] }));
  const { graph } = compose(workspace.build(), decisions.build());
  const shares = relations(graph, "shares-evidence");
  assert.equal(shares.length, 1);
  assert.deepEqual(shares[0]?.value.kind === "shares-evidence" ? shares[0].value.parts : undefined, [stated, ...gaps].toSorted());
  assert.equal(connections(graph, "shared-support").length, 1);
});

test("an incompatible read citing shared evidence leaves the compatible reads' support connection in place", () => {
  const place = { path: "pom.xml", line: 7 };
  const cite = (name: string, family: SourceFamilyRef, version: string) => {
    const builder = new SetBuilder(name, family, sha("web"), { engines: { typescript: version } });
    builder.part({ kind: "outward-name", origin: builder.origin(sha("web")), name, kindName: "dependency", evidence: [builder.evidence(place, { snapshot: sha("web") })], disposition: "unserved" });
    return builder;
  };
  const a = cite("a", WORKSPACE, "6.0.3");
  const b = cite("b", DECISIONS, "6.0.3");
  const c = cite("c", IMPORTERS, "5.9.3");
  const { graph } = compose(a.build(), b.build(), c.build());
  const supports = connections(graph, "shared-support");
  assert.deepEqual(supports.map((connection) => [...new Set(connection.supports.map((support) => support.read))].toSorted()), [[a.read, b.read].toSorted()]);
});

test("one read citing a location from two findings keeps its support connection", () => {
  const workspace = new SetBuilder("workspace-alone", WORKSPACE, sha("web"));
  const place = { path: "pom.xml", line: 7 };
  for (const name of ["orders", "billing"]) workspace.part({ kind: "outward-name", origin: workspace.origin(sha("web")), name, kindName: "dependency", evidence: [workspace.evidence(place, { snapshot: sha("web") })], disposition: "unserved" });
  assert.equal(connections(compose(workspace.build()).graph, "shared-support").length, 1);
});

test("a connection proven by several compatible read combinations is one connection carrying every proving read", () => {
  const route = (name: string) => {
    const builder = new SetBuilder(name, ENTRYPOINTS, sha("shop"));
    builder.part({ kind: "entrypoint", entry: httpRoute(builder.anchor(builder.file(PATH), HANDLER, 10, 20)), evidence: [] });
    return builder;
  };
  const wide = route("entrypoints-wide");
  const scoped = route("entrypoints-scoped");
  const outline = new SetBuilder("outline-one", OUTLINE, sha("shop"));
  outline.part({ kind: "outline-declaration", anchor: outline.anchor(outline.file(PATH), "create", 10, 20), kindName: "method" });
  const declarations = connections(compose(wide.build(), scoped.build(), outline.build()).graph, "handler-declaration");
  assert.equal(declarations.length, 1);
  assert.deepEqual(new Set(declarations[0]?.supports.map((support) => support.read)), new Set([wide.read, scoped.read, outline.read]));
});

// contract_consequences parts join through the relations that already exist (RFC-0023 "Compose"): no rule of their own.

type ConsequenceKind = "consequence-use" | "consequence-producer" | "derived-contract-change";
const HYPOTHESIS = { method: "GET", path: "/orders/{id}", target: "response", property: "customer", change: "removed" } as const;

/** The three part kinds over the same handler and the given places, each citing one place of its own. */
function consequenceParts(builder: SetBuilder, handler: AnchorId, places: Record<ConsequenceKind, ReturnType<SetBuilder["evidence"]>>) {
  const call = { file: builder.file("src/app/order.service.ts", { snapshot: sha("web"), repo: "web" }), line: 3, symbol: "OrderService.find" };
  const link = { id: "link", basis: "exact" as const, call, handler };
  const use = builder.part({ kind: "consequence-use", repo: "web", hypothesis: HYPOTHESIS, place: places["consequence-use"], link, verdict: { kind: "review", reason: "consumed" }, operation: { steps: [], end: { kind: "none" } }, path: "customer", changed: "customer", chain: [] });
  const producer = builder.part({ kind: "consequence-producer", repo: "web", hypothesis: HYPOTHESIS, place: builder.evidence({ path: "src/app/order.service.ts", line: 40 }, { snapshot: sha("web"), repo: "web" }), link, verdict: { kind: "incompatible", witness: { value: "absent", at: places["consequence-producer"], conditions: [] } }, path: "customer", chain: [] });
  const derived = builder.part({ kind: "derived-contract-change", hypothesis: HYPOTHESIS, operation: "GET /orders/{id}", property: "customer", places: { base: places["derived-contract-change"], head: builder.evidence({ path: "api/openapi.yaml", line: 12 }, { snapshot: sha("shop"), repo: "shop" }) }, handlers: [handler] });
  return { "consequence-use": use, "consequence-producer": producer, "derived-contract-change": derived };
}

test("every consequence part kind joins any other part that cites an equal place, through shares-evidence alone", () => {
  const consequences = new SetBuilder("consequences", CONSEQUENCES, sha("shop"));
  const other = new SetBuilder("other", WORKSPACE, sha("web"));
  const kinds: ConsequenceKind[] = ["consequence-use", "consequence-producer", "derived-contract-change"];
  const wherever = { "consequence-use": { path: "src/app/a.ts", line: 5 }, "consequence-producer": { path: "src/app/b.ts", line: 6 }, "derived-contract-change": { path: "api/openapi.yaml", line: 10 } };
  const repoOf = { "consequence-use": "web", "consequence-producer": "web", "derived-contract-change": "shop" };
  const places = Object.fromEntries(kinds.map((kind) => [kind, consequences.evidence(wherever[kind], { snapshot: sha(repoOf[kind]), repo: repoOf[kind] })])) as Record<ConsequenceKind, ReturnType<SetBuilder["evidence"]>>;
  const handler = consequences.anchor(consequences.file(PATH, { snapshot: sha("shop") }), HANDLER, 10, 20);
  const own = consequenceParts(consequences, handler, places);
  const cited = Object.fromEntries(kinds.map((kind) => [kind, other.part({ kind: "outward-name", origin: other.origin(sha(repoOf[kind])), name: kind, kindName: "dependency", evidence: [other.evidence(wherever[kind], { snapshot: sha(repoOf[kind]), repo: repoOf[kind] })], disposition: "unserved" })]));
  const { graph } = compose(consequences.build(), other.build());
  const shared = relations(graph, "shares-evidence").map((relation) => (relation.value.kind === "shares-evidence" ? relation.value.parts : []));
  for (const kind of kinds) assert.ok(shared.some((parts) => parts.length === 2 && parts.includes(own[kind]) && parts.includes(cited[kind]!)), `${kind} joins through its place`);
  assert.ok(graph.relations.every((relation) => relation.value.kind === "shares-evidence"), "no relation of their own");
});

test("a consequence part whose handler or place is local to its read is reported as missing provenance", () => {
  const consequences = new SetBuilder("consequences", CONSEQUENCES, sha("shop"));
  const handler = consequences.anchor(consequences.file(PATH, { snapshot: "query-context" }), HANDLER, 10, 20);
  const own = consequenceParts(consequences, handler, {
    "consequence-use": consequences.evidence({ path: "src/app/a.ts", line: 5 }, { snapshot: "query-context", repo: "elsewhere" }),
    "consequence-producer": consequences.evidence({ path: "src/app/b.ts", line: 6 }, { snapshot: sha("web"), repo: "web" }),
    "derived-contract-change": consequences.evidence({ path: "api/openapi.yaml", line: 10 }, { snapshot: sha("shop"), repo: "shop" }),
  });
  const missing = issues(compose(consequences.build()), "missing-provenance").flatMap((issue) => (issue.kind === "missing-provenance" ? [issue.part] : []));
  assert.ok(missing.includes(own["consequence-use"]), "a use with a handler and a place outside any snapshot");
  assert.ok(missing.includes(own["derived-contract-change"]), "a derived change that names that handler");
  assert.ok(missing.includes(own["consequence-producer"]), "a producer that names that handler");
});
