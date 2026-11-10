import ts from "typescript";
import { moduleShape, type ModuleShape, type RawSpan } from "./module-shape.ts";
import { sourceTree } from "./source-tree.ts";
import { hasModifier, propertyOf, unwrapped } from "./syntax.ts";
import type { ImportedName, RouterVocabulary } from "../../ports/router-vocabulary.port.ts";

/** A value the loader resolves: a literal, or a reference to a constant (`RoutePath.Home`, or a plain identifier), with the module it is imported from when it is. */
export type RawValue = { literal: string } | { ref: string; member?: string; module?: string; imported?: string } | { template: RawValue[] } | { opaque: true };

/**
 * A guard as written, with the list it was written in: a name (a call's callee for a guard factory) with the module it is
 * imported from, an inline function, a named list of guards (a whole list or a spread), or an expression that is none.
 */
export type RawGuard = ({ name: string; module?: string; local: boolean } | { inline: true } | { list: RawChildRef } | { unreadable: true }) & { at: RawSpan };

/** The component an entry shows: a class by name, a lazily loaded module (and the export it takes, the default when none), or an expression that names neither. */
export type RawComponent = { ref: string; module?: string; imported?: string } | { lazy: { module: string; name?: string } } | { opaque: true };

/**
 * A table an entry's children come from, or a spread, or a router configuration, that is not inline: a lazily loaded module
 * (and the export it takes), or a named array or a call without arguments of a helper, of this file or of an imported module
 * (then `name` is the export it takes there, not a local alias). `unresolved` with the reason `no-extractor` is a call with
 * arguments, which this extractor does not evaluate.
 */
export interface RawChildRef {
  module?: string;
  name?: string;
  unresolved?: true;
  reason?: "no-extractor";
  legacy?: true;
}

export interface RawEntry {
  line: number;
  endLine: number;
  path?: RawValue;
  outlet?: RawValue;
  matcher: boolean;
  redirect: boolean;
  component?: RawComponent;
  /** `canMatch`, `canActivate` and `canLoad`: they guard the entry and what is beneath it. */
  guards: RawGuard[];
  /** `canActivateChild`: it guards what is beneath the entry, never the entry. */
  childGuards: RawGuard[];
  children?: RawEntry[];
  childRef?: RawChildRef;
  /** The element is a spread: `childRef` names the table whose entries it puts here, and nothing else of the entry is set. */
  spread?: true;
  /** The element is a name: it stands for the route object constant of that name. */
  element?: RawChildRef;
  /** The element cannot be read as one route: a conditional, a call, an object with spread properties. */
  unreadable?: "no-extractor";
}

export interface RawTable {
  name: string;
  exported: boolean;
  entries: RawEntry[];
  /** The array sits in a branch of a conditional expression, so the sources do not say it is served. */
  conditional?: true;
}

/** A `provideRouter`, `RouterModule.forRoot` or `RouterModule.forChild` call, with the routes it receives. */
export interface RawRouterConfig {
  kind: "root" | "child";
  line: number;
  endLine: number;
  /** The class whose decorator `imports` operand holds the call: the only place Angular registers the configuration. */
  owner?: string;
  /** The array literal passed inline. */
  table?: RawTable;
  ref?: RawChildRef;
}

/** A class a `bootstrapModule(...)` call boots: the identifier it names, and the import it comes from when it is one. */
export interface RawBootstrap {
  className: string;
  module?: string;
  imported?: string;
  line: number;
  endLine: number;
}

export interface RawRouteFile extends ModuleShape {
  /** The route arrays not nested as another entry's children, by the variable that holds them (`""` for an anonymous one), in source order. */
  tables: RawTable[];
  routerConfigs: RawRouterConfig[];
  /** The classes the file boots, in source order; empty when it boots none. */
  bootstraps: RawBootstrap[];
  /** The route object constants this file declares at its top level, by name. */
  entryConstants: Map<string, RawEntry>;
  /** The arrays of guards this file declares at its top level, by name. */
  guardLists: Map<string, RawGuard[]>;
  /** Values this file declares: `X` for `const X = 'v'`, `X.k` for an object literal's member or an enum's string member. */
  constants: Map<string, RawValue>;
}

