import ts from "typescript";
import { isPackageManifest, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { readAngularRouteFile, type RawImport } from "./angular-router.extractor.ts";
import { createDeclarationLookup, type Declaration, type DeclarationLookup } from "./declaration-lookup.ts";
import { lineOf } from "./http-call-sites.adapter.ts";
import { createModuleResolver, manifestDependencies } from "./module-resolver.ts";
import { namedFunction, type NamedFunction } from "./consumer-flow.syntax.ts";
import { sourceTree } from "./source-tree.ts";

export interface Unit {
  file: string;
  tree: ts.SourceFile;
  imports: ReadonlyMap<string, RawImport>;
  classes: ReadonlyMap<string, ts.ClassDeclaration>;
  functions: ReadonlyMap<string, NamedFunction>;
}

export type Origin = Declaration | "external" | undefined;

export interface FlowIndex {
  units: ReadonlyMap<string, Unit>;
  origin(file: string, local: string): Origin;
}

export interface ResolverRegistration {
  key: string;
  at: Evidence;
  component?: Declaration;
}

export interface RouteIndex {
  inputBinding: boolean;
  resolvers: ReadonlyMap<string, readonly ResolverRegistration[]>;
}

export interface Program {
  index: FlowIndex;
  routes: RouteIndex;
}

export const resolverKey = (file: string, symbol: string, line: number): string => `${file}\0${symbol}\0${line}`;

export async function buildProgram(files: readonly SourceFile[]): Promise<Program> {
  const texts = new Map(files.map((file) => [file.path, file.content]));
  const dependencies = new Set(files.filter((file) => isPackageManifest(file.path)).flatMap((file) => [...manifestDependencies(file.content)]));
  const modules = createModuleResolver(async (file) => texts.get(file), dependencies);
  const units = new Map<string, Unit>();
  const shapes = new Map<string, NonNullable<ReturnType<typeof readAngularRouteFile>>>();
  for (const file of files.filter((candidate) => isTypeScriptSource(candidate.path))) {
    const tree = sourceTree(file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const shape = readAngularRouteFile(tree);
    if (shape === undefined) continue;
    shapes.set(file.path, shape);
    units.set(file.path, describe(file.path, tree, shape.imports));
  }
  const fileOf = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolved = await modules.resolve(from, specifier);
    return "file" in resolved ? resolved.file : undefined;
  };
  const declarationOf = createDeclarationLookup(async (file) => shapes.get(file), fileOf);

  const origins = new Map<string, Origin>();
  for (const unit of units.values()) {
    for (const [local, imported] of unit.imports) {
      if (imported.imported === "*") continue;
      const resolved = await modules.resolve(unit.file, imported.module);
      if ("external" in resolved) origins.set(`${unit.file}\0${local}`, "external");
      else if ("file" in resolved) origins.set(`${unit.file}\0${local}`, await declarationOf(resolved.file, imported.imported));
    }
  }
  const index: FlowIndex = { units, origin: (file, local) => origins.get(`${file}\0${local}`) };
  return { index, routes: await routeIndex(index, fileOf, declarationOf) };
}

function describe(file: string, tree: ts.SourceFile, imports: ReadonlyMap<string, RawImport>): Unit {
  const classes = new Map<string, ts.ClassDeclaration>();
  const functions = new Map<string, NamedFunction>();
  for (const statement of tree.statements) {
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) classes.set(statement.name.text, statement);
    if (ts.isFunctionDeclaration(statement)) {
      const named = namedFunction(statement);
      if (named !== undefined) functions.set(named.name, named);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const named = initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? namedFunction(initializer) : undefined;
      if (named !== undefined) functions.set(named.name, named);
    }
  }
  return { file, tree, imports, classes, functions };
}

