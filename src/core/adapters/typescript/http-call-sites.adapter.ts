import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { compareCallSites, type CallSite, type CallSiteDiagnostic, type CallSiteReader, type HttpTarget, type PlacedCallSite, type PlacedCallSiteReader, type StatedRequest } from "../../domain/topology/call-site.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { requestMethodOf } from "../../domain/entrypoints/http-route.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { moduleResolverOf, type ModuleResolver } from "./module-resolver.ts";
import { buildDefines, type BuildDefines } from "./url-define.ts";
import { callUrl, joinedCallUrl, RUN_TIME_HOLE, urlText } from "../../domain/topology/path-template.ts";
import { known, undecided, undecidedTarget, type Evaluated, type Undecided } from "../../domain/topology/evaluated.ts";
import { injectedClass } from "./angular-injection.ts";
import { declarationCounts } from "./syntax-names.ts";
import { defaultExportOf } from "./import-bindings.ts";
import { bindingNames, constructorParameters, hasModifier, lineOf, propertyOf, thisClass, typeName } from "./syntax.ts";
import { ANONYMOUS_DEFAULT, recoveredModuleShape, type ModuleShape } from "./module-shape.ts";
import { createDeclarationLookup, type DeclarationLookup } from "./declaration-lookup.ts";

export const VERBS: ReadonlySet<string> = new Set(["get", "head", "post", "put", "patch", "delete", "options", "request"]);
const HTTP_CLIENT_PACKAGE = "@angular/common/http";
/** A value the snapshot does not decide for no cause more specific than that. */
const UNDECIDABLE: Undecided = undecided("destination-undecidable");
const RUN_TIME: Read = known({ kind: "value" });
/** A class field the code assigns at run time, so no initializer states its value. */
const ASSIGNED_AT_RUN_TIME = Symbol("assigned at run time");
const WRITTEN_FIELDS = new WeakMap<ts.ClassDeclaration, ReadonlySet<string>>();
const VARIABLE_WRITES = new WeakMap<ts.Node, ReadonlyMap<string, readonly ts.Expression[] | null>>();
/** The request call through which a wrapper method forwards its parameters, by the method; set where the wrapper fixpoint settles it. */
const FORWARDING_CALLS = new WeakMap<ts.Node, ts.CallExpression>();
const CALL_ORIGINS = new WeakMap<CallSite, NonNullable<PlacedCallSite["origins"]>>();

/** What one file declares at its top level, and the classes and enums it holds, as the reader needs them. */
interface FileShape {
  source: ts.SourceFile;
  /** How often each name is declared anywhere in the file. */
  declared: ReadonlyMap<string, number>;
  bindings: ReadonlySet<string>;
  unsafeEncoder: boolean;
  consts: Map<string, ts.Expression>;
  module: ModuleShape;
  imports: ModuleShape["imports"];
  /** What `export default` holds: an expression, or the class or function it declares. */
  defaultExport?: ts.Node;
  classes: Map<string, ts.ClassDeclaration>;
  enums: Map<string, ts.EnumDeclaration>;
}

/** The names the code being evaluated binds at run time, and what the variables its body declares are initialized to. */
interface Scope {
  names: ReadonlySet<string>;
  locals: ReadonlyMap<string, ts.Expression>;
}

const NO_SCOPE: Scope = { names: new Set(), locals: new Map() };
const LEXICAL_SCOPES = new WeakMap<ts.Node, Scope>();
const OWN_BINDINGS = new WeakMap<ts.Node, ReadonlyMap<string, Binding>>();
const LOCAL_INITIALIZERS = new WeakMap<ts.Node, ReadonlyMap<string, ts.Expression>>();
const REBOUND_NAMES = new WeakMap<ts.Node, ReadonlySet<string>>();

/** The names the code being evaluated binds at run time: a path part that names one is `{}`, never undecided. */
type RunTime = ReadonlySet<string>;

/**
 * What a path part came down to: the text it states, or a value the code being evaluated fills at run time. A `cut` text
 * stopped at the query or the fragment, so it states the URL only up to there.
 */
type Evaluation = { readonly kind: "text"; readonly text: string; readonly cut?: true } | { readonly kind: "value" };

/** What a path part reads as: an evaluation, or why the snapshot does not decide it. */
type Read = Evaluated<Evaluation>;

interface HeldClass {
  shape: FileShape;
  declaration: ts.ClassDeclaration;
}

/** A declaration an import names, with the file that declares it and the exports the resolution visited. */
interface Resolved<T> {
  shape: FileShape;
  declaration: T;
  trail: ReadonlySet<string>;
}

/** How a kind of declaration is found in a file: under the name it declares, or as what `export default` holds. */
interface DeclarationKind<T> {
  named(shape: FileShape, name: string): T | undefined;
  defaulted(node: ts.Node): T | undefined;
}

const CLASSES: DeclarationKind<ts.ClassDeclaration> = { named: (shape, name) => shape.classes.get(name), defaulted: (node) => (ts.isClassDeclaration(node) ? node : undefined) };
const ENUMS: DeclarationKind<ts.EnumDeclaration> = { named: (shape, name) => shape.enums.get(name), defaulted: () => undefined };
const CONSTANTS: DeclarationKind<ts.Expression> = { named: (shape, name) => shape.consts.get(name), defaulted: (node) => (ts.isExpression(node) ? node : undefined) };
const CALLABLES: DeclarationKind<ts.Expression | ts.FunctionDeclaration> = {
  named: (shape, name) => shape.consts.get(name) ?? functionNamed(shape, name),
  defaulted: (node) => (ts.isFunctionDeclaration(node) || ts.isExpression(node) ? node : undefined),
};

interface HeldMethod {
  shape: FileShape;
  method: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
}

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

export function createHttpCallSites(): CallSiteReader & PlacedCallSiteReader {
  return { of: async (files, repo) => (await readPlaced(files, repo)).map(({ site, column }) => ({ ...site, ...(column === undefined ? {} : { column: column + 1 }) })), placed: (files, repo) => readPlaced(files, repo, true) };
}

