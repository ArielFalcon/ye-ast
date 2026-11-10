import { legacyRoots } from "./angular-projects.ts";
import type { Handler } from "../../domain/entrypoints/http-route.ts";
import type { RouteGuard } from "../../domain/entrypoints/ui-route.ts";
import { declarationSpan } from "../../domain/shared/fact.ts";
import type { UnknownReason } from "../../domain/shared/fact.ts";
import type { RawChildRef, RawBootstrap, RawComponent, RawEntry, RawGuard, RawRouteFile, RawTable, RawValue } from "./angular-router.extractor.ts";
import type { RawOperand, RawReference } from "./angular-metadata.extractor.ts";
import { createDeclarationLookup, type Declaration } from "./declaration-lookup.ts";
import { createModuleResolver, type ManifestPackages, type SourceReader } from "./module-resolver.ts";

const ANGULAR_ROUTER = "@angular/router";

/** What the Angular metadata reading states about one file, projected to what the route graph needs. */
export interface AngularModuleReading {
  /** Its `@NgModule` classes, in source order, with the operands of each decorator's `imports` list. */
  modules: readonly { name: string; line: number; imports: readonly RawOperand[] }[];
  /** Its top-level arrays, by name: what a spread in an `imports` list names. */
  arrays: ReadonlyMap<string, readonly RawOperand[]>;
}

/** One file, parsed once: its route reading and its Angular module reading. */
export interface RouteFileReading {
  routes: RawRouteFile;
  modules: AngularModuleReading;
}

/** What the route loader reads: the files that seed the walk, and the one reading of a file the caller memoizes. */
export interface RouteTableInputs {
  /** The files that seed the walk. `read` and `reading` may reach any path the export holds: a legacy string, a barrel and a lazily loaded module need not be candidates. */
  candidates: readonly string[];
  read: SourceReader;
  packages: ManifestPackages;
  /** The one reading of a file, memoized by the caller; `undefined` when the file does not parse. */
  reading(file: string): Promise<RouteFileReading | undefined>;
}

/** A route entry with everything that can be followed across files followed; what cannot is marked, never guessed. */
export interface RouteEntry {
  file: string;
  line: number;
  endLine: number;
  /** The path as text; absent when the entry has none or the sources do not give it as text. */
  path?: string;
  matcher: boolean;
  redirect: boolean;
  /** The outlet as text; absent for the primary outlet. */
  outlet?: string;
  outletUnresolved: boolean;
  /** `undefined`: the entry shows no component. `unknown`: it shows one the sources do not name as one class. */
  component?: Handler | "unknown";
  /** The guards of the entry itself: `canMatch`, `canActivate` and `canLoad`, which guard it and what is beneath it. */
  guards: RouteGuard[];
  /** `canActivateChild`: it guards what is beneath the entry, never the entry. */
  childGuards: RouteGuard[];
  /** Where the guard list of `guards` (or of `childGuards`) the sources do not let us read sits. */
  guardsProblem?: UnresolvedReference;
  childGuardsProblem?: UnresolvedReference;
  /** The element of the table cannot be read as one route, and why. */
  unreadable?: UnknownReason;
  /** The inline children. */
  children: RouteEntry[];
  /** The table the entry loads as children, shared by every entry that loads it; it may load the tables above it. */
  loaded?: RouteTable;
  /** The element is a spread: `loaded` holds the entries it puts here, under the same parent. */
  spread: boolean;
  /** The table the entry loads as children (or a spread puts here) cannot be followed to exactly one table, and why. */
  unresolvedLoad?: UnknownReason;
}

/** The entries of one route array, built once however many entries load it. */
export interface RouteTable {
  entries: RouteEntry[];
  /** The array sits in a branch of a conditional expression. */
  conditional: boolean;
}

/** Where a child reference the sources do not resolve sits. */
export interface UnresolvedReference {
  path: string;
  line: number;
  endLine: number;
}

