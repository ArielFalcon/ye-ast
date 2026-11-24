import type { Cut, Fact, FactBase } from "../../../core/domain/shared/fact.ts";
import type { TraceStep, TraceValue } from "../../../core/domain/trace/trace-fact.ts";
import type { UnlinkedCallSite } from "../../../core/domain/topology/link.ts";
import type { Link } from "../../../core/domain/topology/link.ts";

const base: FactBase = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const at = (path: string, line: number, endLine?: number) => ({ path, line, ...(endLine === undefined ? {} : { endLine }) });
const cut = (kind: string, places: readonly string[], extra: object = {}): Cut => ({ kind, at: places, reason: kind, reach: { kind: "anything" }, ...extra }) as never;

const nestedSteps: TraceStep[] = [
  { id: 0, depth: 0, file: "src/order.ts", symbol: "Order", kind: "class", line: 1, endLine: 30 },
  {
    id: 1, parent: 0, depth: 1, file: "src/order.ts", symbol: "total", kind: "method", line: 12, endLine: 20, at: { line: 5 }, via: "own-member",
    leaves: [{ symbol: "round", file: "src/math.ts", start: 1, end: 3 }, { symbol: "log", file: "src/log.ts", start: 2, end: 4, deferred: true }],
    external: [{ kind: "import", module: "lodash", names: ["sum", "map"] }],
    effects: [
      { kind: "http", line: 15, target: { method: "POST", path: "/orders/checkout", base: "https://api" } },
      { kind: "data", line: 16, operation: "save", access: "write", target: { kind: "entity", name: "shop.Order" } },
    ],
  },
  {
    id: 2, parent: 1, depth: 2, file: "src/tax.ts", symbol: "tax", kind: "function", line: 4, endLine: 9, at: { line: 14 }, deferred: true, via: "member",
    alternatives: [{ symbol: "tax", file: "src/flat-tax.ts", start: 3, end: 6 }],
    effects: [{ kind: "message", line: 7, target: { protocol: "nats", destination: "orders.created", role: "publish" } }],
    unresolvedEffects: [{ path: "src/tax.ts", line: 8, symbol: "quote", transport: "http", reason: "unresolved", evidence: [at("src/config.ts", 7)], stated: { method: "GET", path: "/rates" } }],
  },
  { id: 3, parent: 0, depth: 1, file: "src/order.ts", symbol: "total", kind: "method", line: 12, endLine: 20, at: { line: 7 }, seen: 1 },
];

const nestedValue: TraceValue = {
  roots: [{ target: "src/order.ts:1-30", steps: [0] }],
  steps: nestedSteps,
  readingPlan: { ranges: [{ file: "src/order.ts", start: 1, end: 30, steps: [0, 1, 3] }, { file: "src/tax.ts", start: 4, end: 9, steps: [2] }, { file: "src/order.ts", start: 40, end: 40, steps: [1] }], lines: 37 },
  cost: { expanded: 3 },
};

const nested: Fact<TraceValue> = { ...base, status: "complete", value: nestedValue };

export const ENTRYPOINT_ROOT_FIXTURE: Fact<TraceValue> = { ...base, status: "complete", value: { ...nestedValue, roots: [{ target: "http-route GET /orders", steps: [0] }] } };

