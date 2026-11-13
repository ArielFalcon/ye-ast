import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkspace } from "./render.ts";

const base = { schema: "0.12.0", snapshot: { repo: "a", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };

test("mixed unserved references reconstruct original order, multiplicity and qualified ownership", () => {
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const name = (i: number) => ({ kind: "http-host", name: `a-long-service-name-${i}.example`, evidence: [{ path: "src/a-long-shared-location.ts", line: i + 1, ...(i === 1 ? { via: "client", confidence: 0.75 } : {}) }] });
  const names = Array.from({ length: 20 }, (_, i) => name(i));
  const section = (repo: string, status: string) => ({ ...base, snapshot: snapshot(repo), status, ...(status === "partial" ? { cuts: [] } : {}), value: { names, unresolved: [{ reason: "unresolved", evidence: [{ path: "src/shared.ts", line: 4 }], path: "src/shared.ts", line: 4, symbol: "call", transport: "http", via: "client", stated: { method: "GET", path: "/route" } }] } });
  const qualified = (repo: string, i: number) => ({ ...names[i]!, evidence: names[i]!.evidence.map(e => ({ ...e, repo })) });
  const unserved = [qualified("b", 1), qualified("a", 0), qualified("b", 1), ...names.slice(2).map((_, i) => qualified("a", i + 2)), { ...qualified("a", 1), evidence: [{ path: "different.ts", line: 88, repo: "a" }] }, { ...name(0), evidence: [] }];
  const value = { workspace: { repos: ["a", "b", "unknown"], source: "request" }, repositorySnapshots: ["a", "b", "unknown"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: { a: section("a", "partial"), b: section("b", "complete"), unknown: { ...base, snapshot: snapshot("unknown"), status: "unknown", reason: "unavailable" } }, candidates: [], links: [], unlinked: [], unserved };
  const fact = { ...base, status: "complete", value } as never;
  const before = JSON.stringify(fact);
  const text = renderWorkspace(fact, "details");
  const rows = text.split("no local repository serves (")[1]!.split("\nunresolved call sites")[0]!.split("\ncuts for repository")[0]!;
  const refs = [...rows.matchAll(/^  - outward ("[^"]+")\[(\d+)\]$/gm)].map(m => [JSON.parse(m[1]!), Number(m[2])]);
  assert.deepEqual(refs, [["b", 1], ["a", 0], ["b", 1], ...names.slice(2).map((_, i) => ["a", i + 2])]);
  assert.match(text, /"via":"client","confidence":0\.75/);
  assert.match(rows, /different\.ts:88/);
  assert.match(rows, /http-host a-long-service-name-0\.example/);
  assert.match(text, /unknown: unknown \(unavailable\)/);
  assert.match(text, /unresolved call sites \(2\):[\s\S]*  a:[\s\S]*src\/shared.ts[\s\S]*call \(http, through client\) GET \/route[\s\S]*  b:/);
  const invalid = { ...value, repositorySnapshots: value.repositorySnapshots.map(item => item.repo === "b" ? { ...item, snapshot: snapshot("wrong") } : item) };
  const invalidText = renderWorkspace({ ...base, status: "complete", value: invalid } as never, "details");
  assert.doesNotMatch(invalidText, /  - outward "b"\[/);
  assert.match(invalidText, /b:src\/a-long-shared-location.ts:2/);
  const wrongSnapshot = snapshot("wrong");
  const bothWrong = { ...value, sections: { ...value.sections, b: { ...value.sections.b, snapshot: wrongSnapshot } }, repositorySnapshots: value.repositorySnapshots.map(item => item.repo === "b" ? { ...item, snapshot: wrongSnapshot } : item) };
  const wrongOwnerText = renderWorkspace({ ...base, status: "complete", value: bothWrong } as never, "details");
  assert.doesNotMatch(wrongOwnerText, /  - outward "b"\[/);
  assert.match(wrongOwnerText, /b:src\/a-long-shared-location.ts:2/);
  assert.equal(JSON.stringify(fact), before);
});

test("whole-category reference requires the same order as the displayed names", () => {
  const names = Array.from({ length: 12 }, (_, i) => ({ kind: "http-host", name: `long-service-${i}.example`, evidence: [{ path: "src/a-very-long-shared-evidence-file.ts", line: i + 1 }] }));
  const unserved = names.map(name => ({ ...name, evidence: name.evidence.map(e => ({ ...e, repo: "a" })) }));
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }], sections: { a: { ...base, status: "complete", value: { names, unresolved: [] } } }, candidates: [], links: [], unlinked: [], unserved: [...unserved].reverse() };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.doesNotMatch(text, /all recorded outward names are unserved/);
  const runs = [...text.matchAll(/^  outward ("[^"]+") indexes (\[[^\n]+\])$/gm)];
  assert.equal(runs.length, 1);
  assert.equal(JSON.parse(runs[0]![1]!), "a");
  const indexes = JSON.parse(runs[0]![2]!);
  assert.deepEqual(indexes, names.map((_, i) => names.length - i - 1));
  for (const name of names) assert.equal(text.split(name.name).length - 1, 1);
  for (let i = 0; i < names.length; i++) assert.ok(text.includes(`- [${i}] ${names[i]!.name} (`));
  const bSnapshot = { ...base.snapshot, repo: "b" };
  const bNames = unserved.map(name => ({ ...name, evidence: name.evidence.map(evidence => ({ ...evidence, repo: "b" })) }));
  const multi = { ...value, workspace: { repos: ["a", "b"], source: "request" }, repositorySnapshots: [...value.repositorySnapshots, { repo: "b", snapshot: bSnapshot }], sections: { ...value.sections, b: { ...value.sections.a, snapshot: bSnapshot } }, unserved: [...unserved, ...bNames, ...unserved] };
  const multiText = renderWorkspace({ ...base, status: "complete", value: multi } as never, "details");
  const multiRuns = [...multiText.matchAll(/^  outward ("[^"]+") indexes (\[[^\n]+\])$/gm)].map(m => ({ repo: JSON.parse(m[1]!), indexes: JSON.parse(m[2]!) }));
  const forward = names.map((_, index) => index);
  assert.deepEqual(multiRuns, [{ repo: "a", indexes: forward }, { repo: "b", indexes: forward }, { repo: "a", indexes: forward }]);
});

test("invalid snapshot ownership and tiny results retain literal rows", () => {
  const name = { kind: "http-host", name: "host", evidence: [{ path: "a.ts", line: 1 }] };
  const snapshot = { ...base.snapshot, sha: "b".repeat(40) };
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot }], sections: { a: { ...base, status: "complete", value: { names: [name], unresolved: [] } } }, candidates: [], links: [], unlinked: [], unserved: [{ ...name, evidence: [{ ...name.evidence[0]!, repo: "a" }] }] };
  for (const v of [value, { ...value, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }] }]) {
    const text = renderWorkspace({ ...base, status: "complete", value: v } as never, "details");
    assert.match(text, /  - http-host host \(a:a\.ts:1\)/);
    assert.doesNotMatch(text, /  - outward /);
  }
  const empty = { ...value, unserved: [], sections: { a: { ...base, status: "complete", value: { names: [], unresolved: [] } } } };
  assert.match(renderWorkspace({ ...base, status: "complete", value: empty } as never, "details"), /no local repository serves \(0\)/);
});

test("index permutations cannot hide evidence relationship metadata", () => {
  const names = Array.from({ length: 20 }, (_, i) => ({ kind: "http-host", name: `service-with-a-long-name-${i}.example`, evidence: [{ path: "src/long-evidence-path.ts", line: i + 1, via: "fetch", confidence: 0.6 }] }));
  const unserved = names.map(name => ({ ...name, evidence: name.evidence.map(evidence => ({ ...evidence, repo: "a" })) })).reverse();
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }], sections: { a: { ...base, status: "complete", value: { names, unresolved: [] } } }, candidates: [], links: [], unlinked: [], unserved };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.match(text, /"via":"fetch","confidence":0\.6/);
});

