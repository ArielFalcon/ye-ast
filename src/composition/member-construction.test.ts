import { indexedDeclaration } from "../core/application/navigation/declaration-model.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createAngularMetadataReader } from "../core/adapters/typescript/angular-metadata.adapter.ts";
import { createCodeGraph } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createInboundEdges } from "../core/application/impact/inbound-edges.ts";
import { walkImpact } from "../core/application/impact/walk.ts";
import { referenceKey, rootedName, unresolvedLinkCuts } from "../core/domain/impact/impact-cuts.ts";
import type { CodeGraphReader } from "../core/ports/code-graph.port.ts";

const sources = (constructor: string) => Object.entries({
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "22.2.4" } }),
  "src/replacement.ts": "export class Replacement { hit() {} }\n",
  "src/svc.ts": `import { Replacement } from './replacement';\nexport class Svc { ${constructor} hit() {} }\n`,
  "src/holder.ts": "import { inject } from '@angular/core';\nimport { Svc } from './svc';\nexport class Holder { svc = inject(Svc); run() { this.svc.hit(); } }\n",
}).map(([path, content]) => ({ path, content }));

for (const [name, constructor, count] of [
  ["ordinary construction", "constructor() {}", 1],
  ["an early return without a value", "constructor() { return; }", 1],
  ["an alternate constructor result", "constructor() { return new Replacement(); }", 0],
  ["a conditional alternate result", "constructor(flag = false) { if (flag) return new Replacement(); }", 0],
  ["an unrelated nested arrow return", "constructor() { const make = () => { return new Replacement(); }; make(); }", 1],
  ["an unrelated nested function return", "constructor() { function make() { return new Replacement(); } make(); }", 1],
] as const) {
  test(`member identity distinguishes ${name}`, async () => {
    const metadata = await createAngularMetadataReader().read(sources(constructor), { memberProofs: { completeSource: true } });
    assert.equal(metadata.memberUses?.length, count, JSON.stringify(metadata.memberUses));
  });
}

test("a derived receiver cannot bypass replacement-constructor uncertainty", async () => {
  const files = sources("").map((file) => file.path === "src/svc.ts" ? {
    path: file.path,
    content: "import { Replacement } from './replacement';\nclass Base { constructor() { return new Replacement(); } }\nexport class Svc extends Base { hit() {} }\n",
  } : file);
  const metadata = await createAngularMetadataReader().read(files, { memberProofs: { completeSource: true } });
  assert.deepEqual(metadata.memberUses, []);
});

test("an alternate constructor result cannot exclude the replacement method from unresolved impact", async () => {
  const files = sources("constructor() { return new Replacement(); }");
  const root = await mkdtemp(join(tmpdir(), "ye-ast-constructor-proof-"));
  const snapshot = join(root, "snapshot");
  let reader: CodeGraphReader | undefined;
  try {
    for (const file of files) {
      const path = join(snapshot, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    const graph = createCodeGraph();
    const indexed = await graph.index(snapshot, join(root, "index"));
    assert.ok(indexed.ok, JSON.stringify(indexed));
    const opened = graph.open(join(root, "index"));
    assert.ok(opened.ok, JSON.stringify(opened));
    reader = opened.value;
    const paths = files.map((file) => file.path);
    const symbols = opened.value.symbolsInFiles(paths);
    const references = opened.value.unresolvedReferences(paths);
    const metadata = await createAngularMetadataReader().read(files, { memberProofs: { completeSource: true } });
    const origins = await createImportOrigins(files).origins(references.map((reference) => ({ file: reference.file, line: reference.line, column: reference.column + 1, name: rootedName(reference.name), fullName: reference.name, kind: reference.kind })));
    const valid = new Set(references.flatMap((reference, index) => origins[index]?.occurrence === true ? [referenceKey(reference)!] : []));
    const inbound = createInboundEdges(opened.value, () => false, [], valid, metadata.memberUses);
    const target = symbols.find((symbol) => symbol.file === "src/replacement.ts" && symbol.name === "hit");
    assert.ok(target);
    const walk = walkImpact([target], inbound, {});
    const reached = new Set(walk.reached.flatMap(({ symbol }) => indexedDeclaration(symbol)?.id ?? []));
    const cuts = unresolvedLinkCuts(references, walk.reached.flatMap(({ symbol }) => indexedDeclaration(symbol) ?? []), [], inbound.settledUses(walk.expanded, reached), new Set(), new Map(), inbound.memberProofs(walk.expanded));
    assert.ok(cuts.some((cut) => cut.at.some((place) => place.includes("this.svc.hit"))), JSON.stringify(cuts));
  } finally {
    reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});
