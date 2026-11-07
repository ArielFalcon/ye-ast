/**
 * Typed `ExecutedSource` fixtures of the seven families (and both impact/callers branches) for normalization and later
 * integration tests. Every value is built from the concrete domain types: no `any`, no untyped payload. The defaults are
 * deliberately rich (unknown findings, optional fields present and absent, nested sections, non-zero origin indices,
 * self/missing link reach, external decision evidence) so a single fixture exercises a family's whole public contract.
 */
import { SCHEMA, type Cut, type Evidence, type Fact, type FactInputs, type Producer, type SnapshotRef, type UnknownReason } from "../core/domain/shared/fact.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { OutlineListing, OutlineValue } from "../core/domain/outline/outline-fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { CallSite } from "../core/domain/topology/call-site.ts";
import type { WorkspaceImpactValue, RepoImpact } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { ExecutedSource, PublicRead, PublicWorkspaceValue, RedactionIdentityGuard } from "./query-runner.ts";
import type { SemanticArguments, SemanticQueryOf } from "./query-schema.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
export const MERGE_BASE = "d".repeat(40);
export const REPLAY_DECLARATION = `ws-r1:${"e".repeat(64)}`;

export const shaRef = (repo: string, sha: string = SHA_A): SnapshotRef => ({ repo, kind: "sha", sha });
export const liveRef = (repo: string, stateId: string, head: string = SHA_A): SnapshotRef => ({ repo, kind: "live", head, stateId });

export const PRODUCER: Producer = { name: "ye-ast", version: "0.0.0-test" };

export function inputsOf(overrides: Partial<FactInputs> = {}): FactInputs {
  return {
    trust: "trusted",
    scope: "scope-digest",
    declaredScope: { languages: ["java", "typescript"], frameworks: ["spring"], include: [], exclude: [] },
    content: "content-digest",
    config: "config-digest",
    declaredConfig: {},
    engines: { "ye-ast-java": "1.0.0" },
    ...overrides,
  };
}

type FactOptions = { snapshot?: SnapshotRef; inputs?: FactInputs; evidence?: readonly Evidence[]; cuts?: readonly [Cut, ...Cut[]] };

/** A complete fact, or a partial one when `cuts` is given. */
export function factOf<T>(value: T, options: FactOptions = {}): Fact<T> {
  const base = { schema: SCHEMA, snapshot: options.snapshot ?? shaRef("shop"), producer: PRODUCER, inputs: options.inputs ?? inputsOf(), evidence: options.evidence ?? [] };
  return options.cuts === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: options.cuts };
}

export function unknownFactOf<T>(reason: UnknownReason, options: Omit<FactOptions, "cuts"> = {}): Fact<T> {
  return { schema: SCHEMA, snapshot: options.snapshot ?? shaRef("shop"), producer: PRODUCER, inputs: options.inputs ?? inputsOf(), evidence: options.evidence ?? [], status: "unknown", reason };
}

const handler = (path: string, symbol: string, line: number, endLine?: number) => ({ path, symbol, line, ...(endLine === undefined ? {} : { endLine }) });

