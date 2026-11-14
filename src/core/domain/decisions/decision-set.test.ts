import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../entrypoints/http-route.ts";
import { canonicalJson } from "../shared/canonical-json.ts";
import type { CallSite, HttpTarget } from "../topology/call-site.ts";
import type { NameCandidate, OutwardName, RepositoryOutwardName } from "../topology/outward-name.ts";
import type { Decision, DecisionSet } from "./decision.ts";
import { decisionsOf, type DecisionInput, type DecisionRepository } from "./decision-set.ts";

function outward(name: string, kind: OutwardName["kind"] = "http-host", evidence: OutwardName["evidence"] = [{ path: "src/app.ts", line: 1 }]): RepositoryOutwardName {
  return { name, kind, evidence: evidence.map((place) => ({ ...place, repo: "webapp" })) };
}

function unservedAt(name: string, kind: OutwardName["kind"], ...places: { repo: string; path: string; line: number }[]): RepositoryOutwardName {
  return { name, kind, evidence: places };
}

function candidate(name: string, repo: string, basis: NameCandidate["basis"] = "exact-name"): NameCandidate {
  return { name, repo, basis, evidence: [{ path: `src/${repo}.ts`, line: 1, repo }] };
}

function route(path: string, handlerLine = 10, method: HttpRoute["method"] = "GET"): HttpRoute {
  return {
    kind: "http-route",
    name: `${method} ${path}`,
    method,
    path,
    handler: { path: `src/${path.slice(1)}.java`, symbol: "App.run", line: handlerLine },
    basePath: { status: "unknown", reason: "unresolved", evidence: [] },
  };
}

function call(repo: string, path: string, method: HttpTarget["method"] = "GET"): CallSite {
  return { repo, file: `${repo}/src/app.ts`, line: 7, symbol: "Api.call", transport: "http", target: { status: "complete", value: { method, path }, evidence: [] } };
}

function cut(repo: string, library?: string, at: { path: string; line: number } = { path: `${repo}/src/app.ts`, line: 7 }): CallSite {
  return { repo, file: at.path, line: at.line, symbol: "Api.call", transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [{ ...at, ...(library === undefined ? {} : { via: library }) }] } };
}

function repository(repo: string, overrides: Partial<DecisionRepository> = {}): DecisionRepository {
  return { repo, names: [], callSites: [], entrypoints: [], trust: "untrusted", ...overrides };
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return { trigger: "webapp", repositories: [repository("webapp")], candidates: [], unserved: [], gateways: [], ...overrides };
}

function byId(set: DecisionSet): Map<string, Decision> {
  return new Map(set.decisions.map((decision) => [decision.id, decision]));
}

function ids(set: DecisionSet): string[] {
  return set.decisions.map((decision) => decision.id);
}

function options(decision: Decision | undefined): string[] {
  return decision === undefined ? [] : decision.options.map((option) => `${option.value}${option.recommended ? "*" : ""}${option.basis === undefined ? "" : `(${option.basis})`}`);
}

test("a membership decision recommends the unique strongest basis and records it on the option", () => {
  const set = decisionsOf(input({ candidates: [candidate("orders", "orders", "remote"), candidate("orders", "orders-api", "exact-name"), candidate("orders", "orders-core", "artifact")] }));

  assert.deepEqual(options(byId(set).get("membership:name:orders")), ["orders(remote)", "orders-api*(exact-name)", "orders-core(artifact)"]);
});

test("two membership candidates at the strongest basis recommend none", () => {
  const set = decisionsOf(input({ candidates: [candidate("orders", "orders-a", "exact-name"), candidate("orders", "orders-b", "exact-name")] }));

  assert.deepEqual(options(byId(set).get("membership:name:orders")), ["orders-a(exact-name)", "orders-b(exact-name)"]);
});

test("a candidate clone that states no name and that no name named is one optional membership decision", () => {
  const set = decisionsOf(
    input({
      repositories: [repository("webapp"), repository("geo"), repository("named", { names: [outward("geo-api")] }), repository("served")],
      candidates: [candidate("orders", "served", "artifact")],
    }),
  );

  assert.deepEqual(ids(set), ["membership:clone:geo", "membership:name:orders"]);
  const clone = byId(set).get("membership:clone:geo");
  assert.deepEqual(options(clone), ["geo"]);
  assert.equal(clone?.allowsFreeText, false);
  assert.equal(clone?.required, false);
});