export interface LoadedRouteTables {
  /**
   * The tables the router is configured with (`provideRouter` and `RouterModule.forRoot`) and the module graphs the
   * application boots, in file and line order.
   */
  roots: RouteTable[];
  /** The sources configure the router, so a table no root reaches is not an entrypoint. */
  declared: boolean;
  /** With declared roots, the tables no root reaches. */
  unreached: RouteTable[];
  unparsed: string[];
  /** Every `loadChildren`, `children`, spread and root configuration of the repository that does not come down to one table, sorted. */
  unresolvedReferences: UnresolvedReference[];
  /** The root configurations among them, with why each is unresolved. */
  unresolvedConfigurations: Array<UnresolvedReference & { reason: UnknownReason }>;
  /**
   * Every `@NgModule({ imports })` operand a visited module graph could not follow to a file, sorted: one the metadata
   * reading marks `unreadable`, or a name whose import names no file of the snapshot or a file that does not parse. An
   * operand that names the router's own `RouterModule`, an external package, a type-only import, a namespace without that
   * member, or a declaration that is no module class is skipped and not recorded.
   */
  unresolvedModuleImports: UnresolvedReference[];
}

/** A module-graph name as the reading answers it: a top-level array to expand, a module class to visit, or nothing to follow. */
type OperandTarget =
  | { kind: "module"; file: string; name: string }
  | { kind: "array"; file: string; name: string }
  | { kind: "skip" }
  | { kind: "unresolved"; line: number }
  | { kind: "unreadable"; line: number };

/** A child reference read: the table it loads, or why the sources do not come down to one. */
type ChildResolution = { table: RouteTable } | { reason: UnknownReason };

/**
 * Builds the route tables of the parsed files: each file is read and parsed once, a module specifier is resolved with the
 * module resolver, and what a path, an outlet, a component or a guard names is followed through re-exports and renames to
 * the file and the name that declare it (a guard is placed only there, never at a barrel). A child table that is not
 * inline (a lazily loaded module, a named array) is attached under the entry that loads it. A module class answers the
 * aggregate of its `@NgModule({ imports })` graph, so a `forChild` table is served under the root that boots the graph or
 * under the route that loads it. A chain that does not come down to exactly one declaration is unresolved. Each table is
 * built once and shared by the entries that load it. Returns the root tables, the candidates that do not parse, the
 * unresolved child references and the unresolved module imports.
 */