export function entrypointsValue(): EntrypointMap {
  return {
    entrypoints: factOf(
      [
        {
          status: "complete",
          value: { kind: "http-route", name: "GET /orders", method: "GET", path: "/orders", handler: handler("src/OrderController.java", "OrderController.one", 6, 9), basePath: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/main/resources/application.yml", line: 3 }] } },
          evidence: [{ path: "src/OrderController.java", line: 6, endLine: 9 }, { path: "src/OrderController.java", line: 5 }],
        },
        {
          status: "complete",
          value: { kind: "http-route", name: "POST /orders v2", method: "POST", path: "/orders", version: "2", handler: handler("src/OrderController.java", "OrderController.one", 6, 9), basePath: { status: "complete", value: { default: { contextPath: "/api" }, profiles: { prod: { servletPath: "/v" } } }, evidence: [{ path: "src/main/resources/application.yml", line: 1 }] } },
          evidence: [{ path: "src/OrderController.java", line: 6, endLine: 9 }],
        },
        { status: "complete", value: { kind: "ui-route", name: "/orders (aux)", path: "/orders", outlet: "aux", component: "unknown", guards: [{ name: "AuthGuard", path: "src/auth.guard.ts" }, { name: "(inline)" }, { name: "RemoteGuard", external: true }] }, evidence: [{ path: "src/app.routes.ts", line: 12 }] },
        { status: "complete", value: { kind: "ui-route", name: "/home", path: "/home", component: handler("src/home.component.ts", "HomeComponent", 3), guards: [] }, evidence: [] },
        { status: "complete", value: { kind: "listener", name: "kafka orders", protocol: "kafka", destination: "orders", handler: handler("src/OrderListener.java", "OrderListener.on", 10, 14) }, evidence: [{ path: "src/OrderListener.java", line: 9 }] },
        { status: "complete", value: { kind: "job", name: "scheduled cron=0 * * * *", trigger: { attribute: "cron", value: "0 * * * *" }, handler: handler("src/Jobs.java", "Jobs.tick", 20, 22) }, evidence: [] },
        { status: "unknown", reason: "unresolved", evidence: [{ path: "src/Dynamic.java", line: 4 }, { path: "src/Dynamic.java", line: 4 }] },
      ],
      { cuts: [{ kind: "no-extractor", at: ["src/legacy.kt"] }] },
    ),
  };
}

export function impactValue(): ImpactValue {
  return {
    mergeBase: MERGE_BASE,
    seeds: [
      { file: "src/OrderService.java", symbol: "OrderService.find", line: 31, endLine: 38, basis: "lines" },
      { file: "src/Util.java", symbol: "Util.fmt", line: 3, basis: "top-level" },
    ],
    changedEntrypoints: [
      { change: "removed", kind: "http-route", name: "DELETE /orders", handler: handler("src/OrderController.java", "OrderController.drop", 30, 33) },
      { change: "added", kind: "listener", name: "kafka orders", handler: handler("src/OrderListener.java", "OrderListener.on", 10, 14) },
    ],
    changedContracts: [
      { change: "altered", method: "GET", path: "/orders/{id}", operationId: "getOrder", document: "api/openapi.yaml", line: 12, parts: ["response"], handlers: [handler("src/OrderController.java", "OrderController.one", 6, 9)] },
      { change: "removed", method: "DELETE", path: "/orders/{id}", document: "api/openapi.yaml", line: 30 },
    ],
    symbols: [
      { file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 6, endLine: 9, depth: 1, confidence: 0.9, fanIn: 2, via: { file: "src/OrderService.java", symbol: "OrderService.find", lines: [7, 8], basis: "call" } },
      { file: "src/Report.java", symbol: "Report", kind: "class", line: 1, endLine: 40, depth: 2, confidence: 0.5, fanIn: 0, via: { file: "src/Util.java", symbol: "fmt", basis: "reference" } },
      { file: "src/Root.java", symbol: "Root", kind: "class", line: 1, depth: 0, confidence: 1, fanIn: 0 },
    ],
    entrypoints: [
      { kind: "http-route", name: "GET /orders", handler: handler("src/OrderController.java", "OrderController.one", 6, 9), depth: 1, confidence: 0.9, seeds: [1, 0, 1] },
      { kind: "unknown", handler: handler("src/Dyn.java", "Dyn.run", 2), depth: 3, confidence: 0.2, seeds: [7] },
    ],
    modules: {
      origins: [
        { file: "src/gone.ts", change: "deleted" },
        { file: "src/util.ts", change: "modified" },
        { file: "src/new.ts", change: "added" },
      ],
      modules: [
        { file: "src/app.ts", snapshot: "head", depth: 1, origins: [2, 1], via: { file: "src/util.ts", line: 3, specifier: "./util", kind: "import", typeOnly: false } },
        { file: "src/old.ts", snapshot: "base", depth: 1, origins: [0], via: { file: "src/gone.ts", line: 1, specifier: "./gone", kind: "reexport", typeOnly: true, form: "type-query" } },
        { file: "src/lazy.ts", snapshot: "head", depth: 2, origins: [9] },
      ],
      cost: { expansionsUsed: 4 },
    },
    cost: { expansionsUsed: 6 },
  };
}

export function callersValue(): ImpactValue {
  return {
    seeds: [
      { file: "src/OrderService.java", symbol: "OrderService.find", line: 31, endLine: 38, basis: "requested" },
      { file: "src/OrderService.java", symbol: "OrderService.find", line: 50, endLine: 52, basis: "requested" },
    ],
    symbols: [{ file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 6, endLine: 9, depth: 1, confidence: 0.9, fanIn: 1, via: { file: "src/OrderService.java", symbol: "OrderService.find", lines: [7], basis: "call" } }],
    entrypoints: [{ kind: "http-route", name: "GET /orders", handler: handler("src/OrderController.java", "OrderController.one", 6, 9), depth: 1, confidence: 0.9, seeds: [0] }],
    cost: { expansionsUsed: 1 },
  };
}

const callSite: CallSite = {
  repo: "web",
  file: "src/orders.service.ts",
  line: 14,
  endLine: 16,
  symbol: "OrdersService.load",
  ancestors: [{ symbol: "OrdersService", line: 3, endLine: 40 }],
  transport: "http",
  target: { status: "complete", value: { method: "GET", path: "/orders", base: "api" }, evidence: [{ path: "src/orders.service.ts", line: 15, via: "environment.api" }] },
  stated: { method: "GET", path: "/orders" },
};
/** No `ancestors`, `stated` or `endLine`, and an unknown target. */
const bareCallSite: CallSite = { repo: "web", file: "src/orders.service.ts", line: 30, symbol: "OrdersService.save", transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [] } };
const eventCallSite: CallSite = { repo: "web", file: "src/orders.service.ts", line: 44, symbol: "OrdersService.emit", ancestors: [], transport: "event", target: { status: "complete", value: { protocol: "kafka", destination: "billing", role: "publish" }, evidence: [] } };

