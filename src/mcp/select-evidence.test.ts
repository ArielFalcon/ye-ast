import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { selectEvidence } from "./select-evidence.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { WorkspaceImpactValue, RepoImpact } from "../core/ports/workspace-impact-queries.port.ts";
import type { Link } from "../core/domain/topology/link.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

const base = {
  schema: "0.12.0", snapshot: { repo: "app", kind: "sha", sha: "head" },
  producer: { name: "test", version: "1" },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "c", declaredConfig: {}, engines: {} }, evidence: [],
} as const;
const handler = { path: "route.ts", symbol: "handle", line: 7 };
const seeds = [
  { file: "a.ts", symbol: "a", line: 1, basis: "lines" },
  { file: "b.ts", symbol: "b", line: 2, basis: "lines" },
  { file: "c.ts", symbol: "c", line: 3, basis: "lines" },
] as const;
const fact: Fact<ImpactValue> = { ...base, status: "complete", value: { seeds, symbols: [], entrypoints: [
  { kind: "job", handler, depth: 1, confidence: 1, seeds: [2, 1] },
  { kind: "job", handler, depth: 2, confidence: 1, seeds: [2] },
], cost: { expansionsUsed: 1 } } };

test("unions the recorded seed indexes of handler aliases in ascending order", async () => {
  const result = selectEvidence({ kind: "local", fact }, { kind: "handler-origins", owner: { kind: "local" }, handler });
  deepStrictEqual(result?.ok && result.value.availability === "available" ? result.value.items : undefined, [
    { seedIndex: 1, seed: seeds[1] }, { seedIndex: 2, seed: seeds[2] },
  ]);
});

const complete = <T>(value: T, repo = "app"): Fact<T> => ({ ...base, snapshot: { repo, kind: "sha", sha: "head" }, status: "complete", value });
const partial = <T>(value: T, repo = "app"): Fact<T> => ({ ...base, snapshot: { repo, kind: "sha", sha: "head" }, status: "partial", value, cuts: [{ kind: "depth", at: ["anchor", "one", "two"], limit: 3, reason: "depth", reach: { kind: "anything" } }] });
const unknown = { ...base, status: "unknown", reason: "deadline", evidence: [{ path: "unknown.ts", line: 9 }] } as const;
const handlerSelect = { kind: "handler-origins", owner: { kind: "local" }, handler } as const;
const selected = (result: ReturnType<typeof selectEvidence>) => {
  if (!result.ok || result.value.availability !== "available") throw new Error("expected available selection");
  return result.value;
};

test("handler origins distinguish empty, missing, malformed, and unknown", () => {
  const empty = complete({ ...fact.value, entrypoints: [{ ...fact.value.entrypoints[0]!, seeds: [] }] });
  deepStrictEqual(selected(selectEvidence({ kind: "local", fact: empty }, handlerSelect)).items, []);
  deepStrictEqual(selectEvidence({ kind: "local", fact }, { ...handlerSelect, handler: { ...handler, line: 8 } }), { ok: false, fault: { code: "selection-not-found" } });
  const malformed = complete({ ...fact.value, entrypoints: [{ ...fact.value.entrypoints[0]!, seeds: [9] }] });
  const bad = selectEvidence({ kind: "local", fact: malformed }, handlerSelect);
  if (!bad.ok) throw new Error("expected unavailable");
  deepStrictEqual({ availability: bad.value.availability, reason: bad.value.availability === "unavailable" && bad.value.reason }, { availability: "unavailable", reason: "unresolved" });
  const noSource = selectEvidence({ kind: "local", fact: unknown }, handlerSelect);
  if (!noSource.ok || noSource.value.availability !== "unavailable") throw new Error("expected unknown");
  deepStrictEqual([noSource.value.reason, noSource.value.evidence], ["deadline", unknown.evidence]);
});