async function routeIndex(index: FlowIndex, fileOf: (from: string, specifier: string) => Promise<string | undefined>, declarationOf: DeclarationLookup): Promise<RouteIndex> {
  const resolvers = new Map<string, ResolverRegistration[]>();
  let inputBinding = false;
  for (const unit of index.units.values()) {
    const routes: ts.ObjectLiteralExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && unit.imports.get(node.expression.text)?.imported === "withComponentInputBinding") inputBinding = true;
      if (ts.isPropertyAssignment(node) && node.name.getText(unit.tree) === "bindToComponentInputs" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) inputBinding = true;
      if (ts.isObjectLiteralExpression(node) && propertyInitializer(node, "resolve") !== undefined) routes.push(node);
      node.forEachChild(visit);
    };
    visit(unit.tree);
    for (const route of routes) {
      const table = propertyInitializer(route, "resolve");
      if (table === undefined || !ts.isObjectLiteralExpression(table)) continue;
      const component = await componentOf(index, unit, route, fileOf, declarationOf);
      for (const property of table.properties) {
        const key = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? property.name.getText(unit.tree).replace(/^['"]|['"]$/g, "") : undefined;
        const reference = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
        if (key === undefined || reference === undefined || !ts.isIdentifier(reference)) continue;
        const target = resolverTarget(index, unit, reference.text);
        if (target === undefined) continue;
        const held = resolvers.get(target) ?? [];
        held.push({ key, at: { path: unit.file, line: lineOf(unit.tree, property) }, ...(component === undefined ? {} : { component }) });
        resolvers.set(target, held);
      }
    }
  }
  return { inputBinding, resolvers };
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) return property.initializer;
  return undefined;
}

/** The function a name resolves to: a function or a class with a `resolve` method, here or through an import. */
function resolverTarget(index: FlowIndex, unit: Unit, name: string): string | undefined {
  const origin = unit.imports.has(name) ? index.origin(unit.file, name) : { file: unit.file, name };
  if (origin === undefined || origin === "external") return undefined;
  const owner = index.units.get(origin.file);
  const named = owner?.functions.get(origin.name);
  if (named !== undefined) return resolverKey(origin.file, named.name, lineOf(owner!.tree, named.declaration));
  const method = owner?.classes.get(origin.name)?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "resolve");
  return method === undefined ? undefined : resolverKey(origin.file, "resolve", lineOf(owner!.tree, method));
}

async function componentOf(index: FlowIndex, unit: Unit, route: ts.ObjectLiteralExpression, fileOf: (from: string, specifier: string) => Promise<string | undefined>, declarationOf: DeclarationLookup): Promise<Declaration | undefined> {
  const direct = propertyInitializer(route, "component");
  if (direct !== undefined && ts.isIdentifier(direct)) {
    const origin = unit.imports.has(direct.text) ? index.origin(unit.file, direct.text) : { file: unit.file, name: direct.text };
    return origin === undefined || origin === "external" ? undefined : origin;
  }
  const lazy = propertyInitializer(route, "loadComponent");
  if (lazy === undefined || !ts.isArrowFunction(lazy)) return undefined;
  let specifier: string | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) specifier = first.text;
    }
    node.forEachChild(find);
  };
  find(lazy.body);
  if (specifier === undefined) return undefined;
  const file = await fileOf(unit.file, specifier);
  return file === undefined ? undefined : declarationOf(file, exportTaken(lazy.body));
}

/** The export a lazy `import(...).then(m => m.X)` takes, the default when it names none. */
function exportTaken(body: ts.ConciseBody): string {
  if (!ts.isCallExpression(body) || !ts.isPropertyAccessExpression(body.expression) || body.expression.name.text !== "then") return "default";
  const [callback] = body.arguments;
  if (callback === undefined || !ts.isArrowFunction(callback)) return "default";
  const result = callback.body;
  if (ts.isPropertyAccessExpression(result)) return result.name.text;
  if (ts.isIdentifier(result)) {
    const [parameter] = callback.parameters;
    if (parameter !== undefined && ts.isObjectBindingPattern(parameter.name)) {
      const element = parameter.name.elements.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === result.text);
      if (element !== undefined) return element.propertyName !== undefined && ts.isIdentifier(element.propertyName) ? element.propertyName.text : result.text;
    }
  }
  return "default";
}