function repoImpact(kind: "trigger" | "upstream", repo: string, snapshot: SnapshotRef, impact: ImpactValue | undefined, sites: Pick<RepoImpact, "callSites" | "unmatched" | "external" | "unresolved">): Fact<RepoImpact> {
  const reads: RepoImpact["reads"] = [
    { kind: "discovery", fact: { schema: SCHEMA, snapshot, producer: PRODUCER, inputs: inputsOf(), evidence: [], status: "complete" } },
    { kind, fact: { schema: SCHEMA, snapshot, producer: PRODUCER, inputs: inputsOf({ trust: repo === "shop" ? "trusted" : "untrusted" }), evidence: [{ path: "pom.xml", line: 1 }], status: "partial", cuts: [{ kind: "depth", at: ["src/Root.java"], limit: 2 }] } },
  ];
  return factOf<RepoImpact>({ reads, ...(impact === undefined ? {} : { impact }), ...sites }, { snapshot });
}

export function workspaceImpactValue(family: "impact" | "callers"): WorkspaceImpactValue {
  const shop = shaRef("shop");
  const web = shaRef("web", SHA_B);
  const inner = family === "impact" ? impactValue() : callersValue();
  return {
    workspace: { repos: ["shop", "web"], gateways: [{ prefix: "api", repo: "shop", basis: "gateway-prefix" }], unmatchedGateways: [{ prefix: "legacy", repo: "old" }], unserved: ["billing"], source: "request" },
    repositorySnapshots: [{ repo: "web", snapshot: web }, { repo: "shop", snapshot: shop }],
    trigger: { repo: "shop", ...(family === "impact" ? { mergeBase: MERGE_BASE } : {}) },
    sections: {
      shop: repoImpact("trigger", "shop", shop, inner, { callSites: [], unmatched: [], external: [], unresolved: [] }),
      web: repoImpact("upstream", "web", web, undefined, {
        callSites: [callSite],
        unmatched: [bareCallSite],
        external: [eventCallSite],
        unresolved: [{ reason: "unresolved", diagnostic: { cause: "destination-undecidable", source: "read" }, evidence: [{ path: "(library)/lib/Client.java", line: 17 }], path: "src/orders.service.ts", line: 52, endLine: 54, symbol: "OrdersService.remote", transport: "http", via: "environment.remote", stated: { method: "GET", path: "/remote" } }],
      }),
      ghost: unknownFactOf("revision-unavailable", { snapshot: shaRef("ghost", SHA_C) }),
    },
    links: [
      { link: { id: "link-1", from: { repo: "web", file: "src/orders.service.ts", line: 14, symbol: "OrdersService.load" }, to: { repo: "shop", kind: "http-route", name: "GET /orders", handler: handler("src/OrderController.java", "OrderController.one", 6, 9) }, transport: "http", basis: "gateway-prefix", profiles: ["prod"], confidence: 0.8 }, direction: "upstream", reach: ["link-1", "link-missing", "link-2"], operations: [{ change: "altered", method: "GET", path: "/orders/{id}", operationId: "getOrder", document: "api/openapi.yaml", line: 12, parts: ["response"] }] },
      { link: { id: "link-2", from: { repo: "shop", file: "src/Notifier.java", line: 8, symbol: "Notifier.send" }, to: { repo: "billing", kind: "listener", name: "kafka bills", handler: handler("src/Bills.java", "Bills.on", 4, 9) }, transport: "event", basis: "event-destination", confidence: 1 }, direction: "downstream", reach: [] },
    ],
  };
}