test("module origins use the module domain, distinguish snapshots, and require recorded base", () => {
  const origins = [{ file: "zero", change: "added" }, { file: "one", change: "deleted" }, { file: "two", change: "modified" }] as const;
  const sha = "a".repeat(40);
  const impact: ImpactValue = { ...fact.value, mergeBase: sha, modules: { origins, modules: [{ file: "same", snapshot: "base", depth: 2, origins: [2, 1, 2] }, { file: "same", snapshot: "head", depth: 1, origins: [0] }], cost: { expansionsUsed: 1 } } };
  const source = { kind: "local", fact: complete(impact) } as const;
  const selection = { kind: "module-origins", owner: { kind: "local" }, module: { file: "same", snapshot: "base" } } as const;
  const result = selected(selectEvidence(source, selection));
  if (result.kind !== "module-origins") throw new Error("wrong kind");
  deepStrictEqual(result.items, [{ originIndex: 1, origin: origins[1] }, { originIndex: 2, origin: origins[2] }]);
  deepStrictEqual(result.context, { owner: selection.owner, snapshot: { repo: "app", kind: "sha", sha }, module: { file: "same", snapshot: "base", depth: 2 }, originCount: 3 });
  deepStrictEqual(selected(selectEvidence(source, { ...selection, module: { file: "same", snapshot: "head" } })).items, [{ originIndex: 0, origin: origins[0] }]);
  const duplicate = { ...impact, modules: { ...impact.modules!, modules: [impact.modules!.modules[0]!, impact.modules!.modules[0]!] } };
  deepStrictEqual(selectEvidence({ kind: "local", fact: complete(duplicate) }, selection), { ok: false, fault: { code: "ambiguous-selection" } });
  const { mergeBase: _base, ...missingBase } = impact;
  void _base;
  const bad = selectEvidence({ kind: "local", fact: complete(missingBase) }, selection);
  strictEqual(bad.ok && bad.value.availability === "unavailable" && bad.value.reason, "unresolved");
  const dangling = { ...impact, modules: { ...impact.modules!, modules: [{ file: "same", snapshot: "base" as const, depth: 1, origins: [3] }] } };
  const badOrigin = selectEvidence({ kind: "local", fact: complete(dangling) }, selection);
  strictEqual(badOrigin.ok && badOrigin.value.availability === "unavailable" && badOrigin.value.reason, "unresolved");
});

test("base module provenance accepts only the shared full object ID formats", () => {
  const selection = { kind: "module-origins", owner: { kind: "local" }, module: { file: "same", snapshot: "base" } } as const;
  const resolve = (mergeBase: string) => selectEvidence({ kind: "local", fact: complete({ ...fact.value, mergeBase, modules: { origins: [], modules: [{ file: "same", snapshot: "base" as const, depth: 0, origins: [] }], cost: { expansionsUsed: 0 } } }) }, selection);
  for (const id of ["a".repeat(41), "a".repeat(63), "HEAD"]) {
    const result = resolve(id);
    strictEqual(result.ok && result.value.availability === "unavailable" && result.value.reason, "unresolved");
  }
  for (const sha of ["a".repeat(40), "A".repeat(40), "b".repeat(64)]) {
    const result = selected(resolve(sha));
    if (result.kind !== "module-origins") throw new Error("wrong kind");
    deepStrictEqual(result.context.snapshot, { repo: "app", kind: "sha", sha });
  }
});

test("finding evidence preserves duplicate records and precise UI identity", () => {
  const evidence = [{ path: "ui.ts", line: 5 }, { path: "ui.ts", line: 5 }];
  const section = partial([
    { status: "unknown" as const, reason: "no-extractor" as const, evidence },
    { status: "complete" as const, value: { kind: "ui-route" as const, name: "/", path: "/", outlet: "side", component: { ...handler, endLine: 10 }, guards: [{ name: "guard" }] }, evidence },
    { status: "complete" as const, value: { kind: "ui-route" as const, name: "/x", path: "/x", component: "unknown" as const, guards: [] }, evidence: [] },
  ]);
  const source = { kind: "entrypoints", fact: complete({ entrypoints: section }) } as const;
  const first = selected(selectEvidence(source, { kind: "entrypoint-evidence", findingIndex: 0 }));
  if (first.kind !== "entrypoint-evidence") throw new Error("wrong kind");
  deepStrictEqual(first.context, { findingIndex: 0, section: { status: "partial" }, finding: { status: "unknown", reason: "no-extractor" } });
  deepStrictEqual(first.items, evidence.map((item, evidenceIndex) => ({ evidenceIndex, evidence: item })));
  const second = selected(selectEvidence(source, { kind: "entrypoint-evidence", findingIndex: 1 }));
  if (second.kind !== "entrypoint-evidence") throw new Error("wrong kind");
  deepStrictEqual(second.context.finding, { status: "complete", identity: { kind: "ui-route", name: "/", path: "/", outlet: "side", component: { ...handler, endLine: 10 } } });
  const third = selected(selectEvidence(source, { kind: "entrypoint-evidence", findingIndex: 2 }));
  if (third.kind !== "entrypoint-evidence") throw new Error("wrong kind");
  deepStrictEqual(third.context.finding, { status: "complete", identity: { kind: "ui-route", name: "/x", path: "/x", component: "unknown" } });
  deepStrictEqual(selectEvidence(source, { kind: "entrypoint-evidence", findingIndex: 3 }), { ok: false, fault: { code: "selection-not-found" } });
});

