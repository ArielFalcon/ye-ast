import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherCandidates, sortEvidence, type NameCandidate } from "./outward-name.ts";

test("one line reached two ways is two places, so the library that reached it is not lost", () => {
  const sorted = sortEvidence([
    { path: "src/app/orders.ts", line: 7, via: "com.shop.Orders" },
    { path: "src/app/orders.ts", line: 7, via: "com.shop.Events" },
  ]);

  assert.deepEqual(
    sorted.map((place) => place.via),
    ["com.shop.Events", "com.shop.Orders"],
  );
});

const NAME = "http://ms-orders.b2c:8080/orders/{orderId}";

function candidate(basis: NameCandidate["basis"], paths: readonly [string, number][]): NameCandidate {
  return { name: NAME, repo: "ms-orders", basis, evidence: paths.map(([path, line]) => ({ path, line, repo: "ms-orders" })) };
}

test("the same served name reached twice is one candidate, its evidence gathered and sorted", () => {
  const gathered = gatherCandidates([candidate("exact-name", [["web/src/main/resources/application.yaml", 91]]), candidate("exact-name", [["svc/src/main/resources/application.yaml", 77]])]);

  assert.deepEqual(gathered, [
    {
      name: NAME,
      repo: "ms-orders",
      basis: "exact-name",
      evidence: [
        { path: "svc/src/main/resources/application.yaml", line: 77, repo: "ms-orders" },
        { path: "web/src/main/resources/application.yaml", line: 91, repo: "ms-orders" },
      ],
    },
  ]);
});

test("the same served name under two bases is two candidates, in the domain's order", () => {
  const gathered = gatherCandidates([candidate("exact-name", [["pom.xml", 7]]), candidate("artifact", [["pom.xml", 3]])]);

  assert.deepEqual(
    gathered.map((each) => `${each.name} -> ${each.repo} (${each.basis}) pom.xml:${each.evidence[0]?.line}`),
    [`${NAME} -> ms-orders (artifact) pom.xml:3`, `${NAME} -> ms-orders (exact-name) pom.xml:7`],
  );
});

test("candidate evidence preserves the caller and serving clone at identical coordinates", async () => {
  const { nameCandidates } = await import("./repository-identity.ts");
  const place = { path: "src/app.ts", line: 7 };
  const candidates = nameCandidates({ name: "service", kind: "http-host", evidence: [place] }, [{ repo: "server", id: "service", artifacts: [], remotes: [], evidence: [place] }], "caller");
  assert.deepEqual(candidates[0]?.evidence, [{ ...place, repo: "caller" }, { ...place, repo: "server" }]);
});

test("gathered names preserve equal coordinates from distinct repositories", async () => {
  const { gatherNames } = await import("./outward-name.ts");
  const names = ["a", "b"].map((repo) => ({ name: "external", kind: "http-host" as const, evidence: [{ repo, path: "src/app.ts", line: 7 }] }));
  assert.deepEqual(gatherNames(names)[0]?.evidence.map((place) => place.repo), ["a", "b"]);
});

test("evidence identity includes span, confidence and via with deterministic ordering", () => {
  const places = [{ path: "src/a.ts", line: 7, endLine: 9, confidence: 0.5, via: "x" }, { path: "src/a.ts", line: 7, endLine: 8, confidence: 0.5, via: "x" }, { path: "src/a.ts", line: 7, endLine: 8, confidence: 0.8, via: "x" }];
  const forward = sortEvidence([...places, places[0]!]);
  assert.equal(forward.length, 3);
  assert.deepEqual(sortEvidence([...places].reverse()), forward);
});

test("Maven dependency candidates require the complete declared coordinates, while service names keep their existing recognition", async () => {
  const { nameCandidates } = await import("./repository-identity.ts");
  const identities = [
    { repo: "correct", id: "correct", artifacts: ["com.acme:clients"], remotes: [], evidence: [] },
    { repo: "clients", id: "clients", artifacts: ["org.other:clients"], remotes: [], evidence: [] },
  ];
  const dependency = { name: "com.acme:clients", kind: "dependency" as const, evidence: [{ path: "pom.xml", line: 4 }] };
  assert.deepEqual(nameCandidates(dependency, identities, "app").map(({ repo, basis }) => ({ repo, basis })), [{ repo: "correct", basis: "artifact" }]);
  assert.deepEqual(nameCandidates({ ...dependency, name: "http://clients/items", kind: "http-host" }, identities, "app").map(({ repo }) => repo), ["clients", "correct"]);
});

test("qualified Maven recognition keeps the existing optional version outside artifact identity", async () => {
  const { nameCandidates } = await import("./repository-identity.ts");
  const candidates = nameCandidates({ name: "com.acme:clients@2", kind: "dependency", evidence: [] }, [{ repo: "library", id: "library", artifacts: ["com.acme:clients"], remotes: [], evidence: [] }], "app");
  assert.deepEqual(candidates.map(({ repo, basis }) => ({ repo, basis })), [{ repo: "library", basis: "artifact" }]);
});

function dependencyRepository(id: string, dependencies: readonly string[], artifact = `com.acme:${id}`) {
  return { identity: { repo: id, id, artifacts: artifact === "" ? [] : [artifact], remotes: [], evidence: [] }, names: dependencies.map((name, index) => ({ name: `com.acme:${name}`, kind: "dependency" as const, evidence: [{ path: "pom.xml", line: index + 2 }] })) };
}

test("dependency closure is stable, visits a diamond once and excludes its root through a cycle", async () => {
  const { dependencyClosures } = await import("./repository-identity.ts");
  const repositories = [dependencyRepository("app", ["b", "d", "blocked"]), dependencyRepository("b", ["c"]), dependencyRepository("d", ["c"]), dependencyRepository("c", ["app", "blocked"]), dependencyRepository("blocked", [], "")];
  const closure = dependencyClosures(repositories).get("app");
  assert.deepEqual(closure?.repositories, ["b", "c", "d"]);
  assert.equal(closure?.transitive, true);
  assert.deepEqual(closure?.unresolved.map(({ repo, name }) => ({ repo, name: name.name })), [{ repo: "app", name: "com.acme:blocked" }, { repo: "c", name: "com.acme:blocked" }]);
  assert.deepEqual(dependencyClosures([...repositories].reverse().map(r => ({ ...r, names: [...r.names].reverse() }))).get("app"), closure);
});

test("dependency closure keeps each blocked hop at its owner and never traverses unproved candidates", async () => {
  const { dependencyClosures } = await import("./repository-identity.ts");
  const closure = dependencyClosures([
    dependencyRepository("app", ["b"]), dependencyRepository("b", ["x", "y"]),
    dependencyRepository("x1", ["secret"], "com.acme:x"), dependencyRepository("x2", ["secret"], "com.acme:x"),
    dependencyRepository("y", ["secret"], ""), dependencyRepository("secret", []),
  ]).get("app");
  assert.deepEqual(closure?.repositories, ["b"]);
  assert.equal(closure?.transitive, false);
  assert.deepEqual(closure?.unresolved.map(({ repo, name, diagnostic }) => ({ repo, name: name.name, reason: diagnostic.reason, candidates: diagnostic.candidates })), [
    { repo: "b", name: "com.acme:x", reason: "ambiguous", candidates: ["x1", "x2"] },
    { repo: "b", name: "com.acme:y", reason: "unproven-coordinates", candidates: ["y"] },
  ]);
});