export function importersValue(): ImportersValue {
  return {
    files: [
      { file: "src/service.ts", importers: ["src/ui.ts", "src/ui.ts", "src/app.ts"], reexporters: [], typeImporters: ["src/types.ts"], users: ["src/ui.ts"], unresolvedNamers: ["src/legacy.ts"] },
      { file: "src/empty.ts", importers: [], dynamicImporters: ["src/lazy.ts"], users: [], unresolvedNamers: [] },
    ],
  };
}

/** The controller method the callers fixture reaches, traced forward into the service method that fixture targets. */
export function traceValue(): TraceValue {
  return {
    roots: [{ target: "src/OrderController.java:30-33", steps: [4] }, { target: "src/OrderController.java:one", steps: [0] }],
    steps: [
      { id: 0, depth: 0, file: "src/OrderController.java", symbol: "one", kind: "method", line: 6, endLine: 9 },
      {
        id: 1, parent: 0, depth: 1, file: "src/OrderService.java", symbol: "find", kind: "method", line: 31, endLine: 38, at: { line: 7, column: 12 }, via: "call",
        leaves: [{ symbol: "check", file: "src/OrderService.java", start: 40, end: 41 }, { symbol: "check", file: "src/OrderService.java", start: 40, end: 41, deferred: true }, { symbol: "id", file: "src/Order.java", start: 5, end: 5 }],
        external: [{ kind: "import", module: "org.slf4j", names: ["debug", "info"] }, { kind: "unnamed", names: ["repository.findById"] }],
        alternatives: [{ symbol: "find", file: "src/OrderServiceImpl.java", start: 12, end: 20 }],
      },
      { id: 2, parent: 0, depth: 1, file: "src/Audit.java", symbol: "audit", kind: "method", line: 3, at: { line: 8 }, via: "reference", deferred: true },
      { id: 3, parent: 0, depth: 1, file: "src/OrderService.java", symbol: "find", kind: "method", line: 31, endLine: 38, at: { line: 9, column: 4 }, via: "own-member", seen: 1 },
      { id: 4, depth: 0, file: "src/OrderController.java", symbol: "drop", kind: "method", line: 30, endLine: 33 },
      { id: 5, parent: 4, depth: 1, file: "src/OrderController.java", symbol: "one", kind: "method", line: 6, endLine: 9, via: "member", seen: 0 },
    ],
    readingPlan: {
      ranges: [
        { file: "src/OrderController.java", start: 6, end: 9, steps: [0] },
        { file: "src/OrderController.java", start: 30, end: 33, steps: [4] },
        { file: "src/OrderService.java", start: 31, end: 38, steps: [1] },
        { file: "src/Audit.java", start: 3, end: 3, steps: [2] },
      ],
      lines: 17,
    },
    cost: { expanded: 4 },
  };
}

