import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));

/** Each concept the edge verdicts rest on, with its one owner; `pending` lists copies a later consolidation removes and only shrinks. */
const RULES: readonly { concept: string; pattern: RegExp; owner: string; pending: readonly string[] }[] = [
  { concept: "a symbol declared within another", pattern: /(\w+)\.file === (\w+)\.file && \2\.startLine <= \1\.startLine && \1\.endLine <= \2\.endLine/, owner: "core/application/navigation/graph-navigation.ts", pending: [] },
  { concept: "a source's receiver bindings by place", pattern: /\.has\(key\) \? "ambiguous"/, owner: "core/application/navigation/call-binder.ts", pending: [] },
  { concept: "what a receiver's binding at a place holds", pattern: /!== "ambiguous" && \w+\.receiver === receiver/, owner: "core/application/navigation/call-binder.ts", pending: [] },
  { concept: "a receiver settled by a field's or an inject() local's origin", pattern: /\b(?:fieldOriginAt|localOriginAt)\(\w+,/, owner: "core/application/navigation/call-binder.ts", pending: [] },
  { concept: "the one member a member proof names", pattern: /\.includes\(symbol\.kind\) && joinsFact\(symbol, \w+\)/, owner: "core/application/navigation/call-binder.ts", pending: [] },
  { concept: "the repository type a receiver's annotation or construction names", pattern: /TYPE_KINDS\.includes\(imported\.kind\)/, owner: "core/application/navigation/call-binder.ts", pending: [] },
  { concept: "the member proofs by call place", pattern: /\.template !== true/, owner: "core/application/navigation/proven-calls.ts", pending: [] },
  { concept: "the declarations that can own an inject() local", pattern: /\[\.\.\.EDGE_POLICY\.relations\.from, "function"\]/, owner: "core/domain/impact/edge-policy.ts", pending: [] },
  { concept: "the field or inject() local origin that holds a receiver at a use", pattern: /\b(?:fields|locals)\.(?:filter|find)\(\(\w+\) => \w+\.(?:field|local) === /, owner: "core/application/navigation/graph-navigation.ts", pending: [] },
  { concept: "the declarations that hold a value", pattern: /= \["constant", "variable"\]/, owner: "core/domain/impact/edge-policy.ts", pending: [] },
  { concept: "the repository declarations a call's name can bind", pattern: /declarationsNamed\(\[\w+\]\)\.filter\(\(symbol\) => inScope\(/, owner: "core/application/navigation/call-binding.ts", pending: [] },
  { concept: "the written calls no record matches, looked up by the name they spell", pattern: /\.\.\.writtenOnly, \.\.\.deferredOnly\]/, owner: "core/application/navigation/reverse-calls.ts", pending: [] },
  { concept: "the names a reached declaration's calls are looked up by", pattern: /\{ name: chaining\.inherited, files: /, owner: "core/application/navigation/reverse-calls.ts", pending: [] },
  { concept: "the declarations that are classes", pattern: /= \["class", "component"\]/, owner: "core/domain/impact/edge-policy.ts", pending: [] },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
  });
}

for (const { concept, pattern, owner, pending } of RULES) {
  test(`${concept} lives only in its owner`, () => {
    const holders = sourceFiles(SOURCE)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE, file))
      .sort();

    assert.deepEqual(holders, [owner, ...pending].sort());
  });
}
