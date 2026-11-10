import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import type { RouteGuard, UiRoute } from "../../domain/entrypoints/ui-route.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { Cut, Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { EntrypointExtraction, EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RouterVocabulary } from "../../ports/router-vocabulary.port.ts";
import { pathsByProject } from "./angular-projects.ts";
import type { ManifestPackages } from "./module-resolver.ts";
import { sourceTree } from "./source-tree.ts";
import ts from "typescript";
import { readAngularRouteFile } from "./angular-router.extractor.ts";
import { coreExternalOf, readAngularMetadataFile, type RawAngularFile } from "./angular-metadata.extractor.ts";
import { createModuleResolver, type ModuleResolver } from "./module-resolver.ts";
import { loadRouteTables, type AngularModuleReading, type RouteEntry, type RouteFileReading, type RouteTable, type UnresolvedReference } from "./route-table.loader.ts";

/** The module reading the route graph needs, projected from the one Angular metadata reading of a file, never re-derived. */
export function modulesOf(angular: RawAngularFile): AngularModuleReading {
  return {
    modules: angular.classes.flatMap((c) => (c.kind === "module" ? [{ name: c.name, line: c.line, imports: c.imports }] : [])),
    arrays: angular.arrays,
  };
}

/**
 * The Angular router's routes: each project (the directory of a `package.json` that names the package of `router`'s signal) has its
 * route tables read from the TypeScript sources outside tests that belong to it, nearest project first, with nothing built or run. A table is read wherever the router receives one:
 * from every root configuration and from the module graph a `bootstrapModule(...)` call boots or a `loadChildren` loads,
 * so a `forChild` table a module composes is named under the prefix of the root or route that reaches its graph. Each route entry that shows a component is a
 * `ui-route`; a path or an outlet the sources do not give as text, a lazy section that cannot be followed, a `matcher`
 * and a source that does not parse are `unknown` items at their location. Lazy loads include legacy strings,
 * helpers, await and destructuring; a reference called with arguments is `no-extractor`.
 */
export function createAngularRoutesExtractor(router: RouterVocabulary): EntrypointExtractor {
  return { extract: async (files) => extractRoutes(files, router) };
}

async function extractRoutes(files: readonly SourceFile[], router: RouterVocabulary): Promise<EntrypointExtraction> {
  const contents = new Map(files.map((file) => [file.path, file]));
  const { byProject, orphaned } = pathsByProject([...contents.keys()].filter(isTypeScriptSource), files, router.signal.dependency);
  const found: Finding<Entrypoint>[] = orphaned.map((path) => unknown("no-project", { path, line: 1 }));
  const readingCuts: Cut[] = [];
  for (const [project, sources] of byProject) {
    const extracted = await extractProject(sources, project.packages, contents, router);
    found.push(...extracted.findings);
    readingCuts.push(...extracted.readingCuts);
  }
  return { findings: sortFindings(found), readingCuts };
}

async function extractProject(sources: readonly string[], packages: ManifestPackages, contents: ReadonlyMap<string, SourceFile>, router: RouterVocabulary): Promise<{ findings: Finding<Entrypoint>[]; readingCuts: Cut[] }> {
  const read = async (path: string): Promise<string | undefined> => contents.get(path)?.content;
  const resolver = createModuleResolver(read, packages);
  const readings = new Map<string, Promise<RouteFileReading | undefined>>();
  const reading = (path: string): Promise<RouteFileReading | undefined> => {
    let held = readings.get(path);
    if (held === undefined) {
      held = readOne(path, contents.get(path), resolver, router);
      readings.set(path, held);
    }
    return held;
  };
  const loaded = await loadRouteTables({ candidates: sources, read, listing: [...contents.keys()], packages, router, reading });
  const { roots, unparsed, unresolvedReferences } = loaded;
  const walk: Walk = { findings: [], blockers: loaded.declared ? [] : unresolvedReferences };
  for (const root of roots) routesOf(root, enter(root, { segments: [], conditional: false, above: new Set() }), walk);
  for (const configuration of loaded.unresolvedConfigurations) walk.findings.push(unknown(configuration.reason, configuration));
  const noRoot: UnknownReason | undefined = loaded.declared ? undefined : "unresolved";
  for (const table of loaded.unreached) unreachedRoutesOf(table.entries, unresolvedReferences, walk.findings, noRoot);
  for (const path of unparsed) walk.findings.push(unknown("source-unreadable", { path, line: 1 }));
  const importCuts = loaded.unresolvedModuleImports.map((reference) => (reference.specifier === undefined ? frontierOf(reference) : importFrontierOf(reference.path, reference.line, reference.specifier, reference.namesNoFile)));
  return { findings: walk.findings, readingCuts: [...loaded.unresolvedReferences.map(frontierOf), ...importCuts] };
}

function frontierOf(reference: UnresolvedReference): Cut {
  return { kind: "unresolved-link", at: [reference.path, `${reference.path}:${reference.line}`], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } };
}

function importFrontierOf(path: string, line: number, specifier: string, namesNoFile: boolean): Cut {
  return { kind: "unresolved-link", at: [path, `${path}:${line}`], reason: "specifier", reach: { kind: "module", importer: path, specifiers: [{ specifier, ...(namesNoFile ? { namesNoFile: true as const } : {}) }] } };
}

/**
 * One file read once: its route reading and the Angular metadata reading of the same syntax tree. Both readings ask the
 * one `coreExternalOf` whether `@angular/core` is outside the snapshot, so they never disagree about the file's decorators.
 */
