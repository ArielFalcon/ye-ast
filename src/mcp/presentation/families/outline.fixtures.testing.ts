import type { OutlineDeclaration, OutlineImport, OutlineListing, OutlineValue } from "../../../core/domain/outline/outline-fact.ts";
import { SCHEMA, type Cut, type Fact, type SnapshotRef } from "../../../core/domain/shared/fact.ts";

const snapshot: SnapshotRef = { repo: "shop", kind: "sha", sha: "a".repeat(40) };
const base = {
  schema: SCHEMA,
  snapshot,
  producer: { name: "ye-ast", version: "1" },
  inputs: {
    trust: "untrusted",
    scope: "s",
    declaredScope: { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] },
    content: "c",
    config: "k",
    declaredConfig: {},
    engines: {},
  },
  evidence: [],
};
const at = (path: string, line: number, endLine?: number) => ({ path, line, ...(endLine === undefined ? {} : { endLine }) });
const declaration = (kind: string, name: string, line: number, endLine: number, children: readonly OutlineDeclaration[] = [], placement?: OutlineDeclaration["placement"]): OutlineDeclaration => ({
  kind,
  name,
  line,
  endLine,
  ...(children.length === 0 ? {} : { children }),
  ...(placement === undefined ? {} : { placement }),
});
const binding = (imported: string, declaration?: OutlineImport["bindings"][number]["declaration"], local?: string, typeOnly?: true) => ({
  ...(local === undefined ? {} : { local }),
  imported,
  ...(typeOnly === undefined ? {} : { typeOnly }),
  ...(declaration === undefined ? {} : { declaration }),
});
const imported = (file: string, name: string, kind: string, line: number, endLine: number) => ({ file, name, kind, line, endLine });
const moduleImport = (line: number, endLine: number, specifier: string, targetFile: string, bindings: OutlineImport["bindings"]): OutlineImport => ({
  line,
  endLine,
  specifier,
  kind: "import",
  typeOnly: false,
  target: { kind: "repository", file: targetFile },
  bindings,
});
const listing = (value: OutlineListing, cuts?: readonly Cut[]): Fact<OutlineValue> => outlineFact(value, cuts);
const focus = (value: Extract<OutlineValue, { focus: readonly unknown[] }>, cuts?: readonly Cut[]): Fact<OutlineValue> => outlineFact(value, cuts);
/** A fact of this family over the same envelope, so a test can state one shape the fixtures do not carry. */
export const outlineFact = (value: OutlineValue, cuts?: readonly Cut[]): Fact<OutlineValue> =>
  ({ ...base, status: cuts === undefined ? "complete" : "partial", ...(cuts === undefined ? {} : { cuts }), value }) as Fact<OutlineValue>;
const cut = (kind: string, places: readonly string[], reason = kind, extra: Partial<Cut> = {}): Cut => ({ kind, at: places, reason, reach: { kind: "anything" }, ...extra }) as Cut;

const service = (name: string, line: number, endLine: number, methods: readonly OutlineDeclaration[]) => declaration("class", name, line, endLine, methods);
const method = (name: string, line: number, endLine: number, children: readonly OutlineDeclaration[] = []) => declaration("method", name, line, endLine, children);

export interface OutlineFixture { name: string; fact: Fact<OutlineValue> }

