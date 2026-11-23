import assert from "node:assert/strict";
import { test } from "node:test";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createRelationExtractor, FRAMEWORK_RELATIONS } from "../core/application/relations/relation-extractor.ts";
import { createDerivedFacts } from "../core/application/snapshot/derived-facts.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { composeAngularRelations } from "./angular-relations.ts";

const CORE = "import { Component, inject } from '@angular/core';\n";
const TEMPLATE: SourceFile = { path: "src/app/shell/shell.html", content: "<app-card></app-card>\n" };
const JAVA: SourceFile = { path: "src/main/java/app/Orders.java", content: "package app;\nclass Orders {}\n" };
const SOURCES: readonly SourceFile[] = [
  { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/core": "22.0.0", "@angular/router": "22.0.0" } }) },
  { path: "src/app/orders.service.ts", content: "export class OrdersService {}\n" },
  { path: "src/app/card.component.ts", content: `${CORE}@Component({ selector: 'app-card', template: '' })\nexport class CardComponent {}\n` },
  { path: "src/app/shell/shell.component.ts", content: `${CORE}import { CardComponent } from '../card.component';\nimport { OrdersService } from '../orders.service';\n@Component({ selector: 'app-shell', imports: [CardComponent], templateUrl: './shell.html' })\nexport class ShellComponent {\n  orders = inject(OrdersService);\n}\n` },
  { path: "src/app/app.routes.ts", content: "import { Routes } from '@angular/router';\nimport { ShellComponent } from './shell/shell.component';\nexport const routes: Routes = [{ path: 'orders', component: ShellComponent }];\n" },
  TEMPLATE,
  JAVA,
];
const NO_LANGUAGE_RELATIONS = { extract: async () => ({ relations: [], cuts: [], unresolved: [] }) };

/** One process: a memory tier kept across reads, over which each read answers the stage's output and whether it derived it again. */
function oneProcess(slot: string, stage: (sources: readonly SourceFile[], facts?: DerivedFacts) => Promise<unknown>) {
  const cache = createSnapshotDataCache(32 * 1024 * 1024);
  const digest = createSha256Digest();
  return async (sources: readonly SourceFile[]) => {
    const facts = createDerivedFacts(cache, digest, "trusted");
    let derived = false;
    const counting: DerivedFacts = { ...facts, ofReads: (asked, subject, answers, derive) => facts.ofReads(asked, subject, answers, (record) => ((derived ||= asked === slot), derive(record))) };
    return { output: JSON.stringify(await stage(sources, counting)), derived };
  };
}

const relations = (sources: readonly SourceFile[], facts?: DerivedFacts) => createRelationExtractor(composeAngularRelations(), NO_LANGUAGE_RELATIONS).extract(sources, { memberProofs: { completeSource: true }, ...(facts === undefined ? {} : { facts }) });
const edited = (target: SourceFile, addition: string) => SOURCES.map((file) => (file === target ? { ...file, content: `${file.content}${addition}` } : file));

test("the Angular relations are kept across an edit of a file they never read, and an edit of the template a component names derives them again as a cold read does", async () => {
  const read = oneProcess(FRAMEWORK_RELATIONS, relations);
  const cold = await read(SOURCES);
  const afterJava = await read(edited(JAVA, "// edit\n"));
  const templateEdit = edited(TEMPLATE, "<p>more</p>\n");
  const afterTemplate = await read(templateEdit);
  assert.match(cold.output, /uses-component/u);
  assert.deepEqual({ cold: cold.derived, java: afterJava, template: afterTemplate.derived }, { cold: true, java: { output: cold.output, derived: false }, template: true });
  assert.equal(afterTemplate.output, JSON.stringify(await relations(templateEdit)));
});