function readerOf(files: readonly SourceFile[]): { shapes: ReadonlyMap<string, FileShape>; reader: Reader } {
  const shapes = new Map(files.filter((file) => isTypeScriptSource(file.path)).map((file) => [file.path, describe(file)]));
  const modules = moduleResolverOf(files);
  const wrappers = wrapperMethods(shapes);
  return { shapes, reader: new Reader(shapes, modules, wrappers, buildDefines(files)) };
}

/** A call to a wrapper method, and the method it enters. */
export interface WrapperCall {
  function: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  call: ts.CallExpression;
  forwarded: ts.CallExpression;
}

/** The expression a request carries as its body and the wrapper methods the call enters before it, outermost first. */
export interface RequestBody {
  expression: ts.Expression | undefined;
  wrappers: readonly WrapperCall[];
}

/** Where the body of the HTTP request a call makes is written, read through the same owner and wrapper resolution as the call sites; undefined for a call that is no request of the project. */
export function createRequestBodies(files: readonly SourceFile[]): (call: ts.CallExpression) => Promise<RequestBody | undefined> {
  const { shapes, reader } = readerOf(files);
  return async (call) => {
    const shape = shapes.get(call.getSourceFile().fileName);
    return shape === undefined ? undefined : reader.requestBody(shape, call);
  };
}

async function readPlaced(files: readonly SourceFile[], repo: string, includeForwarding = false): Promise<readonly PlacedCallSite[]> {
  const { shapes, reader: read } = readerOf(files);
  const found: PlacedCallSite[] = [];
  for (const shape of shapes.values()) {
    for (const call of calls(shape.source)) {
      const column = shape.source.getLineAndCharacterOfPosition(call.getStart(shape.source)).character;
      for (const site of await read.callSite(shape, call, repo, includeForwarding)) {
        const origins = CALL_ORIGINS.get(site);
        found.push({ site, column, ...(origins === undefined ? {} : { origins }) });
      }
    }
  }
  return found.sort(({ site: a }, { site: b }) => compareCallSites(a, b));
}
function describe(file: SourceFile): FileShape {
  const source = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const module = recoveredModuleShape(source);
  const shape: FileShape = { source, declared: declarationCounts(source), bindings: sourceBindings(source), unsafeEncoder: mayOverrideEncoder(source), consts: new Map(), module, imports: module.imports, classes: new Map(), enums: new Map() };
  for (const statement of source.statements) {
    const held = defaultExportOf(statement);
    if (held !== undefined) shape.defaultExport = held;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) shape.consts.set(declaration.name.text, declaration.initializer);
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) shape.classes.set(statement.name.text, statement);
    if (ts.isEnumDeclaration(statement)) shape.enums.set(statement.name.text, statement);
  }
  return shape;
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
      const injected = ts.isCallExpression(node) ? injectedClass(node, shape) : undefined;
      if (injected !== undefined) held.add(injected);
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
  return isAngularHttpClientName(shape, injectedClass(expression, shape));
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

/** Whether a name is Angular's `HttpClient`: the name alone is not enough, its import decides. */
function isAngularHttpClientName(shape: FileShape, name: string | undefined): boolean {
  if (name === undefined) return false;
  const imported = shape.imports.get(name);
  return name === "HttpClient" && imported?.module === HTTP_CLIENT_PACKAGE;
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
        FORWARDING_CALLS.set(member, node);
        return;
      }
      const chained = reaching.get(name);
      if (receiver.kind === ts.SyntaxKind.ThisKeyword && chained !== undefined && forwards(node, name)) {
        found = chained;
        FORWARDING_CALLS.set(member, node);
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

/** The argument that carries the body of a request through the verb of its `HttpClient` call; the others carry none, or (`request`) an options object. */
function bodyArgument(verb: string, call: ts.CallExpression): ts.Expression | undefined {
  return verb === "post" || verb === "put" || verb === "patch" ? call.arguments[1] : undefined;
}

function memberNamed(declaration: ts.ClassDeclaration, name: string): ts.ClassElement | undefined {
  return declaration.members.find((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
}

/** Whether a function reads one of its own parameters anywhere in its body. */
function readsOwnParameters(method: ts.SignatureDeclaration): boolean {
  const parameters = parameterNames(method.parameters);
  if (parameters.size === 0) return false;
  const visit = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && parameters.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) return true;
    return ts.forEachChild(node, visit) === true;
  };
  return "body" in method && method.body !== undefined && visit(method.body);
}

/** The function a class member is: a method, or a property initialized with an arrow or a function expression. */
function functionOf(member: ts.Node): ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : undefined;
}

/** The variables a member declares in its body, by name, with what they are initialized to. */
function localInitializers(member: ts.Node): ReadonlyMap<string, ts.Expression> {
  const cached = LOCAL_INITIALIZERS.get(member);
  if (cached !== undefined) return cached;
  const held = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) held.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(member);
  LOCAL_INITIALIZERS.set(member, held);
  return held;
}

function parametersOf(member: ts.Node): RunTime {
  return parameterNames(functionOf(member)?.parameters ?? []);
}

function parameterNames(parameters: readonly ts.ParameterDeclaration[]): RunTime {
  return new Set(parameters.flatMap((parameter) => bindingNames(parameter.name)));
}

/**
 * The lexical bindings visible at a call, with inner declarations taking precedence over outer declarations.
 */
function scopeOfCall(call: ts.CallExpression): Scope {
  return lexicalScope(call);
}

