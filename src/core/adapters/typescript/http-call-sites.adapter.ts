import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { isPackageManifest, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { CallSite, HttpTarget, StatedRequest } from "../../domain/topology/call-site.ts";
import type { CallSiteReader } from "../../domain/topology/call-site.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { manifestPackages, createModuleResolver, type ModuleResolver } from "./module-resolver.ts";
import { buildDefines, type BuildDefines } from "./url-define.ts";

export const VERBS: ReadonlySet<string> = new Set(["get", "head", "post", "put", "patch", "delete", "options", "request"]);
const HTTP_CLIENT_PACKAGE = "@angular/common/http";
const PLACEHOLDER = "{}";
const UNDECIDED = Symbol("undecided");
const RUN_TIME_VALUE: Evaluation = { kind: "value" };
/** A class field the code assigns at run time, so no initializer states its value. */
const ASSIGNED_AT_RUN_TIME = Symbol("assigned at run time");
const WRITTEN_FIELDS = new WeakMap<ts.ClassDeclaration, ReadonlySet<string>>();
const VARIABLE_WRITES = new WeakMap<ts.Node, ReadonlyMap<string, readonly ts.Expression[] | null>>();

/** What one file declares at its top level, and the classes it holds, as the reader needs them. */
interface FileShape {
  source: ts.SourceFile;
  bindings: ReadonlySet<string>;
  unsafeEncoder: boolean;
  consts: Map<string, ts.Expression>;
  imports: Map<string, { module: string; imported: string }>;
  /** The names this file re-exports from another module: `export { X } from './m'`. */
  reexports: Map<string, { module: string; imported: string }>;
  /** The modules this file star-exports: `export * from './m'`. */
  stars: string[];
  /** The expression `export default` names, when the file states one. */
  defaultExport?: ts.Expression;
  classes: Map<string, ts.ClassDeclaration>;
}

/** The names the code being evaluated binds at run time, and what the variables its body declares are initialized to. */
interface Scope {
  names: ReadonlySet<string>;
  locals: ReadonlyMap<string, ts.Expression>;
}

const NO_SCOPE: Scope = { names: new Set(), locals: new Map() };
const LEXICAL_SCOPES = new WeakMap<ts.Node, Scope>();

/** The names the code being evaluated binds at run time: a path part that names one is `{}`, never undecided. */
type RunTime = ReadonlySet<string>;

/**
 * What a path part came down to: the text it states, or a value the code being evaluated fills at run time. A `cut` text
 * stopped at the query or the fragment, so it states the URL only up to there.
 */
type Evaluation = { readonly kind: "text"; readonly text: string; readonly cut?: true } | { readonly kind: "value" };

/** A type name as a file writes it: the file's imports decide which class it names. */
interface TypeNamed {
  name: string;
  shape: FileShape;
}

/** A value a name states, the file that declares it, and the names already visited to reach it. */
interface Located<E extends ts.Expression = ts.Expression> {
  shape: FileShape;
  expression: E;
  trail: ReadonlySet<string>;
}

export function createHttpCallSites(): CallSiteReader {
  return { of: async (files, repo) => read(files, repo) };
}

async function read(files: readonly SourceFile[], repo: string): Promise<readonly CallSite[]> {
  /* The module resolver reads the config files of the snapshot too, so the map holds every source it was given. */
  const texts = new Map(files.map((file) => [file.path, file.content]));
  const shapes = new Map(files.filter((file) => isTypeScriptSource(file.path)).map((file) => [file.path, describe(file)]));
  const modules = createModuleResolver(async (file) => texts.get(file), manifestPackages(files.filter((file) => isPackageManifest(file.path)).map((file) => file.content)));
  const wrappers = wrapperMethods(shapes);
  const read = new Reader(shapes, modules, wrappers, buildDefines(files));
  const found: CallSite[] = [];
  for (const shape of shapes.values()) {
    for (const call of calls(shape.source)) found.push(...(await read.callSite(shape, call, repo)));
  }
  return found.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(file: SourceFile): FileShape {
  const source = sourceTree(file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shape: FileShape = { source, bindings: sourceBindings(source), unsafeEncoder: mayOverrideEncoder(source), consts: new Map(), imports: new Map(), reexports: new Map(), stars: [], classes: new Map() };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      collectImports(statement.importClause, module, shape);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      collectExports(statement, shape);
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      shape.defaultExport = statement.expression;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) shape.consts.set(declaration.name.text, declaration.initializer);
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) shape.classes.set(statement.name.text, statement);
  }
  return shape;
}

function collectImports(clause: ts.ImportClause | undefined, module: string, into: FileShape): void {
  if (clause === undefined) return;
  if (clause.name !== undefined) into.imports.set(clause.name.text, { module, imported: "default" });
  if (clause.namedBindings === undefined) return;
  if (ts.isNamespaceImport(clause.namedBindings)) into.imports.set(clause.namedBindings.name.text, { module, imported: "*" });
  else for (const element of clause.namedBindings.elements) into.imports.set(element.name.text, { module, imported: element.propertyName?.text ?? element.name.text });
}

/** The names a file re-exports, by name or through `export *`, so a name reached through a barrel is still decided. */
function collectExports(statement: ts.ExportDeclaration, shape: FileShape): void {
  if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const module = statement.moduleSpecifier.text;
  if (statement.exportClause === undefined) {
    shape.stars.push(module);
    return;
  }
  if (!ts.isNamedExports(statement.exportClause)) return;
  for (const element of statement.exportClause.elements) shape.reexports.set(element.name.text, { module, imported: element.propertyName?.text ?? element.name.text });
}

function calls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/**
 * The methods of each class another class injects that forward a parameter as the path of an `HttpClient` request, with
 * the verb that request uses: a class the repository injects is a wrapper, and a call to one of its methods is where a
 * repository makes a request.
 */
function wrapperMethods(shapes: ReadonlyMap<string, FileShape>): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const injected = injectedClasses(shapes);
  const held = new Map<string, ReadonlyMap<string, string>>();
  for (const shape of shapes.values()) {
    for (const [name, classDeclaration] of shape.classes) {
      if (!injected.has(name)) continue;
      const reaching = reachingMethods(shape, classDeclaration);
      if (reaching.size > 0) held.set(name, reaching);
    }
  }
  return held;
}

