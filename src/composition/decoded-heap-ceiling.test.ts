import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";

test("the snapshot cache's charge is a ceiling on the heap its decoded entries take, for derived facts and an all-ASCII sources entry", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const heap = (): number => {
    for (let pass = 0; pass < 4; pass++) gc();
    return process.memoryUsage().heapUsed;
  };
  const path = (at: number) => `module-${at % 7}/src/main/java/com/example/area${at % 31}/Type${at % 997}.java`;
  const relation = (at: number) => ({ status: "complete", value: { kind: "references", name: `Type${at % 997}>Base${at % 13}`, from: { path: path(at), symbol: `Type${at % 997}`, line: at % 300 }, to: { path: path(at + 1), symbol: `Base${at % 13}`, line: 5 }, at: { path: path(at), line: at % 300, column: 9 } } });
  const fact = (at: number) => JSON.stringify({ value: { relations: Array.from({ length: 6 }, (_, index) => relation(at * 6 + index)), rows: Array.from({ length: 6 }, () => ({ findings: [], found: [] })) }, reads: [[`file|${path(at)}`, `${at}`.padStart(64, "0")]] });
  const source = (at: number) => ({ path: path(at), content: `package com.example.area${at % 31};\n\npublic class Type${at} {\n${"  void run() { helper(); }\n".repeat(60)}}\n`, blob: `${at}`.padStart(40, "0") });
  const cache = createSnapshotDataCache("working-set");
  cache.beginRead({ repository: "/repo", snapshot: "revision", key: "content" });

  const before = heap();
  for (let at = 0; at < 2_000; at++) cache.putFact(`${at}`.padStart(64, "f"), fact(at));
  cache.put("sources", { sources: Array.from({ length: 2_500 }, (_, at) => source(at)) });
  const taken = heap() - before;

  assert.ok(taken <= cache.usage().retainedBytes, `${taken} heap bytes against a charge of ${cache.usage().retainedBytes}`);
});