async function readOne(path: string, file: SourceFile | undefined, resolver: ModuleResolver, router: RouterVocabulary): Promise<RouteFileReading | undefined> {
  if (file === undefined) return undefined;
  const sf = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const routes = readAngularRouteFile(sf, router);
  if (routes === undefined) return undefined;
  const coreExternal = await coreExternalOf(routes, async (specifier) => "external" in (await resolver.resolve(path, specifier)));
  return { routes, modules: modulesOf(readAngularMetadataFile(sf, routes, false, coreExternal)) };
}

interface Walk {
  findings: Finding<Entrypoint>[];
  /**
   * Without a declared root, the child references the sources do not resolve: while there is one, a root table may be a
   * table whose loader is among them, so no route is named.
   */
  blockers: readonly Evidence[];
}

/**
 * A table no declared root reaches may be dead code, the table an unresolved reference should have loaded, or a root the
 * extractor does not recognize: its routes are unknown, never named and never an empty answer.
 */
function unreachedRoutesOf(entries: readonly RouteEntry[], references: readonly Evidence[], findings: Finding<Entrypoint>[], reason?: UnknownReason): void {
  for (const entry of entries) {
    if (entry.spread || entry.redirect || entry.unreadable !== undefined) continue;
    if (entry.component !== undefined) findings.push(unknown(reason ?? (references.length > 0 ? "unresolved" : "no-extractor"), { path: entry.file, line: entry.line, endLine: entry.endLine }, ...references));
    unreachedRoutesOf(entry.children, references, findings, reason);
  }
}

/** What an entry inherits from the entries and tables above it. */
interface Context {
  segments: readonly string[];
  outlet?: string;
  /** Where a guard list above could not be read: nothing beneath it has known guards. */
  guardsProblem?: UnresolvedReference;
  /** The table being walked sits in a branch of a conditional expression, so the sources do not say it is served. */
  conditional: boolean;
  above: ReadonlySet<RouteTable>;
}

function enter(table: RouteTable, context: Context): Context {
  return { ...context, conditional: context.conditional || table.conditional, above: new Set(context.above).add(table) };
}

function routesOf(table: RouteTable, context: Context, walk: Walk): void {
  for (const entry of table.entries) routeOf(entry, context, walk);
}

function routeOf(entry: RouteEntry, context: Context, walk: Walk): void {
  const { findings } = walk;
  const at: Evidence = { path: entry.file, line: entry.line, endLine: entry.endLine };
  if (entry.unreadable !== undefined) {
    findings.push(unknown(entry.unreadable, at));
    return;
  }
  if (entry.spread) {
    if (entry.unresolvedLoad !== undefined) findings.push(unknown(entry.unresolvedLoad, at));
    else if (entry.loaded !== undefined && context.above.has(entry.loaded)) findings.push(unknown("unresolved", at));
    else if (entry.loaded !== undefined) routesOf(entry.loaded, enter(entry.loaded, context), walk);
    return;
  }
  if (entry.redirect) return;
  if (entry.matcher) {
    findings.push(unknown("no-extractor", at));
    return;
  }
  if (entry.path === undefined || entry.outletUnresolved) {
    findings.push(unknown("unresolved", at));
    return;
  }
  if (entry.outlet !== undefined && context.outlet !== undefined && entry.outlet !== context.outlet) {
    findings.push(unknown("no-extractor", at));
    return;
  }
  const outlet = entry.outlet ?? context.outlet;
  const segments = [...context.segments, ...entry.path.split("/").filter((segment) => segment !== "")];
  const guards = withoutRepeats(entry.guards);
  const guardsProblem = context.guardsProblem ?? entry.guardsProblem;
  if (entry.component !== undefined) {
    if (guardsProblem !== undefined) findings.push(unknown("unresolved", guardsProblem, at));
    else if (walk.blockers.length > 0) findings.push(unknown("unresolved", at, ...walk.blockers));
    else if (context.conditional) findings.push(unknown("no-extractor", at));
    else findings.push({ status: "complete", value: uiRoute(entry, entry.component, `/${segments.join("/")}`, outlet, guards), evidence: [at] });
  }
  if (entry.unresolvedLoad !== undefined) findings.push(unknown(entry.unresolvedLoad, at));
  const beneath: Context = {
    ...context,
    segments,
    ...(outlet !== undefined ? { outlet } : {}),
    ...((guardsProblem ?? entry.childGuardsProblem) !== undefined ? { guardsProblem: (guardsProblem ?? entry.childGuardsProblem)! } : {}),
  };
  for (const child of entry.children) routeOf(child, beneath, walk);
  if (entry.loaded === undefined) return;
  if (context.above.has(entry.loaded)) findings.push(unknown("unresolved", at));
  else routesOf(entry.loaded, enter(entry.loaded, beneath), walk);
}

function withoutRepeats(guards: readonly RouteGuard[]): RouteGuard[] {
  return [...new Map(guards.map((guard) => [JSON.stringify(guard), guard])).values()];
}

function uiRoute(entry: RouteEntry, component: UiRoute["component"], path: string, outlet: string | undefined, guards: readonly RouteGuard[]): UiRoute {
  return {
    kind: "ui-route",
    name: outlet === undefined ? path : `${path} (${outlet})`,
    path,
    ...(outlet !== undefined ? { outlet } : {}),
    component,
    guards,
  };
}

/** An unknown item at the span, then at the others; a span listed twice is kept once. */
function unknown(reason: UnknownReason, at: Evidence, ...also: readonly Evidence[]): Finding<never> {
  const spans = new Map([at, ...also].map((span) => [`${span.path}:${span.line}:${span.endLine ?? span.line}`, span]));
  return { status: "unknown", reason, evidence: [...spans.values()] };
}
