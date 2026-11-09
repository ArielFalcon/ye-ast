import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotRef } from "../../domain/shared/fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { TypeBindingsAnswer } from "../../ports/type-bindings.port.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import { createBaseReadings } from "./base-reading.ts";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import type { EdgeTargets } from "../navigation/edge-targets.ts";

const SHA: SnapshotRef = { repo: "shop", kind: "sha", sha: "a".repeat(40) };
const LIVE: SnapshotRef = { repo: "shop", kind: "live", head: "h", stateId: "s" };
const OUTPUTS = [{ kind: "node-modules" as const, at: "", path: "/host/node_modules" }];

function typedOf(snapshot: SnapshotRef, answer: TypeBindingsAnswer, inputs: "read" | "fault" = "read") {
  const checkerInputs: RevisionSources = {
    resolve: async () => ({ ok: true, value: SHA.kind === "sha" ? SHA.sha : "" }),
    filesAt: async () => (inputs === "read" ? { ok: true, value: { files: [], cuts: [] } } : { ok: false, fault: { kind: "unreadable" } as unknown as WorkspaceFault }),
  };
  const readings = createBaseReadings({ relations: {} as RelationExtractor, typeBindings: { of: async () => answer }, checkerInputs });
  const source = { tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: undefined, store: {} as CodeGraphReader, snapshot, request: { repo: "/work/shop", buildOutputs: OUTPUTS } };
  return readings.of(source, {}).typed();
}

test("the typed reading answers evidence and builds no cut, whatever kept it from reading the declared outputs", async () => {
  const answers: [SnapshotRef, TypeBindingsAnswer, ("read" | "fault")?][] = [
    [LIVE, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }],
    [SHA, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }, "fault"],
    [SHA, { status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit" } as never] }] }],
    [SHA, { status: "fault", fault: { kind: "unreadable", outputs: [{ kind: "node-modules", at: "", paths: ["kit"] }] } }],
    [SHA, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }],
    [SHA, { status: "bound", bindings: [], unowned: [], refused: ["node_modules/link"], outputs: [] }],
  ];
  for (const [snapshot, answer, inputs] of answers) {
    const reading = await typedOf(snapshot, answer, inputs);
    assert.ok(reading !== "aborted");
    assert.equal("cuts" in reading, false, JSON.stringify(reading));
  }
});

test("the calls through origins are derived once per index and relations' scope, and again for another index", async () => {
  const file = "src/cmp.ts";
  const graph = fakeCodeGraph([fakeNode("Owner", "class", file, 1, 20), fakeNode("caller", "method", file, 5, 9), fakeNode("list", "method", "src/svc.ts", 2, 4)], [{ from: "Owner", to: "caller", kind: "contains" }], [{ from: "caller", name: "this.svc.list", kind: "calls", file, line: 7, column: 4 }]);
  let reads = 0;
  const store: CodeGraphReader = { ...graph, unresolvedReferences: (files) => (reads++, graph.unresolvedReferences(files)) };
  const relations = { language: { reads: () => true }, extract: async () => ({ relations: [], fields: [{ owner: { path: file, symbol: "Owner", line: 1 }, field: "svc", holds: { class: { path: "src/svc.ts", symbol: "Svc", line: 1 } } }], locals: [], memberUses: [] }) } as unknown as RelationExtractor;
  const kept = new Map<string, unknown>();
  const retained = async <T>(slot: string, produce: () => Promise<T>): Promise<T> => (kept.has(slot) ? (kept.get(slot) as T) : (kept.set(slot, JSON.parse(JSON.stringify(await produce()))), kept.get(slot) as T));
  const asked: string[][] = [];
  const targets = { bindings: { boundCalls: async (calls: readonly { reference: { name: string } }[]) => (asked.push(calls.map(({ reference }) => reference.name)), calls.map(() => ({ kind: "unbound", form: "member", candidates: [], attributed: [] }))) } } as unknown as EdgeTargets;
  const readings = createBaseReadings({ relations });
  const [list] = store.symbolsInFiles(["src/svc.ts"]);
  const into = (digest: string, scope?: { exclude: string[] }) => readings.of({ tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: { retained } as never, store, digest, snapshot: SHA, request: { repo: "/work/shop", ...(scope && { scope }) } }, {}).originCalls(targets)!.into([list!]);

  await into("index-1");
  await into("index-1");
  assert.equal(reads, 1);
  await into("index-2");
  await into("index-1", { exclude: ["gen/"] });
  assert.equal(reads, 3);
  assert.deepEqual(asked, [["this.svc.list"], ["this.svc.list"], ["this.svc.list"], ["this.svc.list"]]);
});
