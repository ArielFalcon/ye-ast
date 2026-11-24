import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalJson } from "../../core/domain/shared/canonical-json.ts";
import { expandFull } from "../full-projection.testing.ts";
import { isRecord, projectFull, type Json } from "../full-projection.ts";
import { assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails, tokensOf } from "./migration.testing.ts";
import { write } from "./writer.ts";
import { BASE_PATHS_SECTION, ENTRYPOINTS_SECTION, present } from "./families/entrypoints.ts";
import { ENTRYPOINT_FIXTURES } from "./families/entrypoints.fixtures.testing.ts";
import { ENTRYPOINTS_LEGACY } from "./families/entrypoints.legacy.testing.ts";

const jsonOf = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const arrayOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The entries of `answer.json` of the same fact, with the folds of the full projection undone. */
function resolver(fact: unknown): (section: string, key: string) => boolean {
  const answer = expandFull("entrypoints", projectFull("entrypoints", jsonOf(fact)).fields);
  const value = isRecord(answer["value"]) ? answer["value"] : {};
  const section = isRecord(value["entrypoints"]) ? value["entrypoints"] : {};
  const findings = arrayOf(section["value"]);
  const cuts = [...arrayOf(answer["cuts"]), ...arrayOf(section["cuts"])];
  const placeOf = (finding: Json): Json | undefined => {
    const inner = isRecord(finding["value"]) ? finding["value"] : {};
    return [inner["handler"], inner["component"], arrayOf(finding["evidence"])[0]].find(isRecord);
  };
  return (id, key) => {
    const [repo, kind, name, path, line, ...extra] = key.split("\0");
    if (id === ENTRYPOINTS_SECTION) {
      const found = findings.find((finding) => {
        const place = placeOf(finding);
        const inner = isRecord(finding["value"]) ? finding["value"] : {};
        const same = place?.["path"] === (path === "" ? undefined : path) && String(place?.["line"] ?? "") === line;
        return repo === "" && same && (kind === "unknown" ? finding["status"] === "unknown" && name!.startsWith(String(finding["reason"])) : inner["kind"] === kind && inner["name"] === name);
      });
      if (found === undefined) return false;
      const inner = isRecord(found["value"]) ? found["value"] : {};
      if (extra[0] === "guard") return arrayOf(inner["guards"]).some((guard) => guard["name"] === extra[1] && (guard["path"] ?? "") === extra[2]);
      return extra.length === 0 || (extra[0] === "base" && isRecord(inner["basePath"]));
    }
    if (id === BASE_PATHS_SECTION) return key.startsWith("base-path\0") && findings.some((finding) => isRecord(finding["value"]) && canonicalJson(finding["value"]["basePath"]) === key.slice("base-path\0".length));
    if (id === "cuts") return cuts.some((cut) => cut["kind"] === kind && cut["reason"] === name);
    return false;
  };
}

for (const { name, fact } of ENTRYPOINT_FIXTURES) {
  const legacy = ENTRYPOINTS_LEGACY[name]!;
  const presentation = present(fact);
  const texts = { summary: write(presentation, "summary").text, details: write(presentation, "details").text };
  const extraEvidence = fact.status === "unknown" || fact.value.entrypoints.status === "unknown" ? [] : fact.value.entrypoints.value.flatMap((finding) => (finding.status === "unknown" ? finding.evidence.slice(1).map(({ path, line, endLine }) => `place ${path}:${line}${endLine === undefined ? "" : `-${endLine}`}`) : []));
  const movedToDetails = new Set([...extraEvidence, ...legacy.summary.filter((token) => token.startsWith("cut ") || token.startsWith("anchor "))]);

  test(`entrypoints migration (${name}): no fact the legacy text stated is lost, in either mode`, () => {
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails });
    for (const token of movedToDetails) assert.ok(legacy.summary.includes(token), `a documented move that the legacy summary never stated: ${token}`);
  });

  test(`entrypoints migration (${name}): summary rows are details rows, and every row is an entry of answer.json`, () => {
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, resolver(fact));
  });

  test(`entrypoints migration (${name}): the reply is smaller than the legacy one in details`, () => {
    if (legacy.bytes.details > 400) assert.ok(Buffer.byteLength(texts.details) < legacy.bytes.details, `${Buffer.byteLength(texts.details)} >= ${legacy.bytes.details}`);
  });
}

test("a row number is the position of the finding in answer.json, in both modes, whichever file groups the row", () => {
  const { fact } = ENTRYPOINT_FIXTURES[0]!;
  const findings = fact.status === "unknown" || fact.value.entrypoints.status === "unknown" ? [] : fact.value.entrypoints.value;
  for (const mode of ["summary", "details"] as const) {
    const block = write(present(fact), mode).text.split(/^(?=entrypoints:)/m).at(-1)!.split(/\n(?=\S)/)[0]!;
    const numbered = new Map(block.split("\n").flatMap((line) => { const match = /^ +(\d+)\. (.*)$/.exec(line); return match === null ? [] : [[Number(match[1]), match[2]!] as const]; }));
    findings.forEach((finding, index) => {
      const row = numbered.get(index);
      assert.ok(row !== undefined, `no row ${index}`);
      if (finding.status === "complete") assert.ok(row.includes(`${finding.value.kind} ${finding.value.name}`), `row ${index}: ${row}`);
    });
  }
});

test("a route's evidence that is its own place is stated once, and a UI route keeps its declaration in both modes", () => {
  const { fact } = ENTRYPOINT_FIXTURES[0]!;
  for (const mode of ["summary", "details"] as const) {
    const text = write(present(fact), mode).text;
    assert.equal(text.split("OwnerResource.java").length - 1, 1);
    assert.ok(text.includes("(at src/routes.ts:12, guards 2)"));
  }
  assert.equal(tokensOf(write(present(fact), "details").text).has("place src/routes.ts:12"), true);
});
