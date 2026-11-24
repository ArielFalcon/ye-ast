import assert from "node:assert/strict";
import { test } from "node:test";
import { renderImpact, renderWorkspaceImpact } from "../render.ts";
import { expandFull } from "../full-projection.testing.ts";
import { projectFull, type Json } from "../full-projection.ts";
import type { ImpactValue } from "../../core/domain/impact/impact-fact.ts";
import type { Fact } from "../../core/domain/shared/fact.ts";
import { present, presentWorkspace, sections } from "./families/impact.ts";
import { IMPACT_FIXTURES } from "./families/impact.fixtures.testing.ts";
import { IMPACT_LEGACY } from "./families/impact.legacy.testing.ts";
import { assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails } from "./migration.testing.ts";
import { write } from "./writer.ts";

for (const fixture of IMPACT_FIXTURES.filter((fixture) => !fixture.workspace)) {
  const { name, fact } = fixture;
  const presentation = present(fact);
  const texts = { summary: write(presentation, "summary").text, details: write(presentation, "details").text };
  const legacy = IMPACT_LEGACY[name]!;
  test(`impact migration ${name}: legacy identities survive, summary is within details, deterministic`, () => {
    const movedToDetails = new Set([...legacy.summary.filter((token) => token.startsWith("cut ") || token.startsWith("anchor ")), ...(fact.status === "unknown" ? [] : fact.value.symbols.flatMap((symbol) => symbol.via?.substitutes?.map((substitute) => `place ${substitute.at.file}:${substitute.at.line}`) ?? []))]);
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails });
    assertSummaryWithinDetails(presentation);
    assert.ok(Buffer.byteLength(texts.details) >= Buffer.byteLength(texts.summary));
    assert.equal(write(structuredClone(presentation), "details").text, texts.details);
  });
}

test("workspace impact sections use the same symbol, seed and reached-entrypoint mappings for each owner", () => {
  for (const fixture of IMPACT_FIXTURES) {
    if (!fixture.workspace || fixture.fact.status === "unknown") continue;
    for (const [repo, fact] of Object.entries(fixture.fact.value.sections)) {
      if (fact.status === "unknown" || fact.value.impact === undefined) continue;
      const mapped = sections(fact.value.impact, `value.sections.${repo}.value.impact`, repo);
      assertSummaryWithinDetails({ status: [], snapshots: [], sections: mapped });
      for (const section of mapped) for (const row of section.rows) if (row.place?.line !== undefined) assert.equal(row.place.repo, repo);
    }
  }
});

test("impact rows resolve to the same answer.json and retain declaration and association facts", () => {
  for (const fixture of IMPACT_FIXTURES) {
    if (fixture.workspace) continue;
    const fact = fixture.fact;
    const answer = expandFull("impact", projectFull("impact", JSON.parse(JSON.stringify(fact)) as Json).fields) as unknown as typeof fact;
    const mapped = present(fact);
    assertRowsResolve(mapped, resolver(answer));
    if (fact.status === "unknown") continue;
    const symbols = mapped.sections.find((section) => section.id === "value.symbols")!.rows;
    fact.value.symbols.forEach((symbol, index) => {
      const row = symbols[index]!;
      assert.equal(row.place?.endLine, symbol.endLine);
      assert.equal(row.tier, Math.max(0, symbol.depth - 1));
      assert.ok(row.qualifiers?.some((qualifier) => qualifier.name === "depth" && qualifier.value === String(symbol.depth)));
      if (symbol.via !== undefined) assert.ok(row.qualifiers?.some((qualifier) => qualifier.name === "via" && qualifier.value?.includes(symbol.via!.symbol)));
      if (symbol.via?.substitutes !== undefined) assert.equal(row.children?.length, symbol.via.substitutes.length);
    });
    mapped.sections.find((section) => section.id === "value.entrypoints")!.rows.forEach((row, index) => {
      assert.equal(row.place?.endLine, fact.value.entrypoints[index]!.handler.endLine);
      assert.deepEqual(row.evidence?.map((place) => [place.path, place.line]), fact.value.entrypoints[index]!.seeds.map((seed) => [fact.value.seeds[seed]!.file, fact.value.seeds[seed]!.line]));
    });
  }
});

