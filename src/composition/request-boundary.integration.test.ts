import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpCallSites, createRequestCallLookup } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { createContractConsequencesQueries } from "../core/application/contracts/contract-consequences-queries.ts";
import { NO_FLOW, type Carrier } from "../core/domain/contracts/consumer-flow.ts";
import type { FactBase } from "../core/domain/shared/fact.ts";
import type { Link } from "../core/domain/topology/link.ts";
import type { ConsumerSession, ServingWorkspace } from "../core/ports/consumer-sources.port.ts";
import type { HypothesesRequest } from "../core/ports/contract-consequences-queries.port.ts";

test("a real first-binding HTTP site starts the public consequence query there", async () => {
  const files = [{ path: "fixture.ts", content: [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {}",
    " get(path:string) { return this.http.get('/api'+path) }",
    "}",
    "class Service { constructor(private crud:Crud) {}",
    " item(id:string) { return this.crud.get('/owners/'+id) }",
    "}",
  ].join("\n") }];
  const reader = createHttpCallSites();
  const sites = await reader.placed(files, "web");
  assert.equal(sites.length, 1);
  const site = sites[0]!;
  assert.equal(site.issuingBoundary, "site");
  assert.deepEqual(site.origins?.map((origin) => [origin.kind, origin.line]), [["body", 3], ["leaf", 3]]);
  assert.ok(!("issuingBoundary" in (await reader.of(files, "web"))[0]!));
  const lookup = await createRequestCallLookup(files);
  const call = lookup.at({ file: "fixture.ts", line: 6, column: site.column! + 1, symbol: "Service.item" });
  assert.ok(call);
  assert.equal(lookup.bodiesOf(call).length, 1);
  const link: Link = { id: "one", from: { repo: "web", file: "fixture.ts", line: 6, symbol: "Service.item", column: site.column! + 1 }, to: { repo: "api", kind: "http-route", name: "GET /api/owners/{id}", handler: { path: "api.ts", symbol: "handler", line: 1 } }, transport: "http", basis: "exact", confidence: 1 };
  const followed: Carrier[] = [];
  const session: ConsumerSession = {
    links: [link], serving: [{ repo: "api", handler: link.to.handler }], cutsAfterWalk: () => [], unresolvedCalls: [], ambiguousCalls: [], callers: () => ({ kind: "found", callers: [] }), memberOccurrences: () => ({ kind: "found", occurrences: [] }), flow: { follow: (carrier) => (followed.push(carrier), NO_FLOW) }, templates: { follow: () => NO_FLOW }, placedSites: async () => ({ kind: "read", sites, owned: new Set(["fixture.ts"]) }), requestOrigins: () => undefined, excludes: () => false,
  };
  const base: FactBase = { schema: "0.21.0", snapshot: { repo: "web", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "0" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
  const workspace: ServingWorkspace = { base: (declared) => ({ ...base, inputs: { ...base.inputs, declaredConfig: declared } }), repositorySnapshots: [], cuts: [], sectionCuts: {}, session: async () => ({ ok: true, value: session }), serving: () => ({ kind: "unserved" }) };
  const queries = createContractConsequencesQueries({ sources: { withWorkspace: async (_, run) => ({ ok: true, value: await run(workspace) }) }, ofChange: async () => assert.fail("unexpected change") });
  const result = await queries.ofHypotheses({ repo: { repo: "web", path: "/fake" } as HypothesesRequest["repo"], hypotheses: [{ method: "get", path: "/api/owners/{id}", target: "response", property: "name", change: "nullable" }] });
  assert.ok(result.ok);
  assert.deepEqual(followed.map((carrier) => carrier.site.kind === "call-site" && [carrier.site.file, carrier.site.line]), [["fixture.ts", 6]]);
  assert.ok(!JSON.stringify(result).includes("issuingBoundary"));
});