function linkOf(line: number, to = "orders", transport: "http" | "event" = "http") {
  return { id: `link-${line}`, from: { repo: "shop-web", file: "src/app/orders-client.service.ts", line, symbol: `OrdersClient.call${line}` }, to: { repo: to, kind: "http-route", name: "POST /orders/{}/confirmations", handler: { path: "src/main/java/app/OrdersController.java", symbol: "OrdersController.confirm", line: 40 } }, transport, basis: "exact", confidence: 1 };
}

function mapValue(links: readonly ReturnType<typeof linkOf>[], unlinked: readonly unknown[] = []) {
  return { workspace: { repos: ["shop-web"], gateways: [], source: "request" }, repositorySnapshots: [{ repo: "shop-web", snapshot: base.snapshot }], sections: {}, candidates: [], unserved: [], links, unlinked };
}

test("a workspace summary counts its links per caller, callee and transport when that is shorter, and details lists each one in the impact's link line", () => {
  const value = mapValue([linkOf(7), linkOf(9), linkOf(11), linkOf(13, "billing", "event")]);

  const summary = renderWorkspace({ ...base, status: "complete", value } as never, "summary");
  const details = renderWorkspace({ ...base, status: "complete", value } as never, "details");

  assert.match(summary, /links between the repositories read \(4\):\n  - shop-web -> orders http: 3\n  - shop-web -> billing event: 1\n  mode "details" lists each link/);
  assert.doesNotMatch(summary, /OrdersClient\.call7/);
  assert.match(details, /\n  - 1\. shop-web:src\/app\/orders-client\.service\.ts:7 OrdersClient\.call7 -> orders POST \/orders\/\{\}\/confirmations -> src\/main\/java\/app\/OrdersController\.java:40 OrdersController\.confirm \(exact\)\n/);
  assert.equal(details.split("\n").filter((line) => line.includes("OrdersClient.call")).length, 4);
});