const largeFiles = ["src/checkout/checkout.service.ts", "src/pricing/pricing.service.ts", "src/tax/tax.service.ts"] as const;
const largeSteps: TraceStep[] = [
  { id: 0, depth: 0, file: largeFiles[0], symbol: "CheckoutService", kind: "class", line: 1, endLine: 140 },
  { id: 1, parent: 0, depth: 1, file: largeFiles[0], symbol: "validate", kind: "method", line: 20, endLine: 32, at: { line: 5 }, via: "own-member" },
  { id: 2, parent: 0, depth: 1, file: largeFiles[0], symbol: "charge", kind: "method", line: 40, endLine: 70, at: { line: 21 }, effects: [{ kind: "http", line: 40, target: { method: "POST", path: "/orders" } }] },
  { id: 3, parent: 0, depth: 1, file: largeFiles[0], symbol: "notify", kind: "method", line: 80, endLine: 95, at: { line: 22 }, effects: [{ kind: "message", line: 92, target: { protocol: "nats", destination: "orders.created", role: "publish" } }] },
  { id: 4, parent: 2, depth: 2, file: largeFiles[1], symbol: "price", kind: "method", line: 10, endLine: 40, at: { line: 24 }, effects: [{ kind: "data", line: 11, operation: "findById", access: "read", target: { kind: "entity", name: "shop.Order" } }] },
  { id: 5, parent: 4, depth: 3, file: largeFiles[2], symbol: "tax", kind: "function", line: 6, endLine: 14, at: { line: 26 }, deferred: true, unresolvedEffects: [{ path: largeFiles[2], line: 13, symbol: "quote", transport: "http", reason: "unresolved", evidence: [at(largeFiles[2], 12)], stated: { method: "GET", path: "/rates" }, deferred: true }] },
  { id: 6, parent: 4, depth: 3, file: largeFiles[1], symbol: "discount", kind: "method", line: 50, endLine: 60, at: { line: 12 } },
  { id: 7, parent: 5, depth: 4, file: largeFiles[2], symbol: "rate", kind: "function", line: 30, endLine: 44, at: { line: 8 }, leaves: [{ symbol: "readTaxTable", file: largeFiles[2], start: 46, end: 58 }] },
  { id: 8, parent: 6, depth: 4, file: largeFiles[2], symbol: "lookup", kind: "function", line: 50, endLine: 58, at: { line: 31 } },
  { id: 9, parent: 2, depth: 2, file: largeFiles[0], symbol: "audit", kind: "method", line: 100, endLine: 110, at: { line: 33 }, external: [{ kind: "global", names: ["console", "process"] }] },
  { id: 10, parent: 2, depth: 2, file: largeFiles[0], symbol: "store", kind: "method", line: 44, endLine: 48, at: { line: 42 }, via: "reference" },
  { id: 11, parent: 1, depth: 2, file: largeFiles[0], symbol: "total", kind: "method", line: 12, endLine: 18, at: { line: 6 }, external: [{ kind: "import", module: "lodash", names: ["sum", "map"] }] },
  { id: 12, parent: 6, depth: 4, file: largeFiles[1], symbol: "clamp", kind: "function", line: 70, endLine: 76, at: { line: 13 } },
  { id: 13, parent: 8, depth: 5, file: largeFiles[2], symbol: "round", kind: "function", line: 60, endLine: 64, at: { line: 51 } },
  { id: 14, parent: 8, depth: 5, file: largeFiles[2], symbol: "format", kind: "function", line: 66, endLine: 70, at: { line: 61 } },
  { id: 15, parent: 3, depth: 2, file: largeFiles[0], symbol: "send", kind: "method", line: 90, endLine: 94, at: { line: 84 } },
  { id: 16, parent: 3, depth: 2, file: largeFiles[0], symbol: "queue", kind: "method", line: 96, endLine: 99, at: { line: 91 } },
  { id: 17, parent: 9, depth: 3, file: largeFiles[2], symbol: "lookup", kind: "function", line: 50, endLine: 58, at: { line: 41 }, seen: 8 },
  { id: 18, parent: 9, depth: 3, file: largeFiles[0], symbol: "store", kind: "method", line: 44, endLine: 48, at: { line: 43 }, seen: 10 },
];

const large: Fact<TraceValue> = {
  ...base,
  status: "complete",
  value: {
    roots: [{ target: largeFiles[0], steps: [0] }],
    steps: largeSteps,
    readingPlan: { ranges: largeFiles.map((file) => ({ file, start: 1, end: 140, steps: largeSteps.filter((step) => step.file === file).map((step) => step.id) })), lines: 214 },
    cost: { expanded: 18 },
  },
};

const partial: Fact<TraceValue> = {
  ...base,
  status: "partial",
  cuts: [
    cut("unresolved-link", ["src/order.ts:15 this.handler.handle", "src/a.ts::A.handle", "src/b.ts::B.handle"], { reason: "callee-unknown" }),
    cut("unresolved-link", ["src/order.ts:18 this.store.save", "src/s.ts::Store.save"], { reason: "callee-unknown" }),
    cut("unresolved-link", ["src/order.ts:22 client.send", "src/c.ts::Client.send"], { reason: "receiver-unproven", subReason: "capability-absent" }),
    cut("unresolved-link", ["src/pet-edit.html:3 dirty"], { reason: "page-unplanned" }),
    cut("depth", ["src/flow.ts::deep"], { limit: 2 }),
    cut("build-output", ["node_modules"]),
  ],
  value: nestedValue,
};

