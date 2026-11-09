import { test } from "node:test";
import assert from "node:assert/strict";
import { entrypointCandidateText, unknownEntryText, unknownTargetKey, type UnknownSymbolEntry } from "./unknown-target.ts";

function symbolEntry(overrides: Partial<UnknownSymbolEntry> = {}): UnknownSymbolEntry {
  return { file: "src/A.java", symbol: "gone", absent: false, candidates: [], ...overrides } as UnknownSymbolEntry;
}

test("a fault entry is formatted by the one shared owner", () => {
  assert.equal(unknownEntryText({ file: "a.ts", candidates: [], absent: true }), "a.ts is not in the snapshot");
  assert.equal(
    unknownEntryText({ file: "a.ts", candidates: ["b.ts", "c.ts"], absent: true }),
    "a.ts is not in the snapshot; snapshot paths: b.ts, c.ts",
  );
  assert.equal(unknownEntryText({ file: "a.ts", candidates: [], absent: false }), "a.ts declares no symbol");
  assert.equal(unknownEntryText({ file: "a.ts", candidates: ["load", "save"], absent: false }), "declared in a.ts: load, save");
});

test("an entrypoint fault names what the map holds of its kind, with and without candidates", () => {
  assert.equal(entrypointCandidateText({ kind: "route", name: "/x", candidates: [] }), "the map holds no route");
  assert.equal(entrypointCandidateText({ kind: "route", name: "/x", candidates: ["/a", "/b"] }), "the map's route names: /a, /b");
});

test("a target key names a symbol, a line range, or the whole file", () => {
  assert.equal(unknownTargetKey(symbolEntry()), "src/A.java:gone");
  assert.equal(unknownTargetKey({ file: "src/C.java", start: 30, end: 35, absent: false, candidates: [] }), "src/C.java:30-35");
  assert.equal(unknownTargetKey({ file: "src/D.ts", wholeFile: true, absent: true, candidates: [] }), "src/D.ts");
});