function resolver(answer: Fact<ImpactValue>): (section: string, key: string) => boolean {
  return (section, key) => {
      const [repo, file, line, symbol] = key.split("\0");
      if (section === "cuts") return answer.status === "partial" && answer.cuts.some((cut) => key === ["cut", cut.kind, cut.reason, cut.subReason ?? "", String(cut.limit ?? ""), cut.at.join("\u0001")].join("\0") || cut.at.some((at) => key.endsWith(`\0${at}`)) || cut.cause?.some((at) => key.endsWith(`\0${at}`)) === true);
      if (answer.status === "unknown") return false;
      const value = answer.value;
      if (section === "value.symbols") return value.symbols.some((item) => repo === "" && file === item.file && line === String(item.line) && symbol === item.symbol && (key.split("\0").length === 4 || item.via?.substitutes?.some((substitute) => key.endsWith([substitute.file, substitute.symbol, substitute.line].join("\0"))) === true));
      if (section === "value.seeds") return value.seeds.some((item) => repo === "" && file === item.file && line === String(item.line) && symbol === item.symbol);
      if (section === "value.entrypoints") return value.entrypoints.some((entry) => key.startsWith(["", entry.kind, entry.name ?? "", entry.handler.path, entry.handler.line].join("\0")) || (entry.kind === "unknown" && entry.observations.some((observation) => key.startsWith("\0unknown\0") && key.includes(observation.reason) && observation.evidence.some((place) => key.endsWith([place.path, place.line].join("\0"))))));
      if (section === "value.modules.modules") return value.modules?.modules.some((item) => key === ["", item.snapshot, item.file].join("\0")) === true;
      if (section === "value.modules.origins") return value.modules?.origins.some((item) => key === ["", item.file, item.change].join("\0")) === true;
      if (section === "value.changedPaths") return value.changedPaths?.some((item) => key === `\0${item.path}`) === true;
      if (section === "value.changedEntrypoints") return value.changedEntrypoints?.some((item) => key === ["", item.kind, item.name, item.handler.path, item.handler.line].join("\0")) === true;
      if (section === "value.changedContracts") return value.changedContracts?.some((item) => key === [item.document, item.line, item.method, item.path].join("\0")) === true;
      if (section === "value.settled") return value.settled?.some((item) => key === JSON.stringify(item)) === true;
      return false;
  };
}

test("workspace row identities resolve to each owner's full projection", () => {
  for (const fixture of IMPACT_FIXTURES) {
    if (!fixture.workspace || fixture.fact.status === "unknown") continue;
    const fact = fixture.fact;
    const answer = expandFull("impact", projectFull("impact", JSON.parse(JSON.stringify(fact)) as Json).fields) as unknown as typeof fact;
    const presentation = presentWorkspace(fact);
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, (sectionId, key) => {
      if (sectionId === "cuts") return resolver({ ...fact, value: { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } } })(sectionId, key);
      for (const [repo, section] of Object.entries(answer.value.sections)) {
        if (section.status === "unknown") continue;
        if (sectionId === `value.sections.${repo}.cuts`) return resolver({ ...section, value: section.value.impact ?? { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } } })("cuts", key);
        const prefix = `value.sections.${repo}.value.impact`;
        if (sectionId.startsWith(`${prefix}.`) && section.value.impact !== undefined) {
          const localKey = key.startsWith(`${repo}\0`) ? key.slice(repo.length) : key;
          return resolver({ ...section, value: section.value.impact })(sectionId.replace(prefix, "value"), localKey);
        }
      }
      return false;
    });
  }
});

test("workspace impact retains legacy text identities in both modes", () => {
  for (const fixture of IMPACT_FIXTURES) {
    if (!fixture.workspace) continue;
    const texts = { summary: renderWorkspaceImpact(fixture.fact, "summary"), details: renderWorkspaceImpact(fixture.fact, "details") };
    if (fixture.fact.status !== "unknown") for (const repo of fixture.fact.value.workspace.repos) {
      for (const mode of ["summary", "details"] as const) texts[mode] = texts[mode].split("\n").map((line) => line.trimStart().startsWith(`${repo}:`) ? line.replace(`${repo}:`, "") : line).join("\n");
    }
    const legacy = IMPACT_LEGACY[fixture.name]!;
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails: new Set(legacy.summary.filter((token) => token.startsWith("cut ") || token.startsWith("anchor "))) });
  }
});

test("compact module and changed-path replies stay below the frozen legacy sizes", () => {
  for (const name of ["fixture-23", "fixture-58"]) {
    const fixture = IMPACT_FIXTURES.find((fixture) => fixture.name === name)!;
    assert.equal(fixture.workspace, false);
    if (fixture.workspace) continue;
    for (const mode of ["summary", "details"] as const) assert.ok(Buffer.byteLength(renderImpact(fixture.fact, mode)) < IMPACT_LEGACY[name]!.bytes[mode]);
  }
});
