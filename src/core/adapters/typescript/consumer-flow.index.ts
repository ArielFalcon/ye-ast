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
  /** Whether the router that registers the route binds route data to component inputs. */
  inputBinding: boolean;
}

export interface RouteIndex {
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

interface RouterCall {
  unit: Unit;
  call: ts.CallExpression;
  kind: "provide" | "for-root";
}

type FileOf = (from: string, specifier: string) => Promise<string | undefined>;

async function routeIndex(index: FlowIndex, fileOf: FileOf, declarationOf: DeclarationLookup): Promise<RouteIndex> {
  const resolvers = new Map<string, ResolverRegistration[]>();
  const routers: RouterCall[] = [];
  const found: { unit: Unit; route: ts.ObjectLiteralExpression }[] = [];
  for (const unit of index.units.values()) {
    const visit = (node: ts.Node): void => {
      const router = ts.isCallExpression(node) ? routerCall(unit, node) : undefined;
      if (router !== undefined) routers.push(router);
      if (ts.isObjectLiteralExpression(node) && propertyInitializer(node, "resolve") !== undefined) found.push({ unit, route: node });
      node.forEachChild(visit);
    };
    visit(unit.tree);
  }
  let inputBinding = routers.length > 0;
  for (const router of routers) inputBinding &&= await bindsInputs(index, fileOf, router);
  for (const { unit, route } of found) {
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
      held.push({ key, inputBinding, at: { path: unit.file, line: lineOf(unit.tree, property) }, ...(component === undefined ? {} : { component }) });
      resolvers.set(target, held);
    }
  }
  return { resolvers };
}

/** A root router of the application: `provideRouter(...)` or `RouterModule.forRoot(...)`; component input binding is a setting of the whole router. */
function routerCall(unit: Unit, call: ts.CallExpression): RouterCall | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && unit.imports.get(callee.text)?.imported === "provideRouter") return { unit, call, kind: "provide" };
  const forRoot = ts.isPropertyAccessExpression(callee) && callee.name.text === "forRoot" && ts.isIdentifier(callee.expression) && unit.imports.get(callee.expression.text)?.imported === "RouterModule";
  return forRoot ? { unit, call, kind: "for-root" } : undefined;
}

/** Whether a root router turns component input binding on: a feature argument, an array of features spread into it, or forRoot's option. */
async function bindsInputs(index: FlowIndex, fileOf: FileOf, { unit, call, kind }: RouterCall): Promise<boolean> {
  if (kind === "for-root") {
    const options = call.arguments[1];
    return options !== undefined && ts.isObjectLiteralExpression(options) && propertyInitializer(options, "bindToComponentInputs")?.kind === ts.SyntaxKind.TrueKeyword;
  }
  for (const argument of call.arguments.slice(1)) {
    if (isInputBindingFeature(unit, argument)) return true;
    if (!ts.isSpreadElement(argument) || !ts.isIdentifier(argument.expression)) continue;
    const declared = await initializerOf(index, fileOf, unit, argument.expression.text);
    if (declared !== undefined && ts.isArrayLiteralExpression(declared.initializer) && declared.initializer.elements.some((element) => isInputBindingFeature(declared.unit, element))) return true;
  }
  return false;
}

function isInputBindingFeature(unit: Unit, node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && unit.imports.get(node.expression.text)?.imported === "withComponentInputBinding";
}

async function initializerOf(index: FlowIndex, fileOf: FileOf, unit: Unit, name: string): Promise<{ unit: Unit; initializer: ts.Expression } | undefined> {
  const imported = unit.imports.get(name);
  const file = imported === undefined ? unit.file : await fileOf(unit.file, imported.module);
  const owner = file === undefined ? undefined : index.units.get(file);
  const exported = imported?.imported ?? name;
  if (owner === undefined) return undefined;
  for (const statement of owner.tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === exported && declaration.initializer !== undefined) return { unit: owner, initializer: declaration.initializer };
    }
  }
  return undefined;
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

async function componentOf(index: FlowIndex, unit: Unit, route: ts.ObjectLiteralExpression, fileOf: FileOf, declarationOf: DeclarationLookup): Promise<Declaration | undefined> {
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