export function outlineValue(): OutlineListing {
  return {
    files: [
      {
        file: "src/OrderController.java",
        declarations: [
          { kind: "class", name: "OrderController", line: 1, endLine: 40 },
          { kind: "method", name: "one", line: 6, endLine: 9 },
          { kind: "method", name: "one", line: 6, endLine: 9 },
          { kind: "method", name: "drop", line: 30, endLine: 33, children: [{ kind: "function", name: "check", line: 31, endLine: 32 }] },
        ],
        imports: [
          { line: 2, endLine: 2, specifier: "app.OrderService", kind: "import", typeOnly: false, target: { kind: "repository", file: "src/OrderService.java" }, bindings: [{ local: "OrderService", imported: "OrderService", declaration: { file: "src/OrderService.java", name: "OrderService", kind: "class", line: 3, endLine: 50 } }] },
          { line: 3, endLine: 3, specifier: "app.OrderService.LIMIT", kind: "import", typeOnly: false, target: { kind: "repository", file: "src/OrderService.java" }, bindings: [{ local: "LIMIT", imported: "LIMIT" }] },
          { line: 4, endLine: 4, specifier: "java.util.List", kind: "import", typeOnly: false, target: { kind: "external", module: "java.util" }, bindings: [{ local: "List", imported: "List", typeOnly: true }] },
          { line: 5, endLine: 5, specifier: "com.acme.Gone", kind: "reexport", typeOnly: false, target: { kind: "unresolved", reason: "no source of the snapshot declares com.acme.Gone" }, bindings: [] },
          { line: 7, endLine: 7, kind: "import", form: "dynamic-import", typeOnly: false, target: { kind: "unresolved", reason: "a computed expression names the module" }, bindings: [] },
        ],
      },
      { file: "src/Empty.java", declarations: [], imports: [] },
    ],
    unheld: ["src/Missing.java", "src/generated/Out.java"],
  };
}