/** The classes of the snapshot that some class of it injects, by name. */
function injectedClasses(shapes: ReadonlyMap<string, FileShape>): ReadonlySet<string> {
  const held = new Set<string>();
  for (const shape of shapes.values()) {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(shape.source) === "inject") {
        const [first] = node.arguments;
        if (first !== undefined && ts.isIdentifier(first)) held.add(first.text);
      }
      if (ts.isParameter(node) && node.type !== undefined) {
        const name = typeName(node.type);
        if (name !== undefined) held.add(name);
      }
      ts.forEachChild(node, walk);
    };
    walk(shape.source);
  }
  return held;
}

/** The methods of one class that forward a parameter as the path of a request of the class's HTTP client, with the request's verb. */
function reachingMethods(shape: FileShape, classDeclaration: ts.ClassDeclaration): ReadonlyMap<string, string> {
  const httpFields = httpClientFields(shape, classDeclaration);
  if (httpFields.size === 0) return new Map();
  const methods = new Map<string, ts.Node>();
  for (const member of classDeclaration.members) {
    if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name !== undefined && ts.isIdentifier(member.name)) methods.set(member.name.text, member);
  }
  const reaching = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, member] of methods) {
      if (reaching.has(name)) continue;
      const verb = forwardedVerb(member, httpFields, reaching, methods);
      if (verb !== undefined) {
        reaching.set(name, verb);
        changed = true;
      }
    }
  }
  const kept = new Map([...reaching].filter(([name]) => VERBS.has(name)));
  for (const name of [...kept.keys()]) {
    const member = methods.get(name);
    if (member !== undefined) for (const helper of thisCalls(member)) if (reaching.has(helper)) kept.set(helper, reaching.get(helper) ?? helper);
  }
  return kept;
}

/** The methods of its own class a member calls through `this`. */
function thisCalls(member: ts.Node): string[] {
  const called: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) called.push(node.expression.name.text);
    ts.forEachChild(node, visit);
  };
  visit(member);
  return called;
}

/** The fields and constructor parameters of a class that hold an `HttpClient`, by the name the code uses them with. */
function httpClientFields(shape: FileShape, classDeclaration: ts.ClassDeclaration): Set<string> {
  const held = new Set<string>();
  for (const member of classDeclaration.members) {
    if (!ts.isPropertyDeclaration(member) || member.name === undefined || !ts.isIdentifier(member.name)) continue;
    if (member.initializer !== undefined && injectsAngularHttpClient(shape, member.initializer)) held.add(member.name.text);
    if (member.type !== undefined && isAngularHttpClientName(shape, typeName(member.type))) held.add(member.name.text);
  }
  for (const parameter of constructorParameters(classDeclaration)) {
    if (!ts.isIdentifier(parameter.name) || parameter.type === undefined) continue;
    if (isAngularHttpClientName(shape, typeName(parameter.type))) held.add(parameter.name.text);
  }
  return held;
}

function injectsAngularHttpClient(shape: FileShape, expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || expression.arguments.length === 0) return false;
  const first = expression.arguments[0];
  if (first === undefined || !ts.isIdentifier(first)) return false;
  return expression.expression.getText(shape.source) === "inject" && isAngularHttpClientName(shape, first.text);
}

/** Whether an expression names `httpResource` or one of its variants (`httpResource.text`), imported from Angular. */
function isHttpResource(shape: FileShape, callee: ts.Expression): boolean {
  const named = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return isHttpPackageName(shape, named, "httpResource");
}

function isHttpPackageName(shape: FileShape, expression: ts.Expression, name: string): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const imported = shape.imports.get(expression.text);
  return imported?.module === HTTP_CLIENT_PACKAGE && imported.imported === name;
}

export function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && candidate.name.getText() === name);
  return property?.initializer;
}

/** Whether a name is Angular's `HttpClient`: the name alone is not enough, its import decides. */
function isAngularHttpClientName(shape: FileShape, name: string | undefined): boolean {
  if (name === undefined) return false;
  const imported = shape.imports.get(name);
  return name === "HttpClient" && imported?.module === HTTP_CLIENT_PACKAGE;
}

/** The parameter properties of a class's constructor: the fields a class declares by writing them in its signature. */
export function constructorParameters(classDeclaration: ts.ClassDeclaration): readonly ts.ParameterDeclaration[] {
  return classDeclaration.members.flatMap((member) => (ts.isConstructorDeclaration(member) ? member.parameters : []));
}

export function typeName(node: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text;
  return undefined;
}

/**
 * The verb of the request through which a member forwards one of its own parameters as the path, directly or through
 * another wrapper method of its class; undefined when it forwards none.
 */
function forwardedVerb(member: ts.Node, httpFields: ReadonlySet<string>, reaching: ReadonlyMap<string, string>, methods: ReadonlyMap<string, ts.Node>): string | undefined {
  const parameters = parametersOf(member);
  const forwards = (call: ts.CallExpression, name: string): boolean => {
    const path = call.arguments[name === "request" ? 1 : 0];
    return path !== undefined && forwardsAsTail(path, member, parameters, methods, new Set());
  };
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = node.expression.expression;
      if (VERBS.has(name) && ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword && httpFields.has(receiver.name.text) && forwards(node, name)) {
        found = name;
        return;
      }
      const chained = reaching.get(name);
      if (receiver.kind === ts.SyntaxKind.ThisKeyword && chained !== undefined && forwards(node, name)) {
        found = chained;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(member);
  return found;
}

/**
 * Whether an expression ends with one of the parameters unchanged, so a URL it builds is the parameter's path after a
 * prefix: the parameter, a variable holding such an expression, a template or a sum that ends with one, or a method of
 * the class that returns its own parameter that way. A parameter written inside a segment (`/items/${encode(id)}`) is not.
 */
function forwardsAsTail(node: ts.Node, member: ts.Node, parameters: ReadonlySet<string>, methods: ReadonlyMap<string, ts.Node>, trail: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return forwardsAsTail(node.expression, member, parameters, methods, trail);
  if (ts.isIdentifier(node)) {
    if (parameters.has(node.text)) return true;
    const initializer = localInitializers(member).get(node.text);
    return initializer !== undefined && !trail.has(node.text) && forwardsAsTail(initializer, member, parameters, methods, new Set(trail).add(node.text));
  }
  if (ts.isTemplateExpression(node)) {
    const last = node.templateSpans.at(-1);
    return last !== undefined && last.literal.text === "" && forwardsAsTail(last.expression, member, parameters, methods, trail);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return forwardsAsTail(node.right, member, parameters, methods, trail);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const name = `this.${node.expression.name.text}`;
  const helper = methods.get(node.expression.name.text);
  const declared = helper === undefined ? undefined : functionOf(helper);
  if (helper === undefined || declared === undefined || trail.has(name)) return false;
  return node.arguments.some((argument, index) => {
    const parameter = declared.parameters[index];
    if (parameter === undefined || !ts.isIdentifier(parameter.name) || !forwardsAsTail(argument, member, parameters, methods, trail)) return false;
    const own = new Set([parameter.name.text]);
    return returnsOf(declared).every((returned) => returned !== undefined && forwardsAsTail(returned, helper, own, methods, new Set(trail).add(name)));
  });
}

/** The function a class member is: a method, or a property initialized with an arrow or a function expression. */
function functionOf(member: ts.Node): ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : undefined;
}

/** The variables a member declares in its body, by name, with what they are initialized to. */
function localInitializers(member: ts.Node): ReadonlyMap<string, ts.Expression> {
  const held = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) held.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(member);
  return held;
}