/** The keys of the router's Route configuration beside `path`: an object with a path and one of these is a route. */
const ROUTE_KEYS: ReadonlySet<string> = new Set([
  "component", "loadComponent", "loadChildren", "children", "redirectTo", "pathMatch", "canMatch", "canActivate",
  "canActivateChild", "canDeactivate", "canLoad", "resolve", "data", "title", "outlet", "providers", "runGuardsAndResolvers",
]);
/** The keys whose guards decide whether a route is entered at all. */
const GUARD_KEYS: readonly string[] = ["canMatch", "canActivate", "canLoad"];
/** The key whose guards apply beneath an entry only. */
const CHILD_GUARD_KEY = "canActivateChild";

const propName = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | undefined =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name !== undefined ? p.name.getText(sf).replace(/^['"]|['"]$/g, "") : undefined;

function isRouteObject(node: ts.Expression, sf: ts.SourceFile): node is ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const names = node.properties.map((p) => propName(p, sf));
  return (names.includes("path") || names.includes("matcher")) && names.some((n) => n !== undefined && ROUTE_KEYS.has(n));
}

function isRouteArray(node: ts.Node, sf: ts.SourceFile): node is ts.ArrayLiteralExpression {
  return ts.isArrayLiteralExpression(node) && node.elements.some((e) => isRouteObject(unwrapped(e as ts.Expression), sf));
}

function hasSpreadProperty(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((p) => ts.isSpreadAssignment(p));
}

/** Whether a type annotation names the router's `Route` or `Routes`. */
function isRouteType(type: ts.TypeNode, sf: ts.SourceFile): boolean {
  return /\bRoutes?\b/.test(type.getText(sf));
}

/** Whether the node is a branch of a conditional expression, through parentheses and assertions. */
function isConditionalBranch(node: ts.Node): boolean {
  let current = node;
  while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent))) current = current.parent;
  return current.parent !== undefined && ts.isConditionalExpression(current.parent) && current.parent.condition !== current;
}

/** The route arrays of one TypeScript file, or undefined when the file does not parse. Nothing is resolved across files. */
export function parseAngularRouteFile(file: string, source: string, router?: RouterVocabulary): RawRouteFile | undefined {
  return readAngularRouteFile(sourceTree({ path: file, content: source }, ts.ScriptTarget.Latest, ts.ScriptKind.TS), router);
}

/**
 * The route arrays of a parsed TypeScript file, or undefined when it has syntax errors. Its router configurations are
 * the calls `router` recognises; a reading without it holds none.
 */
