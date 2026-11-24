import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalJson } from "../../core/domain/shared/canonical-json.ts";
import type { Fact } from "../../core/domain/shared/fact.ts";
import { expandFull } from "../full-projection.testing.ts";
import { isRecord, projectFull, type Json } from "../full-projection.ts";
import { assertDeterministic, assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails, tokensOf } from "./migration.testing.ts";
import { write } from "./writer.ts";
import { ANCESTORS_SECTION, FILES_SECTION, FOCUS_SECTION, UNHELD_SECTION, USES_SECTION, present } from "./families/outline.ts";
import type { OutlineFocus, OutlineUse, OutlineValue } from "../../core/domain/outline/outline-fact.ts";
import type { Cut } from "../../core/domain/shared/fact.ts";
import { OUTLINE_FIXTURES, outlineFact } from "./families/outline.fixtures.testing.ts";
import { OUTLINE_LEGACY } from "./families/outline.legacy.testing.ts";

const jsonOf = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const arrayOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const declarationKey = (file: unknown, declaration: Json): string => ["", String(file), String(declaration["line"]), String(declaration["name"])].join("\0");
const declarationKeys = (file: unknown, declarations: readonly Json[]): Set<string> =>
  new Set(declarations.flatMap((declaration) => [declarationKey(file, declaration), ...declarationKeys(file, arrayOf(declaration["children"]))]));

/** The entries of `answer.json` of the same fact each row key names, read back from the projection. */
function resolver(fact: Fact<OutlineValue>): (section: string, key: string) => boolean {
  const answer = expandFull("outline", projectFull("outline", jsonOf(fact)).fields);
  const value = isRecord(answer["value"]) ? answer["value"] : {};
  const files = arrayOf(value["files"]);
  const listing = new Set(files.flatMap((entry) => [...declarationKeys(entry["file"], arrayOf(entry["declarations"]))]));
  const declaresNothing = new Set(files.filter((entry) => arrayOf(entry["declarations"]).length === 0).map((entry) => [String(entry["file"]), "none"].join("\0")));
  const statements = new Set<string>();
  const bindings = new Set<string>();
  for (const entry of files) {
    for (const item of arrayOf(entry["imports"])) {
      const key = [String(entry["file"]), "import", canonicalJson(item)].join("\0");
      statements.add(key);
      for (const binding of arrayOf(item["bindings"])) bindings.add([key, "binding", canonicalJson(binding)].join("\0"));
    }
  }
  const matches = arrayOf(value["focus"]);
  const focused = new Set<string>();
  const ancestors = new Set<string>();
  const uses = new Set<string>();
  for (const match of matches) {
    const file = String(match["file"]);
    const selector = String(match["selector"]);
    const declaration = match["declaration"] as Json;
    focused.add([declarationKey(file, declaration), "focus", selector].join("\0"));
    for (const key of declarationKeys(file, arrayOf(declaration["children"]))) focused.add(key);
    for (const ancestor of arrayOf(match["ancestors"])) ancestors.add(declarationKey(file, ancestor));
    if (Array.isArray(match["uses"])) {
      for (const use of arrayOf(match["uses"])) uses.add(canonicalJson([file, selector, use]));
      if (arrayOf(match["uses"]).length === 0) uses.add(canonicalJson([file, selector, "uses-nothing"]));
    }
  }
  const unheld = new Set(stringsOf(value["unheld"]).map((file) => [file, "unheld"].join("\0")));
  const cuts = new Set(arrayOf(answer["cuts"]).flatMap((cut) => {
    const key = ["cut", String(cut["kind"]), String(cut["reason"]), String(cut["subReason"] ?? ""), String(cut["limit"] ?? ""), stringsOf(cut["at"]).join("\u0001")].join("\0");
    return [key, ...stringsOf(cut["at"]).map((at) => `${key}\0${at}`), ...stringsOf(cut["cause"]).map((at) => `${key}\0${at}`)];
  }));
  return (section, key) => {
    if (section === FILES_SECTION) return listing.has(key) || declaresNothing.has(key) || statements.has(key) || bindings.has(key);
    if (section === FOCUS_SECTION) return focused.has(key);
    if (section === ANCESTORS_SECTION) return ancestors.has(key);
    if (section === USES_SECTION) return uses.has(key);
    if (section === UNHELD_SECTION) return unheld.has(key);
    return cuts.has(key);
  };
}