function parametersOf(member: ts.Node): RunTime {
  const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  const declared = ts.isMethodDeclaration(member) ? member.parameters : initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer.parameters : [];
  return parameterNames(declared);
}

function parameterNames(parameters: readonly ts.ParameterDeclaration[]): RunTime {
  return new Set(parameters.flatMap((parameter) => bindingNames(parameter.name)));
}

function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => ts.isBindingElement(element) ? bindingNames(element.name) : []);
}

/** The names a function or method binds, and what the variables it declares are initialized to. */
function scopeOf(declaration: ts.MethodDeclaration | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): Scope {
  const point = declaration.body ?? declaration;
  return lexicalScope(point, true);
}

/**
 * The lexical bindings visible at a call, with inner declarations taking precedence over outer declarations.
 */
function scopeOfCall(call: ts.CallExpression): Scope {
  return lexicalScope(call);
}

function lexicalScope(point: ts.Node, includePoint = false): Scope {
  const node = includePoint ? point : point.parent;
  if (node === undefined || ts.isSourceFile(node)) return NO_SCOPE;
  const cached = LEXICAL_SCOPES.get(node);
  if (cached !== undefined) return cached;
  const outer = lexicalScope(node);
  const names = new Set<string>();
  const locals = new Map<string, ts.Expression>();
  const bind = (name: ts.BindingName, initializer?: ts.Expression): void => {
    for (const text of bindingNames(name)) {
      if (names.has(text)) continue;
      names.add(text);
      if (ts.isIdentifier(name) && initializer !== undefined) locals.set(text, initializer);
    }
  };
  if (ts.isBlock(node) || ts.isCaseBlock(node)) {
    const statements = ts.isBlock(node) ? node.statements : node.clauses.flatMap((clause) => [...clause.statements]);
    for (const statement of statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) for (const declaration of statement.declarationList.declarations) bind(declaration.name, declaration.initializer);
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) bind(statement.name);
    }
  }
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name !== undefined) bind(node.name);
  if ((ts.isFunctionLike(node) && "parameters" in node) || ts.isClassStaticBlockDeclaration(node)) {
    if ("parameters" in node) for (const parameter of node.parameters) bind(parameter.name);
    const visitVar = (child: ts.Node): void => {
      if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isModuleDeclaration(child)) return;
      if (ts.isVariableDeclarationList(child) && (child.flags & ts.NodeFlags.BlockScoped) === 0) for (const declaration of child.declarations) bind(declaration.name);
      ts.forEachChild(child, visitVar);
    };
    if ("body" in node && node.body !== undefined) visitVar(node.body);
  }
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) bind(node.variableDeclaration.name);
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
    for (const declaration of node.initializer.declarations) bind(declaration.name, declaration.initializer);
  }
  if (names.size === 0) {
    LEXICAL_SCOPES.set(node, outer);
    return outer;
  }
  for (const name of outer.names) {
    if (names.has(name)) continue;
    names.add(name);
    const initializer = outer.locals.get(name);
    if (initializer !== undefined) locals.set(name, initializer);
  }
  const scope = { names, locals };
  LEXICAL_SCOPES.set(node, scope);
  return scope;
}

/** A call's target, and the request the code states when the snapshot cannot decide where it goes. */
interface ReadTarget {
  target: Finding<HttpTarget>;
  stated?: StatedRequest;
}

/** Reads one file's call sites, resolving the module specifiers it meets through the snapshot. */
class Reader {
  private readonly unsafeEncoder: boolean;
  /** The classes of the snapshot that extend a class, by the name they extend. */
  private readonly subclasses = new Map<string, ts.ClassDeclaration[]>();

  constructor(
    private readonly shapes: ReadonlyMap<string, FileShape>,
    private readonly modules: ModuleResolver,
    private readonly wrappers: ReadonlyMap<string, ReadonlyMap<string, string>>,
    private readonly defines: BuildDefines,
  ) {
    this.unsafeEncoder = [...shapes.values()].some((shape) => shape.unsafeEncoder);
    for (const shape of shapes.values()) {
      for (const declaration of shape.classes.values()) {
        const base = baseClassName(declaration);
        if (base !== undefined) this.subclasses.set(base, [...(this.subclasses.get(base) ?? []), declaration]);
      }
    }
  }

  async callSite(shape: FileShape, call: ts.CallExpression, repo: string): Promise<CallSite[]> {
    if (this.forwardsItsOwnParameter(shape, call)) return [];
    const read = await this.target(shape, call);
    if (read === undefined) return [];
    const start = shape.source.getLineAndCharacterOfPosition(call.getStart(shape.source)).line + 1;
    const end = shape.source.getLineAndCharacterOfPosition(call.getEnd()).line + 1;
    return [{ repo, file: shape.source.fileName, line: start, endLine: end, symbol: symbolOf(call) ?? "(top level)", ancestors: ancestorsOf(call, shape.source), transport: "http", target: read.target, ...(read.stated === undefined ? {} : { stated: read.stated }) }];
  }

  /**
   * A wrapper's own body is where the request is made, not where a repository calls one: its path parameter is supplied by
   * the call to the wrapper, which is the call site. Forwarding a parameter is therefore not a call site of its own.
   */
  private forwardsItsOwnParameter(_shape: FileShape, call: ts.CallExpression): boolean {
    const enclosing = enclosingMethodDeclaration(call);
    if (enclosing === undefined || !ts.isIdentifier(enclosing.name)) return false;
    const owner = ts.isClassDeclaration(enclosing.parent) && enclosing.parent.name !== undefined ? enclosing.parent.name.text : undefined;
    return this.wrappers.get(owner ?? "")?.has(enclosing.name.text) === true;
  }

