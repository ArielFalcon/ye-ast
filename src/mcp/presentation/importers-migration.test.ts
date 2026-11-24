import { strict as assert } from "node:assert";
import { test } from "node:test";
import { expandFull } from "../full-projection.testing.ts";
import { isRecord, projectFull, type Json } from "../full-projection.ts";
import type { ImportedFile } from "../../core/domain/impact/importers-fact.ts";
import type { Fact } from "../../core/domain/shared/fact.ts";
import { assertDeterministic, assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails, tokensOf } from "./migration.testing.ts";
import { write } from "./writer.ts";
import { IMPORTED_FILES_SECTION, present } from "./families/importers.ts";
import { IMPORTERS_FIXTURES } from "./families/importers.fixtures.testing.ts";
import { IMPORTERS_LEGACY } from "./families/importers.legacy.testing.ts";

const CATEGORIES = ["importers", "reexporters", "dynamicImporters", "typeImporters", "users", "unresolvedNamers"] as const;

const entriesOf = (fact: Fact<unknown>): readonly ImportedFile[] => (fact.status === "unknown" ? [] : (fact.value as { files: readonly ImportedFile[] }).files);
const distinctRelated = (entry: ImportedFile): number => new Set(CATEGORIES.flatMap((category) => entry[category] ?? [])).size;
const expectedRows = (fact: Fact<unknown>): number => entriesOf(fact).reduce((total, entry) => total + Math.max(1, distinctRelated(entry)), 0);

const jsonOf = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const recordsOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The entries of `answer.json` of the same fact, with the folds of the full projection undone. */
function resolver(fact: unknown): (section: string, key: string) => boolean {
  const answer = expandFull("importers", projectFull("importers", jsonOf(fact)).fields);
  const value = isRecord(answer["value"]) ? answer["value"] : {};
  const files = recordsOf(value["files"]);
  const cuts = recordsOf(answer["cuts"]);
  const cutKey = (cut: Json): string => ["cut", cut["kind"], cut["reason"], cut["subReason"] ?? "", String(cut["limit"] ?? ""), (cut["at"] as string[]).join("\u0001")].join("\0");
  return (id, key) => {
    if (id === IMPORTED_FILES_SECTION) {
      const [file, related, ...child] = key.split("\0");
      const owners = files.filter((record) => record["file"] === file);
      if (owners.length !== 1 || child.length > 0) return false;
      const owner = owners[0]!;
      if (related === "no-related-files") return CATEGORIES.every((category) => !Array.isArray(owner[category]) || owner[category].length === 0);
      return CATEGORIES.some((category) => Array.isArray(owner[category]) && (owner[category] as unknown[]).includes(related));
    }
    if (id === "cuts") return cuts.some((cut) => cutKey(cut) === key || key.startsWith(`${cutKey(cut)}\0`));
    return false;
  };
}

for (const { name, fact } of IMPORTERS_FIXTURES) {
  const legacy = IMPORTERS_LEGACY[name]!;
  const presentation = present(fact);
  const texts = { summary: write(presentation, "summary").text, details: write(presentation, "details").text };

  test(`importers migration (${name}): no identity the legacy text stated is lost, in either mode`, () => {
    const movedToDetails = new Set(legacy.summary.filter((token) => token.startsWith("anchor ") || token.startsWith("cut ")));
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails });
    for (const token of movedToDetails) assert.ok(legacy.summary.includes(token), `a documented move that the legacy summary never stated: ${token}`);
  });

  test(`importers migration (${name}): summary is within details and every row is an entry of answer.json`, () => {
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, resolver(fact));
  });

  test(`importers migration (${name}): each target file and each related file is one row, in both modes`, () => {
    for (const mode of ["summary", "details"] as const) {
      const rows = write(presentation, mode).printed.filter((row) => row.section === IMPORTED_FILES_SECTION);
      assert.equal(rows.length, expectedRows(fact), `${mode}: one row per target file with no related file, else one per distinct related file`);
      assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, `${mode}: a related file is stated once per target`);
    }
    for (const entry of entriesOf(fact)) assert.ok(texts.summary.includes(entry.file), `no row states the target file ${entry.file}`);
  });

  test(`importers migration (${name}): recorded relationship lines print in details, never in summary`, () => {
    const details = tokensOf(texts.details);
    const summary = tokensOf(texts.summary);
    for (const entry of entriesOf(fact)) {
      for (const place of entry.places ?? []) {
        assert.ok(details.has(`place ${place.file}:${place.line}`), `details does not state ${place.file}:${place.line}`);
        assert.equal(summary.has(`place ${place.file}:${place.line}`), false, `summary states the evidence place ${place.file}:${place.line}`);
      }
    }
  });

  test(`importers migration (${name}): the details reply is smaller than the legacy one`, () => {
    if (legacy.bytes.details > 400) assert.ok(Buffer.byteLength(texts.details) < legacy.bytes.details, `${Buffer.byteLength(texts.details)} >= ${legacy.bytes.details}`);
  });

  test(`importers migration (${name}): the same fact gives the same bytes`, () => assertDeterministic(() => present(fact)));
}

test("importers with no recorded place answer summary and details with the same bytes, and an empty entry is stated", () => {
  const withoutPlaces = IMPORTERS_FIXTURES.find(({ fact }) => entriesOf(fact).length > 0 && entriesOf(fact).every((entry) => (entry.places ?? []).length === 0))!;
  const presentation = present(withoutPlaces.fact);
  assert.equal(write(presentation, "summary").text, write(presentation, "details").text);
  const empty = IMPORTERS_FIXTURES.find(({ fact }) => entriesOf(fact).some((entry) => distinctRelated(entry) === 0))!;
  const text = write(present(empty.fact), "summary").text;
  assert.ok(text.includes("no related files"));
});

test("importers states a user that imports nothing as an additional user and a name already related as also unresolved", () => {
  const { fact } = IMPORTERS_FIXTURES.find(({ name }) => name.startsWith("memberships"))!;
  const text = write(present(fact), "details").text;
  assert.ok(text.includes("src/OrderController.java (importers[0], users[0])"), text);
  assert.ok(text.includes("src/Shared.java (importers[1], users[1], also unresolved name matches[1])"), text);
  assert.ok(text.includes("src/Billing.java (additional users[2])"), text);
  assert.ok(text.includes("src/Legacy.java (unresolved name matches[0])"), text);
});

test("importers states each recorded relationship line once, in ascending order", () => {
  const { fact } = IMPORTERS_FIXTURES.find(({ name }) => name.startsWith("memberships"))!;
  const details = write(present(fact), "details").text;
  assert.ok(details.includes("evidence: src/OrderController.java:12,30"), details);
  assert.equal(details.split("src/OrderController.java:12").length - 1, 1);
});

test("importers states a file two targets share under each target", () => {
  const { fact } = IMPORTERS_FIXTURES.find(({ name }) => name.startsWith("two targets"))!;
  const text = write(present(fact), "summary").text;
  for (const path of entriesOf(fact)[0]!.importers) assert.equal(text.split(path).length - 1, 2, path);
});

test("importers unknown fact prints its reason and no answer section", () => {
  const { fact } = IMPORTERS_FIXTURES.find(({ fact }) => fact.status === "unknown")!;
  const text = write(present(fact), "summary").text;
  assert.match(text, /status: unknown \(unresolved\)/);
  assert.equal(text.includes("importers:"), false);
});