function lexicalScope(point: ts.Node): Scope {
  const node = point.parent;
  if (node === undefined || ts.isSourceFile(node)) return NO_SCOPE;
  const cached = LEXICAL_SCOPES.get(node);
  if (cached !== undefined) return cached;
  const outer = lexicalScope(node);
  const own = ownBindings(node);
  if (own.size === 0) {
    LEXICAL_SCOPES.set(node, outer);
    return outer;
  }
  const names = new Set(own.keys());
  const locals = new Map<string, ts.Expression>();
  for (const [name, { initializer }] of own) if (initializer !== undefined) locals.set(name, initializer);
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

/** A name a node itself binds: the declaration that binds it, and what it is initialized to when a variable states it. */
interface Binding {
  declaration: ts.Node;
  initializer?: ts.Expression;
}

/**
 * The names a node itself binds, the first declaration of each winning: a block's `let`, `const`, functions and
 * classes, a function's parameters and the `var`s of its body, a named function or class expression, a catch clause's
 * variable, a loop's variables.
 */
function ownBindings(node: ts.Node): ReadonlyMap<string, Binding> {
  const cached = OWN_BINDINGS.get(node);
  if (cached !== undefined) return cached;
  const own = new Map<string, Binding>();
  const bind = (name: ts.BindingName, declaration: ts.Node, initializer?: ts.Expression): void => {
    for (const text of bindingNames(name)) {
      if (!own.has(text)) own.set(text, ts.isIdentifier(name) && initializer !== undefined ? { declaration, initializer } : { declaration });
    }
  };
  if (ts.isBlock(node) || ts.isCaseBlock(node)) {
    const statements = ts.isBlock(node) ? node.statements : node.clauses.flatMap((clause) => [...clause.statements]);
    for (const statement of statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) for (const declaration of statement.declarationList.declarations) bind(declaration.name, declaration, declaration.initializer);
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) bind(statement.name, statement);
    }
  }
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name !== undefined) bind(node.name, node);
  if ((ts.isFunctionLike(node) && "parameters" in node) || ts.isClassStaticBlockDeclaration(node)) {
    if ("parameters" in node) for (const parameter of node.parameters) bind(parameter.name, parameter);
    const visitVar = (child: ts.Node): void => {
      if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isModuleDeclaration(child)) return;
      if (ts.isVariableDeclarationList(child) && (child.flags & ts.NodeFlags.BlockScoped) === 0) for (const declaration of child.declarations) bind(declaration.name, declaration);
      ts.forEachChild(child, visitVar);
    };
    if ("body" in node && node.body !== undefined) visitVar(node.body);
  }
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) bind(node.variableDeclaration.name, node.variableDeclaration);
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
    for (const declaration of node.initializer.declarations) bind(declaration.name, declaration, declaration.initializer);
  }
  OWN_BINDINGS.set(node, own);
  return own;
}

/** A call's target, and the request the code states when the snapshot cannot decide where it goes. */
interface ReadTarget {
  throughWrapper?: true;
  target: Finding<HttpTarget>;
  stated?: StatedRequest;
  diagnostic?: CallSiteDiagnostic;
}

/** Reads one file's call sites, resolving the module specifiers it meets through the snapshot. */
class Reader {
  private readonly unsafeEncoder: boolean;
  private readonly fileOf: (from: string, specifier: string) => Promise<string | undefined>;
  private readonly declarationOf: DeclarationLookup;
  /** The classes of the snapshot that extend a class, by the declaration their `extends` resolves to; built once, when first read. */
  private subclassIndex: Promise<ReadonlyMap<ts.ClassDeclaration, readonly HeldClass[]>> | undefined;

  constructor(
    private readonly shapes: ReadonlyMap<string, FileShape>,
    modules: ModuleResolver,
    private readonly wrappers: ReadonlyMap<string, ReadonlyMap<string, string>>,
    private readonly defines: BuildDefines,
  ) {
    this.unsafeEncoder = [...shapes.values()].some((shape) => shape.unsafeEncoder);
    this.fileOf = async (from, specifier) => {
      const resolved = await modules.resolve(from, specifier);
      return "file" in resolved ? resolved.file : undefined;
    };
    this.declarationOf = createDeclarationLookup(async (file) => shapes.get(file)?.module, this.fileOf, { anonymousDefault: true });
  }

  private async subclassesOf(declaration: ts.ClassDeclaration): Promise<readonly HeldClass[]> {
    this.subclassIndex ??= this.indexSubclasses();
    return (await this.subclassIndex).get(declaration) ?? [];
  }

  private async indexSubclasses(): Promise<ReadonlyMap<ts.ClassDeclaration, readonly HeldClass[]>> {
    const index = new Map<ts.ClassDeclaration, HeldClass[]>();
    for (const shape of this.shapes.values()) {
      for (const declaration of shape.source.statements.filter(ts.isClassDeclaration)) {
        const base = baseClassName(declaration);
        const extended = base === undefined ? undefined : await this.classOf(shape, base);
        if (extended !== undefined) index.set(extended.declaration, [...(index.get(extended.declaration) ?? []), { shape, declaration }]);
      }
    }
    return index;
  }

  async callSite(shape: FileShape, call: ts.CallExpression, repo: string, includeForwarding = false): Promise<CallSite[]> {
    if (!includeForwarding && this.forwardsItsOwnParameter(shape, call)) return [];
    const read = await this.target(shape, call);
    if (read === undefined) return [];
    const start = shape.source.getLineAndCharacterOfPosition(call.getStart(shape.source)).line + 1;
    const end = shape.source.getLineAndCharacterOfPosition(call.getEnd()).line + 1;
    const site: CallSite = { repo, file: shape.source.fileName, line: start, endLine: end, symbol: symbolOf(call) ?? "(top level)", ancestors: ancestorsOf(call, shape.source), transport: "http", target: read.target, ...(read.diagnostic === undefined ? {} : { diagnostic: read.diagnostic }), ...(read.stated === undefined ? {} : { stated: read.stated }) };
    if (includeForwarding && read.throughWrapper === true) {
      const body = await this.requestBody(shape, call);
      CALL_ORIGINS.set(site, body?.wrappers.flatMap((wrapper) => [originOf(wrapper.function), originOf(wrapper.forwarded)]) ?? []);
    }
    return [site];
  }