  /** The target of the call when it is a request the project makes out of itself; undefined for every other call. */
  private async target(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget | undefined> {
    const callee = call.expression;
    if (ts.isIdentifier(callee) && callee.text === "fetch") return isGlobalName(shape, scopeOfCall(call), "fetch") ? this.fetched(shape, call) : undefined;
    if (isHttpResource(shape, callee)) return this.resource(shape, call);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.name.text;
    if (!VERBS.has(name) && name !== "fetch") return undefined;
    const owner = await this.ownerClass(shape, callee.expression);
    if (owner === undefined) return undefined;
    const isHttpClient = isAngularHttpClientName(owner.shape, owner.name);
    const wrapped = isHttpClient ? undefined : this.wrappers.get(owner.name)?.get(name === "fetch" ? "request" : name);
    if (!isHttpClient && wrapped === undefined) return undefined;
    if (name === "request") return this.explicitRequest(shape, call);
    const verb = wrapped === undefined || wrapped === "request" ? name : wrapped;
    return this.request(shape, call, call.arguments[0], verb === "fetch" ? "GET" : verbOf(verb));
  }

  /** `fetch(url, init)`: the method is the one the init object states, GET without an init. */
  private async fetched(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget> {
    const [resource, init] = call.arguments;
    const stated = init === undefined ? undefined : objectOf(init);
    const method = init === undefined ? "GET" : stated === undefined ? undefined : await this.requestMethod(shape, stated, scopeOfCall(call));
    return this.request(shape, call, resource, method);
  }

  /** The method a request object states, GET when it states none; undefined when the snapshot does not decide it. */
  private async requestMethod(shape: FileShape, object: ts.ObjectLiteralExpression, scope: Scope): Promise<HttpTarget["method"] | undefined> {
    const method = memberOf(object, "method");
    if (method === UNDECIDED) return undefined;
    return method === undefined ? "GET" : this.methodOf(shape, method, scope);
  }

  /** `request(method, url)`, or `request(new HttpRequest(method, url))`: the method is an argument, never assumed. */
  private async explicitRequest(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget> {
    const [first, second] = call.arguments;
    const sent = first !== undefined && ts.isNewExpression(first) && isHttpPackageName(shape, first.expression, "HttpRequest") ? first.arguments : undefined;
    const [method, path] = sent ?? [first, second];
    return this.request(shape, call, path, method === undefined ? undefined : await this.methodOf(shape, method));
  }

  /**
   * `httpResource(() => url)` is a GET of the URL; `httpResource(() => ({ url, method }))` states its method, GET when it
   * names none. A function that returns undefined requests nothing then, so the request is the one every other return
   * states; returns that disagree leave it undecided.
   */
  private async resource(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget> {
    const [first] = call.arguments;
    const requests = first === undefined ? [] : ts.isArrowFunction(first) || ts.isFunctionExpression(first) ? returnsOf(first).filter(requestsSomething) : [first];
    let agreed: ReadTarget | undefined;
    for (const returned of requests) {
      const read = await this.resourceRequest(shape, call, returned);
      if (agreed !== undefined && JSON.stringify(read) !== JSON.stringify(agreed)) return unresolvedAt(shape, call);
      agreed = read;
    }
    return agreed ?? unresolvedAt(shape, call);
  }

  private async resourceRequest(shape: FileShape, call: ts.CallExpression, returned: ts.Expression): Promise<ReadTarget> {
    const scope = lexicalScope(returned);
    const described = objectOf(returned);
    if (described === undefined) return this.request(shape, call, returned, "GET", scope);
    const url = memberOf(described, "url");
    return this.request(shape, call, url === UNDECIDED ? undefined : url, await this.requestMethod(shape, described, scope), scope);
  }

  private async methodOf(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE): Promise<HttpTarget["method"] | undefined> {
    const text = textOf(await this.evaluate(shape, expression, scope));
    return text === undefined ? undefined : verbOf(text.toLowerCase());
  }

  private async request(shape: FileShape, call: ts.CallExpression, pathExpression: ts.Expression | undefined, method: HttpTarget["method"] | undefined, scope = scopeOfCall(call)): Promise<ReadTarget> {
    const unknown = unresolvedAt(shape, call);
    const path = pathExpression === undefined ? undefined : textOf(await this.evaluate(shape, pathExpression, scope));
    if (path === undefined || method === undefined || !startsSegments(path)) return unknown;
    const base = await this.baseUrl(shape, call);
    const written = normalizePath(path);
    if (base === UNDECIDED) return { ...unknown, stated: { method, path: written } };
    return { target: { status: "complete", value: { method, path: written, ...(base === undefined ? {} : { base }) }, evidence: unknown.target.evidence } };
  }

  /** The base URL the call's options declare: undefined when they declare none, `UNDECIDED` when the snapshot does not decide it. */
  private async baseUrl(shape: FileShape, call: ts.CallExpression): Promise<string | typeof UNDECIDED | undefined> {
    for (const argument of call.arguments.slice(1)) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      const declared = propertyOf(argument, "baseUrl");
      if (declared !== undefined) return textOf(await this.evaluate(shape, declared, scopeOfCall(call))) ?? UNDECIDED;
    }
    return undefined;
  }

  /**
   * The name of the class a receiver is an instance of, with the file that names it: `this.x` through the field the class of
   * the call declares or inherits, a bare name through the binding the code around it declares, or a constant of the file.
   */
  private async ownerClass(shape: FileShape, receiver: ts.Expression): Promise<TypeNamed | undefined> {
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = enclosingClassOf(receiver);
      return enclosing === undefined ? undefined : this.memberType(shape, enclosing, receiver.name.text, new Set());
    }
    if (!ts.isIdentifier(receiver)) return undefined;
    const scope = lexicalScope(receiver);
    if (scope.names.has(receiver.text)) {
      const local = scope.locals.get(receiver.text);
      const named = local === undefined ? parameterType(receiver) : this.injectedType(shape, local);
      return named === undefined ? undefined : { name: named, shape };
    }
    const constant = shape.consts.get(receiver.text);
    const named = constant === undefined ? undefined : this.injectedType(shape, constant);
    return named === undefined ? undefined : { name: named, shape };
  }

  /** The type of the field a class declares under a name, a parameter property included, or the one its base class declares. */
  private async memberType(shape: FileShape, declaration: ts.ClassDeclaration, name: string, visited: ReadonlySet<ts.ClassDeclaration>): Promise<TypeNamed | undefined> {
    if (visited.has(declaration)) return undefined;
    const field = declaration.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name);
    const parameter = constructorParameters(declaration).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name && ts.isParameterPropertyDeclaration(candidate, candidate.parent));
    const declared = field ?? parameter;
    if (declared !== undefined) {
      const named = (field?.initializer === undefined ? undefined : this.injectedType(shape, field.initializer)) ?? (declared.type === undefined ? undefined : typeName(declared.type));
      return named === undefined ? undefined : { name: named, shape };
    }
    const base = baseClassName(declaration);
    const found = base === undefined ? undefined : await this.classOf(shape, base);
    return found === undefined ? undefined : this.memberType(found.shape, found.declaration, name, new Set(visited).add(declaration));
  }