/** The tokens a numeric focus selector states as evidence, which `summary` counts instead of listing. */
function selectorEvidence(fact: Fact<OutlineValue>): string[] {
  const value = jsonOf(fact)["value"];
  if (!isRecord(value)) return [];
  return arrayOf(value["focus"]).flatMap((match) => (/^\d+$/.test(String(match["selector"])) ? [`place ${String(match["file"])}:${String(match["selector"])}`] : []));
}

for (const { name, fact } of OUTLINE_FIXTURES) {
  const legacy = OUTLINE_LEGACY[name]!;
  const presentation = present(fact);
  const texts = { summary: write(presentation, "summary").text, details: write(presentation, "details").text };

  test(`outline migration (${name}): no fact the legacy text stated is lost, in either mode`, () => {
    const movedToDetails = new Set([...legacy.summary.filter((token) => token.startsWith("cut ") || token.startsWith("anchor ")), ...selectorEvidence(fact)]);
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails });
    for (const token of movedToDetails) assert.ok(legacy.summary.includes(token), `a documented move that the legacy summary never stated: ${token}`);
  });

  test(`outline migration (${name}): summary rows are details rows, every row is an entry of answer.json, and the bytes are stable`, () => {
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, resolver(fact));
    assertDeterministic(() => present(fact));
  });
}

test("every declaration an import binding reaches is stated in both modes", () => {
  const fact = OUTLINE_FIXTURES[0]!.fact;
  assert.notEqual(fact.status, "unknown");
  const value = (fact as { value: Extract<OutlineValue, { files: readonly unknown[] }> }).value;
  const texts = { summary: write(present(fact), "summary").text, details: write(present(fact), "details").text };
  const places = value.files.flatMap((file) => file.imports.flatMap((item) => item.bindings.flatMap((binding) => (binding.declaration === undefined ? [] : [`${binding.declaration.file}:${binding.declaration.line}`]))));
  assert.ok(places.length > 2);
  for (const [mode, text] of Object.entries(texts)) {
    for (const place of places) assert.ok(tokensOf(text).has(`place ${place}`), `${mode} does not state ${place}`);
  }
});

test("a file that holds no declaration says so", () => {
  assert.match(write(present(OUTLINE_FIXTURES[5]!.fact), "summary").text, /\n {4}declares nothing$/);
});

test("a focus states its members in both modes, a proven path on the row and a line selector only as evidence", () => {
  const { fact } = OUTLINE_FIXTURES[2]!;
  const summary = write(present(fact), "summary").text;
  const details = write(present(fact), "details").text;
  assert.ok(summary.includes(":38-38 total [const]"));
  assert.ok(summary.includes("(path OrdersComponent.save, omitted 5)"));
  assert.ok(details.includes("evidence: :48"));
  assert.equal(summary.includes(":48"), false);
});

test("files whose declarations are unknown are a cut of the answer: counted in summary, named in details", () => {
  const { fact } = OUTLINE_FIXTURES[3]!;
  const summary = write(present(fact), "summary").text;
  const details = write(present(fact), "details").text;
  assert.ok(summary.includes("unheld files:\n  declarations unknown"));
  assert.ok(details.includes("src/app/orders/broken.ts declarations unknown"));
});

const unprovedUse: Cut = {
  kind: "unresolved-link",
  at: ["src/app/orders/orders.service.ts::OrdersService.find", "src/app/orders/orders.service.ts:16 port.load"],
  reason: "use-unproven",
  reach: { kind: "anything" },
};

test("a focus states what its body uses, that it uses nothing, and nothing it never evaluated", () => {
  const match = (uses?: readonly OutlineUse[]): OutlineFocus => ({
    file: "src/app/orders/orders.service.ts",
    selector: "OrdersService.find",
    path: "OrdersService.find",
    ancestors: [],
    declaration: { kind: "method", name: "find", line: 12, endLine: 20 },
    omitted: 0,
    ...(uses === undefined ? {} : { uses }),
  });
  const written = (uses?: readonly OutlineUse[], cuts?: readonly Cut[]): string => write(present(outlineFact({ unheld: [], focus: [match(uses)] }, cuts)), "summary").text;
  assert.equal(written(undefined).includes("uses"), false);
  assert.ok(written([], [unprovedUse]).includes("uses nothing proven outside its body"));
  assert.ok(written([{ module: "rxjs", relations: ["references"], at: [{ line: 13 }] }]).includes("rxjs (package) (references, at 13)"));
});