  async requestBody(shape: FileShape, call: ts.CallExpression): Promise<RequestBody | undefined> {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !VERBS.has(callee.name.text)) return undefined;
    const owner = await this.ownerClass(shape, callee.expression);
    if (owner === undefined) return undefined;
    if (isAngularHttpClientName(owner.shape, owner.name)) return { expression: bodyArgument(callee.name.text, call), wrappers: [] };
    const held = await this.classOf(owner.shape, owner.name);
    const wrappers: WrapperCall[] = [];
    let entering = call;
    let name = callee.name.text;
    while (held !== undefined) {
      const member = memberNamed(held.declaration, name);
      const forwarded = member === undefined ? undefined : FORWARDING_CALLS.get(member);
      const entered = member === undefined ? undefined : functionOf(member);
      if (forwarded === undefined || entered === undefined || !ts.isPropertyAccessExpression(forwarded.expression) || wrappers.some((wrapper) => wrapper.function === entered)) return undefined;
      wrappers.push({ function: entered, call: entering, forwarded });
      if (forwarded.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return { expression: bodyArgument(forwarded.expression.name.text, forwarded), wrappers };
      entering = forwarded;
      name = forwarded.expression.name.text;
    }
    return undefined;
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
    const verb = wrapped === undefined || wrapped === "request" ? name : wrapped;
    const read = name === "request" ? await this.explicitRequest(shape, call) : await this.request(shape, call, call.arguments[0], verb === "fetch" ? "GET" : verbOf(verb));
    return wrapped === undefined ? read : { ...read, throughWrapper: true };
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
    if (method === undefined) return "GET";
    return method.status === "undecided" ? undefined : this.methodOf(shape, method.value, scope);
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
    return this.request(shape, call, url?.status === "known" ? url.value : undefined, await this.requestMethod(shape, described, scope), scope);
  }

  private async methodOf(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE): Promise<HttpTarget["method"] | undefined> {
    const text = textOf(await this.evaluate(shape, expression, scope));
    return text === undefined ? undefined : verbOf(text.toLowerCase());
  }

  private async request(shape: FileShape, call: ts.CallExpression, pathExpression: ts.Expression | undefined, method: HttpTarget["method"] | undefined, scope = scopeOfCall(call)): Promise<ReadTarget> {
    const read = pathExpression === undefined ? UNDECIDABLE : await this.evaluate(shape, pathExpression, scope);
    if (read.status === "undecided") return unresolvedAt(shape, call, read);
    const path = textOf(read);
    if (path === undefined || method === undefined || !startsSegments(path)) return unresolvedAt(shape, call);
    const own = callUrl(path);
    const base = own.origin === undefined ? await this.baseUrl(shape, call) : undefined;
    if (base?.status === "undecided") return { ...unresolvedAt(shape, call, base), stated: { method, path: namedHoles(own.path) } };
    const url = base === undefined ? own : joinedCallUrl(base.value, path);
    return { target: { status: "complete", value: { method, path: urlText({ ...url, path: namedHoles(url.path) }) }, evidence: [placeOf(shape, call)] } };
  }