  private injectedType(shape: FileShape, expression: ts.Expression): string | undefined {
    if (!ts.isCallExpression(expression) || expression.expression.getText(shape.source) !== "inject") return undefined;
    const [first] = expression.arguments;
    return first !== undefined && ts.isIdentifier(first) ? first.text : undefined;
  }

  /**
   * What a path expression comes down to: the text it states, a value the code being evaluated fills at run time
   * (`kind: "value"`, written `{}` inside a path), or undefined when the snapshot does not decide it. `scope` holds the
   * names that code binds.
   */
  private async evaluate(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE, trail: ReadonlySet<string> = new Set()): Promise<Evaluation | undefined> {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return stated(expression.text);
    if (ts.isTemplateExpression(expression)) {
      let text = expression.head.text;
      for (const span of expression.templateSpans) {
        if (endsPath(text)) return cutAt(text);
        const part = await this.evaluate(shape, span.expression, scope, trail);
        if (part === undefined) return undefined;
        if (part.kind === "text" && part.cut) return cutAt(text + part.text);
        text += written(part) + span.literal.text;
      }
      return stated(text);
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = await this.evaluate(shape, expression.left, scope, trail);
      if (left?.kind === "text" && endsPath(left.text)) return cutAt(left.text);
      const right = await this.evaluate(shape, expression.right, scope, trail);
      if (left === undefined || right === undefined) return undefined;
      return right.kind === "text" && right.cut ? cutAt(written(left) + right.text) : stated(written(left) + written(right));
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return this.evaluate(shape, expression.expression, scope, trail);
    }
    if (ts.isIdentifier(expression)) return this.evaluateName(shape, expression.text, scope, trail);
    if (ts.isPropertyAccessExpression(expression)) return this.evaluateProperty(shape, expression, scope, trail);
    if (ts.isCallExpression(expression)) return this.evaluateCall(shape, expression, scope, trail);
    return undefined;
  }

  /**
   * A name the code binds is what it was bound to: the initializer of a variable declared where the call sits, a value
   * the code fills at run time, or the constant a top-level declaration or an import names. The code's own binding wins,
   * so a parameter that shadows a const of the file stays a value the code fills. An initializer the snapshot does not
   * decide is a value the code fills only when it reads one, so a value computed from nothing it holds stays undecided.
   */
  private async evaluateName(shape: FileShape, name: string, scope: Scope, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    const local = scope.locals.get(name);
    if (local !== undefined) {
      const visited = `${shape.source.fileName}\0local ${name}`;
      if (trail.has(visited)) return undefined;
      const declared = lexicalScope(local);
      const initial = (await this.evaluate(shape, local, declared, new Set(trail).add(visited))) ?? (readsRunTime(local, declared) ? RUN_TIME_VALUE : undefined);
      return this.afterWrites(shape, local, initial, trail);
    }
    if (scope.names.has(name)) return RUN_TIME_VALUE;
    const constant = await this.constantAt(shape, name, trail);
    if (constant !== undefined) return this.afterWrites(constant.shape, constant.expression, await this.evaluate(constant.shape, constant.expression, NO_SCOPE, constant.trail), constant.trail);
    if (shape.imports.has(name) || shape.bindings.has(name)) return undefined;
    const defined = this.defines.valueOf(shape.source.fileName, name);
    return defined === undefined ? undefined : stated(defined);
  }

  /** Where a name's constant lives and the trail that visited it: a declaration of this file, or one an import names. */
  private async constantAt(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const local = shape.consts.get(name);
    if (local !== undefined) {
      const visited = `${shape.source.fileName}\0${name}`;
      return trail.has(visited) ? undefined : { shape, expression: local, trail: new Set(trail).add(visited) };
    }
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.moduleShape(shape, imported.module);
    return target === undefined ? undefined : this.exported(target, imported.imported, trail);
  }

  /**
   * The expression a module exports under a name: its own declaration, a named re-export, or one reached through
   * `export *`, which a barrel chain answers. Undefined when the module states none, and when the chain repeats a module
   * and a name it already visited.
   */
  private async exported(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const visited = `${shape.source.fileName}\0export ${name}`;
    if (trail.has(visited)) return undefined;
    const next = new Set(trail).add(visited);
    const held = name === "default" ? shape.defaultExport : shape.consts.get(name);
    if (held !== undefined) return { shape, expression: held, trail: next };
    const reexport = shape.reexports.get(name);
    if (reexport !== undefined) {
      const target = await this.moduleShape(shape, reexport.module);
      return target === undefined ? undefined : this.exported(target, reexport.imported, next);
    }
    for (const star of shape.stars) {
      const target = await this.moduleShape(shape, star);
      const found = target === undefined ? undefined : await this.exported(target, name, next);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * A member read from a class (`this.base`, `OrderApi.BASE`), a namespace import or an object literal: the value it
   * holds. A property of a value the code fills at run time is one too; a root the code binds is read through that
   * binding first.
   */
  private async evaluateProperty(shape: FileShape, expression: ts.PropertyAccessExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    const owner = expression.expression;
    if (ts.isIdentifier(owner) && scope.names.has(owner.text)) return (await this.evaluateName(shape, owner.text, scope, trail))?.kind === "value" ? RUN_TIME_VALUE : undefined;
    if (!ts.isIdentifier(owner) && owner.kind !== ts.SyntaxKind.ThisKeyword && (await this.evaluate(shape, owner, scope, trail))?.kind === "value") return RUN_TIME_VALUE;
    const held = await this.memberOf(shape, expression, trail);
    if (held === ASSIGNED_AT_RUN_TIME) return RUN_TIME_VALUE;
    return held === undefined ? undefined : this.afterWrites(held.shape, held.expression, await this.evaluate(held.shape, held.expression, NO_SCOPE, held.trail), held.trail);
  }

  /**
   * What a variable holds where the code reads it, given what its initializer holds: the initializer's path while the code
   * only extends it with a query or a fragment (`url += '?q=' + q`), undecided once it writes it any other way.
   */
  private async afterWrites(shape: FileShape, initializer: ts.Expression, initial: Evaluation | undefined, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    const appended = appendsTo(initializer);
    if (appended === null) return undefined;
    if (appended.length === 0 || initial === undefined) return initial;
    if (initial.kind !== "text") return undefined;
    if (endsPath(initial.text)) return cutAt(initial.text);
    for (const part of appended) {
      const text = textOf(await this.evaluate(shape, part, lexicalScope(part), trail));
      if (text === undefined || !(text.startsWith("?") || text.startsWith("#"))) return undefined;
    }
    return cutAt(initial.text);
  }

  private async memberOf(shape: FileShape, expression: ts.PropertyAccessExpression, trail: ReadonlySet<string>): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const owner = expression.expression;
    const name = expression.name.text;
    if (owner.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = enclosingClassOf(owner);
      return enclosing === undefined ? undefined : await this.fieldOf(shape, enclosing, name, trail, [enclosing]);
    }
    if (!ts.isIdentifier(owner)) return undefined;
    const namespace = shape.imports.get(owner.text);
    if (namespace?.imported === "*") {
      const target = await this.moduleShape(shape, namespace.module);
      return target === undefined ? undefined : this.exported(target, name, trail);
    }
    const found = await this.classOf(shape, owner.text);
    const field = found === undefined ? undefined : await this.fieldOf(found.shape, found.declaration, name, trail, [found.declaration]);
    if (field !== undefined) return field;
    const literal = await this.objectLiteral(shape, owner.text, trail);
    if (literal === undefined) return undefined;
    const property = literal.expression.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && candidate.name.getText(literal.expression.getSourceFile()) === name);
    return property === undefined ? undefined : { shape: literal.shape, expression: property.initializer, trail: literal.trail };
  }

