import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../../core/domain/shared/canonical-json.ts";
import { linkIdentity, type Link } from "../../core/domain/topology/link.ts";
import { assertDeterministic, assertNoFactLost, assertRowsResolve, assertSummaryWithinDetails } from "./migration.testing.ts";
import { write } from "./writer.ts";
import { present as workspace } from "./families/workspace.ts";
import { present as decisions } from "./families/decisions.ts";
import { workspaceFixture, decisionsFixture } from "./families/workspace.fixtures.testing.ts";
import { LEGACY as workspaceLegacy } from "./families/workspace.legacy.testing.ts";
import { LEGACY as decisionsLegacy } from "./families/decisions.legacy.testing.ts";
import { expandFull } from "../full-projection.testing.ts";
import { projectFull, type Json } from "../full-projection.ts";
import type { Presentation } from "./model.ts";

function resolver(fact: unknown, tool: "workspace" | "decisions"): (section: string, key: string) => boolean {
  const keys = new Set<string>();
  const visit = (node: unknown, repo = "") => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(item => visit(item, repo)); return; }
    const item = node as Record<string, unknown>;
    keys.add(canonicalJson(node));
    if (typeof item["id"] === "string") keys.add(item["id"]);
    if (typeof item["kind"] === "string" && typeof item["name"] === "string") keys.add([repo || canonicalJson(item["evidence"]), item["kind"], item["name"]].join("\0"));
    if (typeof item["basis"] === "string" && typeof item["repo"] === "string") keys.add(canonicalJson([item["name"], item["repo"], item["basis"]]));
    if (item["from"] && item["to"]) { const key = linkIdentity(node as Link); keys.add(key); keys.add(`${key}\0handler`); }
    if (item["from"] && item["outcome"]) keys.add(canonicalJson([item["from"], item["transport"], item["method"], item["name"], item["outcome"]]));
    if (item["path"] && item["symbol"]) keys.add(canonicalJson([repo || undefined, item["path"], item["line"], item["symbol"], item["transport"], item["reason"], item["diagnostic"]]));
    if (item["at"] && item["reason"]) {
      const key = ["cut", item["kind"], item["reason"], item["subReason"] ?? "", String(item["limit"] ?? ""), (item["at"] as string[]).join("\u0001")].join("\0");
      keys.add(key);
      for (const place of [...item["at"] as string[], ...(item["cause"] as string[] | undefined ?? [])]) keys.add(`${key}\0${place}`);
    }
    if (item["subject"] && Array.isArray(item["options"])) for (const option of item["options"] as {value:string}[]) keys.add([item["id"], "option", option.value].join("\0"));
    for (const [key, child] of Object.entries(item)) {
      if (key === "sections" && child && typeof child === "object") for (const [owner, section] of Object.entries(child)) visit(section, owner);
      else visit(child, repo);
    }
  };
  visit(expandFull(tool, projectFull(tool, JSON.parse(JSON.stringify(fact)) as Json).fields));
  return (_section, key) => keys.has(key);
}

const normalize = (text: string) => {
  let file = "";
  return text.replace(/\b(?:web|api|missing):(?=src\/)/g, "").split("\n").map(line => {
    const header = /^  (src\/\S+)$/.exec(line);
    if (header) file = header[1]!;
    if (!line.startsWith(" ")) file = "";
    return line.replace(/^(    (?:\d+\. )?)(\d+(?:-\d+)?) /, `$1${file}:$2 `);
  }).join("\n");
};
for (const [name, fact, present, legacy] of [["workspace", workspaceFixture, workspace, workspaceLegacy], ["decisions", decisionsFixture, decisions, decisionsLegacy]] as const) {
  const presentation = (present as (fact: unknown) => Presentation)(fact);
  const texts = { summary: normalize(write(presentation, "summary").text), details: normalize(write(presentation, "details").text) };
  test(`${name}: I1 preserves legacy tokens, with evidence moved to details`, () => {
    for (const mode of ["summary", "details"] as const) assertNoFactLost(mode, legacy[mode], texts, { movedToDetails: new Set(legacy.summary.filter(token => token.startsWith("place ") || token.startsWith("cut "))) });
  });
  test(`${name}: I2-I4 preserve rows, identity resolution and deterministic bytes`, () => {
    assertSummaryWithinDetails(presentation);
    assertRowsResolve(presentation, resolver(fact, name));
    assertDeterministic(() => (present as (fact: unknown) => Presentation)(fact));
  });
  test(`${name}: details reduces fixture bytes`, () => assert.ok(Buffer.byteLength(write(presentation, "details").text) < legacy.bytes.details));
}
