import { test } from "node:test";
import assert from "node:assert/strict";
import type { Link } from "../core/domain/topology/link.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import { keyTraceLinks, keyWorkspaceImpactLinks, keyWorkspaceLinks } from "./link-keys.ts";

const handler = (symbol: string) => ({ path: "src/Api.java", symbol, line: 10 });
function link(id: string, from: number, to = "api"): Link {
  return { id, from: { repo: "web", file: `src/f${from}.ts`, line: from, symbol: `call${from}` }, to: { repo: to, kind: "http-route", name: `GET /${from}`, handler: handler(`Api.m${from}`) }, transport: "http", basis: "exact", confidence: 1 };
}
const LONG = (n: number) => JSON.stringify(["web", `src/f${n}.ts`, n, `call${n}`, "api", "http-route", `GET /${n}`, "src/Api.java", `Api.m${n}`, 10, "http", "exact", null]);

test("a workspace impact answer keys its links by position and re-points every reach entry", () => {
  const [a, b, c] = [link(LONG(1), 1), link(LONG(2), 2), link(LONG(3), 3)];
  const value = {
    links: [
      { link: a, direction: "upstream", reach: [LONG(1)] },
      { link: b, direction: "upstream", reach: [LONG(1), LONG(2)] },
      { link: c, direction: "downstream", reach: [LONG(3), "[\"missing\"]"] },
    ],
  } as unknown as WorkspaceImpactValue;
  const keyed = keyWorkspaceImpactLinks(value);
  assert.deepEqual(keyed.links.map((item) => item.link.id), ["1", "2", "3"]);
  assert.deepEqual(keyed.links.map((item) => item.reach), [["1"], ["1", "2"], ["3", "[\"missing\"]"]]);
  const keys = new Map(keyed.links.map((item, index) => [item.link.id, value.links[index]!.link.id]));
  assert.deepEqual(keyed.links.map((item) => ({ ...item, link: { ...item.link, id: keys.get(item.link.id)! }, reach: item.reach.map((key) => keys.get(key) ?? key) })), value.links);
});

test("a workspace answer numbers its internal links after its links and keeps their order", () => {
  const value = { links: [link(LONG(5), 5), link(LONG(1), 1)], internalLinks: [link(LONG(9), 9, "web")] } as unknown as WorkspaceValue;
  const keyed = keyWorkspaceLinks(value);
  assert.deepEqual(keyed.links.map((item) => item.id), ["1", "2"]);
  assert.deepEqual(keyed.internalLinks.map((item) => item.id), ["3"]);
  assert.equal(keyed.links[0]!.from.symbol, "call5");
});

test("a trace answer keys its links and an answer without links is returned as it is", () => {
  const linked = { links: [{ ...link(LONG(2), 2), deferred: true as const }, link(LONG(1), 1)] } as unknown as TraceValue;
  assert.deepEqual(keyTraceLinks(linked).links!.map((item) => [item.id, item.deferred]), [["1", true], ["2", undefined]]);
  const none = { roots: [] } as unknown as TraceValue;
  assert.equal(keyTraceLinks(none), none);
});