test("a name with candidates is a membership decision and never also a repository one", () => {
  const set = decisionsOf(input({ repositories: [repository("webapp", { names: [outward("orders")] })], candidates: [candidate("orders", "orders")], unserved: [] }));

  assert.deepEqual(ids(set), ["membership:name:orders"]);
});

test("the bound repository and a clone the declaration holds are no membership candidates", () => {
  const set = decisionsOf(
    input({
      repositories: [repository("webapp"), repository("orders")],
      candidates: [candidate("orders", "webapp"), candidate("orders", "orders")],
      confirmed: ["orders"],
    }),
  );

  assert.deepEqual(ids(set), []);
});

test("a declared gateway answers the prefix's unserved name", () => {
  const set = decisionsOf(input({ unserved: [outward("geo-api", "path-prefix")], gateways: [{ prefix: "geo-api", repo: "orders" }] }));

  assert.deepEqual(ids(set), []);
});

test("an unserved name is one free-text decision carrying the places that write it", () => {
  const set = decisionsOf(input({ unserved: [outward("geo-api", "http-host", [{ path: "src/geo.ts", line: 4 }])] }));

  const decision = byId(set).get("repository:geo-api");
  assert.deepEqual(decision?.options, []);
  assert.equal(decision?.allowsFreeText, true);
  assert.equal(decision?.required, false);
  assert.deepEqual(decision?.evidence, [{ path: "src/geo.ts", line: 4, repo: "webapp" }]);
});

test("two unserved names that write one string are one decision with both places", () => {
  const set = decisionsOf(
    input({
      unserved: [outward("geo-api", "path-prefix", [{ path: "b.ts", line: 2 }]), outward("geo-api", "http-host", [{ path: "a.ts", line: 1 }])],
    }),
  );

  assert.deepEqual(ids(set), ["repository:geo-api"]);
  assert.deepEqual(byId(set).get("repository:geo-api")?.evidence, [
    { path: "a.ts", line: 1, repo: "webapp" },
    { path: "b.ts", line: 2, repo: "webapp" },
  ]);
});

test("a repository decision records the outward kinds its subject is written with, so a dependency is told from a prefix", () => {
  const set = decisionsOf(input({ unserved: [outward("@angular/core", "dependency"), outward("orders-api", "path-prefix")] }));

  assert.deepEqual(byId(set).get("repository:@angular/core")?.outwardKinds, ["dependency"]);
  assert.deepEqual(byId(set).get("repository:orders-api")?.outwardKinds, ["path-prefix"]);
});

test("one name written with two kinds is one decision that records both, sorted", () => {
  const set = decisionsOf(input({ unserved: [outward("geo-api", "path-prefix"), outward("geo-api", "http-host")] }));

  assert.deepEqual(byId(set).get("repository:geo-api")?.outwardKinds, ["http-host", "path-prefix"]);
});

test("a cut that names a library offers only a clone the caller's own dependency names, with that evidence, and none recommended", () => {
  const dependency: OutwardName = { name: "orders-lib", kind: "dependency", evidence: [{ path: "pom.xml", line: 3 }] };
  const evidence = [{ path: "pom.xml", line: 3, repo: "webapp" }, { path: "pom.xml", line: 1, repo: "orders" }];
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [dependency], callSites: [cut("webapp", "com.acme.OrdersClient")] }),
        repository("geo", { callSites: [cut("geo", "com.acme.GeoClient", { path: "geo/src/app.ts", line: 4 })] }),
        repository("orders"),
        repository("billing"),
      ],
      candidates: [{ name: "orders-lib", repo: "orders", basis: "artifact", evidence }],
      confirmed: ["geo", "orders", "billing"],
    }),
  );

  assert.deepEqual(ids(set), ["library:com.acme.GeoClient", "library:com.acme.OrdersClient"]);
  const named = byId(set).get("library:com.acme.OrdersClient");
  assert.deepEqual(named?.evidence, [{ path: "webapp/src/app.ts", line: 7, repo: "webapp" }]);
  assert.deepEqual(options(named), ["orders(artifact)"]);
  assert.deepEqual(named?.options[0]?.evidence, [evidence[1], evidence[0]]);
  assert.equal(named?.allowsFreeText, true);
  assert.equal(named?.required, false);
  assert.deepEqual(options(byId(set).get("library:com.acme.GeoClient")), []);
  assert.equal(byId(set).get("library:com.acme.GeoClient")?.allowsFreeText, true);
});

