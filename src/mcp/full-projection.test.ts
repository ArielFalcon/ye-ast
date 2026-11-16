import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionId } from "../core/domain/decisions/decision.ts";
import { projectFull, type Json } from "./full-projection.ts";
import { expandFull } from "./full-projection.testing.ts";

const ENGINES = { typescript: "6.0.3", "tree-sitter-java": "0.23.5" };
const sha = (repo: string, char: string) => ({ repo, kind: "sha", sha: char.repeat(40) });
const inputs = (over: Json = {}): Json => ({ trust: "untrusted", scope: "s", declaredScope: { languages: ["java"], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: ENGINES, ...over });
const envelope = (snapshot: unknown, over: Json = {}): Json => ({ schema: "8", snapshot, producer: { name: "ye-ast", version: "0.4.0" }, inputs: inputs(), evidence: [{ path: "pom.xml", line: 3 }], ...over });
const answer = (value: Json, over: Json = {}): Json => ({ ...envelope(sha("shop", "a")), status: "complete", value, mode: "full", ...over });
const round = (tool: Parameters<typeof projectFull>[0], source: Json) => {
  const before = structuredClone(source);
  const { fields, guidance } = projectFull(tool, source);
  assert.deepEqual(source, before, "the source answer is not changed");
  assert.deepEqual(expandFull(tool, fields), source, "the projection keeps every entry of the source answer");
  return { fields, guidance };
};

function workspaceAnswer(): Json {
  const shop = envelope(sha("shop", "a"), { inputs: inputs({ content: "c-shop" }), status: "complete", value: { reads: [] } });
  const web = envelope(sha("web", "b"), { inputs: (({ engines: _, ...rest }) => rest)(inputs({ config: "k-web" }) as Json & { engines: unknown }), status: "partial", cuts: [{ kind: "depth", at: ["x"] }], value: { reads: [{ kind: "trigger", fact: envelope(sha("web", "b"), { status: "complete" }) }] } });
  const moved = envelope(sha("moved", "d"), { status: "complete", value: { reads: [] } });
  return answer({ repositorySnapshots: [{ repo: "shop", snapshot: sha("shop", "a") }, { repo: "web", snapshot: sha("web", "b") }, { repo: "moved", snapshot: sha("moved", "d") }], sections: { shop, web, moved } });
}

test("a nested fact states only what differs from its answer, and a missing part is the answer's", () => {
  const { fields, guidance } = round("workspace", workspaceAnswer());
  const value = fields["value"] as { sections: Record<string, Json & { value: { reads: { fact: Json }[] } }> };
  const { shop, web, moved } = value.sections;
  assert.equal(shop!["schema"], undefined);
  assert.equal(shop!["producer"], undefined);
  assert.equal(shop!["snapshot"], undefined, "the trigger repository's section has the answer's snapshot");
  assert.deepEqual(shop!["inputs"], { content: "c-shop" });
  assert.deepEqual(web!["inputs"], { config: "k-web", engines: null });
  assert.deepEqual(web!["snapshot"], sha("web", "b"));
  assert.deepEqual(web!.value.reads[0]!.fact["snapshot"], sha("web", "b"));
  assert.equal(web!.value.reads[0]!.fact["inputs"], undefined);
  assert.deepEqual(web!["cuts"], [{ kind: "depth", at: ["x"] }]);
  assert.deepEqual(moved!["snapshot"], sha("moved", "d"));
  assert.deepEqual(shop!["evidence"], [{ path: "pom.xml", line: 3 }]);
  assert.deepEqual([fields["schema"], fields["snapshot"], fields["producer"]], ["8", sha("shop", "a"), { name: "ye-ast", version: "0.4.0" }]);
  assert.equal(guidance.length, 1);
});

test("an answer with no nested fact keeps every field and carries no guidance", () => {
  const source = answer({ files: [] });
  const projected = projectFull("importers", source);
  assert.deepEqual(projected.fields, source);
  assert.deepEqual(projected.guidance, []);
});

test("an entrypoints section is a nested fact whose snapshot is the answer's", () => {
  const finding = { status: "complete", value: { kind: "ui-route", name: "/", component: "unknown" }, evidence: [{ path: "src/app.routes.ts", line: 3 }] };
  const { fields } = round("entrypoints", answer({ entrypoints: { ...envelope(sha("shop", "a")), status: "complete", value: [finding] } }));
  const section = (fields["value"] as { entrypoints: Json }).entrypoints;
  assert.deepEqual(Object.keys(section).toSorted(), ["evidence", "status", "value"]);
});

function contractAnswer(): Json {
  const place = (line: number) => ({ path: "src/server/auth.ts", line, via: "unresolved-call-site", repo: "web" });
  const shared = { status: "unknown", reason: "unresolved", evidence: [place(1), place(2), place(3)] };
  const own = (line: number) => ({ status: "unknown", reason: "unresolved", evidence: [{ ...place(line), via: "link-basis:suffix" }] });
  const twice = { status: "unknown", reason: "no-extractor", evidence: [place(9)] };
  return answer({
    repositorySnapshots: [],
    answers: [
      { hypothesis: { method: "GET", path: "/a" }, status: "complete", findings: [own(10), shared] },
      { hypothesis: { method: "GET", path: "/b" }, status: "complete", findings: [own(11), twice, twice, shared] },
      { hypothesis: { method: "GET", path: "/c" }, status: "unknown", reason: "unresolved", detail: "d" },
    ],
  });
}

test("a finding several answers share is stated once and each place points to it", () => {
  const { fields, guidance } = round("contract_consequences", contractAnswer());
  const value = fields["value"] as { sharedFindings: Json[]; answers: { findings?: Json[] }[] };
  assert.equal(value.sharedFindings.length, 2);
  assert.deepEqual(value.answers[0]!.findings!.map((finding) => finding["sharedFinding"]), [undefined, 0]);
  assert.deepEqual(value.answers[1]!.findings!.map((finding) => finding["sharedFinding"]), [undefined, 1, 1, 0]);
  assert.equal((value.answers[0]!.findings![0] as Json)["reason"], "unresolved");
  assert.equal(value.answers[2]!.findings, undefined);
  assert.equal(guidance.length, 1);
  for (const answerOfValue of value.answers) for (const finding of answerOfValue.findings ?? []) {
    if (typeof finding["sharedFinding"] === "number") assert.ok(value.sharedFindings[finding["sharedFinding"]] !== undefined);
  }
});

test("answers whose findings are all different carry no shared pool", () => {
  const source = answer({ repositorySnapshots: [], answers: [{ hypothesis: {}, status: "complete", findings: [{ status: "unknown", reason: "unresolved", evidence: [] }] }, { hypothesis: {}, status: "complete", findings: [{ status: "unknown", reason: "no-extractor", evidence: [] }] }] });
  const { fields } = round("contract_consequences", source);
  assert.equal((fields["value"] as Json)["sharedFindings"], undefined);
});

function entrypointsAnswer(): Json {
  const handler = { path: "src/Api.java", symbol: "Api.create", line: 57, endLine: 65 };
  const place = { path: "src/Api.java", line: 57, endLine: 65 };
  const route = (name: string, evidence: Json[], baseEvidence: Json[]) => ({ status: "complete", value: { kind: "http-route", name, handler, basePath: { status: "unknown", reason: "unresolved", evidence: baseEvidence } }, evidence });
  return answer({
    entrypoints: {
      ...envelope(sha("shop", "a")),
      status: "complete",
      value: [
        route("POST /a", [place], [place]),
        route("POST /b", [place, { path: "src/Other.java", line: 2 }], [{ ...place, line: 58 }]),
        { status: "complete", value: { kind: "ui-route", name: "/x", component: { path: "src/x.ts", symbol: "X", line: 4, endLine: 9 } }, evidence: [{ path: "src/x.ts", line: 4, endLine: 9 }] },
      ],
    },
  });
}

test("an entrypoint's evidence that is exactly its handler's place is said once, and any other evidence is kept", () => {
  const { fields, guidance } = round("entrypoints", entrypointsAnswer());
  const [first, second, ui] = (fields["value"] as { entrypoints: { value: Json[] } }).entrypoints.value as (Json & { value: Json & { basePath: Json } })[];
  assert.deepEqual(first!["evidence"], { sameAs: "handler" });
  assert.deepEqual(first!.value.basePath["evidence"], { sameAs: "handler" });
  assert.deepEqual((second!["evidence"] as Json[]).length, 2);
  assert.deepEqual(second!.value.basePath["evidence"], [{ path: "src/Api.java", line: 58, endLine: 65 }]);
  assert.deepEqual(ui!["evidence"], [{ path: "src/x.ts", line: 4, endLine: 9 }]);
  assert.ok(guidance.some((line) => line.includes("sameAs")));
});

test("a decision id that is kind and subject is omitted, and a scoped one is kept", () => {
  const decision = (kind: string, subject: string, id: string) => ({ id, kind, subject, evidence: [], options: [], allowsFreeText: false, required: false });
  const source = answer({ decisions: [decision("repository", "@angular/core", decisionId("repository", "@angular/core")), decision("repository", "api", decisionId("repository", "api", "scope-a"))], repositories: [], source: "request" });
  const { fields } = round("decisions", source);
  const decisions = (fields["value"] as { decisions: Json[] }).decisions;
  assert.equal(decisions[0]!["id"], undefined);
  assert.equal(decisions[1]!["id"], "repository:scope-a:api");
});