  /** The base URL the call's options declare: undefined when they declare none. */
  private async baseUrl(shape: FileShape, call: ts.CallExpression): Promise<Evaluated<string> | undefined> {
    for (const argument of call.arguments.slice(1)) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      const declared = propertyOf(argument, "baseUrl");
      if (declared === undefined) continue;
      const read = await this.evaluate(shape, declared, scopeOfCall(call));
      if (read.status === "undecided") return read;
      const text = textOf(read);
      return text === undefined ? UNDECIDABLE : known(text);
    }
    return undefined;
  }

  /**
   * The name of the class a receiver is an instance of, with the file that names it: `this.x` through the field the class of
   * the call declares or inherits, a bare name through the binding the code around it declares, or a constant of the file.
   */
  private async ownerClass(shape: FileShape, receiver: ts.Expression): Promise<TypeNamed | undefined> {
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = ownClassDeclaration(receiver);
      return enclosing === undefined ? undefined : this.memberType(shape, enclosing, receiver.name.text, new Set());
    }
    if (!ts.isIdentifier(receiver)) return undefined;
    const scope = lexicalScope(receiver);
    if (scope.names.has(receiver.text)) {
      const local = scope.locals.get(receiver.text);
      const named = local === undefined ? parameterType(receiver) : appendsTo(local)?.length === 0 ? injectedClass(local, shape) : undefined;
      return named === undefined ? undefined : { name: named, shape };
    }
    const constant = shape.consts.get(receiver.text);
    const named = constant === undefined ? undefined : injectedClass(constant, shape);
    return named === undefined ? undefined : { name: named, shape };
  }

  /** The type of the field a class declares under a name, a parameter property included, or the one its base class declares. */
  private async memberType(shape: FileShape, declaration: ts.ClassDeclaration, name: string, visited: ReadonlySet<ts.ClassDeclaration>): Promise<TypeNamed | undefined> {
    if (visited.has(declaration)) return undefined;
    const field = declaration.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name);
    const parameter = constructorParameters(declaration).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name && ts.isParameterPropertyDeclaration(candidate, candidate.parent));
    const declared = field ?? parameter;
    if (declared !== undefined) {
      const named = (field?.initializer === undefined ? undefined : injectedClass(field.initializer, shape)) ?? (declared.type === undefined ? undefined : typeName(declared.type));
      return named === undefined ? undefined : { name: named, shape };
    }
    const base = baseClassName(declaration);
    const found = base === undefined ? undefined : await this.classOf(shape, base);
    return found === undefined ? undefined : this.memberType(found.shape, found.declaration, name, new Set(visited).add(declaration));
  }

  /**
   * What a path expression comes down to: the text it states, a value the code being evaluated fills at run time
   * (`kind: "value"`, written `{}` inside a path), or why the snapshot does not decide it. `scope` holds the names that
   * code binds.
   */
  private async evaluate(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE, trail: ReadonlySet<string> = new Set()): Promise<Read> {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return stated(expression.text);
    if (ts.isTemplateExpression(expression)) {
      let text = expression.head.text;
      for (const span of expression.templateSpans) {
        if (endsPath(text)) return cutAt(text);
        const part = await this.evaluate(shape, span.expression, scope, trail);
        if (part.status === "undecided") return part;
        if (part.value.kind === "text" && part.value.cut) return cutAt(text + part.value.text);
        text += written(part.value) + span.literal.text;
      }
      return stated(text);
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = await this.evaluate(shape, expression.left, scope, trail);
      if (left.status === "known" && left.value.kind === "text" && endsPath(left.value.text)) return cutAt(left.value.text);
      const right = await this.evaluate(shape, expression.right, scope, trail);
      if (left.status === "undecided") return left;
      if (right.status === "undecided") return right;
      return right.value.kind === "text" && right.value.cut ? cutAt(written(left.value) + right.value.text) : stated(written(left.value) + written(right.value));
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return this.evaluate(shape, expression.expression, scope, trail);
    }
    if (ts.isIdentifier(expression)) return this.evaluateName(shape, expression.text, scope, trail);
    if (ts.isPropertyAccessExpression(expression)) return this.evaluateProperty(shape, expression, scope, trail);
    if (ts.isCallExpression(expression)) return this.evaluateCall(shape, expression, scope, trail);
    return UNDECIDABLE;
  }

  /**
   * A name the code binds is what it was bound to: the initializer of a variable declared where the call sits, a value
   * the code fills at run time, or the constant a top-level declaration or an import names. The code's own binding wins,
   * so a parameter that shadows a const of the file stays a value the code fills. An initializer the snapshot does not
   * decide is a value the code fills only when it reads one, so a value computed from nothing it holds stays undecided.
   */
  private async evaluateName(shape: FileShape, name: string, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const local = scope.locals.get(name);
    if (local !== undefined) {
      const visited = `${shape.source.fileName}\0local ${local.pos}`;
      if (trail.has(visited)) return UNDECIDABLE;
      const declared = lexicalScope(local);
      const evaluated = await this.evaluate(shape, local, declared, new Set(trail).add(visited));
      const initial = evaluated.status === "undecided" && readsRunTime(local, declared) ? RUN_TIME : evaluated;
      return this.afterWrites(shape, local, initial, trail);
    }
    if (scope.names.has(name)) return RUN_TIME;
    const constant = await this.constantAt(shape, name, trail);
    if (constant !== undefined) return this.afterWrites(constant.shape, constant.expression, await this.evaluate(constant.shape, constant.expression, NO_SCOPE, constant.trail), constant.trail);
    if (shape.imports.has(name) || shape.bindings.has(name)) return UNDECIDABLE;
    const defined = this.defines.valueOf(shape.source.fileName, name);
    return defined === undefined ? UNDECIDABLE : stated(defined);
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
    const target = await this.importedShape(shape, imported.module);
    return target === undefined ? undefined : this.exported(target, imported.imported, trail);
  }

  /** The expression a module exports under a name. */
  private async exported(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const found = await this.exportedAs(shape, name, CONSTANTS, trail);
    return found === undefined ? undefined : { shape: found.shape, expression: found.declaration, trail: found.trail };
  }

  /** The declaration a name stands for in a file: one the file declares, or the one an import names, through any re-export. */
  private async declaredAs<T>(shape: FileShape, name: string, kind: DeclarationKind<T>, trail: ReadonlySet<string>): Promise<Resolved<T> | undefined> {
    const own = kind.named(shape, name);
    if (own !== undefined) return { shape, declaration: own, trail };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.importedShape(shape, imported.module);
    return target === undefined ? undefined : this.exportedAs(target, imported.imported, kind, trail);
  }

  /**
   * The declaration a module exports under a name, through any re-export chain (`declaration-lookup.ts`), when it is of
   * the kind asked. Undefined when the module states none, when two `export *` could supply it, and when the evaluation
   * already visited that declaration.
   */
  private async exportedAs<T>(shape: FileShape, name: string, kind: DeclarationKind<T>, trail: ReadonlySet<string>): Promise<Resolved<T> | undefined> {
    const found = await this.declarationOf(shape.source.fileName, name);
    const holder = found === undefined ? undefined : this.shapes.get(found.file);
    if (found === undefined || holder === undefined) return undefined;
    const visited = `${found.file}\0${found.name}`;
    if (trail.has(visited)) return undefined;
    const held = holder.defaultExport;
    const declaration = found.name !== ANONYMOUS_DEFAULT ? kind.named(holder, found.name) : held === undefined ? undefined : kind.defaulted(held);
    return declaration === undefined ? undefined : { shape: holder, declaration, trail: new Set(trail).add(visited) };
  }

  /**
   * A member read from a class (`this.base`, `OrderApi.BASE`), a namespace import or an object literal: the value it
   * holds. A property of a value the code fills at run time is one too; a root the code binds is read through that
   * binding first.
   */
  private async evaluateProperty(shape: FileShape, expression: ts.PropertyAccessExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const owner = expression.expression;
    if (ts.isIdentifier(owner) && scope.names.has(owner.text)) return isRunTime(await this.evaluateName(shape, owner.text, scope, trail)) ? RUN_TIME : UNDECIDABLE;
    if (!ts.isIdentifier(owner) && owner.kind !== ts.SyntaxKind.ThisKeyword && isRunTime(await this.evaluate(shape, owner, scope, trail))) return RUN_TIME;
    const held = await this.memberOf(shape, expression, trail);
    if (held === ASSIGNED_AT_RUN_TIME) return RUN_TIME;
    return held === undefined ? UNDECIDABLE : this.afterWrites(held.shape, held.expression, await this.evaluate(held.shape, held.expression, NO_SCOPE, held.trail), held.trail);
  }

  /**
   * What a variable holds where the code reads it, given what its initializer holds: the initializer's path while the code
   * only extends it with a query or a fragment (`url += '?q=' + q`), undecided once it writes it any other way.
   */
  private async afterWrites(shape: FileShape, initializer: ts.Expression, initial: Read, trail: ReadonlySet<string>): Promise<Read> {
    const appended = appendsTo(initializer);
    if (appended === null) return UNDECIDABLE;
    if (appended.length === 0 || initial.status === "undecided") return initial;
    if (initial.value.kind !== "text") return UNDECIDABLE;
    if (endsPath(initial.value.text)) return cutAt(initial.value.text);
    for (const part of appended) {
      const text = textOf(await this.evaluate(shape, part, lexicalScope(part), trail));
      if (text === undefined || !(text.startsWith("?") || text.startsWith("#"))) return UNDECIDABLE;
    }
    return cutAt(initial.value.text);
  }

  private async memberOf(shape: FileShape, expression: ts.PropertyAccessExpression, trail: ReadonlySet<string>): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const owner = expression.expression;
    const name = expression.name.text;
    if (owner.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = ownClassDeclaration(owner);
      return enclosing === undefined ? undefined : await this.fieldOf(shape, enclosing, name, trail, { shape, declaration: enclosing });
    }
    if (!ts.isIdentifier(owner)) return undefined;
    const namespace = shape.imports.get(owner.text);
    if (namespace?.imported === "*") {
      const target = await this.importedShape(shape, namespace.module);
      return target === undefined ? undefined : this.exported(target, name, trail);
    }
    const found = await this.classOf(shape, owner.text);
    const field = found === undefined ? undefined : await this.fieldOf(found.shape, found.declaration, name, trail, found);
    if (field !== undefined) return field;
    const enumeration = await this.declaredAs(shape, owner.text, ENUMS, new Set());
    if (enumeration !== undefined) return enumMember(enumeration.shape, enumeration.declaration, name, trail);
    const literal = await this.objectLiteral(shape, owner.text, trail);
    if (literal === undefined) return undefined;
    const property = literal.expression.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && candidate.name.getText(literal.expression.getSourceFile()) === name);
    return property === undefined ? undefined : { shape: literal.shape, expression: property.initializer, trail: literal.trail };
  }

  /**
   * The initializer of a class member, once, whatever names the class states; a member the class does not declare is its
   * base class's. `read` is the class the code reads the member of. A field declared without an initializer or as a
   * constructor parameter, or that a class of the instance's hierarchy assigns besides its initializer, holds a value the
   * code assigns at run time.
   */
  private async fieldOf(shape: FileShape, declaration: ts.ClassDeclaration, name: string, trail: ReadonlySet<string>, read: HeldClass): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const visited = `${shape.source.fileName}\0${declaration.name?.text ?? "(anonymous)"}.${name}`;
    if (trail.has(visited)) return undefined;
    const member = memberNamed(declaration, name);
    if (member === undefined) {
      if (constructorParameters(declaration).some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name && ts.isParameterPropertyDeclaration(parameter, parameter.parent))) return ASSIGNED_AT_RUN_TIME;
      const base = baseClassName(declaration);
      const found = base === undefined ? undefined : await this.classOf(shape, base);
      return found === undefined ? undefined : this.fieldOf(found.shape, found.declaration, name, new Set(trail).add(visited), read);
    }
    if (!ts.isPropertyDeclaration(member)) return undefined;
    const assigned = (await this.assignedAbove(read, name)) || (await this.assignedBelow(read.declaration, name, new Set()));
    if (member.initializer === undefined || assigned) return ASSIGNED_AT_RUN_TIME;
    return { shape, expression: member.initializer, trail: new Set(trail).add(visited) };
  }

  /** Whether the class, or a base class it extends at any depth, assigns the member through `this`. */
  private async assignedAbove(held: HeldClass, name: string): Promise<boolean> {
    const seen = new Set<ts.ClassDeclaration>();
    for (let current: HeldClass | undefined = held; current !== undefined && !seen.has(current.declaration); ) {
      if (writes(current.declaration, name)) return true;
      seen.add(current.declaration);
      const base = baseClassName(current.declaration);
      current = base === undefined ? undefined : await this.classOf(current.shape, base);
    }
    return false;
  }

  /** Whether a subclass of the class, the instance the code may run on, declares the field again or writes it. */
  private async assignedBelow(declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<boolean> {
    if (visited.has(declaration)) return false;
    visited.add(declaration);
    for (const { declaration: subclass } of await this.subclassesOf(declaration)) {
      if (memberNamed(subclass, name) !== undefined || writes(subclass, name) || (await this.assignedBelow(subclass, name, visited))) return true;
    }
    return false;
  }

  /** The class a name states in this file, or the one an import names. */
  private classOf(shape: FileShape, name: string): Promise<HeldClass | undefined> {
    return this.declaredAs(shape, name, CLASSES, new Set());
  }

  private async objectLiteral(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located<ts.ObjectLiteralExpression> | undefined> {
    const local = shape.consts.get(name);
    const held = local === undefined ? undefined : objectOf(local);
    if (held !== undefined) return { shape, expression: held, trail };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.importedShape(shape, imported.module);
    if (target === undefined) return undefined;
    const found = await this.exported(target, imported.imported, trail);
    const literal = found === undefined ? undefined : objectOf(found.expression);
    return literal === undefined || found === undefined ? undefined : { shape: found.shape, expression: literal, trail: found.trail };
  }

  /** A function the call names, evaluated at its one returned expression: its own parameters are the run-time values. */
  private async evaluateCall(shape: FileShape, call: ts.CallExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "toString") return this.scalarText(shape, call.arguments.length === 0 ? [call.expression.expression] : [], scope, trail);
    if (ts.isPropertyAccessExpression(call.expression)) return this.evaluateMethod(shape, call.expression, trail);
    if (!ts.isIdentifier(call.expression)) return UNDECIDABLE;
    if (scope.names.has(call.expression.text)) return UNDECIDABLE;
    if (call.expression.text === "String" && isGlobalName(shape, scope, "String")) return this.scalarText(shape, call.arguments, scope, trail);
    if (call.expression.text === "encodeURIComponent" && isGlobalName(shape, scope, "encodeURIComponent")) {
      const [argument, ...rest] = call.arguments;
      return argument === undefined || rest.length > 0 || ts.isSpreadElement(argument) ? UNDECIDABLE : this.encoded(shape, argument, scope, trail);
    }
    const visited = `${shape.source.fileName}\0call ${call.expression.text}`;
    if (trail.has(visited)) return undecided("recursive", [placeOf(shape, call)]);
    const found = await this.callTargetOf(shape, call.expression.text);
    return found === undefined ? UNDECIDABLE : this.evaluateReturned(found.target, found.declaration, new Set(trail).add(visited));
  }

  /** `String(x)` and `x.toString()` write what a template writes for `x`. */
  private async scalarText(shape: FileShape, operands: readonly ts.Expression[], scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const [operand, ...rest] = operands;
    return operand === undefined || rest.length > 0 ? UNDECIDABLE : this.evaluate(shape, operand, scope, trail);
  }

  /**
   * `encodeURIComponent(x)` escapes `/`, `?` and `#`, so whatever it encodes stays in one segment: a text it states whole
   * is encoded, anything else is a run-time value, unless the snapshot cannot read it and it reads nothing the code fills
   * at run time. A snapshot that may replace the global encoder leaves a text undecided: only its run-time values stay.
   */
  private async encoded(shape: FileShape, argument: ts.Expression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const read = await this.evaluate(shape, argument, scope, trail);
    if (read.status === "undecided") return readsRunTime(argument, scope) ? RUN_TIME : read;
    const value = read.value;
    if (value.kind === "value" || value.cut || value.text.includes(RUN_TIME_HOLE)) return RUN_TIME;
    if (this.unsafeEncoder) return UNDECIDABLE;
    try {
      return stated(encodeURIComponent(value.text));
    } catch {
      return UNDECIDABLE;
    }
  }

  private async callTargetOf(shape: FileShape, name: string): Promise<{ target: FileShape; declaration: ts.Expression | ts.FunctionDeclaration } | undefined> {
    const found = await this.declaredAs(shape, name, CALLABLES, new Set());
    return found === undefined ? undefined : { target: found.shape, declaration: found.declaration };
  }

  /**
   * What a method call writes: what the method of the receiver's class, or the one it inherits, returns, and every
   * override a subclass declares must write the same; `super` calls only the inherited one. A method that reads its own
   * parameters is not read, since its arguments are not substituted.
   */
  private async evaluateMethod(shape: FileShape, callee: ts.PropertyAccessExpression, trail: ReadonlySet<string>): Promise<Read> {
    const receiver = await this.receiverClass(shape, callee.expression);
    if (receiver === undefined || (await this.assignedAbove(receiver, callee.name.text))) return UNDECIDABLE;
    const inherited = await this.inheritedMethod(receiver.shape, receiver.declaration, callee.name.text, new Set());
    if (inherited === undefined) return UNDECIDABLE;
    const overrides = receiver.virtual ? await this.overrides(receiver.declaration, callee.name.text, new Set()) : [];
    if (overrides === undefined) return UNDECIDABLE;
    const methods = [inherited, ...overrides];
    let agreed: Read | undefined;
    for (const { shape: held, method } of methods) {
      const visited = `${held.source.fileName}\0method ${method.pos}`;
      if (trail.has(visited)) return undecided("recursive", [placeOf(held, method)]);
      if (readsOwnParameters(method)) return UNDECIDABLE;
      const value = await this.evaluateReturned(held, method, new Set(trail).add(visited));
      if (value.status === "undecided") return value;
      if (agreed !== undefined && !sameRead(agreed, value)) return undecided("dispatch-disagreement", methods.map(({ shape: owner, method: declared }) => placeOf(owner, declared)));
      agreed = value;
    }
    return agreed ?? UNDECIDABLE;
  }

  /** The class a method call's receiver is an instance of; `virtual` unless the call is a `super` call. */
  private async receiverClass(shape: FileShape, receiver: ts.Expression): Promise<{ shape: FileShape; declaration: ts.ClassDeclaration; virtual: boolean } | undefined> {
    const enclosing = ownClassDeclaration(receiver);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return enclosing === undefined ? undefined : { shape, declaration: enclosing, virtual: true };
    if (receiver.kind === ts.SyntaxKind.SuperKeyword) {
      const base = enclosing === undefined ? undefined : baseClassName(enclosing);
      const found = base === undefined ? undefined : await this.classOf(shape, base);
      return found === undefined ? undefined : { ...found, virtual: false };
    }
    const named = await this.ownerClass(shape, receiver);
    const found = named === undefined ? undefined : await this.classOf(named.shape, named.name);
    return found === undefined ? undefined : { ...found, virtual: true };
  }

  /** The method a class declares or inherits under a name. */
  private async inheritedMethod(shape: FileShape, declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<HeldMethod | undefined> {
    if (visited.has(declaration)) return undefined;
    visited.add(declaration);
    const member = memberNamed(declaration, name);
    if (member !== undefined) {
      const method = functionOf(member);
      return method === undefined ? undefined : { shape, method };
    }
    const base = baseClassName(declaration);
    const found = base === undefined ? undefined : await this.classOf(shape, base);
    return found === undefined ? undefined : this.inheritedMethod(found.shape, found.declaration, name, visited);
  }

  /**
   * The methods of that name the subclasses of a class declare, at any depth; none once a subclass assigns the name
   * through `this` or declares it as something the snapshot cannot read as a function.
   */
  private async overrides(declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<HeldMethod[] | undefined> {
    if (visited.has(declaration)) return [];
    visited.add(declaration);
    const found: HeldMethod[] = [];
    for (const { shape, declaration: subclass } of await this.subclassesOf(declaration)) {
      if (writes(subclass, name)) return undefined;
      const member = memberNamed(subclass, name);
      if (member !== undefined) {
        const method = functionOf(member);
        if (method === undefined) return undefined;
        found.push({ shape, method });
      }
      const below = await this.overrides(subclass, name, visited);
      if (below === undefined) return undefined;
      found.push(...below);
    }
    return found;
  }

  /** What a call writes: what every return of the function it names writes, undecided when one is or two disagree. */
  private async evaluateReturned(target: FileShape, declaration: ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration, trail: ReadonlySet<string>): Promise<Read> {
    if (!ts.isFunctionDeclaration(declaration) && !ts.isMethodDeclaration(declaration) && !ts.isArrowFunction(declaration) && !ts.isFunctionExpression(declaration)) return this.evaluate(target, declaration, NO_SCOPE, trail);
    let agreed: Read | undefined;
    for (const returned of returnsOf(declaration)) {
      const value = returned === undefined ? UNDECIDABLE : await this.evaluate(target, returned, lexicalScope(returned), trail);
      if (value.status === "undecided") return value;
      if (agreed !== undefined && !sameRead(agreed, value)) return UNDECIDABLE;
      agreed = value;
    }
    return agreed ?? UNDECIDABLE;
  }

  private async importedShape(shape: FileShape, specifier: string): Promise<FileShape | undefined> {
    const file = await this.fileOf(shape.source.fileName, specifier);
    return file === undefined ? undefined : this.shapes.get(file);
  }
}

function baseClassName(declaration: ts.ClassDeclaration): string | undefined {
  const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) ? base.text : undefined;
}

/** The names the file binds at run time; an ambient `declare` binds none. */
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
  return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
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

/**
 * The type name a name's nearest binding declares, when that binding is a function parameter the function never assigns
 * nor declares again with a value: then it holds only its argument.
 */
function parameterType(name: ts.Identifier): string | undefined {
  for (let current: ts.Node | undefined = name.parent; current !== undefined; current = current.parent) {
    const binding = ownBindings(current).get(name.text);
    if (binding === undefined) continue;
    const declaration = binding.declaration;
    if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name) || declaration.type === undefined) return undefined;
    return reboundIn(current).has(name.text) ? undefined : typeName(declaration.type);
  }
  return undefined;
}