test("two cuts that name one library are one decision with both places", () => {
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [cut("webapp", "com.acme.OrdersClient", { path: "webapp/src/b.ts", line: 9 })] }),
        repository("geo", { names: [outward("orders")], callSites: [cut("geo", "com.acme.OrdersClient", { path: "geo/src/a.ts", line: 3 })] }),
      ],
    }),
  );

  assert.deepEqual(ids(set), ["library:com.acme.OrdersClient"]);
  assert.deepEqual(byId(set).get("library:com.acme.OrdersClient")?.evidence, [
    { path: "geo/src/a.ts", line: 3, repo: "geo" },
    { path: "webapp/src/b.ts", line: 9, repo: "webapp" },
  ]);
});

test("a call site that resolves, or a cut that names no library, is no library decision", () => {
  const resolvedThroughLibrary: CallSite = {
    repo: "webapp",
    file: "webapp/src/ok.ts",
    line: 5,
    symbol: "Api.ok",
    transport: "http",
    target: { status: "complete", value: { method: "GET", path: "/orders" }, evidence: [{ path: "webapp/src/ok.ts", line: 5, via: "com.acme.OrdersClient" }] },
  };
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [cut("webapp"), cut("webapp", ""), resolvedThroughLibrary] }),
        repository("orders", { names: [outward("orders")], entrypoints: [route("/orders")] }),
      ],
    }),
  );

  assert.deepEqual(ids(set), []);
});

test("a prefix the join served raises no gateway decision, however its calls read", () => {
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [call("webapp", "/api/owners"), call("webapp", "/orders-api/refunds"), call("webapp", "http://localhost:9966/legacy/thing")] }),
        repository("orders-api", { names: [outward("orders")], entrypoints: [route("/refunds")] }),
        repository("owners", { names: [outward("orders")], entrypoints: [route("/owners")] }),
      ],
    }),
  );

  assert.deepEqual(ids(set), []);
});

test("an unserved prefix a repository serves behind it is a gateway decision offering that repository and still a free-text repository decision, since a gateway can only name a repository of the workspace", () => {
  const places = [{ repo: "webapp", path: "webapp/src/app.ts", line: 7 }];
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [call("webapp", "/legacy/thing", "POST")] }),
        repository("orders", { names: [outward("orders")], entrypoints: [route("/thing", 31, "POST")] }),
      ],
      unserved: [unservedAt("legacy", "path-prefix", ...places)],
    }),
  );

  const decision = byId(set).get("gateway:legacy");
  assert.deepEqual(ids(set), ["gateway:legacy", "repository:legacy"]);
  assert.deepEqual(options(decision), ["orders"]);
  assert.deepEqual(decision?.options[0]?.evidence, [{ path: "src/thing.java", line: 31, repo: "orders" }]);
  assert.equal(decision?.allowsFreeText, false);
  assert.equal(decision?.required, false);
  assert.deepEqual(decision?.evidence, places);
  const repositoryDecision = byId(set).get("repository:legacy");
  assert.deepEqual(repositoryDecision?.options, []);
  assert.equal(repositoryDecision?.allowsFreeText, true);
  assert.deepEqual(repositoryDecision?.outwardKinds, ["path-prefix"]);
  assert.deepEqual(repositoryDecision?.evidence, places);
});

test("an unserved prefix two repositories match offers both and recommends none", () => {
  const set = decisionsOf(
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [call("webapp", "/api/orders")] }),
        repository("shop", { names: [outward("orders")], entrypoints: [route("/orders", 11)] }),
        repository("billing", { names: [outward("orders")], entrypoints: [route("/orders", 22)] }),
      ],
      unserved: [unservedAt("api", "path-prefix", { repo: "webapp", path: "webapp/src/app.ts", line: 7 })],
    }),
  );

  assert.deepEqual(options(byId(set).get("gateway:api")), ["billing", "shop"]);
});

test("an unserved prefix no other repository serves behind it, the caller's own route included, is one repository decision and no gateway one", () => {
  const set = decisionsOf(
    input({
      repositories: [repository("orders-svc", { callSites: [call("orders-svc", "/orders-api/orders/{id}"), call("orders-svc", "/legacy/thing")], entrypoints: [route("/orders/{id}")] })],
      unserved: [unservedAt("orders-api", "path-prefix", { repo: "orders-svc", path: "orders-svc/src/app.ts", line: 7 }), unservedAt("legacy", "path-prefix", { repo: "orders-svc", path: "orders-svc/src/app.ts", line: 7 })],
      confirmed: ["orders-svc"],
    }),
  );

  assert.deepEqual(ids(set), ["repository:legacy", "repository:orders-api"]);
  assert.deepEqual(byId(set).get("repository:orders-api")?.options, []);
  assert.equal(byId(set).get("repository:orders-api")?.allowsFreeText, true);
});

