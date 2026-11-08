import { test } from "node:test";
import assert from "node:assert/strict";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import { createEdgeTargets, NOTHING_DECLARED } from "../navigation/edge-targets.ts";
import { fakeCodeGraph, type FakeEdge, type FakeNode, type FakeUnresolved } from "../navigation/fake-code-graph.testing.ts";
import { originCallsOf } from "./inbound-origins.ts";

const SVC = "src/svc.ts";
const CMP = "src/cmp.ts";
const HOLDS = { class: { path: SVC, symbol: "Child", line: 7 } };

/** `Base` declares `list`; `Child` extends it and declares nothing; `Lone` declares no `list`; `Over` declares two. */
const TYPES: readonly FakeNode[] = [{ id: "Base", kind: "class", file: SVC, start: 1, end: 5 }, { id: "Base.list", kind: "method", name: "list", file: SVC, start: 2, end: 4 }, { id: "Child", kind: "class", file: SVC, start: 7, end: 7 }, { id: "Lone", kind: "class", file: SVC, start: 9, end: 9 }, { id: "Over", kind: "class", file: SVC, start: 11, end: 15 }, { id: "Over.list1", kind: "method", name: "list", file: SVC, start: 12, end: 12 }, { id: "Over.list2", kind: "method", name: "list", file: SVC, start: 13, end: 14 }];
const TYPE_EDGES: readonly FakeEdge[] = [{ from: "Base", to: "Base.list", kind: "contains" }, { from: "Child", to: "Base", kind: "extends" }, { from: "Over", to: "Over.list1", kind: "contains" }, { from: "Over", to: "Over.list2", kind: "contains" }];

/** The declarations each member call through an origin reaches, as `caller→target@line`. */
async function reached(nodes: readonly FakeNode[], uses: readonly FakeUnresolved[], origins: { fields?: FieldOrigin[]; locals?: LocalOrigin[] }): Promise<string[]> {
  const store = fakeCodeGraph([...TYPES, ...nodes], [...TYPE_EDGES, { from: "Owner", to: "caller", kind: "contains" }], uses);
  const unknown = async (sites: readonly unknown[]) => sites.map(() => ({ status: "unknown", reason: "unresolved", evidence: [] }));
  const importOrigins = { origins: unknown, rootOrigins: unknown, rootBindings: async (sites) => sites.map(() => ({ kind: "unknown" })), receiverMethods: async (sites) => sites.map(() => ({ kind: "unknown" })) } as Pick<ImportOrigins, "origins" | "rootOrigins" | "rootBindings" | "receiverMethods"> as ImportOrigins;
  const fields = origins.fields ?? [];
  const locals = origins.locals ?? [];
  const calls = uses.map(({ line, column, name }) => ({ kind: "calls" as const, line, column: (column ?? 0) + 1, name, owners: [] }));
  const { bindings } = createEdgeTargets({ origins: importOrigins, store, syntaxOf: async () => ({ ...NOTHING_DECLARED, calls }), proofs: async () => ({ fields, locals, memberUses: [] }) });
  const edges = await originCallsOf(store, bindings!, { fields, locals });
  return edges.map(({ source, target, edge }) => `${source.id}→${target.id}@${edge.line}`);
}

const FIELD_OWNER: readonly FakeNode[] = [{ id: "Owner", kind: "class", file: CMP, start: 1, end: 20 }, { id: "caller", kind: "method", file: CMP, start: 5, end: 9 }];

test("a call on a field reaches the member the class its origin holds has, its own or one a class above declares, each of several it declares, and nothing when that class has none or the use lies outside the declaration the index gives it", async () => {
  const use: FakeUnresolved[] = [{ from: "caller", name: "this.svc.list", kind: "calls", file: CMP, line: 7, column: 4 }];
  const field = (holds: FieldOrigin["holds"]): FieldOrigin[] => [{ owner: { path: CMP, symbol: "Owner", line: 1 }, field: "svc", holds }];

  assert.deepEqual(await reached(FIELD_OWNER, use, { fields: field(HOLDS) }), ["caller→Base.list@7"]);
  assert.deepEqual(await reached(FIELD_OWNER, use, { fields: field({ class: { path: SVC, symbol: "Over", line: 11 } }) }), ["caller→Over.list1@7", "caller→Over.list2@7"]);
  assert.deepEqual(await reached(FIELD_OWNER, use, { fields: field({ class: { path: SVC, symbol: "Lone", line: 9 } }) }), []);
  assert.deepEqual(await reached(FIELD_OWNER, [{ ...use[0]!, line: 15 }], { fields: field(HOLDS) }), []);
});

test("a call on an inject() local counts only at a site the extractor certifies, inside the declaration that takes the local", async () => {
  const owner: readonly FakeNode[] = [{ id: "Owner", kind: "function", file: CMP, start: 1, end: 20 }, { id: "caller", kind: "function", file: CMP, start: 5, end: 9 }, { id: "outside", kind: "function", file: CMP, start: 30, end: 40 }];
  const site = { file: CMP, line: 7, column: 5, name: "svc.list", kind: "calls" as const };
  const local = (calls: LocalOrigin["calls"]): LocalOrigin[] => [{ owner: { path: CMP, symbol: "Owner", line: 1 }, local: "svc", holds: HOLDS, ...(calls === undefined ? {} : { calls }) }];
  const use = (from: string, line: number, column: number): FakeUnresolved[] => [{ from, name: "svc.list", kind: "calls", file: CMP, line, column }];

  assert.deepEqual(await reached(owner, use("caller", 7, 4), { locals: local([site]) }), ["caller→Base.list@7"]);
  assert.deepEqual(await reached(owner, use("caller", 7, 4), { locals: local(undefined) }), []);
  assert.deepEqual(await reached(owner, use("caller", 7, 5), { locals: local([site]) }), []);
  assert.deepEqual(await reached(owner, use("outside", 35, 4), { locals: local([{ ...site, line: 35 }]) }), []);
});
