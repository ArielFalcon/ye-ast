import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotRef } from "../../domain/shared/fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { TypeBindingsAnswer } from "../../ports/type-bindings.port.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import { createBaseReadings } from "./base-reading.ts";

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