test("a repository without a trust record is a required decision offering both modes, and one with a record is not", () => {
  const set = decisionsOf(
    input({
      repositories: [repository("webapp", { names: [outward("orders")], trust: "trusted" }), { repo: "geo", names: [outward("orders")], callSites: [], entrypoints: [] }],
    }),
  );

  assert.deepEqual(ids(set), ["trust:geo"]);
  const decision = byId(set).get("trust:geo");
  assert.deepEqual(options(decision), ["trusted", "untrusted"]);
  assert.equal(decision?.required, true);
  assert.equal(decision?.allowsFreeText, false);
});

test("the decision set is sorted by id and two runs over one input are byte-identical", () => {
  const build = (): DecisionInput =>
    input({
      repositories: [
        repository("webapp", { names: [outward("orders")], callSites: [call("webapp", "/legacy/thing"), cut("webapp", "com.acme.OrdersClient", { path: "webapp/src/cut.ts", line: 12 })], trust: "untrusted" }),
        repository("geo"),
        repository("orders", { names: [outward("orders")], entrypoints: [route("/orders")] }),
      ],
      candidates: [candidate("orders", "orders", "remote"), candidate("geo-api", "orders", "artifact")],
      unserved: [outward("zeta-api"), outward("alpha-api")],
    });

  const first = decisionsOf(build());
  assert.deepEqual(ids(first), [...ids(first)].sort());
  assert.equal(canonicalJson(decisionsOf(build())), canonicalJson(first));
});

test("a name equal to a clone id gives two decisions, one per subject space", () => {
  const set = decisionsOf(input({ repositories: [repository("webapp"), repository("orders")], candidates: [candidate("orders", "orders-api")] }));

  assert.deepEqual(ids(set), ["membership:clone:orders", "membership:name:orders"]);
});

test("a repository the query could not read at the trigger's line is a revision decision recommending the branch it pinned", () => {
  const set = decisionsOf(
    input({ resolutions: [{ repo: "orders", step: "default-branch", consulted: [{ branch: "feature/web" }, { branch: "main", sha: "b".repeat(40) }], sha: "b".repeat(40) }] }),
  );

  const decision = byId(set).get("revision:orders");
  assert.deepEqual(options(decision), ["main*(default-branch)"]);
  assert.equal(decision?.allowsFreeText, true);
  assert.equal(decision?.required, false);
});

test("a revision the declaration asked for, the trigger's line itself, or a default with no other line leaves no revision decision", () => {
  const set = decisionsOf(
    input({
      resolutions: [
        { repo: "explicit", asked: "main", step: "explicit", consulted: [{ branch: "main", sha: "a".repeat(40) }], sha: "a".repeat(40) },
        { repo: "same-line", step: "trigger-line", consulted: [{ branch: "feature/web", sha: "b".repeat(40) }], sha: "b".repeat(40) },
        { repo: "no-line", step: "default-branch", consulted: [{ branch: "main", sha: "c".repeat(40) }], sha: "c".repeat(40) },
      ],
    }),
  );

  assert.deepEqual(ids(set), []);
});

test("a default branch whose consulted refs all carry a sha is no gap, so only a diverged remote is", () => {
  const decisions = (consulted: readonly { branch: string; sha?: string }[]): string[] =>
    ids(decisionsOf(input({ resolutions: [{ repo: "orders", step: "default-branch", consulted, sha: "b".repeat(40) }] })));

  assert.deepEqual(decisions([{ branch: "main", sha: "b".repeat(40) }, { branch: "release/2", sha: "c".repeat(40) }]), []);
  assert.deepEqual(decisions([{ branch: "feature/web" }, { branch: "main", sha: "b".repeat(40) }]), ["revision:orders"]);
});

test("a repository no step could pin is a revision decision with free text and no recommendation", () => {
  const set = decisionsOf(input({ resolutions: [{ repo: "orders", step: "revision-unavailable", consulted: [{ branch: "feature/web" }] }] }));

  const decision = byId(set).get("revision:orders");
  assert.deepEqual(options(decision), []);
  assert.equal(decision?.allowsFreeText, true);
  assert.equal(decision?.required, false);
});

