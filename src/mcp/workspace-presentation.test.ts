import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkspace } from "./render.ts";
import { present } from "./presentation/families/workspace.ts";
import { workspaceFixture } from "./presentation/families/workspace.fixtures.testing.ts";
import { LISTED_ITEMS } from "./render-budget.ts";
import type { WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

type Value = Omit<WorkspaceValue, "repositories">;
const original = workspaceFixture.status === "unknown" ? undefined! : workspaceFixture.value;
function fact(value: Partial<Value> = {}): Fact<Value> { return { ...workspaceFixture, status: "complete", value: { ...original, ...value } }; }
const rows = (value: Partial<Value>, section: string) => present(fact(value)).sections.find(item => item.id === section)!.rows;

test("unserved references preserve order and multiplicity only for exact qualified names with valid snapshot owners", () => {
  const section = original.sections["web"]!;
  if (section.status === "unknown") throw Error("fixture section is unknown");
  const qualified = section.value.names.map(name => ({ ...name, evidence: name.evidence.map(place => ({ ...place, repo: "web" })) }));
  const unserved = [qualified[1]!, qualified[0]!, qualified[1]!, { ...qualified[0]!, evidence: [{ repo: "web", path: "different.ts", line: 88 }] }, { ...qualified[0]!, evidence: [] }];
  const mapped = rows({ unserved }, "value.unserved");
  assert.deepEqual(mapped.slice(0, 3).map(row => row.label), ["outward web[1]", "outward web[0]", "outward web[1]"]);
  assert.equal(mapped[3]!.evidence![0]!.path, "different.ts");
  assert.equal(mapped[4]!.label, "http-host orders.example");
  for (const repositorySnapshots of [original.repositorySnapshots.map(item => ({ ...item, snapshot: { ...item.snapshot, repo: "wrong" } })), []]) {
    assert.ok(rows({ unserved, repositorySnapshots }, "value.unserved").every(row => !row.label.startsWith("outward ")));
  }
  const before = JSON.stringify(original);
  renderWorkspace(fact({ unserved }), "details");
  assert.equal(JSON.stringify(original), before);
});

test("outward evidence preserves repository ownership and relationship metadata and shares equal places", () => {
  const section = original.sections["web"]!;
  if (section.status === "unknown") throw Error("fixture section is unknown");
  const evidence = [{ path: "src/shared.ts", line: 9, via: "fetch", confidence: 0.6 }];
  const sections = { web: { ...section, value: { ...section.value, names: [{ kind: "http-host" as const, name: "host", evidence }, { kind: "path-prefix" as const, name: "prefix", evidence }] } } };
  const mapped = rows({ sections }, "value.sections.web.value.names");
  assert.deepEqual(mapped[0]!.evidence, [{ ...evidence[0], repo: "web" }]);
  const text = renderWorkspace(fact({ sections }), "details");
  assert.equal(text.split("shared.ts:9").length - 1, 1);
  assert.match(text, /via fetch confidence 0\.6/);
});

test("summary lists every cross-repository tier-0 link beyond LISTED_ITEMS and keeps internal links separate", () => {
  const links = Array.from({ length: LISTED_ITEMS + 1 }, (_, index) => ({ ...original.links[0]!, id: `link-${index}`, from: { ...original.links[0]!.from, line: index + 1, symbol: `call${index}` } }));
  assert.ok(links.length > LISTED_ITEMS);
  const value = { links, internalLinks: [links[0]!] };
  for (const mode of ["summary", "details"] as const) {
    const text = renderWorkspace(fact(value), mode);
    for (const link of links) assert.ok(text.includes(link.from.symbol));
    assert.match(text, /links inside one repository:/);
    assert.doesNotMatch(text, /mode "details"/);
  }
  assert.equal(rows(value, "value.links").length, links.length);
});

test("links preserve both endpoints, matching qualifications and drift", () => {
  const link = { ...original.links[0]!, confidence: 0.7, authority: "undecided" as const, profiles: ["prod"], drift: [{ segment: "daily-menus", parameter: "id", type: "UUID" as const }] };
  const row = rows({ links: [link] }, "value.links")[0]!;
  assert.deepEqual(row.place, { repo: "web", path: "src/client.ts", line: 1 });
  assert.equal(row.children![0]!.place!.repo, "api");
  for (const mode of ["summary", "details"] as const) {
    const text = renderWorkspace(fact({ links: [link] }), mode);
    for (const token of ["Controller.get", "GET /orders", "confidence 0.7", "under prod", "base URL undecided", '"daily-menus" fills id (UUID)']) assert.ok(text.includes(token), token);
  }
});

test("unlinked sites keep methods, outcomes, competing repositories and routes", () => {
  const one = original.unlinked[0]!;
  const { method: _method, ...two } = one;
  const mapped = rows({ unlinked: [one, { ...two, name: "/other" }] }, "value.unlinked");
  assert.match(mapped[0]!.label, /http DELETE \/gone: ambiguous/);
  assert.match(mapped[1]!.label, /http \/other: ambiguous/);
  assert.deepEqual(mapped[0]!.qualifiers, [{ name: "repositories", value: "api, other" }, { name: "routes", value: "DELETE /gone" }]);
});

test("unresolved and inherited gaps retain cause, libraries, requests, causal evidence and undecided count", () => {
  const section = original.sections["web"]!;
  if (section.status === "unknown") throw Error("fixture section is unknown");
  const callers = [{ path: "src/a.ts", line: 1, symbol: "a", through: [{ path: "src/through.ts", line: 2 }] }, { path: "src/b.ts", line: 3, symbol: "b", stated: { method: "GET" as const, path: "/users" } }];
  const value = { sections: { web: { ...section, value: { ...section.value, inherited: [{ causePlace: { path: "src/cause.ts", line: 10 }, reason: "unresolved" as const, transport: "http" as const, diagnostic: { cause: "source-not-read" as const }, via: "Client", callers }] } } } };
  const details = renderWorkspace(fact(value), "details");
  assert.match(details, /status: complete \(3 undecided\)/);
  for (const token of ["source-not-read", "destination-undecidable", "Client", "GET /users", "through.ts:2", "https://api.example"]) assert.ok(details.includes(token), token);
  assert.equal(details.split("cause.ts").length - 1, 1);
  assert.match(renderWorkspace(fact(value), "summary"), /GET \/users/);
});

test("cuts retain dependency ambiguity and candidates in both modes", () => {
  const section = original.sections["web"]!;
  if (section.status === "unknown") throw Error("fixture section is unknown");
  const cut = { kind: "unresolved-link" as const, reason: "join-unsettled" as const, at: ["pom.xml", "pom.xml:4"], reach: { kind: "anything" as const }, dependency: { name: "com.acme:clients", reason: "ambiguous" as const, candidates: ["one", "two"] } };
  for (const mode of ["summary", "details"] as const) assert.match(renderWorkspace(fact({ sections: { web: { ...section, status: "partial", cuts: [cut] } } }), mode), /com.acme:clients.*ambiguous.*one, two/);
});

test("names after an undecided base are context, retain places in details and raise no unserved row", () => {
  const presentation = present(fact({ unserved: [] }));
  const section = presentation.sections.find(item => item.id === "value.undecidedBase")!;
  assert.equal(section.role, "context");
  assert.equal(section.rows[0]!.evidence!.length, 16);
  assert.equal(presentation.sections.find(item => item.id === "value.unserved")!.rows.length, 0);
  assert.doesNotMatch(renderWorkspace(fact({ undecidedBase: [] }), "summary"), /names whose base is undecided/);
});

test("candidates refer to serving link rows only when every evidence place is represented without losing metadata", () => {
  const from = original.links[0]!.from;
  const evidence = [{ repo: from.repo, path: from.file, line: from.line }];
  const candidate = { name: "api", repo: "api", basis: "link" as const, evidence };
  const mapped = rows({ candidates: [candidate, { ...candidate, name: "extra", evidence: [...evidence, { repo: "web", path: "src/extra.ts", line: 7 }] }, { ...candidate, name: "metadata", evidence: [{ ...evidence[0]!, via: "fetch" }] }] }, "value.candidates");
  assert.deepEqual(mapped[0]!.evidence, []);
  assert.ok(mapped[0]!.qualifiers!.some(item => item.name === "links" && item.value === "0"));
  assert.equal(mapped[1]!.evidence!.length, 2);
  assert.equal(mapped[2]!.evidence![0]!.via, "fetch");
});