export function workspaceValue(): PublicWorkspaceValue {
  const repoEvidence = (repo: string, path: string, line: number): RepositoryEvidence => ({ path, line, repo });
  return {
    workspace: { repos: ["shop", "web"], gateways: [{ prefix: "api", repo: "shop", basis: "gateway-prefix" }], source: "persisted" },
    repositorySnapshots: [{ repo: "shop", snapshot: shaRef("shop") }, { repo: "web", snapshot: liveRef("web", "state-1") }],
    sections: {
      web: factOf(
        {
          names: [
            { name: "api", kind: "path-prefix", evidence: [{ path: "src/orders.service.ts", line: 15 }] },
            { name: "billing.example", kind: "http-host", evidence: [{ path: "src/env.ts", line: 2 }, { path: "src/env.ts", line: 2 }] },
          ],
          unresolved: [{ reason: "unresolved", diagnostic: { cause: "destination-undecidable", source: "read" }, evidence: [{ path: "(library)/lib/Client.java", line: 17 }], path: "src/dyn.ts", line: 4, symbol: "Dyn.call", transport: "http", via: "httpClient", stated: { method: "POST", path: "/x" } }, { reason: "source-unreadable", evidence: [{ path: "src/dyn.ts", line: 9 }], path: "src/dyn.ts", line: 9, endLine: 11, symbol: "Dyn.emit", transport: "event" }],
        },
        { snapshot: liveRef("web", "state-1"), cuts: [{ kind: "unresolved-link", at: ["src/dyn.ts"], dependency: { name: "com.acme:clients", reason: "ambiguous", candidates: ["one", "two"] } }] },
      ),
      shop: unknownFactOf("index-unavailable", { snapshot: shaRef("shop") }),
    },
    candidates: [
      { name: "api", repo: "shop", basis: "exact-name", evidence: [repoEvidence("shop", "pom.xml", 4), repoEvidence("web", "src/orders.service.ts", 15)] },
      { name: "api", repo: "web", basis: "route-overlap", evidence: [] },
    ],
    unserved: [
      { name: "billing.example", kind: "http-host", evidence: [repoEvidence("web", "src/env.ts", 2)] },
      { name: "ghost.example", kind: "configuration-url", evidence: [repoEvidence("ghost", "app.yml", 1)] },
    ],
    links: [{ id: "link-ws", from: { repo: "web", file: "src/orders.service.ts", line: 15, symbol: "OrdersService.create" }, to: { repo: "shop", kind: "http-route", name: "POST /orders", handler: handler("src/OrderController.java", "OrderController.create", 12, 15) }, transport: "http", basis: "exact", confidence: 1 }],
    unlinked: [
      { from: { repo: "web", file: "src/orders.service.ts", line: 20, symbol: "OrdersService.shared" }, transport: "http", outcome: "ambiguous", name: "shared", repos: ["billing", "shop"] },
      { from: { repo: "web", file: "src/orders.service.ts", line: 24, symbol: "OrdersService.gone" }, transport: "http", outcome: "unmatched", name: "/orders/gone" },
    ],
  };
}

export function decisionsValue(): DecisionValue {
  return {
    decisions: [
      {
        id: "membership:name:api", kind: "membership", subject: "api",
        evidence: [{ path: "pom.xml", line: 4, repo: "shop" }],
        options: [
          { value: "shop", basis: "exact-name", evidence: [{ path: "pom.xml", line: 4, repo: "shop" }], recommended: true },
          { value: "web", basis: "route-overlap", evidence: [], recommended: false },
        ],
        allowsFreeText: true, required: false,
      },
      { id: "repository:billing.example", kind: "repository", subject: "billing.example", evidence: [{ path: "src/env.ts", line: 2, repo: "web" }, { path: "app.yml", line: 1, repo: "ghost" }], outwardKinds: ["configuration-url", "http-host"], options: [], allowsFreeText: true, required: false },
      { id: "remote:web", kind: "remote", subject: "web", evidence: [], options: [{ value: "git@example.com:web.git", basis: "origin", evidence: [{ path: ".git/config", line: 1, via: "origin", repo: "web" }], recommended: false }], allowsFreeText: true, required: false },
      { id: "trust:web", kind: "trust", subject: "web", evidence: [], options: [{ value: "trusted", evidence: [], recommended: false }, { value: "untrusted", evidence: [], recommended: false }], allowsFreeText: false, required: true },
      { id: "revision:web", kind: "revision", subject: "web", evidence: [], options: [{ value: "main", basis: "default-branch", evidence: [], recommended: true }], allowsFreeText: true, required: false },
    ],
    repositories: [{ repo: "web", snapshot: shaRef("web", SHA_B) }, { repo: "shop", snapshot: shaRef("shop") }],
    source: "request",
  };
}

export type FixtureKind = "entrypoints" | "impact-local" | "impact-workspace" | "callers-local" | "callers-workspace" | "importers" | "outline" | "trace" | "workspace" | "decisions";

/** What a test may replace; `value` keeps the default complete envelope, `fact` replaces the whole fact. */
export type FixtureOverrides<V, F extends ExecutedSource["family"]> = {
  value?: V;
  fact?: Fact<V>;
  read?: Omit<PublicRead<V>, "fact">;
  arguments?: SemanticArguments<F>;
  identityGuard?: Partial<RedactionIdentityGuard>;
};