  /**
   * The initializer of a class member, once, whatever names the class states; a member the class does not declare is its
   * base class's. `chain` holds the classes from the one the code reads the member of to this one. A field declared
   * without an initializer or as a constructor parameter, or that the code assigns besides its initializer, holds a value
   * the code assigns at run time.
   */
  private async fieldOf(shape: FileShape, declaration: ts.ClassDeclaration, name: string, trail: ReadonlySet<string>, chain: readonly ts.ClassDeclaration[]): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const visited = `${shape.source.fileName}\0${declaration.name?.text ?? "(anonymous)"}.${name}`;
    if (trail.has(visited)) return undefined;
    const member = declaration.members.find((candidate) => candidate.name !== undefined && ts.isIdentifier(candidate.name) && candidate.name.text === name);
    if (member === undefined) {
      if (constructorParameters(declaration).some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name && ts.isParameterPropertyDeclaration(parameter, parameter.parent))) return ASSIGNED_AT_RUN_TIME;
      const base = baseClassName(declaration);
      const found = base === undefined ? undefined : await this.classOf(shape, base);
      return found === undefined ? undefined : this.fieldOf(found.shape, found.declaration, name, new Set(trail).add(visited), [...chain, found.declaration]);
    }
    if (!ts.isPropertyDeclaration(member)) return undefined;
    const [read] = chain;
    const assigned = chain.some((held) => writes(held, name)) || (read !== undefined && this.assignedBelow(read, name, new Set()));
    if (member.initializer === undefined || assigned) return ASSIGNED_AT_RUN_TIME;
    return { shape, expression: member.initializer, trail: new Set(trail).add(visited) };
  }

  /** Whether a subclass of the class, the instance the code may run on, declares the field again or writes it. */
  private assignedBelow(declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): boolean {
    if (visited.has(declaration)) return false;
    visited.add(declaration);
    const subclasses = declaration.name === undefined ? [] : (this.subclasses.get(declaration.name.text) ?? []);
    return subclasses.some((subclass) => subclass.members.some((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name) || writes(subclass, name) || this.assignedBelow(subclass, name, visited));
  }

  /** The class a name states in this file, or the one an import names. */
  private async classOf(shape: FileShape, name: string): Promise<{ shape: FileShape; declaration: ts.ClassDeclaration } | undefined> {
    const local = shape.classes.get(name);
    if (local !== undefined) return { shape, declaration: local };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*" || imported.imported === "default") return undefined;
    const target = await this.moduleShape(shape, imported.module);
    const declaration = target?.classes.get(imported.imported);
    return target === undefined || declaration === undefined ? undefined : { shape: target, declaration };
  }

  private async objectLiteral(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located<ts.ObjectLiteralExpression> | undefined> {
    const local = shape.consts.get(name);
    const held = local === undefined ? undefined : objectOf(local);
    if (held !== undefined) return { shape, expression: held, trail };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.moduleShape(shape, imported.module);
    if (target === undefined) return undefined;
    const found = await this.exported(target, imported.imported, trail);
    const literal = found === undefined ? undefined : objectOf(found.expression);
    return literal === undefined || found === undefined ? undefined : { shape: found.shape, expression: literal, trail: found.trail };
  }

  /** A function the call names, evaluated at its one returned expression: its own parameters are the run-time values. */
  private async evaluateCall(shape: FileShape, call: ts.CallExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "toString") return this.scalarText(shape, call.arguments.length === 0 ? [call.expression.expression] : [], scope, trail);
    if (!ts.isIdentifier(call.expression)) return undefined;
    if (scope.names.has(call.expression.text)) return undefined;
    if (call.expression.text === "String" && isGlobalName(shape, scope, "String")) return this.scalarText(shape, call.arguments, scope, trail);
    if (call.expression.text === "encodeURIComponent" && !this.unsafeEncoder && isGlobalName(shape, scope, "encodeURIComponent")) {
      const [argument, ...rest] = call.arguments;
      return argument === undefined || rest.length > 0 || ts.isSpreadElement(argument) ? undefined : this.encoded(shape, argument, scope, trail);
    }
    const visited = `${shape.source.fileName}\0call ${call.expression.text}`;
    if (trail.has(visited)) return undefined;
    const found = await this.callTargetOf(shape, call.expression.text);
    return found === undefined ? undefined : this.evaluateReturned(found.target, found.declaration, new Set(trail).add(visited));
  }

  /** `String(x)` and `x.toString()` write what a template writes for `x`. */
  private async scalarText(shape: FileShape, operands: readonly ts.Expression[], scope: Scope, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    const [operand, ...rest] = operands;
    return operand === undefined || rest.length > 0 ? undefined : this.evaluate(shape, operand, scope, trail);
  }

  /**
   * `encodeURIComponent(x)` escapes `/`, `?` and `#`, so whatever it encodes stays in one segment: a text it states whole
   * is encoded, anything else is a run-time value, unless the snapshot cannot read it and it reads nothing the code fills
   * at run time.
   */
  private async encoded(shape: FileShape, argument: ts.Expression, scope: Scope, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    const value = await this.evaluate(shape, argument, scope, trail);
    if (value === undefined) return readsRunTime(argument, scope) ? RUN_TIME_VALUE : undefined;
    if (value.kind === "value" || value.cut || value.text.includes(PLACEHOLDER)) return RUN_TIME_VALUE;
    try {
      return stated(encodeURIComponent(value.text));
    } catch {
      return undefined;
    }
  }

  private async callTargetOf(shape: FileShape, name: string): Promise<{ target: FileShape; declaration: ts.Expression | ts.FunctionDeclaration } | undefined> {
    const local = shape.consts.get(name) ?? functionNamed(shape, name);
    if (local !== undefined) return { target: shape, declaration: local };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.moduleShape(shape, imported.module);
    const declaration = target === undefined ? undefined : (target.consts.get(imported.imported) ?? functionNamed(target, imported.imported));
    return target === undefined || declaration === undefined ? undefined : { target, declaration };
  }

  /** What a call writes: what every return of the function it names writes, undefined when one is undecided or two disagree. */
  private async evaluateReturned(target: FileShape, declaration: ts.Expression | ts.FunctionDeclaration, trail: ReadonlySet<string>): Promise<Evaluation | undefined> {
    if (!ts.isFunctionDeclaration(declaration) && !ts.isArrowFunction(declaration) && !ts.isFunctionExpression(declaration)) return this.evaluate(target, declaration, NO_SCOPE, trail);
    let agreed: Evaluation | undefined;
    for (const returned of returnsOf(declaration)) {
      const value = returned === undefined ? undefined : await this.evaluate(target, returned, lexicalScope(returned), trail);
      if (value === undefined || (agreed !== undefined && (value.kind !== agreed.kind || written(value) !== written(agreed)))) return undefined;
      agreed = value;
    }
    return agreed;
  }

  private async moduleShape(shape: FileShape, specifier: string): Promise<FileShape | undefined> {
    const resolved = await this.modules.resolve(shape.source.fileName, specifier);
    return "file" in resolved ? this.shapes.get(resolved.file) : undefined;
  }
}