export async function loadRouteTables(inputs: RouteTableInputs): Promise<LoadedRouteTables> {
  const { candidates, read, packages, reading } = inputs;
  const resolver = createModuleResolver(read, packages);
  const readings = new Map<string, Promise<RouteFileReading | undefined>>();
  const readOf = (file: string): Promise<RouteFileReading | undefined> => {
    let held = readings.get(file);
    if (held === undefined) {
      held = reading(file);
      readings.set(file, held);
    }
    return held;
  };
  const parse = (file: string): Promise<RawRouteFile | undefined> => readOf(file).then((one) => one?.routes);
  const fileOf = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolution = await resolver.resolve(from, specifier);
    return "file" in resolution ? resolution.file : undefined;
  };
  const declarationOf = createDeclarationLookup(parse, fileOf);
  /* A constant of a file as text, following the constants and imports it is made of; a loop of them is not text. */
  const constantText = async (file: string, raw: RawRouteFile | undefined, key: string, trail: ReadonlySet<string>): Promise<string | undefined> => {
    const value = raw?.constants.get(key);
    const visited = `${file}\0${key}`;
    return value === undefined || raw === undefined || trail.has(visited) ? undefined : textOf(file, raw, value, new Set(trail).add(visited));
  };
  const textOf = async (file: string, raw: RawRouteFile, value: RawValue, trail: ReadonlySet<string> = new Set()): Promise<string | undefined> => {
    if ("opaque" in value) return undefined;
    if ("literal" in value) return value.literal;
    if ("template" in value) {
      let text = "";
      for (const part of value.template) {
        const piece = await textOf(file, raw, part, trail);
        if (piece === undefined) return undefined;
        text += piece;
      }
      return text;
    }
    const key = value.member === undefined ? value.ref : `${value.ref}.${value.member}`;
    if (value.module === undefined || value.imported === undefined) return constantText(file, raw, key, trail);
    const target = await fileOf(file, value.module);
    if (target === undefined) return undefined;
    /* A namespace import names the module itself: its member is a top-level constant of that file. */
    if (value.imported === "*") return value.member === undefined ? undefined : constantText(target, await parse(target), value.member, trail);
    const declaration = await declarationOf(target, value.imported);
    if (declaration === undefined) return undefined;
    return constantText(declaration.file, await parse(declaration.file), value.member === undefined ? declaration.name : `${declaration.name}.${value.member}`, trail);
  };
  const handlerOf = async (declaration: Declaration | undefined): Promise<Handler | "unknown"> => {
    if (declaration === undefined) return "unknown";
    const declaring = await parse(declaration.file);
    const span = declaring?.classes.has(declaration.name) ? declaring.declared.get(declaration.name) : undefined;
    return span === undefined
      ? "unknown"
      : { path: declaration.file, symbol: declaration.name, line: span.line, ...declarationSpan(span.line, span.endLine) };
  };
  const componentOf = async (file: string, raw: RawRouteFile, component: RawComponent): Promise<Handler | "unknown"> => {
    if ("opaque" in component) return "unknown";
    if ("lazy" in component) {
      const target = await fileOf(file, component.lazy.module);
      return handlerOf(target === undefined ? undefined : await declarationOf(target, component.lazy.name ?? "default"));
    }
    if (component.module === undefined || component.imported === undefined) return handlerOf({ file, name: component.ref });
    const target = await fileOf(file, component.module);
    return handlerOf(target === undefined ? undefined : await declarationOf(target, component.imported));
  };
  const guardOf = async (file: string, guard: Extract<RawGuard, { name: string }>): Promise<RouteGuard> => {
    if (guard.local) return { name: guard.name, path: file };
    if (guard.module === undefined) return { name: guard.name };
    const resolution = await resolver.resolve(file, guard.module);
    if ("external" in resolution) return { name: guard.name, external: true };
    if (!("file" in resolution)) return { name: guard.name };
    /* Placed only at the file that declares what the import takes: a barrel that re-exports it is not where it lives. */
    const declaration = await declarationOf(resolution.file, guard.name);
    return declaration === undefined ? { name: guard.name } : { name: declaration.name, path: declaration.file };
  };
  /* A name of a file's top level, in this file or through the file it is imported from. */
  const nameDeclaration = async (file: string, raw: RawRouteFile, ref: { name?: string; module?: string }): Promise<{ file: string; raw: RawRouteFile; name: string } | undefined> => {
    if (ref.name === undefined) return undefined;
    if (ref.module === undefined) return { file, raw, name: ref.name };
    const target = await fileOf(file, ref.module);
    const declaration = target === undefined ? undefined : await declarationOf(target, ref.name);
    const declaring = declaration === undefined ? undefined : await parse(declaration.file);
    return declaration === undefined || declaring === undefined ? undefined : { file: declaration.file, raw: declaring, name: declaration.name };
  };
  /* The guards a list stands for, with the span of the list among those given when one of them cannot be read. */
  const guardsOf = async (file: string, raw: RawRouteFile, items: readonly RawGuard[], outer?: UnresolvedReference, trail: ReadonlySet<string> = new Set()): Promise<{ guards: RouteGuard[]; problem?: UnresolvedReference }> => {
    const guards: RouteGuard[] = [];
    let problem: UnresolvedReference | undefined;
    for (const item of items) {
      const at = outer ?? { path: file, line: item.at.line, endLine: item.at.endLine };
      if ("unreadable" in item) problem ??= at;
      else if ("inline" in item) guards.push({ name: "(inline)" });
      else if ("list" in item) {
        const named = await nameDeclaration(file, raw, item.list);
        const list = named?.raw.guardLists.get(named.name);
        const key = named === undefined ? "" : `${named.file}\0${named.name}`;
        if (named === undefined || list === undefined || trail.has(key)) problem ??= at;
        else {
          const inner = await guardsOf(named.file, named.raw, list, at, new Set(trail).add(key));
          guards.push(...inner.guards);
          problem ??= inner.problem;
        }
      } else guards.push(await guardOf(file, item));
    }
    return { guards, ...(problem !== undefined ? { problem } : {}) };
  };
  const tableOf = (raw: RawRouteFile, name: string | undefined): RawTable | undefined =>
    name !== undefined && name !== "default" ? raw.tables.find((t) => t.name === name) : raw.tables.find((t) => t.exported) ?? raw.tables[0];
  const nodes = new Map<RawTable, RouteTable>();
  const loads = new Map<RouteTable, Set<RouteTable>>();
  const unresolvedReferences = new Map<string, UnresolvedReference>();
  const unresolvedModuleImports = new Map<string, UnresolvedReference>();
  const noteUnresolved = (file: string, at: { line: number; endLine: number }): void => {
    unresolvedReferences.set(`${file}:${at.line}:${at.endLine}`, { path: file, line: at.line, endLine: at.endLine });
  };
  /* A table is registered before its entries are built, so a table that loads itself finds its own node. */
  const tableNode = async (table: RawTable, file: string, raw: RawRouteFile): Promise<RouteTable> => {
    const held = nodes.get(table);
    if (held !== undefined) return held;
    const node: RouteTable = { entries: [], conditional: table.conditional === true };
    nodes.set(table, node);
    node.entries = await build(node, file, raw, table.entries);
    return node;
  };
  /* The name a module-graph reference comes down to, in the file that declares it; a declaration of this file shadows an import of the same name. */
  const moduleNameOf = async (file: string, raw: RawRouteFile, reference: RawReference): Promise<{ file: string; name: string } | "external" | "unresolved" | undefined> => {
    if (reference.member === undefined && raw.declared.has(reference.name)) return { file, name: reference.name };
    const binding = raw.imports.get(reference.name);
    if (binding === undefined || binding.typeOnly === true) return undefined;
    const resolution = await resolver.resolve(file, binding.module);
    if ("external" in resolution) return "external";
    if (!("file" in resolution)) return "unresolved";
    const name = reference.member ?? (binding.imported === "*" ? undefined : binding.imported);
    return name === undefined ? undefined : declarationOf(resolution.file, name);
  };
  /* What one operand of an `imports` list names; an external package, the router's own `RouterModule` and a class that composes no table are nothing to follow. */
  const operandTarget = async (file: string, raw: RawRouteFile, operand: RawOperand): Promise<OperandTarget> => {
    if ("unreadable" in operand) return { kind: "unreadable", line: operand.line };
    const reference = operand.reference;
    const binding = raw.imports.get(reference.name);
    const routerModule = binding?.module === ANGULAR_ROUTER && (binding.imported === "RouterModule" || (binding.imported === "*" && reference.member === "RouterModule"));
    if (routerModule) return { kind: "skip" };
    const named = await moduleNameOf(file, raw, reference);
    if (named === undefined || named === "external") return { kind: "skip" };
    if (named === "unresolved") return { kind: "unresolved", line: operand.line };
    const held = await readOf(named.file);
    if (held === undefined) return { kind: "unresolved", line: operand.line };
    if (held.modules.arrays.has(named.name)) return { kind: "array", file: named.file, name: named.name };
    return held.modules.modules.some((module) => module.name === named.name) ? { kind: "module", file: named.file, name: named.name } : { kind: "skip" };
  };
  /* One aggregate per module graph, memoized by class: its own `forChild` tables then its `imports`, depth first, each class and each array once. */
  const aggregates = new Map<string, RouteTable | undefined>();
  const aggregating = new Set<string>();
  const aggregateOf = async (file: string, className: string): Promise<RouteTable | undefined> => {
    const key = `${file}\0${className}`;
    if (aggregating.has(key)) return undefined;
    if (aggregates.has(key)) return aggregates.get(key);
    aggregating.add(key);
    const table = await buildAggregate(file, className);
    aggregating.delete(key);
    aggregates.set(key, table);
    return table;
  };
  const buildAggregate = async (file: string, className: string): Promise<RouteTable | undefined> => {
    const readAt = await readOf(file);
    if (readAt === undefined || !readAt.modules.modules.some((one) => one.name === className)) return undefined;
    const entries: RouteEntry[] = [];
    const held: RouteTable[] = [];
    const visitedClasses = new Set<string>();
    const visitedArrays = new Set<string>();
    let readable = true;
    let conditional = false;
    const unclear = (path: string, line: number): void => {
      readable = false;
      unresolvedModuleImports.set(`${path}:${line}`, { path, line, endLine: line });
    };
    const follow = async (at: string, raw: RawRouteFile, operand: RawOperand): Promise<void> => {
      const target = await operandTarget(at, raw, operand);
      if (target.kind === "unreadable" || target.kind === "unresolved") {
        unclear(at, target.line);
        return;
      }
      if (target.kind === "array") await expand(target.file, target.name);
      else if (target.kind === "module") await visit(target.file, target.name);
    };
    const expand = async (at: string, name: string): Promise<void> => {
      const key = `${at}\0${name}`;
      if (visitedArrays.has(key)) return;
      visitedArrays.add(key);
      const readingAt = await readOf(at);
      const operands = readingAt?.modules.arrays.get(name);
      if (readingAt === undefined || operands === undefined) return;
      for (const operand of operands) await follow(at, readingAt.routes, operand);
    };
    const visit = async (at: string, name: string): Promise<void> => {
      const key = `${at}\0${name}`;
      if (visitedClasses.has(key)) return;
      visitedClasses.add(key);
      const readingAt = await readOf(at);
      if (readingAt === undefined) return;
      for (const config of readingAt.routes.routerConfigs.filter((one) => one.kind === "child" && one.owner === name)) {
        const resolution = config.table !== undefined ? { table: await tableNode(config.table, at, readingAt.routes) } : config.ref === undefined ? undefined : await childTableOf(at, readingAt.routes, config.ref);
        if (resolution === undefined || !("table" in resolution)) continue;
        entries.push(...resolution.table.entries);
        held.push(resolution.table);
        conditional ||= resolution.table.conditional;
      }
      const module = readingAt.modules.modules.find((one) => one.name === name);
      for (const operand of module?.imports ?? []) await follow(at, readingAt.routes, operand);
    };
    await visit(file, className);
    if (!readable) return undefined;
    const node: RouteTable = { entries, conditional };
    loads.set(node, new Set(held));
    return node;
  };
  /* The aggregate a module class answers; an empty one is a reading gap, never "no routes beneath". */
  const aggregateResolution = async (file: string, className: string): Promise<ChildResolution> => {
    const aggregate = await aggregateOf(file, className);
    if (aggregate === undefined) return { reason: "unresolved" };
    return aggregate.entries.length === 0 ? { reason: "no-extractor" } : { table: aggregate };
  };
  /* The table a reference comes down to: a table by name, the routes of a module class, or the aggregate of its graph. */
  const childTableOf = async (file: string, raw: RawRouteFile, ref: RawChildRef): Promise<ChildResolution> => {
    if (ref.unresolved) return { reason: ref.reason ?? "unresolved" };
    if (ref.module === undefined) {
      const table = tableOf(raw, ref.name);
      if (table !== undefined) return { table: await tableNode(table, file, raw) };
      return ref.name === undefined ? { reason: "unresolved" } : aggregateResolution(file, ref.name);
    }
    const targets = ref.legacy === true
      ? await Promise.all((await legacyRoots(file, read)).map((root) => fileOf(`${root}/__legacy__.ts`, `./${ref.module}`)))
      : [await fileOf(file, ref.module)];
    const unique = [...new Set(targets.filter((target): target is string => target !== undefined))];
    const target = unique.length === 1 ? unique[0] : undefined;
    if (target === undefined) return { reason: "unresolved" };
    const named = ref.name !== undefined && ref.name !== "default";
    const declaration = named ? await declarationOf(target, ref.name!) : await declarationOf(target, "default");
    const at = declaration?.file ?? target;
    const declaring = await parse(at);
    if (declaring === undefined) return { reason: "unresolved" };
    const table = named ? (declaration === undefined ? undefined : tableOf(declaring, declaration.name)) : tableOf(declaring, undefined);
    if (table !== undefined) return { table: await tableNode(table, at, declaring) };
    return declaration === undefined ? { reason: "unresolved" } : aggregateResolution(declaration.file, declaration.name);
  };
  /* The aggregate a `bootstrapModule(...)` call boots: the module graph the root injector seeds. */
  const bootstrapModuleOf = async (file: string, boot: RawBootstrap): Promise<RouteTable | undefined> => {
    if (boot.module === undefined) return aggregateOf(file, boot.className);
    const target = await fileOf(file, boot.module);
    const declaration = target === undefined ? undefined : await declarationOf(target, boot.imported ?? boot.className);
    return declaration === undefined ? undefined : aggregateOf(declaration.file, declaration.name);
  };
  const unreadableEntry = (file: string, entry: RawEntry, reason: UnknownReason): RouteEntry => ({
    file,
    line: entry.line,
    endLine: entry.endLine,
    matcher: false,
    redirect: false,
    outletUnresolved: false,
    guards: [],
    childGuards: [],
    children: [],
    spread: false,
    unreadable: reason,
  });
  const build = async (owner: RouteTable, file: string, raw: RawRouteFile, entries: readonly RawEntry[]): Promise<RouteEntry[]> => {
    const out: RouteEntry[] = [];
    for (const entry of entries) {
      if (entry.unreadable !== undefined) {
        out.push(unreadableEntry(file, entry, entry.unreadable));
        noteUnresolved(file, entry);
        continue;
      }
      if (entry.element !== undefined) {
        const named = await nameDeclaration(file, raw, entry.element);
        const constant = named?.raw.entryConstants.get(named.name);
        if (named === undefined || constant === undefined) {
          out.push(unreadableEntry(file, entry, "unresolved"));
          noteUnresolved(file, entry);
        } else out.push(...(await build(owner, named.file, named.raw, [constant])));
        continue;
      }
      const path = entry.path === undefined ? undefined : await textOf(file, raw, entry.path);
      const outlet = entry.outlet === undefined ? undefined : await textOf(file, raw, entry.outlet);
      const own = await guardsOf(file, raw, entry.guards);
      const beneath = await guardsOf(file, raw, entry.childGuards);
      const built: RouteEntry = {
        file,
        line: entry.line,
        endLine: entry.endLine,
        ...(path !== undefined ? { path } : {}),
        matcher: entry.matcher,
        redirect: entry.redirect,
        ...(outlet !== undefined ? { outlet } : {}),
        outletUnresolved: entry.outlet !== undefined && outlet === undefined,
        ...(entry.component !== undefined ? { component: await componentOf(file, raw, entry.component) } : {}),
        guards: own.guards,
        childGuards: beneath.guards,
        ...(own.problem !== undefined ? { guardsProblem: own.problem } : {}),
        ...(beneath.problem !== undefined ? { childGuardsProblem: beneath.problem } : {}),
        children: entry.children === undefined ? [] : await build(owner, file, raw, entry.children),
        spread: entry.spread === true,
      };
      if (entry.childRef !== undefined) {
        const child = await childTableOf(file, raw, entry.childRef);
        if ("table" in child) {
          built.loaded = child.table;
          loads.set(owner, (loads.get(owner) ?? new Set()).add(child.table));
        } else {
          built.unresolvedLoad = child.reason;
          noteUnresolved(file, entry);
        }
      }
      out.push(built);
    }
    return out;
  };
  const built: RouteTable[] = [];
  const unparsed: string[] = [];
  const files = new Map<string, RawRouteFile>();
  for (const file of [...candidates].sort()) {
    const raw = await parse(file);
    if (raw === undefined) {
      unparsed.push(file);
      continue;
    }
    files.set(file, raw);
    for (const table of raw.tables) built.push(await tableNode(table, file, raw));
  }
  const declaredRoots: RouteTable[] = [];
  const heldRoots = new Set<RouteTable>();
  const seed = (table: RouteTable): void => {
    if (heldRoots.has(table)) return;
    heldRoots.add(table);
    declaredRoots.push(table);
  };
  const unresolvedConfigurations: LoadedRouteTables["unresolvedConfigurations"] = [];
  let declared = false;
  for (const [file, raw] of files) {
    for (const config of raw.routerConfigs.filter((c) => c.kind === "root")) {
      declared = true;
      const resolution = config.table !== undefined ? { table: await tableNode(config.table, file, raw) } : config.ref === undefined ? undefined : await childTableOf(file, raw, config.ref);
      if (resolution === undefined || !("table" in resolution)) {
        noteUnresolved(file, config);
        unresolvedConfigurations.push({ path: file, line: config.line, endLine: config.endLine, reason: config.ref?.reason ?? "unresolved" });
      } else seed(resolution.table);
    }
    for (const boot of raw.bootstraps) {
      const root = await bootstrapModuleOf(file, boot);
      if (root === undefined) continue;
      declared = true;
      seed(root);
    }
  }
  const roots = declared ? declaredRoots : [];
  const reached = new Set<RouteTable>();
  const reach = (table: RouteTable): void => {
    if (reached.has(table)) return;
    reached.add(table);
    for (const child of loads.get(table) ?? []) reach(child);
  };
  for (const root of roots) reach(root);
  return {
    roots,
    declared,
    unreached: declared ? built.filter((table) => !reached.has(table)) : built,
    unparsed,
    unresolvedReferences: [...unresolvedReferences.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)),
    unresolvedConfigurations,
    unresolvedModuleImports: [...unresolvedModuleImports.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)),
  };
}