type AnyOverrides =
  | FixtureOverrides<EntrypointMap, "entrypoints"> | FixtureOverrides<ImpactValue, "impact"> | FixtureOverrides<ImpactValue, "callers">
  | FixtureOverrides<WorkspaceImpactValue, "impact"> | FixtureOverrides<WorkspaceImpactValue, "callers"> | FixtureOverrides<ImportersValue, "importers">
  | FixtureOverrides<OutlineValue, "outline"> | FixtureOverrides<TraceValue, "trace"> | FixtureOverrides<PublicWorkspaceValue, "workspace"> | FixtureOverrides<DecisionValue, "decisions">;

/** A family's source; impact and callers share one payload member, so their branch is fixed by intersection. */
type Of<F extends ExecutedSource["family"], B = never> = [B] extends [never] ? Extract<ExecutedSource, { family: F }> : Extract<ExecutedSource, { branch: B }> & { family: F; query: SemanticQueryOf<F> };

const guardOf = (overrides: Partial<RedactionIdentityGuard> | undefined): RedactionIdentityGuard => ({ changedIdentityPointers: [], changedArguments: false, changedSnapshot: false, ...overrides });
const WORKSPACE_FACT = { snapshot: shaRef("shop"), inputs: inputsOf({ declaredConfig: { walk: { depth: 3 } } }) };
const replay = { version: 1 as const, declaration: REPLAY_DECLARATION, snapshots: [shaRef("shop"), shaRef("web", SHA_B)] };

function build<V, F extends ExecutedSource["family"]>(defaultValue: () => V, overrides: FixtureOverrides<V, F> | undefined, fact: FactOptions = {}): { read: PublicRead<V>; identityGuard: RedactionIdentityGuard } {
  return { read: { ...overrides?.read, fact: overrides?.fact ?? factOf(overrides?.value ?? defaultValue(), fact) }, identityGuard: guardOf(overrides?.identityGuard) };
}

function query<F extends ExecutedSource["family"]>(family: F, args: SemanticArguments<F>): SemanticQueryOf<F> {
  return { name: `ye_ast_${family}`, arguments: args } as SemanticQueryOf<F>;
}