/** The names the file binds at run time; an ambient `declare` binds none. */
function baseClassName(declaration: ts.ClassDeclaration): string | undefined {
  const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) ? base.text : undefined;
}

function sourceBindings(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (isAmbient(statement)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name !== undefined) names.add(statement.name.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node) || isAmbient(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) for (const declaration of node.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isAmbient(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
}

function mayOverrideEncoder(source: ts.SourceFile): boolean {
  const globalNames = new Set(["globalThis", "window", "global", "self"]);
  const globalObject = (node: ts.Node): node is ts.Expression => {
    if (ts.isIdentifier(node)) return globalNames.has(node.text);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return globalObject(node.expression);
    if (ts.isPropertyAccessExpression(node)) return globalObject(node.expression) && globalNames.has(node.name.text);
    if (ts.isElementAccessExpression(node)) return globalObject(node.expression) && (!ts.isStringLiteralLike(node.argumentExpression) || globalNames.has(node.argumentExpression.text));
    return false;
  };
  const target = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === "encodeURIComponent";
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!globalObject(node.expression)) return false;
      return ts.isPropertyAccessExpression(node) ? node.name.text === "encodeURIComponent" : !ts.isStringLiteralLike(node.argumentExpression) || node.argumentExpression.text === "encodeURIComponent";
    }
    return ts.forEachChild(node, (child) => target(child) || undefined) === true;
  };
  const visit = (node: ts.Node): boolean => {
    if (globalObject(node)) {
      const directParent = node.parent;
      if ((ts.isPropertyAccessExpression(directParent) || ts.isPropertyAssignment(directParent) || ts.isVariableDeclaration(directParent) || ts.isModuleDeclaration(directParent)) && directParent.name === node) return false;
      let reference: ts.Expression = node;
      while (true) {
        const parent = reference.parent;
        if ((ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === reference) reference = parent;
        else if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference && globalObject(parent)) reference = parent;
        else break;
      }
      const parent = reference.parent;
      const inspected = ts.isTypeOfExpression(parent) || ts.isSpreadAssignment(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === reference);
      const receiver = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference;
      if (!inspected && !receiver) return true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(node.left)) return true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && target(node.operand)) return true;
    if (ts.isDeleteExpression(node) && target(node.expression)) return true;
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer) && target(node.initializer)) return true;
    return ts.forEachChild(node, (child) => visit(child) || undefined) === true;
  };
  return visit(source);
}

/** The type name the innermost function parameter of that name declares around a node. */
function parameterType(name: ts.Identifier): string | undefined {
  for (let current: ts.Node | undefined = name.parent; current !== undefined; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const parameter = current.parameters.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name.text);
    if (parameter !== undefined) return parameter.type === undefined ? undefined : typeName(parameter.type);
  }
  return undefined;
}

/** What the code appends with `+=` to the variable an initializer declares; null when it writes the variable any other way. */
function appendsTo(initializer: ts.Expression): readonly ts.Expression[] | null {
  const declaration = initializer.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== initializer || !ts.isIdentifier(declaration.name)) return [];
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) !== 0) return [];
  const writes = writesIn(regionOf(list)).get(declaration.name.text);
  return writes === undefined ? [] : writes;
}

/** Where a declaration's variable is visible: its block or loop for `let`, its function or file for `var`. */
function regionOf(list: ts.VariableDeclarationList): ts.Node {
  if ((list.flags & ts.NodeFlags.BlockScoped) !== 0) return ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  for (let current: ts.Node = list.parent; ; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
  }
}

/** The assignments to each name a region makes, destructuring included: what `+=` appends, or null for any other. */
function writesIn(region: ts.Node): ReadonlyMap<string, readonly ts.Expression[] | null> {
  const cached = VARIABLE_WRITES.get(region);
  if (cached !== undefined) return cached;
  const writes = new Map<string, ts.Expression[] | null>();
  const record = (name: string, appended: ts.Expression | null): void => {
    const held = writes.get(name);
    if (appended === null) writes.set(name, null);
    else if (held !== null) writes.set(name, [...(held ?? []), appended]);
  };
  const names = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) record(node.text, null);
    else ts.forEachChild(node, names);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left)) record(node.left.text, node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? node.right : null);
      else if (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left)) names(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(region);
  VARIABLE_WRITES.set(region, writes);
  return writes;
}

const ANY_FIELD = "*";

