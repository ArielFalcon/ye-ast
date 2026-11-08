import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId } from "../../ports/code-graph.port.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import { createCallBinder } from "./call-binder.ts";
import { fakeCodeGraph, fakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";

const STORE = "src/store.ts";
const API = "src/api.ts";

/** `store.ts` line 3 writes `api\n    .remove(id)` inside `drop`; the relations prove `api.remove` there runs `Api.remove`. */
function binder() {
  const store = fakeCodeGraph(
    [fakeNode("drop", "function", STORE, 2, 5), fakeNode("Api", "class", API, 1, 6), fakeNode("remove", "method", API, 2, 4)],
    [{ from: "Api", to: "remove", kind: "contains" }],
  );
  const memberUses: MemberUseOrigin[] = [
    { owner: { path: STORE, symbol: "drop", line: 2 }, receiver: { path: API, symbol: "Api", line: 1 }, member: { path: API, symbol: "Api.remove", line: 2 }, reference: { file: STORE, line: 3, column: 5, name: "api.remove", kind: "calls" } },
  ];
  const settle = createCallBinder({
    store,
    navigation: createGraphNavigation(store, () => false),
    syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }),
    proofs: async () => ({ fields: [], locals: [], memberUses }),
    importedDeclarations: async () => new Map(),
  });
  const [drop] = store.symbolsByIds(["drop" as GraphNodeId]);
  return { settle, drop: drop! };
}

test("a member proof binds a call whose spelling breaks across lines, as it binds the same call written on one", async () => {
  const { settle, drop } = binder();
  for (const spelling of ["api.remove", "api\n    .remove", "api .remove"]) {
    const proof = await settle.receiverOf({ body: drop, line: 3, column: 5, member: "remove", receiver: "api", spelling });
    assert.equal(proof.link === "member" ? proof.method?.name : proof.link, "remove", JSON.stringify(spelling));
  }
});