test("a repository declared without a remote offers its clone's own remote URL with that basis, and recommends none", () => {
  const set = decisionsOf(input({ origins: [{ repo: "billing", remotes: [{ url: "https://git.example.com/billing.git", remote: "origin" }] }] }));

  const decision = byId(set).get("remote:billing");
  assert.deepEqual(options(decision), ["https://git.example.com/billing.git(origin)"]);
  assert.deepEqual(decision?.options[0]?.evidence, [{ path: ".git/config", line: 1, via: "origin", repo: "billing" }]);
  assert.equal(decision?.allowsFreeText, true);
  assert.equal(decision?.required, false);
});

test("a clone that states several remotes is one remote decision offering each, the one it came from as evidence", () => {
  const set = decisionsOf(
    input({
      origins: [
        {
          repo: "billing",
          remotes: [
            { url: "https://git.example.com/me/billing.git", remote: "origin" },
            { url: "https://git.example.com/shop/billing.git", remote: "upstream" },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(
    set.decisions.map((decision) => decision.id),
    ["remote:billing"],
  );
  assert.deepEqual(byId(set).get("remote:billing")?.options.map((option) => `${option.value} ${option.evidence.map((place) => place.via).join(",")}`), [
    "https://git.example.com/me/billing.git origin",
    "https://git.example.com/shop/billing.git upstream",
  ]);
});

test("a revision-unavailable resolution offering a consulted ref that carries a sha recommends none", () => {
  const set = decisionsOf(input({ resolutions: [{ repo: "orders", step: "revision-unavailable", consulted: [{ branch: "develop", sha: "d".repeat(40) }] }] }));

  const decision = byId(set).get("revision:orders");
  assert.deepEqual(options(decision), ["develop"]);
  assert.equal(decision?.allowsFreeText, true);
  assert.equal(decision?.required, false);
});

test("decision evidence retains the owners of identical call and route coordinates", () => {
  const shared = { path: "src/app.ts", line: 7 };
  const invoke = (repo: string): CallSite => ({ ...call(repo, "/api/orders"), file: shared.path, line: shared.line });
  const handler = { ...route("/orders"), handler: { path: shared.path, line: shared.line, symbol: "App.run" } };
  const set = decisionsOf(input({ repositories: [repository("webapp", { callSites: [invoke("webapp"), cut("webapp", "Library", shared)] }), repository("other", { callSites: [invoke("other"), cut("other", "Library", shared)] }), repository("server-a", { entrypoints: [handler] }), repository("server-b", { entrypoints: [handler] })], unserved: [unservedAt("api", "path-prefix", { ...shared, repo: "other" }, { ...shared, repo: "webapp" })] }));
  assert.deepEqual(byId(set).get("library:Library")?.evidence, [{ ...shared, repo: "other" }, { ...shared, repo: "webapp" }]);
  const gateway = byId(set).get("gateway:api");
  assert.deepEqual(gateway?.evidence, [{ ...shared, repo: "other" }, { ...shared, repo: "webapp" }]);
  assert.deepEqual(gateway?.options.map((option) => option.evidence), [[{ ...shared, repo: "server-a" }], [{ ...shared, repo: "server-b" }]]);
});

test("one unserved name retains identical locations from both repositories", () => {
  const evidence = ["alpha", "beta"].map((repo) => ({ repo, path: "src/app.ts", line: 7 }));
  const set = decisionsOf(input({ unserved: [{ name: "external", kind: "http-host", evidence }] }));
  assert.deepEqual(byId(set).get("repository:external")?.evidence, evidence);
});

test("a prefix a call states after an undecided base is a gateway decision", () => {
  const undecided: CallSite = {
    ...cut("webapp"),
    stated: { method: "POST", expressions: [[{ kind: "unknown", cause: "destination-undecidable", evidence: [] }, { kind: "text", text: "/legacy/thing" }]] },
  };
  const set = decisionsOf(
    input({
      repositories: [repository("webapp", { callSites: [undecided] }), repository("orders", { entrypoints: [route("/thing", 10, "POST")] })],
      unserved: [unservedAt("legacy", "path-prefix", { path: "webapp/src/app.ts", line: 7, repo: "webapp" })],
    }),
  );

  assert.deepEqual(options(byId(set).get("gateway:legacy")), ["orders"]);
  assert.deepEqual(byId(set).get("gateway:legacy")?.evidence, [{ path: "webapp/src/app.ts", line: 7, repo: "webapp" }]);
});