test("a workspace summary keeps the link list when it is shorter than the counts, and lists the call sites the join reached without a link", () => {
  const short = { ...linkOf(7), from: { repo: "a", file: "x.ts", line: 7, symbol: "f" }, to: { repo: "b", kind: "http-route", name: "GET /", handler: { path: "y.java", symbol: "g", line: 1 } } };
  const value = mapValue([short], [{ from: { repo: "a", file: "x.ts", line: 9, symbol: "h" }, transport: "http", outcome: "ambiguous", name: "shared", repos: ["b", "c"], routes: ["GET /shared"] }]);

  const summary = renderWorkspace({ ...base, status: "complete", value } as never, "summary");

  assert.match(summary, /links between the repositories read \(1\):\n  - 1\. a:x\.ts:7 f -> b GET \/ -> y\.java:1 g \(exact\)\n/);
  assert.match(summary, /call sites the join reached without a link \(1\):\n  - a:x\.ts:9 h http shared: ambiguous \(b, c\) routes GET \/shared$/m);
});

test("a link whose literal segment a producer variable cannot parse is listed with its drift", () => {
  const drifting = { ...linkOf(7), drift: [{ segment: "daily-menus", parameter: "id", type: "UUID" }] };

  const details = renderWorkspace({ ...base, status: "complete", value: mapValue([drifting, linkOf(9)]) } as never, "details");

  assert.match(details, /OrdersClient\.call7 -> .* \(exact, drift: "daily-menus" fills id \(UUID\)\)\n/);
  assert.match(details, /OrdersClient\.call9 -> .* \(exact\)$/);
});