/** The names a function assigns, or declares with a value, anywhere in its body. */
function reboundIn(declaration: ts.Node): ReadonlySet<string> {
  const cached = REBOUND_NAMES.get(declaration);
  if (cached !== undefined) return cached;
  const names = new Set(writesIn(declaration).keys());
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) for (const text of bindingNames(node.name)) names.add(text);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  REBOUND_NAMES.set(declaration, names);
  return names;
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
 * The expression an object literal states for a member, a shorthand's name included; undecided when a spread or a
 * computed name after it may state the member instead.
 */
function memberOf(object: ts.ObjectLiteralExpression, name: string): Evaluated<ts.Expression> | undefined {
  let found: Evaluated<ts.Expression> | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name))) found = UNDECIDABLE;
    else if (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      found = ts.isPropertyAssignment(property) ? known(property.initializer) : ts.isShorthandPropertyAssignment(property) ? known(property.name) : UNDECIDABLE;
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

/** A call whose target the snapshot does not decide: unknown at the call, with why. */
function unresolvedAt(shape: FileShape, call: ts.CallExpression, why: Undecided = UNDECIDABLE): ReadTarget {
  return undecidedTarget(why, placeOf(shape, call));
}

/** Where a node is written, as evidence. */
function placeOf(shape: FileShape, node: ts.Node) {
  return { path: shape.source.fileName, line: lineOf(shape.source, node) };
}

/**
 * An enum member whose initializer states a text. Any other initializer is undecided: it may name another member, which
 * a file constant of the same name would answer wrongly.
 */
function enumMember(shape: FileShape, declaration: ts.EnumDeclaration, name: string, trail: ReadonlySet<string>): Located | undefined {
  const member = declaration.members.find((candidate) => (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name);
  const initializer = member?.initializer;
  return initializer !== undefined && ts.isStringLiteralLike(initializer) ? { shape, expression: initializer, trail } : undefined;
}

/** The object literal an initializer is, through the wrappers TypeScript lets an author write around it. */
function objectOf(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression)) return objectOf(expression.expression);
  return undefined;
}

