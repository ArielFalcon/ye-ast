import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalJson } from "../../core/domain/shared/canonical-json.ts";
import { linkIdentity } from "../../core/domain/topology/link.ts";
import { expandFull } from "../full-projection.testing.ts";
import { isRecord, projectFull, type Json } from "../full-projection.ts";
import { assertDeterministic, assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails, tokensOf } from "./migration.testing.ts";
import type { Row } from "./model.ts";
import { write } from "./writer.ts";
import { CUTS_SECTION, EFFECTS_SECTION, LINKS_SECTION, READING_PLAN_SECTION, REQUESTS_SECTION, ROOTS_SECTION, SETTLED_SECTION, STEPS_SECTION, UNLINKED_SECTION, present } from "./families/trace.ts";
import { ENTRYPOINT_ROOT_FIXTURE, TRACE_FIXTURES } from "./families/trace.fixtures.testing.ts";
import { TRACE_LEGACY } from "./families/trace.legacy.testing.ts";

const jsonOf = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const childKey = (parent: string, kind: string, value: Json): string => [parent, kind, canonicalJson(value)].join("\0");

/** Strips the repository prefix of a by-file header, which the shared token extractor does not read. */
const normalize = (text: string): string => text.replace(/\b[\w.-]+:(?=src\/)/g, "");

/** The entries of `answer.json` of the same fact, with the folds of the full projection undone. */
function resolver(fact: unknown): (section: string, key: string) => boolean {
  const answer = expandFull("trace", projectFull("trace", jsonOf(fact)).fields);
  const value = isRecord(answer["value"]) ? answer["value"] : {};
  const steps = records(value["steps"]);
  const treeKeys = new Set<string>();
  const effectKeys = new Set<string>();
  const requestKeys = new Set<string>();
  const stepKeys = new Map<unknown, string>();
  for (const step of steps) {
    const key = [step["parent"] === undefined ? "" : stepKeys.get(step["parent"])!, canonicalJson([step["file"], step["line"], step["symbol"], step["at"] ?? null])].join("\0");
    stepKeys.set(step["id"], key);
    treeKeys.add(key);
    for (const [kind, name, into] of [["leaf", "leaves", treeKeys], ["external", "external", treeKeys], ["alternative", "alternatives", treeKeys], ["effect", "effects", effectKeys], ["request", "unresolvedEffects", requestKeys]] as const) {
      for (const child of records(step[name])) into.add(childKey(key, kind, child));
    }
  }
  const roots = new Set(records(value["roots"]).map((root) => ["roots", String(root["target"])].join("\0")));
  const ranges = new Set(records(isRecord(value["readingPlan"]) ? value["readingPlan"]["ranges"] : []).map((range) => ["range", canonicalJson({ file: range["file"], start: range["start"], end: range["end"] })].join("\0")));
  const settled = new Set(records(value["settled"]).map((item) => ["settled", canonicalJson(item)].join("\0")));
  const links = new Set(records(value["links"]).flatMap((link) => { const key = linkIdentity(link as never); return [key, [key, "handler"].join("\0")]; }));
  const unlinked = new Set(records(value["unlinked"]).map((site) => canonicalJson([site["from"], site["transport"], site["method"], site["name"], site["outcome"]])));
  const cuts = new Set(records(answer["cuts"]).flatMap((cut) => {
    const key = ["cut", cut["kind"], cut["reason"], cut["subReason"] ?? "", String(cut["limit"] ?? ""), (cut["at"] as string[]).join("\u0001")].join("\0");
    return [key, ...[...(cut["at"] as string[]), ...((cut["cause"] as string[] | undefined) ?? [])].map((place) => [key, place].join("\0"))];
  }));
  return (section, key) => section === STEPS_SECTION ? treeKeys.has(key) : section === EFFECTS_SECTION ? effectKeys.has(key) || (key === "no-effects" && steps.every((step) => records(step["effects"]).length === 0 && records(step["unresolvedEffects"]).length === 0)) : section === REQUESTS_SECTION ? requestKeys.has(key) : section === ROOTS_SECTION ? roots.has(key) : section === READING_PLAN_SECTION ? ranges.has(key) : section === SETTLED_SECTION ? settled.has(key) : section === LINKS_SECTION ? links.has(key) : section === UNLINKED_SECTION ? unlinked.has(key) : section === CUTS_SECTION ? cuts.has(key) : false;
}

for (const { name, fact } of TRACE_FIXTURES) {
  const legacy = TRACE_LEGACY[name]!;
  const presentation = present(fact);
  const texts = { summary: normalize(write(presentation, "summary").text), details: normalize(write(presentation, "details").text) };
  /** The cut places and anchors a legacy summary stated: the completeness section counts its rows and leaves places to details. */
  const movedToDetails = new Set(legacy.summary.filter((token) => token.startsWith("cut ") || token.startsWith("anchor ")));

  test(`trace migration (${name}): no fact the legacy text stated is lost, in either mode`, () => {
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails });
  });

  test(`trace migration (${name}): summary rows are details rows, and every row is an entry of answer.json`, () => {
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, resolver(fact));
  });

  test(`trace migration (${name}): the same fact writes the same bytes in each mode`, () => {
    assertDeterministic(() => present(fact));
  });
}