const jdk: Fact<TraceValue> = {
  ...base,
  status: "partial",
  cuts: [cut("unresolved-link", ["src/order.ts:15 this.handler.handle", "src/a.ts::A.handle"], { reason: "callee-unknown", cause: ["src/lib.ts:4 function-value-undeclared-jdk"] })],
  value: nestedValue,
};

const shopSnapshot = base.snapshot;
const apiSnapshot = { ...base.snapshot, repo: "api" };

const workspaceLinks: readonly Link[] = [
  { id: "l1", from: { repo: "shop", file: "src/http/client.ts", line: 12, symbol: "post" }, to: { repo: "api", kind: "http-route", name: "POST /orders", handler: { path: "src/OrderController.java", line: 30, symbol: "OrderController.create" } }, transport: "http", basis: "exact", confidence: 1, propagatedThrough: [{ file: "src/http/client.ts", line: 14, column: 3, kind: "body" }] },
  { id: "l2", from: { repo: "shop", file: "src/http/client.ts", line: 12, symbol: "post" }, to: { repo: "api", kind: "http-route", name: "POST /orders", handler: { path: "src/OrderController.java", line: 30, symbol: "OrderController.create" } }, transport: "http", basis: "base-path", confidence: 0.6, profiles: ["prod"] },
];
const workspaceUnlinked: readonly UnlinkedCallSite[] = [
  { from: { repo: "shop", file: "src/http/client.ts", line: 20, symbol: "send" }, transport: "http", method: "DELETE", name: "/gone", outcome: "ambiguous", repos: ["api", "other"], routes: ["DELETE /gone"], propagatedThrough: [{ file: "src/http/client.ts", line: 22, column: 1, kind: "leaf" }] },
];

const workspace: Fact<TraceValue> = {
  ...base,
  status: "complete",
  value: {
    repositorySnapshots: [{ repo: "shop", snapshot: shopSnapshot }, { repo: "api", snapshot: apiSnapshot }],
    links: workspaceLinks.map((link, index) => (index === 0 ? { ...link, deferred: true as const, issuedAt: [{ file: "src/checkout/checkout.service.ts", line: 24, column: 5 }] } : link)),
    unlinked: workspaceUnlinked.map((site) => ({ ...site, deferred: true as const, issuedAt: [{ file: "src/checkout/checkout.service.ts", line: 26, column: 1 }] })),
    roots: [{ target: "src/http/client.ts:post", steps: [0] }],
    steps: [{ id: 0, depth: 0, file: "src/http/client.ts", symbol: "post", kind: "method", line: 10, endLine: 16 }],
    readingPlan: { ranges: [{ file: "src/http/client.ts", start: 10, end: 16, steps: [0] }], lines: 7 },
    cost: { expanded: 1 },
  },
};

const settled: Fact<TraceValue> = {
  ...base,
  status: "complete",
  value: {
    settled: [{ basis: "range", file: "src/order.ts", start: 8, end: 9, reason: "no-token", candidates: ["Order", "OrderTotal"] }],
    roots: [{ target: "src/order.ts:8-9", steps: [0] }],
    steps: [{ id: 0, depth: 0, file: "src/order.ts", symbol: "total", kind: "method", line: 12, endLine: 20 }],
    readingPlan: { ranges: [{ file: "src/order.ts", start: 12, end: 20, steps: [0] }], lines: 9 },
    cost: { expanded: 1 },
  },
};

const empty: Fact<TraceValue> = { ...base, status: "complete", value: { roots: [], steps: [], readingPlan: { ranges: [], lines: 0 }, cost: { expanded: 0 } } };

const unknown = { ...base, status: "unknown", reason: "index-unavailable", evidence: [at("src/gone.ts", 1)] } as unknown as Fact<TraceValue>;

export interface TraceFixture { name: string; fact: Fact<TraceValue> }

export const TRACE_FIXTURES: readonly TraceFixture[] = [
  { name: "nested steps with leaves, external calls and effects", fact: nested },
  { name: "large: nineteen steps over three files with repeated calls", fact: large },
  { name: "partial: unresolved-link, depth and build-output cuts", fact: partial },
  { name: "partial: a function value awaiting a declared JDK", fact: jdk },
  { name: "workspace links and unlinked call sites", fact: workspace },
  { name: "requested ranges that hold no token", fact: settled },
  { name: "complete with no steps", fact: empty },
  { name: "unknown fact", fact: unknown },
];