function verbOf(name: string): HttpTarget["method"] {
  return requestMethodOf(name.toUpperCase()) ?? "GET";
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
  for (let at = path.indexOf(RUN_TIME_HOLE); at !== -1; at = path.indexOf(RUN_TIME_HOLE, at + RUN_TIME_HOLE.length)) {
    if (path[at - 1] !== "/") return false;
  }
  return true;
}

/** `:name` stands for a value the code fills, like `${expr}`. */
function namedHoles(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? RUN_TIME_HOLE : segment))
    .join("/");
}

/** The method a node sits in. */
function enclosingMethodDeclaration(node: ts.Node): ts.MethodDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isMethodDeclaration(current)) return current;
  }
  return undefined;
}

/** The class declaration whose instance `this` or `super` denotes at a node. */
function ownClassDeclaration(node: ts.Node): ts.ClassDeclaration | undefined {
  const owner = thisClass(node);
  return owner !== undefined && ts.isClassDeclaration(owner) ? owner : undefined;
}

/** The text a path part states. */
function stated(text: string): Read {
  return known({ kind: "text", text });
}

function cutAt(text: string): Read {
  return known({ kind: "text", text, cut: true });
}

/** Whether a read is a value the code fills at run time. */
function isRunTime(read: Read): boolean {
  return read.status === "known" && read.value.kind === "value";
}

/** Whether two decided reads write the same thing. */
function sameRead(first: Read, second: Read): boolean {
  return first.status === "known" && second.status === "known" && first.value.kind === second.value.kind && written(first.value) === written(second.value);
}

/** What an evaluation writes inside a path: the text it states, or the placeholder a run-time value leaves. */
function written(evaluation: Evaluation): string {
  return evaluation.kind === "text" ? evaluation.text : RUN_TIME_HOLE;
}

/** The text a read states; undefined for a run-time value and for a part the snapshot does not decide. */
function textOf(read: Read): string | undefined {
  return read.status === "known" && read.value.kind === "text" ? read.value.text : undefined;
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

function originOf(node: ts.Node): NonNullable<PlacedCallSite["origins"]>[number] {
  const source = node.getSourceFile();
  const at = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file: source.fileName, line: at.line + 1, column: at.character };
}