test("a cut place a legacy summary stated is counted there and stated in details", () => {
  const { name, fact } = TRACE_FIXTURES.find(({ name }) => name.startsWith("partial: unresolved-link"))!;
  const token = "anchor src/flow.ts::deep";
  assert.ok(TRACE_LEGACY[name]!.summary.includes(token), "the frozen legacy summary states the cut place");
  assert.equal(tokensOf(write(present(fact), "summary").text).has(token), false, "the summary counts the cut and leaves its place to details");
  assert.equal(tokensOf(write(present(fact), "details").text).has(token), true, "details states the cut place");
});

test("no two rows of a section share a key, children included", () => {
  for (const { name, fact } of TRACE_FIXTURES) {
    for (const section of present(fact).sections) {
      const keys = new Set<string>();
      const visit = (rows: readonly Row[]) => {
        for (const row of rows) {
          assert.equal(keys.has(row.key), false, `${name} ${section.id}: ${row.key}`);
          keys.add(row.key);
          visit(row.children ?? []);
        }
      };
      visit(section.rows);
    }
  }
});

test("a trace summary states every step and root, so the call sequence is the answer", () => {
  for (const { name, fact } of TRACE_FIXTURES) {
    if (fact.status === "unknown") continue;
    const text = write(present(fact), "summary").text;
    for (const step of fact.value.steps) assert.match(text, new RegExp(`#${step.id} `), `${name}: step ${step.id}`);
    for (const root of fact.value.roots) assert.ok(text.includes(`${root.target} matches`), `${name}: root ${root.target}`);
  }
});

test("an entrypoint root states the target and the steps it selected", () => {
  const text = write(present(ENTRYPOINT_ROOT_FIXTURE), "summary").text;
  assert.ok(text.includes("http-route GET /orders matches 1: #0"), text);
  assert.equal(text.includes("src/order.ts:1-30 matches"), false, "the declaration target is not printed again");
});

test("a cut whose cause is a function value awaiting a declared JDK carries the step that lifts it, in both modes", () => {
  const { fact } = TRACE_FIXTURES.find(({ name }) => name.startsWith("partial: a function value"))!;
  for (const mode of ["summary", "details"] as const) assert.match(write(present(fact), mode).text, /next: declare a JDK \(--jdk on ye-ast trace or ye-ast mcp\) .* \(function-value-undeclared-jdk\)$/);
  const { fact: other } = TRACE_FIXTURES.find(({ name }) => name.startsWith("partial: unresolved-link"))!;
  assert.equal(write(present(other), "details").text.includes("next:"), false);
});

test("an unknown trace keeps its status and evidence, and states no section", () => {
  const { fact } = TRACE_FIXTURES.find(({ name }) => name === "unknown fact")!;
  const text = write(present(fact), "details").text;
  assert.match(text, /^status: unknown \(index-unavailable\)$/m);
  assert.match(text, /^ {2}evidence: src\/gone\.ts:1$/m);
  assert.equal(text.includes("steps:"), false);
});

test("a large trace in details is smaller than the legacy text it replaces", () => {
  const { name, fact } = TRACE_FIXTURES.find(({ name: fixture }) => fixture.startsWith("large"))!;
  const details = write(present(fact), "details").text;
  assert.ok(Buffer.byteLength(details) < TRACE_LEGACY[name]!.bytes.details, `${Buffer.byteLength(details)} >= ${TRACE_LEGACY[name]!.bytes.details}`);
});

test("trace row identity survives step renumbering and distinguishes call occurrences", () => {
  const fixture = TRACE_FIXTURES[0]!.fact;
  assert.notEqual(fixture.status, "unknown");
  if (fixture.status === "unknown") return;
  const renumbered = { ...fixture, value: { ...fixture.value, steps: fixture.value.steps.map((step) => ({ ...step, id: step.id + 100, ...(step.parent === undefined ? {} : { parent: step.parent + 100 }) })) } };
  const keys = (fact: typeof fixture) => write(present(fact), "details").printed.filter((row) => row.section === STEPS_SECTION).map((row) => row.key);
  assert.deepEqual(keys(renumbered), keys(fixture));
  const root = fixture.value.steps[0]!;
  const occurrence = { ...root, id: 500, parent: root.id, depth: 1, at: { line: 7, column: 2 } };
  const repeated = { ...fixture, value: { ...fixture.value, steps: [root, occurrence, { ...occurrence, id: 501, at: { line: 7, column: 8 } }] } };
  const repeatedKeys = keys(repeated);
  assert.equal(new Set(repeatedKeys).size, repeatedKeys.length);
});
