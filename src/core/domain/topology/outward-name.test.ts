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
    ["com.shop.Orders", "com.shop.Events"],
  );
});

const NAME = "http://ms-orders.b2c:8080/orders/{orderId}";

function candidate(basis: NameCandidate["basis"], paths: readonly [string, number][]): NameCandidate {
  return { name: NAME, repo: "ms-orders", basis, evidence: paths.map(([path, line]) => ({ path, line })) };
}

test("the same served name reached twice is one candidate, its evidence gathered and sorted", () => {
  const gathered = gatherCandidates([candidate("exact-name", [["web/src/main/resources/application.yaml", 91]]), candidate("exact-name", [["svc/src/main/resources/application.yaml", 77]])]);

  assert.deepEqual(gathered, [
    {
      name: NAME,
      repo: "ms-orders",
      basis: "exact-name",
      evidence: [
        { path: "svc/src/main/resources/application.yaml", line: 77 },
        { path: "web/src/main/resources/application.yaml", line: 91 },
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