test("unresolved diagnostics stay compact in summaries and retain causal evidence in details", () => {
  const sites = [
    { path: "src/Calls.java", line: 4, symbol: "Calls.send", transport: "event", reason: "unresolved", evidence: [{ path: "src/Calls.java", line: 4 }], diagnostic: { cause: "source-not-read", source: "not-read" }, via: "com.acme.Messenger" },
    { path: "src/Calls.java", line: 8, symbol: "Calls.load", transport: "http", reason: "unresolved", evidence: [{ path: "src/Calls.java", line: 8 }, { path: "(library)/lib/Client.java", line: 12 }], diagnostic: { cause: "destination-undecidable", source: "read", alternatives: ["https://images.example"] }, via: "com.acme.RestClient" },
    { path: "src/Calls.java", line: 10, symbol: "Calls.dispatch", transport: "http", reason: "unresolved", evidence: [], diagnostic: { cause: "dispatch-disagreement" } },
    { path: "src/Calls.java", line: 11, symbol: "Calls.loop", transport: "http", reason: "unresolved", evidence: [], diagnostic: { cause: "recursive" } },
    { path: "src/Calls.java", line: 12, symbol: "Calls.bad", transport: "http", reason: "source-unreadable", evidence: [] },
  ];
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }], sections: { a: { ...base, status: "complete", value: { names: [], unresolved: sites } } }, candidates: [], links: [], unlinked: [], unserved: [] };
  const fact = { ...base, status: "complete", value } as never;
  const summary = renderWorkspace(fact, "summary");
  const details = renderWorkspace(fact, "details");
  assert.match(summary, /Calls.send .* missing$/m);
  assert.match(summary, /Calls.load .* target$/m);
  assert.match(summary, /Calls.dispatch .* conflict$/m);
  assert.match(summary, /Calls.loop .* cycle$/m);
  assert.match(summary, /Calls.bad .* parse$/m);
  assert.doesNotMatch(summary, /Client.java:12|source-not-read|destination-undecidable/);
  assert.match(details, /unresolved\/source-not-read.*not-read/);
  assert.match(details, /unresolved\/destination-undecidable.*read/);
  assert.match(details, /\(library\)\/lib\/Client.java:12/);
  assert.match(details, /Calls.load .*chosen at run time, declared alternatives: https:\/\/images\.example/);
  assert.doesNotMatch(summary, /images\.example/);
});

test("dependency ambiguity remains visible with its candidates in both workspace text modes", () => {
  const cut = { kind: "unresolved-link", reason: "unresolved", at: ["pom.xml", "pom.xml:4"], dependency: { name: "com.acme:clients", reason: "ambiguous", candidates: ["one", "two"] } };
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }], sections: { a: { ...base, status: "partial", cuts: [cut], value: { names: [], unresolved: [] } } }, candidates: [], links: [], unlinked: [], unserved: [] };
  for (const mode of ["summary", "details"] as const) {
    const text = renderWorkspace({ ...base, status: "complete", value } as never, mode);
    assert.match(text, /com.acme:clients.*ambiguous.*one, two/);
    if (mode === "details") assert.match(text, /pom.xml.*4/);
  }
});

type Site = { path: string; line: number; symbol: string; transport: string; reason: string; evidence: unknown[]; diagnostic?: { cause: string }; stated?: { method: string; path?: string } };

function unresolvedWorkspace(perRepo: Record<string, Site[]>, anchors: { links?: { repo: string; file: string }[]; unlinked?: { repo: string; file: string }[] } = {}): never {
  const repos = Object.keys(perRepo);
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const from = ({ repo, file }: { repo: string; file: string }) => ({ repo, file, line: 1, symbol: "caller" });
  const sections = Object.fromEntries(repos.map((repo) => [repo, { ...base, snapshot: snapshot(repo), status: "complete", value: { names: [], unresolved: perRepo[repo] } }]));
  const links = (anchors.links ?? []).map((place) => ({ id: `link-${place.file}`, from: from(place), to: { repo: "z", kind: "http", name: "GET /x", handler: { path: "h.ts", line: 1, symbol: "h" } }, transport: "http", basis: "exact", confidence: 1 }));
  const unlinked = (anchors.unlinked ?? []).map((place) => ({ from: from(place), transport: "http", outcome: "unmatched", name: "/x" }));
  const value = { workspace: { repos, source: "request" }, repositorySnapshots: repos.map((repo) => ({ repo, snapshot: snapshot(repo) })), sections, candidates: [], links, unlinked, unserved: [] };
  return { ...base, status: "complete", value } as never;
}

const site = (path: string, line: number, cause: string | undefined, extra: Partial<Site> = {}): Site => ({ path, line, symbol: `Symbol.method${line}`, transport: "http", reason: "unresolved", evidence: [{ path, line }], ...(cause === undefined ? {} : { diagnostic: { cause } }), ...extra });

function unresolvedSection(text: string): string {
  return text.slice(text.indexOf("unresolved call sites ("));
}