const link: Link = { id: "link/1", from: { repo: "constructor", file: "a", line: 1, symbol: "a" }, to: { repo: "__proto__", kind: "job", name: "job", handler }, transport: "http", basis: "exact", confidence: 1 };
const repoValue: RepoImpact = { reads: [{ kind: "discovery", fact: partial(null) }], impact: fact.value, callSites: [], unmatched: [], external: [], unresolved: [] };
const workspace: WorkspaceImpactValue = {
  workspace: { repos: ["constructor", "__proto__"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
  repositorySnapshots: [], trigger: { repo: "constructor", mergeBase: "a".repeat(40) },
  sections: Object.fromEntries([["constructor", partial(repoValue, "constructor")], ["__proto__", complete(repoValue, "__proto__")]]),
  links: [{ link, direction: "upstream", reach: ["link/1", "absent"] }],
};

test("workspace link reach uses recorded order and actual endpoint provenance", () => {
  const source = { kind: "workspace", fact: partial(workspace) } as const;
  const before = structuredClone(source);
  const result = selected(selectEvidence(source, { kind: "workspace-link-evidence", linkId: "link/1" }));
  if (result.kind !== "workspace-link-evidence") throw new Error("wrong kind");
  deepStrictEqual(result.items, [{ position: 0, linkId: "link/1", link }, { position: 1, linkId: "absent", unavailable: true }]);
  deepStrictEqual(result.context, { link, direction: "upstream", reachCount: 2, endpoints: { from: { snapshot: { repo: "constructor", kind: "sha", sha: "head" }, analysis: { status: "partial" } }, to: { snapshot: { repo: "__proto__", kind: "sha", sha: "head" }, analysis: { status: "complete" } } } });
  deepStrictEqual(source, before);
  deepStrictEqual(result.source.reads.map((read) => read.owner), [{ kind: "section", repo: "__proto__" }, { kind: "read", repo: "__proto__", index: 0 }, { kind: "section", repo: "constructor" }, { kind: "read", repo: "constructor", index: 0 }]);
  deepStrictEqual(result.source.limits, [
    { owner: { kind: "fact" }, kind: "depth", cuts: 1, places: 2, limit: 3 },
    { owner: { kind: "read", repo: "__proto__", index: 0 }, kind: "depth", cuts: 1, places: 2, limit: 3 },
    { owner: { kind: "section", repo: "constructor" }, kind: "depth", cuts: 1, places: 2, limit: 3 },
    { owner: { kind: "read", repo: "constructor", index: 0 }, kind: "depth", cuts: 1, places: 2, limit: 3 },
  ]);
  const absent = { ...workspace, sections: {} };
  const noProvenance = selectEvidence({ kind: "workspace", fact: complete(absent) }, { kind: "workspace-link-evidence", linkId: link.id });
  strictEqual(noProvenance.ok && noProvenance.value.availability === "unavailable" && noProvenance.value.reason, "unresolved");
  const duplicate = { ...workspace, links: [...workspace.links, workspace.links[0]!] };
  deepStrictEqual(selectEvidence({ kind: "workspace", fact: complete(duplicate) }, { kind: "workspace-link-evidence", linkId: link.id }), { ok: false, fault: { code: "ambiguous-selection" } });
  deepStrictEqual(selectEvidence({ kind: "workspace", fact: complete(absent) }, { kind: "handler-origins", owner: { kind: "section", repo: "constructor" }, handler }), { ok: false, fault: { code: "selection-not-found" } });
});

test("cut selection addresses all owners using public indices and preserves separate limits", () => {
  const entrySource = { kind: "entrypoints", fact: partial({ entrypoints: partial([] as readonly never[]) }) } as const;
  const workspaceSource = { kind: "workspace", fact: partial(workspace) } as const;
  const cases = [
    { source: entrySource, owner: { kind: "fact" } },
    { source: entrySource, owner: { kind: "entrypoints" } },
    { source: workspaceSource, owner: { kind: "section", repo: "constructor" } },
    { source: workspaceSource, owner: { kind: "read", repo: "constructor", index: 0 } },
  ] as const;
  for (const { source, owner } of cases) {
    const result = selected(selectEvidence(source, { kind: "cut-places", owner, cutIndex: 0 }));
    if (result.kind !== "cut-places") throw new Error("wrong kind");
    deepStrictEqual(result.items, [{ atIndex: 1, place: "one" }, { atIndex: 2, place: "two" }]);
    deepStrictEqual({ owner: result.context.owner, anchor: result.context.anchor, analysis: result.context.analysis }, { owner, anchor: "anchor", analysis: { status: "partial" } });
  }
  const noAnchor: Fact<ImpactValue> = { ...base, status: "partial", value: fact.value, cuts: [{ kind: "depth", at: [], reason: "depth", reach: { kind: "anything" } }] };
  const unavailable = selectEvidence({ kind: "local", fact: noAnchor }, { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 });
  strictEqual(unavailable.ok && unavailable.value.availability === "unavailable" && unavailable.value.reason, "unresolved");
  deepStrictEqual(selectEvidence(workspaceSource, { kind: "cut-places", owner: { kind: "read", repo: "constructor", index: 1 }, cutIndex: 0 }), { ok: false, fault: { code: "selection-not-found" } });
});

test("workspace module base belongs to the selected owner, never an unrelated trigger", () => {
  const modules: ImpactValue["modules"] = { origins: [{ file: "changed", change: "modified" }], modules: [{ file: "module", snapshot: "base", depth: 0, origins: [0] }], cost: { expansionsUsed: 0 } };
  const sectionValue: RepoImpact = { ...repoValue, impact: { ...fact.value, modules } };
  const modified = { ...workspace, sections: Object.fromEntries([["constructor", complete(sectionValue, "constructor")], ["__proto__", complete(sectionValue, "__proto__")]]) };
  const selection = { kind: "module-origins", owner: { kind: "section", repo: "constructor" }, module: { file: "module", snapshot: "base" } } as const;
  const result = selected(selectEvidence({ kind: "workspace", fact: complete(modified) }, selection));
  if (result.kind !== "module-origins") throw new Error("wrong kind");
  deepStrictEqual(result.context.snapshot, { repo: "constructor", kind: "sha", sha: "a".repeat(40) });
  const other = selectEvidence({ kind: "workspace", fact: complete(modified) }, { ...selection, owner: { kind: "section", repo: "__proto__" } });
  strictEqual(other.ok && other.value.availability === "unavailable" && other.value.reason, "unresolved");
});

test("HTTP finding identity excludes nested base path while retaining optional coordinates", () => {
  const route: Entrypoint = { kind: "http-route", name: "GET /x", method: "GET", path: "/x", version: "v1", handler: { ...handler, endLine: 12 }, basePath: { status: "unknown", reason: "unresolved", evidence: [{ path: "config", line: 1 }] } };
  const source = { kind: "entrypoints", fact: complete({ entrypoints: complete([{ status: "complete" as const, value: route, evidence: [{ path: "route", line: 2 }] }]) }) } as const;
  const result = selected(selectEvidence(source, { kind: "entrypoint-evidence", findingIndex: 0 }));
  if (result.kind !== "entrypoint-evidence") throw new Error("wrong kind");
  deepStrictEqual(result.context.finding, { status: "complete", identity: { kind: "http-route", name: "GET /x", method: "GET", path: "/x", version: "v1", handler: { ...handler, endLine: 12 } } });
  deepStrictEqual(result.source.reads[0], { owner: { kind: "entrypoints" }, schema: base.schema, snapshot: base.snapshot, producer: base.producer, inputs: base.inputs, analysis: { status: "complete" } });
});

test("unknown section and read cuts return their recorded reason and evidence", () => {
  const unknownSection = { ...workspace, sections: { repo: unknown } };
  const sectionResult = selectEvidence({ kind: "workspace", fact: complete(unknownSection) }, { kind: "cut-places", owner: { kind: "section", repo: "repo" }, cutIndex: 0 });
  if (!sectionResult.ok || sectionResult.value.availability !== "unavailable") throw new Error("expected unavailable");
  deepStrictEqual([sectionResult.value.reason, sectionResult.value.evidence], ["deadline", unknown.evidence]);
  const withUnknownRead = { ...workspace, sections: { repo: complete({ ...repoValue, reads: [{ kind: "upstream" as const, fact: unknown }] }) } };
  const readResult = selectEvidence({ kind: "workspace", fact: complete(withUnknownRead) }, { kind: "cut-places", owner: { kind: "read", repo: "repo", index: 0 }, cutIndex: 0 });
  if (!readResult.ok || readResult.value.availability !== "unavailable") throw new Error("expected unavailable");
  deepStrictEqual([readResult.value.reason, readResult.value.evidence], ["deadline", unknown.evidence]);
  deepStrictEqual(readResult.value.source.reads[1]?.analysis, { status: "unknown", reason: "deadline" });
});

test("source limits group only matching owner, kind and limit", () => {
  const multiple: Fact<ImpactValue> = { ...base, status: "partial", value: fact.value, cuts: [{ kind: "depth", at: ["a", "b"], limit: 3, reason: "depth", reach: { kind: "anything" } }, { kind: "depth", at: ["c", "d", "e"], limit: 3, reason: "depth", reach: { kind: "anything" } }, { kind: "depth", at: ["f"], limit: 4, reason: "depth", reach: { kind: "anything" } }, { kind: "hub", at: ["g", "h"], reason: "hub", reach: { kind: "anything" } }] };
  const result = selected(selectEvidence({ kind: "local", fact: multiple }, handlerSelect));
  deepStrictEqual(result.source.limits, [
    { owner: { kind: "fact" }, kind: "depth", cuts: 2, places: 3, limit: 3 },
    { owner: { kind: "fact" }, kind: "depth", cuts: 1, places: 0, limit: 4 },
    { owner: { kind: "fact" }, kind: "hub", cuts: 1, places: 1 },
  ]);
  deepStrictEqual(result.source.analysis, { status: "partial" });
});

test("missing owning and endpoint snapshots produce unresolved with owner evidence", () => {
  const section = structuredClone(partial(repoValue, "constructor"));
  Reflect.deleteProperty(section, "snapshot");
  const source = { kind: "workspace", fact: complete({ ...workspace, sections: Object.fromEntries([["constructor", section], ["__proto__", complete(repoValue, "__proto__")]]) }) } as const;
  const handlerResult = selectEvidence(source, { kind: "handler-origins", owner: { kind: "section", repo: "constructor" }, handler });
  if (!handlerResult.ok || handlerResult.value.availability !== "unavailable") throw new Error("expected unavailable");
  deepStrictEqual([handlerResult.value.reason, handlerResult.value.evidence], ["unresolved", section.evidence]);
  const linkResult = selectEvidence(source, { kind: "workspace-link-evidence", linkId: link.id });
  strictEqual(linkResult.ok && linkResult.value.availability === "unavailable" && linkResult.value.reason, "unresolved");
});

test("link endpoint preserves unknown analysis when its provenance is present", () => {
  const unknownEndpoint = { ...unknown, snapshot: { repo: "__proto__", kind: "sha" as const, sha: "endpoint" } };
  const modified = { ...workspace, sections: Object.fromEntries([["constructor", complete(repoValue, "constructor")], ["__proto__", unknownEndpoint]]) };
  const result = selected(selectEvidence({ kind: "workspace", fact: complete(modified) }, { kind: "workspace-link-evidence", linkId: link.id }));
  if (result.kind !== "workspace-link-evidence") throw new Error("wrong kind");
  deepStrictEqual(result.context.endpoints.to, { snapshot: unknownEndpoint.snapshot, analysis: { status: "unknown", reason: "deadline" } });
});

test("cut projections keep the typed reason and dependency diagnostic that discovery recorded", () => {
  const source = { ...fact, status: "partial" as const, cuts: [{ kind: "unresolved-link" as const, reason: "dependency-unresolved" as const, reach: { kind: "anything" as const }, at: ["broken.java", "broken.java:3"], dependency: { name: "com.acme:clients", reason: "ambiguous" as const, candidates: ["one", "two"] } }] as const };
  const result = selected(selectEvidence({ kind: "local", fact: source }, { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 }));
  strictEqual(result.kind === "cut-places" && result.context.reason, "dependency-unresolved");
  deepStrictEqual(result.kind === "cut-places" && result.context.dependency, source.cuts[0].dependency);
});

test("a cut's context carries its reason and, where it has one, its sub-reason", () => {
  const cut = (subReason?: "capability-absent") => ({ kind: "unresolved-link", at: ["src/flow.ts:2 save", "src/a.ts::A.save"], reason: "dispatch", ...(subReason === undefined ? {} : { subReason }), reach: { kind: "anything" } }) as const;
  for (const subReason of ["capability-absent", undefined] as const) {
    const result = selectEvidence({ kind: "local", fact: { ...base, status: "partial", value: fact.value, cuts: [cut(subReason)] } }, { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 });
    const context = result.ok && result.value.availability === "available" && result.value.kind === "cut-places" ? result.value.context : undefined;
    deepStrictEqual({ reason: context?.reason, subReason: context?.subReason, has: context !== undefined && "subReason" in context }, { reason: "dispatch", subReason, has: subReason !== undefined });
  }
});