export function readAngularRouteFile(sf: ts.SourceFile, router?: RouterVocabulary): RawRouteFile | undefined {
  const module = moduleShape(sf);
  if (module === undefined) return undefined;
  const { imports, declared } = module;
  const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const constants = new Map<string, RawValue>();
  const constantInits: Array<[string, ts.Expression]> = [];
  const routeObjectInits = new Map<string, ts.ObjectLiteralExpression>();
  const guardListInits = new Map<string, ts.ArrayLiteralExpression>();
  /** The initializer of each top-level `const` of this file, by name. */
  const initializers = new Map<string, ts.Expression>();
  const stringOf = (e: ts.Expression): string | undefined => {
    const b = unwrapped(e);
    return ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b) ? b.text : undefined;
  };
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
        const name = decl.name.text;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0) initializers.set(name, decl.initializer);
        constantInits.push([name, decl.initializer]);
        const init = unwrapped(decl.initializer);
        if (ts.isObjectLiteralExpression(init) && isRouteObject(init, sf) && !hasSpreadProperty(init)) routeObjectInits.set(name, init);
        if (ts.isArrayLiteralExpression(init)) guardListInits.set(name, init);
        if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const key = propName(p, sf);
            if (key !== undefined && ts.isPropertyAssignment(p)) constantInits.push([`${name}.${key}`, p.initializer]);
          }
        }
      }
    } else if (ts.isEnumDeclaration(statement)) {
      for (const member of statement.members) {
        const value = member.initializer ? stringOf(member.initializer) : undefined;
        if (value !== undefined) constants.set(`${statement.name.text}.${member.name.getText(sf)}`, { literal: value });
      }
    }
  }
  const valueOf = (e: ts.Expression): RawValue => {
    const literal = stringOf(e);
    if (literal !== undefined) return { literal };
    const b = unwrapped(e);
    if (ts.isTemplateExpression(b)) return { template: [{ literal: b.head.text }, ...b.templateSpans.flatMap((span): RawValue[] => [valueOf(span.expression), { literal: span.literal.text }])] };
    const from = (name: string): { module?: string; imported?: string } => {
      const bound = imports.get(name);
      return bound === undefined ? {} : { module: bound.module, imported: bound.imported };
    };
    if (ts.isIdentifier(b)) return { ref: b.text, ...from(b.text) };
    if (ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.expression)) return { ref: b.expression.text, member: b.name.text, ...from(b.expression.text) };
    return { opaque: true };
  };
  /*
   * The module a lazy load imports and the export its `.then` takes. A load that is a binding of this file (`x`, or
   * `x.loadChildren`, where `x` is a top-level const) is read at the binding's initializer, whatever call builds it.
   * Either way it must hold exactly one dynamic `import()`, and with a static specifier; anything else is unresolved.
   */
  const lazyOf = (init: ts.Expression): { module: string; name?: string; legacy?: true } | undefined => {
    const b = unwrapped(init);
    if (ts.isStringLiteral(b)) {
      const parts = b.text.split("#");
      if (parts.length === 2 && parts[0] && parts[1]) return { module: parts[0], name: parts[1], legacy: true };
    }
    const bound = ts.isIdentifier(b) ? b : ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.expression) ? b.expression : undefined;
    const source = bound === undefined ? init : initializers.get(bound.text);
    if (source === undefined) return undefined;
    const dynamic: ts.CallExpression[] = [];
    let name: string | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic.push(node);
      /* `.then((m) => m.ROUTES)`: the export is the property the arrow's body reads. */
      if (name === undefined && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.parent !== undefined && ts.isArrowFunction(node.parent) && node.parent.body === node) name = node.name.text;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const arg = dynamic.length === 1 ? dynamic[0]!.arguments[0] : undefined;
    const module = arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
    return module === undefined ? undefined : { module, ...(name !== undefined ? { name } : {}) };
  };
  const componentOf = (e: ts.Expression): RawComponent => {
    const b = unwrapped(e);
    if (!ts.isIdentifier(b)) return { opaque: true };
    const bound = imports.get(b.text);
    return { ref: b.text, ...(bound !== undefined ? { module: bound.module, imported: bound.imported } : {}) };
  };
  const nameRef = (id: ts.Identifier): RawChildRef => {
    const bound = imports.get(id.text);
    return bound === undefined ? { name: id.text } : { name: bound.imported, module: bound.module };
  };
  /* The table an expression names: an array's name, or the helper a call without arguments calls. */
  const refOf = (e: ts.Expression): RawChildRef => {
    const b = unwrapped(e);
    if (ts.isIdentifier(b)) return nameRef(b);
    if (!ts.isCallExpression(b)) return { unresolved: true };
    const callee = unwrapped(b.expression);
    return b.arguments.length === 0 && ts.isIdentifier(callee) ? nameRef(callee) : { unresolved: true, reason: "no-extractor" };
  };
  const isFunction = (e: ts.Expression): boolean => ts.isArrowFunction(e) || ts.isFunctionExpression(e);
  /* The guards one element of a guard list stands for; `list` is the span of the list it was written in. */
  const guardsOfElement = (e: ts.Expression, at: RawSpan): RawGuard[] => {
    if (ts.isSpreadElement(e)) {
      const target = unwrapped(e.expression);
      if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap((inner) => guardsOfElement(inner as ts.Expression, at));
      return [ts.isIdentifier(target) ? { list: nameRef(target), at } : { unreadable: true, at }];
    }
    const b = unwrapped(e);
    if (isFunction(b)) return [{ inline: true, at }];
    const callee = ts.isCallExpression(b) ? unwrapped(b.expression) : b;
    if (!ts.isIdentifier(callee)) return [{ unreadable: true, at }];
    const bound = imports.get(callee.text);
    /* A name is the export it takes from its module, not the local alias it is bound to. */
    return [{ name: bound?.imported ?? callee.text, local: declared.has(callee.text), ...(bound !== undefined ? { module: bound.module } : {}), at }];
  };
  /* The guards a `canX` value stands for: an array of guards, a named array, or one function. */
  const guardsOfList = (list: ts.Expression): RawGuard[] => {
    const at = { line: line(list.getStart(sf)), endLine: line(list.end) };
    const b = unwrapped(list);
    if (ts.isArrayLiteralExpression(b)) return b.elements.flatMap((element) => guardsOfElement(element as ts.Expression, at));
    if (ts.isIdentifier(b)) return [{ list: nameRef(b), at }];
    return [isFunction(b) ? { inline: true, at } : { unreadable: true, at }];
  };
  const guardLists = new Map<string, RawGuard[]>();
  /* Constants are resolved once the file's imports are all known. */
  for (const [key, expression] of constantInits) {
    const value = valueOf(expression);
    if (!("opaque" in value)) constants.set(key, value);
  }
  const nested = new Set<ts.Node>();
  const spanOf = (node: ts.Node): { line: number; endLine: number } => ({ line: line(node.getStart(sf)), endLine: line(node.end) });
  const blank = (node: ts.Node): RawEntry => ({ ...spanOf(node), matcher: false, redirect: false, guards: [], childGuards: [] });
  const entryOf = (obj: ts.ObjectLiteralExpression): RawEntry => {
    const props = new Map<string, ts.ObjectLiteralElementLike>();
    for (const p of obj.properties) {
      const name = propName(p, sf);
      if (name !== undefined) props.set(name, p);
    }
    /* The value of a property, written `key: value` or as the shorthand `key`. */
    const init = (key: string): ts.Expression | undefined => {
      const p = props.get(key);
      if (p !== undefined && ts.isPropertyAssignment(p)) return p.initializer;
      return p !== undefined && ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
    };
    const pathInit = init("path");
    const outletInit = init("outlet");
    const guardsOfKeys = (keys: readonly string[]): RawGuard[] => keys.flatMap((key) => (init(key) === undefined ? [] : guardsOfList(init(key)!)));
    const entry: RawEntry = {
      ...blank(obj),
      ...(pathInit !== undefined ? { path: valueOf(pathInit) } : {}),
      ...(outletInit !== undefined ? { outlet: valueOf(outletInit) } : {}),
      matcher: props.has("matcher"),
      redirect: props.has("redirectTo"),
      guards: guardsOfKeys(GUARD_KEYS),
      childGuards: guardsOfKeys([CHILD_GUARD_KEY]),
    };
    const component = init("component");
    const lazyComponent = init("loadComponent");
    if (component !== undefined) entry.component = componentOf(component);
    else if (lazyComponent !== undefined) {
      const lazy = lazyOf(lazyComponent);
      entry.component = lazy === undefined ? { opaque: true } : { lazy };
    }
    const children = init("children");
    if (children !== undefined) {
      const b = unwrapped(children);
      if (ts.isArrayLiteralExpression(b)) {
        nested.add(b);
        entry.children = entriesOf(b);
      } else entry.childRef = refOf(b);
    }
    const lazyChildren = init("loadChildren");
    if (lazyChildren !== undefined) {
      const lazy = lazyOf(lazyChildren);
      entry.childRef = lazy === undefined ? { unresolved: true, ...(ts.isCallExpression(unwrapped(lazyChildren)) && (unwrapped(lazyChildren) as ts.CallExpression).arguments.length > 0 ? { reason: "no-extractor" as const } : {}) } : lazy;
    }
    return entry;
  };
  const entriesOf = (array: ts.ArrayLiteralExpression): RawEntry[] => {
    const out: RawEntry[] = [];
    for (const element of array.elements) {
      if (ts.isSpreadElement(element)) {
        const target = unwrapped(element.expression);
        if (ts.isArrayLiteralExpression(target)) {
          nested.add(target);
          out.push(...entriesOf(target));
        } else out.push({ ...blank(element), spread: true, childRef: refOf(target) });
        continue;
      }
      const obj = unwrapped(element as ts.Expression);
      if (ts.isIdentifier(obj)) out.push({ ...blank(element), element: nameRef(obj) });
      else if (!ts.isObjectLiteralExpression(obj)) out.push({ ...blank(element), unreadable: "no-extractor" });
      else if (hasSpreadProperty(obj)) out.push({ ...blank(element), unreadable: "no-extractor" });
      else if (isRouteObject(obj, sf)) out.push(entryOf(obj));
    }
    return out;
  };
  const entryConstants = new Map([...routeObjectInits].map(([name, obj]): [string, RawEntry] => [name, entryOf(obj)]));
  for (const [name, list] of guardListInits) guardLists.set(name, guardsOfList(list));
  const tables: RawTable[] = [];
  const tableOfNode = new Map<ts.Node, RawTable>();
  /* Arrays a type annotation says are routes, whatever their elements. */
  const typed = new Set<ts.Node>();
  const visit = (node: ts.Node, holder: { name: string; exported: boolean }): void => {
    if (ts.isVariableDeclaration(node) && node.type !== undefined && node.initializer !== undefined && isRouteType(node.type, sf)) {
      const initial = unwrapped(node.initializer);
      if (ts.isArrayLiteralExpression(initial)) typed.add(initial);
    }
    if (ts.isArrayLiteralExpression(node) && (isRouteArray(node, sf) || typed.has(node)) && !nested.has(node)) {
      const table: RawTable = { ...holder, entries: entriesOf(node), ...(isConditionalBranch(node) ? { conditional: true as const } : {}) };
      tables.push(table);
      tableOfNode.set(node, table);
      return;
    }
    let next = holder;
    if (ts.isFunctionDeclaration(node) && node.name) next = { name: node.name.text, exported: hasModifier(node, ts.SyntaxKind.ExportKeyword) };
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const statement = node.parent?.parent;
      const exported = statement !== undefined && ts.isVariableStatement(statement) && (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      next = { name: node.name.text, exported };
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, { name: "", exported: false });
  const routerConfigs: RawRouterConfig[] = [];
  const importedNameOf = (expression: ts.Expression): ImportedName => {
    const members: string[] = [];
    let at = expression;
    for (; ts.isPropertyAccessExpression(at); at = at.expression) members.unshift(at.name.text);
    const binding = ts.isIdentifier(at) ? imports.get(at.text) : undefined;
    return { ...(binding !== undefined ? { binding } : {}), members };
  };
  const routerKind = (call: ts.CallExpression): "root" | "child" | undefined => router?.configurationOf(importedNameOf(unwrapped(call.expression)));
  const bootstraps: RawBootstrap[] = [];
  /* `bootstrapModuleFactory(...)` is not matched: its argument is a factory, not a class. */
  const bootstrapOf = (call: ts.CallExpression): RawBootstrap | undefined => {
    const callee = unwrapped(call.expression);
    const arg = call.arguments[0];
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "bootstrapModule" || arg === undefined) return undefined;
    const named = unwrapped(arg);
    if (!ts.isIdentifier(named)) return undefined;
    const bound = imports.get(named.text);
    return {
      className: named.text,
      ...(bound !== undefined ? { module: bound.module, imported: bound.imported } : {}),
      line: line(call.getStart(sf)),
      endLine: line(call.end),
    };
  };
  /* The `imports` operand of each decorator of a class: the one place a `forChild` call of its body is registered. */
  const importsOperandsOf = (declaration: ts.ClassDeclaration): ts.Expression[] =>
    (ts.canHaveDecorators(declaration) ? (ts.getDecorators(declaration) ?? []) : []).flatMap((decorator): ts.Expression[] => {
      const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
      const metadata = argument === undefined ? undefined : unwrapped(argument);
      const imports = metadata !== undefined && ts.isObjectLiteralExpression(metadata) ? propertyOf(metadata, "imports") : undefined;
      return imports === undefined ? [] : [imports];
    });
  /* The class a configuration belongs to: the nearest one whose decorator `imports` operand holds the call, never the class body at large. */
  const configOwnerOf = (node: ts.Node): string | undefined => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (!ts.isClassDeclaration(at) || at.name === undefined) continue;
      return importsOperandsOf(at).some((operand) => operand.getStart(sf) <= node.getStart(sf) && node.end <= operand.end) ? at.name.text : undefined;
    }
    return undefined;
  };
  const findConfigs = (node: ts.Node): void => {
    const kind = ts.isCallExpression(node) ? routerKind(node) : undefined;
    const arg = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (kind !== undefined && arg !== undefined) {
      const b = unwrapped(arg);
      const table = ts.isArrayLiteralExpression(b) ? tableOfNode.get(b) : undefined;
      const target = table !== undefined ? { table } : { ref: ts.isArrayLiteralExpression(b) ? { unresolved: true as const } : refOf(b) };
      const owner = configOwnerOf(node);
      routerConfigs.push({ kind, line: line(node.getStart(sf)), endLine: line(node.end), ...(owner !== undefined ? { owner } : {}), ...target });
    }
    if (ts.isCallExpression(node)) {
      const boot = bootstrapOf(node);
      if (boot !== undefined) bootstraps.push(boot);
    }
    ts.forEachChild(node, findConfigs);
  };
  findConfigs(sf);
  return { ...module, tables, routerConfigs, bootstraps, entryConstants, guardLists, constants };
}