export const OUTLINE_FIXTURES: readonly OutlineFixture[] = [
  {
    name: "small listing with nesting and imports",
    fact: listing({
      files: [
        {
          file: "src/app/orders/orders.component.ts",
          declarations: [
            service("OrdersComponent", 12, 88, [
              method("ngOnInit", 24, 33, [declaration("const", "total", 26, 26)]),
              method("save", 35, 60),
              method("reload", 62, 70),
              declaration("property", "orders", 14, 14),
            ]),
            declaration("class", "OrdersView", 90, 120, [method("render", 95, 118)]),
          ],
          imports: [
            moduleImport(1, 1, "./orders.service", "src/app/orders/orders.service.ts", [
              binding("OrdersService", imported("src/app/orders/orders.service.ts", "OrdersService", "class", 8, 40)),
              binding("Order", imported("src/app/orders/orders.service.ts", "Order", "interface", 3, 6)),
              binding("orderTotal", imported("src/app/orders/orders.service.ts", "orderTotal", "function", 42, 55), "total"),
            ]),
            moduleImport(2, 2, "../shared/format", "src/app/shared/format.ts", [
              binding("money", imported("src/app/shared/format.ts", "money", "function", 3, 9), "formatMoney"),
              binding("formatDate", undefined),
              binding("Currency", imported("src/app/shared/format.ts", "Currency", "type", 11, 11), undefined, true),
            ]),
            { line: 3, endLine: 3, specifier: "@angular/core", kind: "import", typeOnly: true, target: { kind: "external", module: "@angular/core" }, bindings: [binding("Component", undefined, undefined, true), binding("Input", undefined, undefined, true)] },
            { line: 4, endLine: 6, kind: "import", typeOnly: false, target: { kind: "unresolved", reason: "specifier" }, bindings: [binding("lazy")], form: "dynamic-import" },
            { line: 7, endLine: 7, specifier: "./legacy", kind: "reexport", typeOnly: false, target: { kind: "repository", file: "src/app/orders/legacy.ts" }, bindings: [binding("*", imported("src/app/orders/legacy.ts", "legacy", "module", 1, 30))] },
          ],
        },
        {
          file: "src/app/orders/legacy.ts",
          declarations: [declaration("function", "legacy", 1, 30, [declaration("function", "inner", 12, 14)], { kind: "unplaced", reason: "unresolved-container", at: { line: 11, column: 7 } })],
          imports: [],
        },
        { file: "src/app/orders/empty.ts", declarations: [], imports: [] },
      ],
      unheld: [],
    }),
  },
  {
    name: "many files with long declarations",
    fact: listing({
      files: Array.from({ length: 5 }, (_, fileIndex) => ({
        file: `services/service-${fileIndex}/src/main/java/org/example/web/Service${fileIndex}Resource.java`,
        declarations: Array.from({ length: 4 }, (_, index) => service(`Service${fileIndex}Resource`, 10 + index * 30, 30 + index * 30, [
          method(`handle${index}`, 12 + index * 30, 20 + index * 30, [declaration("local", `payload${index}`, 14 + index * 30, 16 + index * 30)]),
          method(`forward${index}`, 22 + index * 30, 28 + index * 30),
        ])),
        imports: [
          moduleImport(1, 1, "org.example.web.Port", `services/service-${fileIndex}/src/main/java/org/example/web/Port${fileIndex}.java`, [
            binding(`Port${fileIndex}`, imported(`services/service-${fileIndex}/src/main/java/org/example/web/Port${fileIndex}.java`, `Port${fileIndex}`, "interface", 5, 12)),
            binding(`Port${fileIndex}Request`, imported(`services/service-${fileIndex}/src/main/java/org/example/web/Port${fileIndex}.java`, `Port${fileIndex}Request`, "class", 14, 26)),
            binding(`Port${fileIndex}Response`, imported(`services/service-${fileIndex}/src/main/java/org/example/web/Port${fileIndex}.java`, `Port${fileIndex}Response`, "class", 28, 40)),
          ]),
          moduleImport(2, 2, "org.example.audit.Audit", "services/audit/src/main/java/org/example/audit/Audit.java", [
            binding("Audit", imported("services/audit/src/main/java/org/example/audit/Audit.java", "Audit", "interface", 4, 10)),
            binding("Audited", imported("services/audit/src/main/java/org/example/audit/Audit.java", "Audited", "annotation", 12, 14)),
          ]),
        ],
      })),
      unheld: ["src/app/orders/missing.ts", "src/app/orders/gone.ts"],
    }),
  },
  {
    name: "focus with ancestors, uses and omissions",
    fact: focus({
      focus: [
        {
          file: "src/app/orders/orders.component.ts",
          selector: "OrdersComponent.save",
          path: "OrdersComponent.save",
          ancestors: [service("OrdersComponent", 12, 88, [])],
          declaration: method("save", 35, 60, [declaration("const", "total", 38, 38)]),
          omitted: 5,
          uses: [
            { declaration: imported("src/app/orders/orders.service.ts", "OrdersService", "class", 8, 40), relations: ["calls"], at: [{ line: 40 }, { line: 44 }] },
            { module: "rxjs", relations: ["references"], at: [{ line: 41 }] },
            { global: "console", relations: ["references"], at: [] },
          ],
        },
        {
          file: "src/app/orders/orders.component.ts",
          selector: "48",
          ancestors: [service("OrdersComponent", 12, 88, [])],
          declaration: method("render", 45, 58),
          omitted: 6,
          uses: [],
        },
      ],
      unheld: [],
    }),
  },
  {
    name: "partial with cuts that name places",
    fact: listing(
      {
        files: [
          {
            file: "src/app/orders/orders.service.ts",
            declarations: [service("OrdersService", 8, 40, [method("find", 12, 20), method("save", 22, 38)])],
            imports: [],
          },
        ],
        unheld: ["src/app/orders/broken.ts"],
      },
      [
        cut("depth", ["src/app/orders/orders.service.ts::OrdersService.save"], "depth", { limit: 2, reach: { kind: "callers-of", declarations: ["src/app/orders/orders.service.ts::OrdersService.save"] } }),
        cut("unresolved-link", ["src/app/orders/orders.service.ts::OrdersService.find", "src/app/orders/orders.service.ts:16 port.load", "src/app/orders/http.ts:9 fetchOrders"], "use-unproven"),
        cut("not-indexed", ["src/app/orders/broken.ts"], "not-indexed"),
      ],
    ),
  },
  {
    name: "unknown fact",
    fact: { ...base, status: "unknown", reason: "index-unavailable", evidence: [at("src/app/orders/orders.component.ts", 1)] } as Fact<OutlineValue>,
  },
  {
    name: "empty and complete",
    fact: listing({ files: [{ file: "src/app/orders/empty.ts", declarations: [], imports: [] }], unheld: [] }),
  },
];
