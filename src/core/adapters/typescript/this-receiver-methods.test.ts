import { test } from "node:test";
import assert from "node:assert/strict";
import { createImportOrigins } from "./import-origins.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverCallSite } from "../../ports/import-origins.port.ts";

const source = (path: string, ...lines: string[]): SourceFile => ({ path, content: `${lines.join("\n")}\n` });
const SOURCES: readonly SourceFile[] = [
  source("package.json", JSON.stringify({ dependencies: { "base-kit": "1.0.0" } })),
  source("src/store.ts", "export class Store {", "  save(): void {}", "}"),
  source("src/mid.ts", "import { Store } from \"./store\";", "export class Mid extends Store {", "  load(): void {}", "  handler = (): void => {};", "}"),
  source(
    "src/sub.ts",
    "import { Mid } from \"./mid\";",
    "export class Sub extends Mid {",
    "  load(): void {}",
    "  run(other: Mid): void { this.load(); this.save(); super.load(); this.handler(); this.missing(); other.save(); [1].forEach(() => this.save()); }",
    "  nested(): void { const f = function (this: Mid) { this.save(); }; f.call(this); }",
    "  static make(): void { this.save(); }",
    "}",
  ),
  source("src/widget.ts", "import { Base } from \"base-kit\";", "export class Widget extends Base {", "  draw(): void { this.render(); super.render(); }", "}"),
  source("src/queue.ts", "export abstract class Queue {", "  abstract send(row: string): void;", "  flush(): void { this.send(\"x\"); }", "}"),
  source("src/fast.ts", "import { Queue } from \"./queue\";", "export class Fast extends Queue {", "  send(row: string): void {}", "}"),
];
const OPEN = source(
    "src/open.ts",
    "import { Store } from \"./store\"; import { Base } from \"base-kit\";",
    "declare function mix<T>(type: T): T;",
    "class Holder<T> { save(): void {} }",
    "export class Typed extends Holder<string> { run(): void { this.save(); } }",
    "export class Mixed extends mix(Store) { run(): void { this.save(); } }",
    "export class Merged extends Base { run(): void { this.extra(); } }",
    "export interface Merged { extra(): void; }",
);

/** The site of the `occurrence`-th `this.` or `super.` (or other receiver) call of `member` written on a line. */
function siteOf(path: string, line: number, spelled: string, occurrence = 0): ReceiverCallSite {
  const text = [...SOURCES, OPEN].find((file) => file.path === path)!.content.split("\n")[line - 1]!;
  let column = -1;
  for (let found = 0; found <= occurrence; found++) column = text.indexOf(spelled, column + 1);
  return { file: path, line, column: column + 1, member: spelled.slice(spelled.indexOf(".") + 1) };
}

test("a call on this or super reads the member through the extends chain of the class it is written in, and a member only an outside type holds names the overrides below the class", async () => {
  const sites = [
    siteOf("src/sub.ts", 4, "this.load"),
    siteOf("src/sub.ts", 4, "this.save"),
    siteOf("src/sub.ts", 4, "super.load"),
    siteOf("src/sub.ts", 4, "this.handler"),
    siteOf("src/sub.ts", 4, "this.save", 1),
    siteOf("src/widget.ts", 3, "this.render"),
    siteOf("src/widget.ts", 3, "super.render"),
    siteOf("src/queue.ts", 3, "this.send"),
    siteOf("src/sub.ts", 4, "this.missing"),
    siteOf("src/sub.ts", 4, "other.save"),
    siteOf("src/sub.ts", 5, "this.save"),
    siteOf("src/sub.ts", 6, "this.save"),
  ];

  assert.deepEqual(await createImportOrigins(SOURCES).receiverMethods(sites), [
    { kind: "method", file: "src/sub.ts", start: 3, nameLine: 3 },
    { kind: "method", file: "src/store.ts", start: 2, nameLine: 2 },
    { kind: "method", file: "src/mid.ts", start: 3, nameLine: 3, exact: true },
    { kind: "method", file: "src/mid.ts", start: 4, nameLine: 4 },
    { kind: "method", file: "src/store.ts", start: 2, nameLine: 2 },
    { kind: "outside", type: "base-kit#Base" },
    { kind: "outside", type: "base-kit#Base", exact: true },
    { kind: "unproven", candidates: [{ file: "src/fast.ts", start: 3, nameLine: 3 }] },
    { kind: "unproven" },
    { kind: "unknown", reason: "capability-absent" },
    { kind: "unknown", reason: "capability-absent" },
    { kind: "unknown", reason: "capability-absent" },
  ]);
  const open = [siteOf("src/open.ts", 4, "this.save"), siteOf("src/open.ts", 5, "this.save"), siteOf("src/open.ts", 6, "this.extra"), siteOf("src/queue.ts", 3, "this.send")];
  assert.deepEqual(await createImportOrigins([...SOURCES, OPEN]).receiverMethods(open), open.map(() => ({ kind: "unproven" })));
  const below = source("src/brush.ts", "import { Widget } from \"./widget\";", "export class Brush extends Widget {", "  render(): void {}", "}");
  assert.deepEqual(await createImportOrigins([...SOURCES, below]).receiverMethods([siteOf("src/widget.ts", 3, "this.render"), siteOf("src/widget.ts", 3, "super.render")]), [
    { kind: "unproven", candidates: [{ file: "src/brush.ts", start: 3, nameLine: 3 }] },
    { kind: "outside", type: "base-kit#Base", exact: true },
  ]);
});

test("the outside supertypes of a method's class are those of it and of every class below it, through every clause", async () => {
  const origins = createImportOrigins([...SOURCES, source("src/painter.ts", "import { Widget } from \"./widget\"; import { Hook } from \"base-kit\";", "export class Painter {", "  render(): void {}", "}", "export class Brush extends Widget {", "  render(): void {}", "  static make(): void {}", "}", "export class Fancy extends Painter implements Hook {}")]);

  assert.deepEqual(await origins.outsideSupertypes!([{ file: "src/painter.ts", start: 3, name: "render" }, { file: "src/painter.ts", start: 6, name: "render" }, { file: "src/store.ts", start: 2, name: "save" }, { file: "src/painter.ts", start: 7, name: "make" }]), [
    { kind: "types", types: ["base-kit#Hook"] },
    { kind: "types", types: ["base-kit#Base"] },
    { kind: "types", types: [] },
    { kind: "types", types: [], static: true },
  ]);
});
