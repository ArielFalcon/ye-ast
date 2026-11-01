import type { Handler } from "../../domain/entrypoints/http-route.ts";
import type { RouteGuard } from "../../domain/entrypoints/ui-route.ts";
import type { UnknownReason } from "../../domain/shared/fact.ts";
import { parseAngularRouteFile, type RawChildRef, type RawComponent, type RawEntry, type RawGuard, type RawRouteFile, type RawTable, type RawValue } from "./angular-router.extractor.ts";
import { createDeclarationLookup, type Declaration } from "./declaration-lookup.ts";
import { createModuleResolver, type SourceReader } from "./module-resolver.ts";

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
   * The tables the router is configured with (`provideRouter` and `RouterModule.forRoot`) when the sources declare any;
   * otherwise the tables no table loads, then one table of each group that only loads itself or each other.
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
}

type ChildTable = { file: string; raw: RawRouteFile; table: RawTable };

/**
 * Builds the route tables of the parsed files: each file is read and parsed once, a module specifier is resolved with the
 * module resolver, and what a path, an outlet, a component or a guard names is followed through re-exports and renames to
 * the file and the name that declare it (a guard is placed only there, never at a barrel). A child table that is not
 * inline (a lazily loaded module, a named array) is attached under the entry that loads it. A chain that does not come
 * down to exactly one declaration is unresolved. Each table is built once and shared by the entries that load it.
 * Returns the root tables, the candidates that do not parse and the unresolved child references.
 */
export async function loadRouteTables(candidates: readonly string[], read: SourceReader, dependencies: ReadonlySet<string>): Promise<LoadedRouteTables> {
  const resolver = createModuleResolver(read, dependencies);
  const parsed = new Map<string, Promise<RawRouteFile | undefined>>();
  const parse = (file: string): Promise<RawRouteFile | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = read(file).then((source) => (source === undefined ? undefined : parseAngularRouteFile(file, source)));
      parsed.set(file, held);
    }
    return held;
  };
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
    const line = declaring?.classes.has(declaration.name) ? declaring.declared.get(declaration.name) : undefined;
    return line === undefined ? "unknown" : { path: declaration.file, symbol: declaration.name, line };
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
  /* The table of the one router configuration inside the decorator of a class, the routes of that NgModule. */
  const moduleTableOf = async (file: string, raw: RawRouteFile, className: string): Promise<ChildTable | undefined> => {
    const configs = raw.routerConfigs.filter((config) => config.owner === className);
    const config = configs.length === 1 ? configs[0] : undefined;
    if (config === undefined) return undefined;
    return config.table !== undefined ? { file, raw, table: config.table } : config.ref === undefined ? undefined : childTableOf(file, raw, config.ref);
  };
  /* The file and the table a reference comes down to: a table by name, the routes of a module class, or the first table of a module. */
  const childTableOf = async (file: string, raw: RawRouteFile, ref: RawChildRef): Promise<ChildTable | undefined> => {
    if (ref.unresolved) return undefined;
    if (ref.module === undefined) {
      const table = tableOf(raw, ref.name);
      return table !== undefined ? { file, raw, table } : ref.name === undefined ? undefined : moduleTableOf(file, raw, ref.name);
    }
    const target = await fileOf(file, ref.module);
    if (target === undefined) return undefined;
    const named = ref.name !== undefined && ref.name !== "default";
    const declaration = named ? await declarationOf(target, ref.name!) : await declarationOf(target, "default");
    const declaring = await parse(declaration?.file ?? target);
    if (declaring === undefined) return undefined;
    const table = named ? (declaration === undefined ? undefined : tableOf(declaring, declaration.name)) : tableOf(declaring, undefined);
    if (table !== undefined) return { file: declaration?.file ?? target, raw: declaring, table };
    return declaration === undefined ? undefined : moduleTableOf(declaration.file, declaring, declaration.name);
  };
  const nodes = new Map<RawTable, RouteTable>();
  const loads = new Map<RouteTable, Set<RouteTable>>();
  const unresolvedReferences = new Map<string, UnresolvedReference>();
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
        if (child === undefined) {
          built.unresolvedLoad = entry.childRef.reason ?? "unresolved";
          noteUnresolved(file, entry);
        } else {
          built.loaded = await tableNode(child.table, child.file, child.raw);
          loads.set(owner, (loads.get(owner) ?? new Set()).add(built.loaded));
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
  const declaredRoots = new Set<RouteTable>();
  const unresolvedConfigurations: LoadedRouteTables["unresolvedConfigurations"] = [];
  let declared = false;
  for (const [file, raw] of files) {
    for (const config of raw.routerConfigs.filter((c) => c.kind === "root")) {
      declared = true;
      const root = config.table !== undefined ? { file, raw, table: config.table } : config.ref === undefined ? undefined : await childTableOf(file, raw, config.ref);
      if (root !== undefined) declaredRoots.add(await tableNode(root.table, root.file, root.raw));
      else {
        noteUnresolved(file, config);
        unresolvedConfigurations.push({ path: file, line: config.line, endLine: config.endLine, reason: config.ref?.reason ?? "unresolved" });
      }
    }
  }
  const roots = declared ? built.filter((table) => declaredRoots.has(table)) : rootsOf(built, loads);
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
    unreached: declared ? built.filter((table) => !reached.has(table)) : [],
    unparsed,
    unresolvedReferences: [...unresolvedReferences.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)),
    unresolvedConfigurations,
  };
}

/**
 * The tables no table loads, then, for tables that only load each other or themselves, the first of each such group in
 * file order, so that no table is left out because the tables above it loop.
 */
function rootsOf(built: readonly RouteTable[], loads: ReadonlyMap<RouteTable, ReadonlySet<RouteTable>>): RouteTable[] {
  const loaded = new Set([...loads.values()].flatMap((tables) => [...tables]));
  const covered = new Set<RouteTable>();
  const cover = (table: RouteTable): void => {
    if (covered.has(table)) return;
    covered.add(table);
    for (const child of loads.get(table) ?? []) cover(child);
  };
  const roots: RouteTable[] = [];
  for (const candidates of [built.filter((table) => !loaded.has(table)), built]) {
    for (const candidate of candidates) {
      if (covered.has(candidate)) continue;
      roots.push(candidate);
      cover(candidate);
    }
  }
  return roots;
}