test("a summary lists the unresolved sites that show a request and counts the rest by cause, file and repository", () => {
  const fact = unresolvedWorkspace({
    alpha: [
      ...Array.from({ length: 12 }, (_, i) => site("src/very/long/path/to/an/unstated/file.ts", i + 1, "source-not-read")),
      ...Array.from({ length: 12 }, (_, i) => site(`src/very/long/path/to/an/other/file${i % 2}.ts`, i + 1, "dispatch-disagreement")),
      site("src/stated.ts", 7, "destination-undecidable", { stated: { method: "GET", path: "/orders" } }),
      site("src/linked.ts", 8, "destination-undecidable"),
      site("src/unlinked.ts", 9, "destination-undecidable"),
      site("src/plain.ts", 10, "destination-undecidable"),
    ],
    beta: [site("src/very/long/path/to/an/unstated/file.ts", 3, "source-not-read"), site("src/other.ts", 4, "unknown-extra"), site("src/r.ts", 5, "recursive", { stated: { method: "GET" } })],
  }, { links: [{ repo: "alpha", file: "src/linked.ts" }], unlinked: [{ repo: "alpha", file: "src/unlinked.ts" }] });
  const text = renderWorkspace(fact, "summary");
  const block = unresolvedSection(text);
  assert.match(block, /^unresolved call sites \(31\): destination-undecidable 4, recursive 1, dispatch-disagreement 12, source-not-read 13, unknown-extra 1$/m);
  const listed = block.split("\n").filter((line) => /^ {8}\d+ Symbol/.test(line));
  assert.deepEqual(listed.map((line) => line.trim().split(" ")[0]), ["8", "7", "9", "5"]);
  assert.match(block, /destination-undecidable \(4\):\n {4}alpha:\n {6}src\/linked\.ts/);
  assert.match(block, /not listed: 1 in 1 file \(alpha 1\); mode "details" lists them; mode: "full" retains all recorded sites/);
  assert.match(block, /not listed: 12 in 2 files \(alpha 12\)/);
  assert.match(block, /not listed: 13 in 2 files \(alpha 12, beta 1\)/);
  assert.match(block, /unknown-extra \(1\):\n {2} {2}not listed: 1 in 1 file \(beta 1\)/);
  assert.equal(block.split("A wrapper request is sited").length - 1, 1);
  assert.ok(block.length < unresolvedSection(renderWorkspace(fact, "details")).length);
});

test("details keeps every unresolved site under its repository", () => {
  const fact = unresolvedWorkspace({ alpha: Array.from({ length: 12 }, (_, i) => site("src/a-long-file-name-here.ts", i + 1, "source-not-read")), beta: [site("src/b.ts", 1, "recursive")] });
  const text = renderWorkspace(fact, "details");
  assert.match(text, /^unresolved call sites \(13\):$/m);
  assert.doesNotMatch(text, /not listed/);
  assert.equal([...text.matchAll(/^ {6}\d+ Symbol/gm)].length, 13);
});

test("a summary keeps the literal listing when counting is not shorter", () => {
  const fact = unresolvedWorkspace({ alpha: [site("src/a.ts", 1, "source-not-read")] });
  const block = unresolvedSection(renderWorkspace(fact, "summary"));
  assert.match(block, /^unresolved call sites \(1\):$/m);
  assert.doesNotMatch(block, /not listed/);
  assert.match(block, /alpha:\n {4}src\/a\.ts\n {6}1 Symbol/);
  assert.equal(block.split("A wrapper request is sited").length - 1, 1);
});

test("the grouped summary does not depend on the order the sites arrive in", () => {
  const sites = [...Array.from({ length: 10 }, (_, i) => site(`src/long/directory/name/file${i % 3}.ts`, i + 1, i % 2 === 0 ? "source-not-read" : "recursive")), site("src/s.ts", 99, "recursive", { stated: { method: "POST" } })];
  const render = (alpha: Site[]) => renderWorkspace(unresolvedWorkspace({ alpha, beta: [site("src/long/directory/name/file0.ts", 1, "source-not-read")] }), "summary");
  const forward = render(sites);
  assert.match(forward, /not listed/);
  assert.equal(render([...sites].reverse()), forward);
});