function writes(declaration: ts.ClassDeclaration, name: string): boolean {
  const written = writtenFields(declaration);
  return written.has(name) || written.has(ANY_FIELD);
}

/** The fields a class body writes through `this`, `ANY_FIELD` when it writes one it does not name. */
function writtenFields(declaration: ts.ClassDeclaration): ReadonlySet<string> {
  const cached = WRITTEN_FIELDS.get(declaration);
  if (cached !== undefined) return cached;
  const written = new Set<string>();
  const target = (node: ts.Expression): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) written.add(node.name.text);
    if (ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) written.add(ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : ANY_FIELD);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
    if (ts.isDeleteExpression(node)) target(node.expression);
    if (ts.isCallExpression(node) && node.expression.getText() === "Object.assign" && node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword) written.add(ANY_FIELD);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  WRITTEN_FIELDS.set(declaration, written);
  return written;
}

/** Whether an expression reads a value the code fills at run time: `this`, or a name the code around it binds. */
function readsRunTime(node: ts.Node, scope: Scope): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isIdentifier(node)) return scope.names.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return readsRunTime(node.expression, scope);
  if (ts.isPropertyAssignment(node)) return readsRunTime(node.initializer, scope);
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (child) => readsRunTime(child, scope) || undefined) === true;
}

/** Whether a name is the global of that name where the code reads it: nothing the file or the code around declares or imports it. */
function isGlobalName(shape: FileShape, scope: Scope, name: string): boolean {
  return !scope.names.has(name) && !shape.imports.has(name) && !shape.bindings.has(name);
}

/**
 * The expression an object literal states for a member, a shorthand's name included; `UNDECIDED` when a spread or a
 * computed name after it may state the member instead.
 */
function memberOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | typeof UNDECIDED | undefined {
  let found: ts.Expression | typeof UNDECIDED | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name))) found = UNDECIDED;
    else if (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      found = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : UNDECIDED;
    }
  }
  return found;
}

function functionNamed(shape: FileShape, name: string): ts.FunctionDeclaration | undefined {
  return shape.source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
}

/**
 * What a function returns from its own body, the functions it declares aside: its expression body, or the expression of
 * every `return`, with undefined for a bare `return` and for an end the body reaches without returning.
 */
function returnsOf(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): (ts.Expression | undefined)[] {
  if (node.body === undefined) return [undefined];
  if (!ts.isBlock(node.body)) return [node.body];
  const returned: (ts.Expression | undefined)[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child)) returned.push(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  const last = node.body.statements.at(-1);
  if (last === undefined || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) returned.push(undefined);
  return returned;
}

/** Whether a returned value states a request: `undefined`, `void x` and no value at all state none. */
function requestsSomething(returned: ts.Expression | undefined): returned is ts.Expression {
  return returned !== undefined && !(ts.isIdentifier(returned) && returned.text === "undefined") && !ts.isVoidExpression(returned);
}

function unresolvedAt(shape: FileShape, call: ts.CallExpression): ReadTarget {
  return { target: { status: "unknown", reason: "unresolved", evidence: [{ path: shape.source.fileName, line: lineOf(shape.source, call) }] } };
}

/** The object literal an initializer is, through the wrappers TypeScript lets an author write around it. */
function objectOf(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression)) return objectOf(expression.expression);
  return undefined;
}

function verbOf(name: string): HttpTarget["method"] {
  const upper = name.toUpperCase();
  return (["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const).find((verb) => verb === upper) ?? "GET";
}

/**
 * Whether a text reaches the query or the fragment of a URL, after which nothing more decides the path. An evaluation stops
 * there, so its text is complete only up to that point.
 */
function endsPath(text: string): boolean {
  return text.includes("?") || text.includes("#");
}

/**
 * Whether every run-time value of a path starts a segment of it. One that starts the URL, or follows text of its segment,
 * may hold an origin, a base path or several segments, so it stands for no segment.
 */
function startsSegments(path: string): boolean {
  for (let at = path.indexOf(PLACEHOLDER); at !== -1; at = path.indexOf(PLACEHOLDER, at + PLACEHOLDER.length)) {
    if (path[at - 1] !== "/") return false;
  }
  return true;
}

/** `:name` stands for a value the code fills, like `${expr}`; the query string and the fragment are not part of the path a route serves. */
function normalizePath(path: string): string {
  const end = path.search(/[?#]/);
  const withoutQuery = end === -1 ? path : path.slice(0, end);
  return withoutQuery
    .split("/")
    .map((segment) => (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? PLACEHOLDER : segment))
    .join("/");
}

/** The method a node sits in. */
function enclosingMethodDeclaration(node: ts.Node): ts.MethodDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isMethodDeclaration(current)) return current;
  }
  return undefined;
}

/** The class whose body a node sits in, if any. */
function enclosingClassOf(node: ts.Node): ts.ClassDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

/** The text a path part states. */
function stated(text: string): Evaluation {
  return { kind: "text", text };
}

function cutAt(text: string): Evaluation {
  return { kind: "text", text, cut: true };
}

/** What an evaluation writes inside a path: the text it states, or the placeholder a run-time value leaves. */
function written(evaluation: Evaluation): string {
  return evaluation.kind === "text" ? evaluation.text : PLACEHOLDER;
}

/** The text an evaluation states; undefined for a run-time value and for a part the snapshot does not decide. */
function textOf(evaluation: Evaluation | undefined): string | undefined {
  return evaluation?.kind === "text" ? evaluation.text : undefined;
}

function ancestorsOf(node: ts.Node, source: ts.SourceFile): { symbol: string; line: number; endLine: number }[] {
  const ancestors: { symbol: string; line: number; endLine: number }[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!(ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isMethodDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isVariableDeclaration(current))) continue;
    const name = current.name;
    if (name === undefined || !ts.isIdentifier(name)) continue;
    ancestors.push({ symbol: name.text, line: lineOf(source, current), endLine: source.getLineAndCharacterOfPosition(current.getEnd()).line + 1 });
  }
  return ancestors;
}

export function symbolOf(node: ts.Node): string | undefined {
  let className: string | undefined;
  let member: string | undefined;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (member === undefined && (ts.isMethodDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || (ts.isVariableDeclaration(current) && current.initializer !== undefined && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))))) {
      const name = current.name;
      if (name !== undefined && ts.isIdentifier(name)) member = name.text;
      else if (ts.isFunctionDeclaration(current)) member = current.name?.text;
    }
    if (ts.isClassDeclaration(current) && current.name !== undefined) {
      className = current.name.text;
      break;
    }
  }
  if (className === undefined) return member;
  return member === undefined ? className : `${className}.${member}`;
}

export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