export function sourceFixture(kind: "entrypoints", overrides?: FixtureOverrides<EntrypointMap, "entrypoints">): Of<"entrypoints">;
export function sourceFixture(kind: "impact-local", overrides?: FixtureOverrides<ImpactValue, "impact">): Of<"impact", "local">;
export function sourceFixture(kind: "impact-workspace", overrides?: FixtureOverrides<WorkspaceImpactValue, "impact">): Of<"impact", "workspace">;
export function sourceFixture(kind: "callers-local", overrides?: FixtureOverrides<ImpactValue, "callers">): Of<"callers", "local">;
export function sourceFixture(kind: "callers-workspace", overrides?: FixtureOverrides<WorkspaceImpactValue, "callers">): Of<"callers", "workspace">;
export function sourceFixture(kind: "importers", overrides?: FixtureOverrides<ImportersValue, "importers">): Of<"importers">;
export function sourceFixture(kind: "outline", overrides?: FixtureOverrides<OutlineValue, "outline">): Of<"outline">;
export function sourceFixture(kind: "trace", overrides?: FixtureOverrides<TraceValue, "trace">): Of<"trace">;
export function sourceFixture(kind: "workspace", overrides?: FixtureOverrides<PublicWorkspaceValue, "workspace">): Of<"workspace">;
export function sourceFixture(kind: "decisions", overrides?: FixtureOverrides<DecisionValue, "decisions">): Of<"decisions">;
export function sourceFixture(kind: FixtureKind, overrides?: AnyOverrides): ExecutedSource {
  // Each overload pairs one kind with its own overrides type, so the implementation narrows by `kind` alone.
  switch (kind) {
    case "entrypoints": {
      const o = overrides as FixtureOverrides<EntrypointMap, "entrypoints"> | undefined;
      return { family: "entrypoints", query: query("entrypoints", o?.arguments ?? { repo: "shop", revision: SHA_A }), ...build(entrypointsValue, o) };
    }
    case "impact-local": {
      const o = overrides as FixtureOverrides<ImpactValue, "impact"> | undefined;
      return { family: "impact", branch: "local", query: query("impact", o?.arguments ?? { repo: "shop", base: "main", head: SHA_A }), ...build(impactValue, o, { inputs: inputsOf({ declaredConfig: { walk: { depth: 2 }, changed: ["src/**"] } }), cuts: [{ kind: "depth", at: ["src/Root.java", "src/Report.java"], limit: 2 }] }) };
    }
    case "callers-local": {
      const o = overrides as FixtureOverrides<ImpactValue, "callers"> | undefined;
      return { family: "callers", branch: "local", query: query("callers", o?.arguments ?? { repo: "shop", revision: SHA_A, targets: [{ file: "src/OrderService.java", symbol: "find" }] }), ...build(callersValue, o, { inputs: inputsOf({ declaredConfig: { targets: ["src/OrderService.java#find"] } }) }) };
    }
    case "impact-workspace": {
      const o = overrides as FixtureOverrides<WorkspaceImpactValue, "impact"> | undefined;
      return { family: "impact", branch: "workspace", query: query("impact", o?.arguments ?? { repo: "shop", base: "main", head: SHA_A, workspace: {}, offline: true }), ...build(() => workspaceImpactValue("impact"), { read: { workspaceReplay: replay }, ...o }, WORKSPACE_FACT) };
    }
    case "callers-workspace": {
      const o = overrides as FixtureOverrides<WorkspaceImpactValue, "callers"> | undefined;
      return { family: "callers", branch: "workspace", query: query("callers", o?.arguments ?? { repo: "shop", revision: SHA_A, targets: [{ file: "src/OrderService.java", symbol: "find" }], workspace: {} }), ...build(() => workspaceImpactValue("callers"), { read: { workspaceReplay: replay }, ...o }, WORKSPACE_FACT) };
    }
    case "importers": {
      const o = overrides as FixtureOverrides<ImportersValue, "importers"> | undefined;
      return { family: "importers", query: query("importers", o?.arguments ?? { repo: "shop", revision: SHA_A, files: ["src/service.ts", "src/empty.ts"] }), ...build(importersValue, o, { inputs: inputsOf({ declaredConfig: { files: ["src/empty.ts", "src/service.ts"] } }) }) };
    }
    case "outline": {
      const o = overrides as FixtureOverrides<OutlineValue, "outline"> | undefined;
      return { family: "outline", query: query("outline", o?.arguments ?? { repo: "shop", revision: SHA_A, files: ["src/OrderController.java"] }), ...build(outlineValue, o, { inputs: inputsOf({ declaredConfig: { files: ["src/OrderController.java"] } }) }) };
    }
    case "trace": {
      const o = overrides as FixtureOverrides<TraceValue, "trace"> | undefined;
      return { family: "trace", query: query("trace", o?.arguments ?? { repo: "shop", revision: SHA_A, targets: [{ file: "src/OrderController.java", symbol: "one" }] }), ...build(traceValue, o, { inputs: inputsOf({ declaredConfig: { targets: ["src/OrderController.java:one"] } }) }) };
    }
    case "workspace": {
      const o = overrides as FixtureOverrides<PublicWorkspaceValue, "workspace"> | undefined;
      return { family: "workspace", query: query("workspace", o?.arguments ?? { repo: "shop", revision: SHA_A, offline: true }), ...build(workspaceValue, o) };
    }
    case "decisions": {
      const o = overrides as FixtureOverrides<DecisionValue, "decisions"> | undefined;
      return { family: "decisions", query: query("decisions", o?.arguments ?? { repo: "shop" }), ...build(decisionsValue, o) };
    }
    default:
      return unreachable(kind);
  }
}

function unreachable(kind: never): never {
  throw new Error(`Unknown fixture ${String(kind)}`);
}
